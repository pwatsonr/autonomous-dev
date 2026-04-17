# SPEC-005-5-2: Canary Exit Evaluator and Auto-Termination

## Metadata
- **Parent Plan**: PLAN-005-5
- **Tasks Covered**: Task 3 (Canary exit evaluator), Task 4 (Canary auto-termination)
- **Estimated effort**: 9 hours

## Description

Implement the canary exit evaluator that determines when and how a canary period should end based on accumulated comparison results, and the auto-termination mechanism that immediately aborts a canary on catastrophic regression without waiting for the full period. These enforce the quality gates that protect production from regressions during the extended validation phase.

## Files to Create/Modify

### New Files

**`src/agent-factory/canary/exit-evaluator.ts`**
- Exports: `CanaryExitEvaluator` class with `evaluate(agentName: string): ExitDecision`

### Modified Files

**`src/agent-factory/canary/state-manager.ts`** (integrate auto-termination)
**`src/agent-factory/canary/shadow-runner.ts`** (call evaluator after each comparison)

## Implementation Details

### Canary Exit Evaluator (`canary/exit-evaluator.ts`)

```typescript
type ExitDecision =
  | { action: 'promote'; reason: string }
  | { action: 'reject'; reason: string }
  | { action: 'terminate'; reason: string }    // catastrophic regression
  | { action: 'wait'; reason: string };         // minimum comparisons not met

interface CanaryExitCriteria {
  winThreshold: number;            // default 0.60 (60%)
  lossThreshold: number;           // default 0.40 (40%)
  catastrophicRegressionDelta: number;  // default 1.5
  minComparisons: number;          // default 3
}

class CanaryExitEvaluator {
  constructor(
    private canaryManager: CanaryStateManager,
    private config: AgentFactoryConfig,
    private auditLogger: AuditLogger
  ) {}

  evaluate(agentName: string): ExitDecision { ... }

  // Called after every comparison (for immediate catastrophic check)
  evaluateImmediate(agentName: string, latestComparison: CanaryComparison): ExitDecision { ... }
}
```

**Evaluation algorithm:**

**Step 1: Check for catastrophic regression (immediate, every comparison)**
```typescript
if (latestComparison.delta < -criteria.catastrophicRegressionDelta) {
  // Proposed scored > 1.5 points lower than current
  return {
    action: 'terminate',
    reason: `Catastrophic regression: proposed scored ${Math.abs(latestComparison.delta).toFixed(1)} points below current on input ${latestComparison.input_hash.substring(0, 8)}`
  };
}
```
This check runs after EVERY comparison, regardless of minimum comparison count. A single catastrophic regression is grounds for immediate termination.

**Step 2: Check minimum comparisons**
```typescript
const comparisons = canaryState.comparisons;
if (comparisons.length < criteria.minComparisons) {
  return {
    action: 'wait',
    reason: `Minimum comparisons not met: ${comparisons.length}/${criteria.minComparisons}`
  };
}
```

**Step 3: Compute win/loss rates**
```typescript
const proposed_wins = comparisons.filter(c => c.outcome === 'proposed_wins').length;
const current_wins = comparisons.filter(c => c.outcome === 'current_wins').length;
const total = comparisons.length;
const win_rate = proposed_wins / total;
const loss_rate = current_wins / total;
```

**Step 4: Evaluate based on canary period**
```typescript
if (canaryManager.isExpired(agentName)) {
  // Canary period complete -- make final decision
  if (win_rate >= criteria.winThreshold) {
    return { action: 'promote', reason: `Canary complete: proposed wins ${(win_rate * 100).toFixed(0)}% of comparisons` };
  } else if (loss_rate >= criteria.lossThreshold) {
    return { action: 'reject', reason: `Canary complete: proposed loses ${(loss_rate * 100).toFixed(0)}% of comparisons` };
  } else {
    return { action: 'reject', reason: `Canary complete: inconclusive results (${proposed_wins}W/${current_wins}L/${total - proposed_wins - current_wins}T)` };
  }
}

// Canary still active -- check for early rejection
if (loss_rate >= criteria.lossThreshold) {
  return { action: 'reject', reason: `Early rejection: proposed losing ${(loss_rate * 100).toFixed(0)}% of comparisons` };
}

// Continue canary
return { action: 'wait', reason: `Canary in progress: ${proposed_wins}W/${current_wins}L, ${total} comparisons` };
```

Note: Early promotion is NOT supported -- the full canary period must complete for a promote decision. Early rejection IS supported when the proposed version is clearly losing.

### Auto-Termination

**Integration with shadow runner:**

After each comparison is recorded by the shadow runner:

```typescript
// In shadow-runner.ts, after addComparison():
const immediate = exitEvaluator.evaluateImmediate(agentName, comparison);
if (immediate.action === 'terminate') {
  canaryManager.terminateCanary(agentName);
  registry.transition(agentName, 'REJECTED');
  proposalStore.updateStatus(proposalId, 'rejected');
  auditLogger.log({
    event_type: 'canary_catastrophic_regression',
    agent_name: agentName,
    details: {
      comparison_id: comparison.comparison_id,
      current_score: comparison.current_score,
      proposed_score: comparison.proposed_score,
      delta: comparison.delta,
      reason: immediate.reason
    }
  });
  // Send operator notification
  notificationService.send({
    severity: 'critical',
    message: `Canary terminated for ${agentName}: ${immediate.reason}`
  });
}
```

**Integration with canary period expiry:**

When the shadow runner detects an expired canary:

```typescript
const decision = exitEvaluator.evaluate(agentName);
switch (decision.action) {
  case 'promote':
    canaryManager.completeCanary(agentName, 'completed_positive');
    // Proceed to promotion (auto or human depending on config)
    break;
  case 'reject':
    canaryManager.completeCanary(agentName, 'completed_negative');
    registry.transition(agentName, 'REJECTED');
    proposalStore.updateStatus(proposalId, 'rejected');
    break;
  case 'wait':
    // Should not happen for expired canary, but handle gracefully
    break;
}
```

## Acceptance Criteria

1. Canary exit evaluator promotes when proposed wins 60%+ of comparisons AND canary period is complete.
2. Canary exit evaluator rejects when proposed loses 40%+ of comparisons.
3. Canary exit evaluator returns `wait` when minimum 3 comparisons not yet reached.
4. Catastrophic regression (> 1.5 point drop) triggers immediate termination.
5. Catastrophic check runs after EVERY comparison (no minimum comparisons required).
6. Terminated canary has `auto_rollback_triggered = true`.
7. Agent state transitions to REJECTED on termination or negative completion.
8. Proposal status updated to `rejected` on termination.
9. Critical audit event logged on catastrophic regression.
10. Operator notification sent on catastrophic regression.
11. Early rejection supported (before period expires) when loss rate >= 40%.
12. Early promotion NOT supported (must wait for full period).
13. Inconclusive results at end of period lead to rejection.

## Test Cases

### Exit Evaluator Tests

```
test_promote_60_percent_wins
  Input: 5 comparisons, 3 proposed_wins, 2 ties, canary expired
  Expected: action="promote"

test_promote_requires_period_complete
  Input: 4 comparisons, 4 proposed_wins, canary NOT expired
  Expected: action="wait" (no early promotion)

test_reject_40_percent_losses
  Input: 5 comparisons, 2 current_wins, 3 ties, canary expired
  Expected: action="reject"

test_early_reject_40_percent_losses
  Input: 5 comparisons, 2 current_wins, 3 proposed_wins, canary NOT expired
  Expected: action="reject" (40% loss rate hit)

test_inconclusive_at_period_end
  Input: 5 comparisons, 2W/1L/2T, canary expired
  Expected: action="reject" (inconclusive defaults to reject)

test_wait_below_minimum_comparisons
  Input: 2 comparisons (minimum is 3)
  Expected: action="wait"

test_wait_canary_in_progress
  Input: 3 comparisons, 2W/1L, canary NOT expired, no loss threshold
  Expected: action="wait"

test_configurable_thresholds
  Setup: winThreshold=0.70
  Input: 10 comparisons, 6 wins (60%)
  Expected: action not "promote" (60% < 70%)
```

### Catastrophic Regression Tests

```
test_catastrophic_immediate_termination
  Input: comparison with delta=-2.0 (threshold is 1.5)
  Expected: action="terminate"

test_catastrophic_on_first_comparison
  Input: first comparison has delta=-1.8
  Expected: immediate termination (no minimum required)

test_no_catastrophic_within_threshold
  Input: comparison with delta=-1.4
  Expected: no termination (1.4 < 1.5)

test_catastrophic_at_boundary
  Input: delta=-1.5
  Expected: no termination (threshold is >, not >=)

test_catastrophic_just_over_boundary
  Input: delta=-1.51
  Expected: termination triggered

test_termination_sets_rollback_flag
  Action: terminate canary
  Expected: canaryState.auto_rollback_triggered = true

test_termination_transitions_to_rejected
  Action: terminate canary
  Expected: agent state = REJECTED

test_termination_updates_proposal_status
  Action: terminate canary
  Expected: proposal.status = "rejected"

test_termination_audit_event
  Action: terminate canary
  Expected: audit log contains canary_catastrophic_regression

test_termination_operator_notification
  Action: terminate canary
  Expected: critical notification sent
```

### Integration Tests

```
test_full_canary_positive_cycle
  Setup: start canary, record 5 comparisons (4 wins, 1 tie), expire
  Expected: evaluate returns "promote"

test_full_canary_negative_cycle
  Setup: start canary, record 5 comparisons (1 win, 3 losses, 1 tie), expire
  Expected: evaluate returns "reject"

test_early_termination_mid_canary
  Setup: start canary, second comparison has delta=-2.0
  Expected: immediate termination, canary ends early

test_canary_shadow_to_exit_flow
  Setup: active canary
  Action: interceptInvocation triggers comparison -> evaluateImmediate
  Expected: flow from shadow run to exit evaluation works end-to-end
```
