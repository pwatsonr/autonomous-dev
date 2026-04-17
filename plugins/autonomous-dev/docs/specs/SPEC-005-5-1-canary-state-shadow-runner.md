# SPEC-005-5-1: Canary State Manager and Shadow Runner

## Metadata
- **Parent Plan**: PLAN-005-5
- **Tasks Covered**: Task 1 (Canary state manager), Task 2 (Canary shadow runner)
- **Estimated effort**: 14 hours

## Description

Implement the canary state manager that tracks extended validation periods for agents with proposals that passed A/B testing, and the shadow runner that executes the proposed agent version alongside the current version on every new production invocation during the canary period. The shadow runner has zero production impact -- only the current agent's output is used by the pipeline.

## Files to Create/Modify

### New Files

**`src/agent-factory/canary/state-manager.ts`**
- Exports: `CanaryStateManager` class with full canary lifecycle management

**`src/agent-factory/canary/shadow-runner.ts`**
- Exports: `CanaryShadowRunner` class with dual-execution and comparison logic

## Implementation Details

### Canary State Manager (`canary/state-manager.ts`)

```typescript
interface CanaryState {
  agent_name: string;
  current_version: string;
  proposed_version: string;
  proposal_id: string;
  canary_started_at: string;        // ISO 8601
  canary_ends_at: string;           // ISO 8601 (started_at + duration)
  comparisons: CanaryComparison[];
  auto_rollback_triggered: boolean;
  status: CanaryStatus;
}

type CanaryStatus = 'active' | 'completed_positive' | 'completed_negative' | 'terminated_regression';

interface CanaryComparison {
  comparison_id: string;            // UUID v4
  timestamp: string;
  input_hash: string;
  current_score: number;
  proposed_score: number;
  delta: number;
  per_dimension: Record<string, number>;  // delta per dimension
  outcome: 'proposed_wins' | 'current_wins' | 'tie';
}

class CanaryStateManager {
  constructor(
    private config: AgentFactoryConfig,
    private auditLogger: AuditLogger
  ) {}

  // Create a new canary for an agent
  startCanary(agentName: string, proposal: AgentProposal): CanaryState;

  // Get active canary for an agent (or null)
  getActiveCanary(agentName: string): CanaryState | null;

  // List all active canaries
  listActiveCanaries(): CanaryState[];

  // Record a comparison result
  addComparison(agentName: string, comparison: CanaryComparison): void;

  // Complete the canary (positive or negative)
  completeCanary(agentName: string, status: 'completed_positive' | 'completed_negative'): void;

  // Terminate immediately (catastrophic regression)
  terminateCanary(agentName: string): void;

  // Check if canary period has expired
  isExpired(agentName: string): boolean;
}
```

**Persistence:** `data/canary-state.json`

```json
{
  "canaries": {
    "code-executor": {
      "agent_name": "code-executor",
      "current_version": "1.0.0",
      "proposed_version": "1.0.1",
      "proposal_id": "abc-123",
      "canary_started_at": "2026-04-01T00:00:00Z",
      "canary_ends_at": "2026-04-08T00:00:00Z",
      "comparisons": [],
      "auto_rollback_triggered": false,
      "status": "active"
    }
  }
}
```

**Duration:** Configurable via `config.canary.durationDays` (default 7 days).

**Lifecycle:**
1. `startCanary()`: Create state, set `canary_ends_at = now + duration`, persist. Transition agent to CANARY state.
2. During canary: `addComparison()` appends to the comparisons array, persists.
3. `completeCanary()`: Set final status, persist.
4. `terminateCanary()`: Set status to `terminated_regression`, set `auto_rollback_triggered = true`, persist.

### Canary Shadow Runner (`canary/shadow-runner.ts`)

```typescript
class CanaryShadowRunner {
  constructor(
    private canaryManager: CanaryStateManager,
    private registry: IAgentRegistry,
    private metricsEngine: IMetricsEngine,
    private auditLogger: AuditLogger
  ) {}

  // Hook into agent invocation: check if canary is active, run shadow if so
  async interceptInvocation(
    agentName: string,
    input: string,
    context: RuntimeContext
  ): Promise<ShadowResult>;
}

interface ShadowResult {
  canary_active: boolean;
  current_output: string;          // always used for the pipeline
  proposed_output?: string;        // shadow output, discarded from pipeline
  comparison?: CanaryComparison;
}
```

**Shadow execution flow:**

1. **Check for active canary**: `canaryManager.getActiveCanary(agentName)`.
   - If no active canary: return `{ canary_active: false, current_output }`. No shadow run.
   - If canary expired: trigger exit evaluation (SPEC-005-5-2).

2. **Run current version (primary):**
   - Execute the current agent version normally.
   - This output is returned to the pipeline (zero production impact).
   - Record invocation metric with `environment: 'production'`.

3. **Run proposed version (shadow):**
   - Load the proposed definition from the proposal.
   - Execute in shadow mode with the same input.
   - Record invocation metric with `environment: 'canary'`.
   - This output is NOT returned to the pipeline.

4. **Score both outputs:**
   - Select the appropriate reviewer agent (same logic as A/B blind scorer).
   - Score both outputs using the agent's evaluation rubric.
   - Single scoring round (not median-of-3, to limit token cost during canary).

5. **Record comparison:**
   - Compute delta and per-dimension deltas.
   - Classify outcome (proposed_wins/current_wins/tie) using 0.2 threshold.
   - Call `canaryManager.addComparison()`.

6. **Check for catastrophic regression (immediate):**
   - If proposed score is > 1.5 points lower than current: trigger immediate termination.
   - This check happens after every comparison (SPEC-005-5-2).

**Token cost management:**
- Shadow runs double the per-invocation cost during the canary period.
- The canary duration is configurable to control total cost.
- Shadow runs are tagged as `environment: 'canary'` for separate cost tracking.

## Acceptance Criteria

1. Canary state created with correct start/end dates and linked to proposal.
2. State persisted to `data/canary-state.json`.
3. Active canaries queryable by agent name.
4. Comparisons appended to canary state as they occur.
5. Shadow runner executes proposed version alongside current on every invocation.
6. Current agent's output is used by the pipeline (zero production impact).
7. Proposed agent's output is discarded from the pipeline.
8. Both outputs scored by appropriate reviewer agent.
9. Shadow invocations tagged with `environment: 'canary'` in metrics.
10. Comparison results include per-dimension deltas and outcome classification.
11. Catastrophic regression (1.5 point drop) detected immediately after comparison.
12. Canary duration configurable (default 7 days).

## Test Cases

### Canary State Manager Tests

```
test_start_canary
  Action: startCanary("code-executor", proposal)
  Expected: CanaryState created with correct dates, status="active"

test_canary_duration_7_days
  Action: start canary at 2026-04-01T00:00:00Z
  Expected: canary_ends_at = 2026-04-08T00:00:00Z

test_canary_duration_configurable
  Setup: config.canary.durationDays = 14
  Expected: canary_ends_at = 14 days after start

test_get_active_canary
  Setup: active canary for "code-executor"
  Expected: getActiveCanary("code-executor") returns CanaryState

test_get_no_active_canary
  Expected: getActiveCanary("prd-author") returns null

test_add_comparison
  Action: addComparison with delta=0.3
  Expected: comparison appended to canary state

test_complete_canary_positive
  Action: completeCanary("code-executor", "completed_positive")
  Expected: status = "completed_positive"

test_terminate_canary
  Action: terminateCanary("code-executor")
  Expected: status = "terminated_regression", auto_rollback_triggered = true

test_is_expired
  Setup: canary_ends_at in the past
  Expected: isExpired() returns true

test_state_persisted_to_disk
  Action: start canary, reload from disk
  Expected: state matches

test_list_active_canaries
  Setup: 2 active canaries, 1 completed
  Expected: listActiveCanaries() returns 2
```

### Shadow Runner Tests

```
test_shadow_run_when_canary_active
  Setup: active canary for "code-executor"
  Action: interceptInvocation("code-executor", input)
  Expected: both versions run, comparison recorded

test_no_shadow_when_no_canary
  Setup: no canary for "prd-author"
  Action: interceptInvocation("prd-author", input)
  Expected: canary_active=false, only current output

test_current_output_returned_to_pipeline
  Expected: ShadowResult.current_output is from current version

test_proposed_output_not_in_pipeline
  Expected: pipeline uses current_output, not proposed_output

test_shadow_invocation_tagged_canary
  Expected: proposed version invocation has environment="canary"

test_current_invocation_tagged_production
  Expected: current version invocation has environment="production"

test_comparison_scored_by_reviewer
  Expected: both outputs scored using appropriate reviewer

test_comparison_delta_computed
  Input: current_score=4.0, proposed_score=4.5
  Expected: delta=0.5, outcome="proposed_wins"

test_catastrophic_regression_detected
  Input: current_score=4.0, proposed_score=2.0 (delta=-2.0)
  Expected: immediate termination triggered

test_expired_canary_triggers_exit
  Setup: canary_ends_at in the past
  Action: interceptInvocation
  Expected: exit evaluation triggered (not another shadow run)

test_shadow_run_failure_does_not_affect_production
  Setup: proposed version times out
  Expected: current output still returned, comparison recorded as proposed_loss
```
