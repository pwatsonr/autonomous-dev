# SPEC-005-4-5: Domain Gap Detection, CLI Commands, and Validation State Transitions

## Metadata
- **Parent Plan**: PLAN-005-4
- **Tasks Covered**: Task 11 (Domain gap detection and logging), Task 12 (Manual A/B comparison CLI), Task 13 (CLI: promote, reject, accept, gaps), Task 14 (Agent state transitions: validation states)
- **Estimated effort**: 20 hours

## Description

Implement the domain gap detector that identifies when no agent can serve a task domain, the manual A/B comparison CLI for ad-hoc version testing, the remaining Phase 2 CLI commands (promote, reject, accept, gaps), and the extended state transition system for validation and promotion states. This spec completes the Phase 2 CLI surface and state machine.

## Files to Create/Modify

### New Files

**`src/agent-factory/gaps/detector.ts`**
- Exports: `DomainGapDetector` class with `detect(taskDomain: string, taskDescription: string, closestAgent: RankedAgent | null): GapRecord`

### Modified Files

**`src/agent-factory/cli.ts`** (extend with Phase 2 commands)
**`src/agent-factory/registry.ts`** (extend state machine)

## Implementation Details

### Domain Gap Detection (`gaps/detector.ts`)

```typescript
interface GapRecord {
  gap_id: string;                  // UUID v4
  task_domain: string;
  task_description: string;
  closest_agent: string | null;
  closest_similarity: number;
  detected_at: string;             // ISO 8601
  status: GapStatus;
  source: 'discovery' | 'analysis';  // how the gap was detected
}

type GapStatus = 'detected' | 'specialist_recommended' | 'proposed' | 'accepted' | 'rejected' | 'deferred';
```

**Detection triggers:**

1. **Discovery-triggered:** When `registry.getForTask()` returns no agent above the 0.6 similarity threshold.
2. **Analysis-triggered:** When the performance analyzer recommends `propose_specialist` (handled in SPEC-005-3-2).

**Gap logging:**
- Append to `data/domain-gaps.jsonl`.
- Include the closest agent and its similarity score for context.
- Rate limit check: only 1 domain gap per calendar week per task_domain (prevents flood).

**Fallback behavior:**
- When a gap is detected during pipeline execution, the system falls back to the closest-matching agent.
- A warning is injected into the pipeline state: "No specialized agent for domain '{domain}'. Falling back to '{closest_agent}' (similarity: {score}). Consider creating a specialist agent."

**Example JSONL line:**
```json
{"gap_id":"e5f6g7h8-...","task_domain":"quantum-computing","task_description":"Implement quantum gate simulation","closest_agent":"code-executor","closest_similarity":0.32,"detected_at":"2026-04-08T14:00:00Z","status":"detected","source":"discovery"}
```

### Manual A/B Comparison CLI

**`agent compare <name> --version-a X --version-b Y [--inputs N]`**

Follows the same 7-step A/B protocol as automated validation, but:
- Operator specifies which two versions to compare.
- Input count configurable (default 3, max 5).
- Either version can be older or newer (not limited to current vs. proposed).

**Implementation:**
1. Retrieve version_a definition from git: `git show <commit-for-version-a>:agents/<name>.md`.
2. Retrieve version_b definition similarly.
3. Select N inputs from historical invocations.
4. Execute the A/B protocol using the same infrastructure (blind-runner, randomizer, scorer, comparator, decision engine).
5. Store results at `data/evaluations/manual-<evaluation_id>.json`.
6. Display results in CLI.

**Output format:**
```
A/B Comparison: code-executor v1.0.0 vs v1.1.0
═══════════════════════════════════════════════

Inputs: 3 | Budget: 100,000 tokens

Input 1 (typescript, below-median):
  v1.0.0: 3.8   v1.1.0: 4.2   delta: +0.4   Winner: v1.1.0
  Per-dimension: correctness +0.2, quality +0.5, coverage +0.4, adherence +0.3

Input 2 (python, weakness-domain):
  v1.0.0: 3.2   v1.1.0: 3.6   delta: +0.4   Winner: v1.1.0

Input 3 (infrastructure, above-median):
  v1.0.0: 4.5   v1.1.0: 4.3   delta: -0.2   Winner: TIE

──────────────────────────────────────────────
Aggregate: v1.1.0 wins 2/3, ties 1/3
Mean delta: +0.2
Verdict: POSITIVE

Evaluation saved: data/evaluations/manual-abc123.json
```

### CLI Commands

**`agent promote <name> <version>`**
- Triggers the Promoter.promote() workflow.
- Displays review summary (weakness report, meta-review, A/B results, diff).
- Prompts for confirmation: "Promote {name} to v{version}? [y/N]".
- On confirm: executes promotion.
- On decline: no action.

**`agent reject <name> <version> --reason "<reason>"`**
- Triggers the Rejector.reject() workflow.
- Requires `--reason` flag.
- Displays confirmation and result.

**`agent accept <name>`**
- Accepts a proposed new agent from `data/proposed-agents/`.
- Placeholder for PLAN-005-5 dynamic creation.
- If no proposed agent with that name exists: error.
- If proposed agent exists: display definition summary, prompt for confirmation.

**`agent gaps`**
- Lists all detected domain gaps.
```
DOMAIN GAPS
════════════════════════════════════════════════════════
DOMAIN               STATUS         CLOSEST AGENT     SIM    DETECTED
─────────────────────────────────────────────────────────
quantum-computing    detected       code-executor     0.32   2026-04-08
rust-development     specialist_recommended  code-executor  0.45   2026-04-05
graphql-design       proposed       spec-author       0.58   2026-04-01
─────────────────────────────────────────────────────────
Total: 3 gaps (1 detected, 1 recommended, 1 proposed)
```

### State Transitions (registry.ts extensions)

Add the following transitions to the registry's state machine:

```typescript
const VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  'REGISTERED':   ['ACTIVE', 'FROZEN'],
  'ACTIVE':       ['FROZEN', 'UNDER_REVIEW'],
  'FROZEN':       ['ACTIVE'],
  'UNDER_REVIEW': ['VALIDATING', 'ACTIVE'],     // ACTIVE = rejected/cancelled
  'VALIDATING':   ['PROMOTED', 'REJECTED', 'CANARY'],  // CANARY from PLAN-005-5
  'CANARY':       ['PROMOTED', 'REJECTED'],       // from PLAN-005-5
  'PROMOTED':     ['ACTIVE'],                     // transient state
  'REJECTED':     ['ACTIVE'],                     // returns to active
};
```

**Transition method:**
```typescript
transition(name: string, targetState: AgentState): void {
  const record = this.agents.get(name);
  if (!record) throw new Error(`Agent '${name}' not found`);

  const allowed = VALID_TRANSITIONS[record.state];
  if (!allowed || !allowed.includes(targetState)) {
    throw new Error(
      `Invalid state transition for '${name}': ${record.state} -> ${targetState}. ` +
      `Allowed transitions: ${allowed?.join(', ') || 'none'}`
    );
  }

  const from = record.state;
  record.state = targetState;

  this.auditLogger.log({
    event_type: 'agent_state_changed',
    agent_name: name,
    details: { from, to: targetState }
  });
}
```

## Acceptance Criteria

1. Domain gaps detected when no agent exceeds 0.6 similarity threshold.
2. Gaps logged to `data/domain-gaps.jsonl` with all required fields.
3. Rate limit: max 1 gap per domain per calendar week.
4. Fallback to closest agent with warning injected into pipeline state.
5. Manual A/B comparison follows the same 7-step protocol.
6. Operator can specify any two versions for comparison.
7. Comparison results stored at `data/evaluations/manual-<id>.json`.
8. `agent promote` displays review summary and prompts for confirmation.
9. `agent reject` requires `--reason` flag.
10. `agent accept` handles proposed agents from `data/proposed-agents/`.
11. `agent gaps` lists all domain gaps with status.
12. State transitions enforce valid paths per the transition table.
13. Invalid transitions throw descriptive error.
14. All transitions logged to audit log.

## Test Cases

### Domain Gap Tests

```
test_gap_detected_on_no_match
  Setup: query "quantum computing", no agent above 0.6
  Expected: GapRecord created with status="detected"

test_gap_includes_closest_agent
  Setup: closest agent is "code-executor" at similarity 0.32
  Expected: closest_agent="code-executor", closest_similarity=0.32

test_gap_rate_limit_per_domain
  Setup: gap for "quantum-computing" already logged this week
  Action: same domain triggers again
  Expected: no duplicate gap logged

test_gap_different_domain_allowed
  Setup: gap for "quantum-computing" logged
  Action: gap for "biotech" detected
  Expected: new gap logged (different domain)

test_fallback_to_closest_agent
  Setup: no match above threshold, closest is "code-executor"
  Expected: code-executor used with warning in pipeline state

test_gap_from_analysis
  Setup: analysis recommends "propose_specialist"
  Expected: gap logged with source="analysis"
```

### Manual A/B Comparison Tests

```
test_compare_two_versions
  Action: agent compare code-executor --version-a 1.0.0 --version-b 1.1.0
  Expected: A/B protocol executes, results displayed

test_compare_default_3_inputs
  Action: compare without --inputs
  Expected: 3 inputs used

test_compare_max_5_inputs
  Action: compare with --inputs 5
  Expected: 5 inputs used

test_compare_inputs_exceeds_max
  Action: compare with --inputs 10
  Expected: capped to 5 with warning

test_compare_result_stored
  Expected: file at data/evaluations/manual-<id>.json

test_compare_version_from_git
  Setup: agent had v1.0.0 in an earlier commit
  Action: compare using v1.0.0
  Expected: v1.0.0 definition retrieved from git history
```

### CLI Tests

```
test_promote_command_confirmation
  Action: agent promote code-executor 1.0.1
  Expected: review summary displayed, confirmation prompt

test_promote_command_success
  Action: confirm promotion
  Expected: "Successfully promoted code-executor to v1.0.1"

test_reject_command_requires_reason
  Action: agent reject code-executor 1.0.1
  Expected: error "Missing required flag: --reason"

test_reject_command_success
  Action: agent reject code-executor 1.0.1 --reason "Quality regression"
  Expected: "Proposal rejected for code-executor"

test_accept_command_no_proposed
  Action: agent accept nonexistent-agent
  Expected: error "No proposed agent found"

test_gaps_command_displays_all
  Setup: 3 domain gaps
  Expected: table with 3 rows showing domain, status, closest agent, similarity, date
```

### State Transition Tests

```
test_under_review_to_validating
  Action: transition("agent", "VALIDATING")
  Expected: state = VALIDATING

test_validating_to_promoted
  Action: transition("agent", "PROMOTED") from VALIDATING
  Expected: state = PROMOTED

test_validating_to_rejected
  Action: transition("agent", "REJECTED") from VALIDATING
  Expected: state = REJECTED

test_promoted_to_active
  Action: transition("agent", "ACTIVE") from PROMOTED
  Expected: state = ACTIVE

test_rejected_to_active
  Action: transition("agent", "ACTIVE") from REJECTED
  Expected: state = ACTIVE

test_invalid_active_to_promoted
  Action: transition("agent", "PROMOTED") from ACTIVE
  Expected: error "Invalid state transition"

test_invalid_frozen_to_validating
  Action: transition("agent", "VALIDATING") from FROZEN
  Expected: error "Invalid state transition"

test_transition_logged
  Action: any valid transition
  Expected: audit log contains agent_state_changed event
```
