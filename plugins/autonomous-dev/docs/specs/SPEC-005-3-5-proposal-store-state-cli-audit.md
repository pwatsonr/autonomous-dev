# SPEC-005-3-5: Proposal Storage, Agent State Transitions, CLI, and Audit Events

## Metadata
- **Parent Plan**: PLAN-005-3
- **Tasks Covered**: Task 11 (Proposal storage and lifecycle state), Task 12 (Agent state transition: ACTIVE -> UNDER_REVIEW), Task 13 (CLI: agent analyze), Task 14 (Audit log entries for improvement events)
- **Estimated effort**: 15 hours

## Description

Implement the proposal storage system with JSONL persistence and SQLite indexing, the ACTIVE-to-UNDER_REVIEW state transition in the registry with proper guards, the `agent analyze` CLI command, and all improvement lifecycle audit log events. This spec wires together the outputs of the analysis and proposal generation into persistent, queryable storage with proper state management.

## Files to Create/Modify

### New Files

**`src/agent-factory/improvement/proposal-store.ts`**
- Exports: `ProposalStore` class with CRUD operations and state transition management

### Modified Files

**`src/agent-factory/registry.ts`** (extend state transitions)
- Add: `transitionToUnderReview(name: string): void` with guards

**`src/agent-factory/cli.ts`** (extend with analyze command)
- Add: `agent analyze <name> [--force]`

**`src/agent-factory/audit.ts`** (extend event types)
- Add: improvement lifecycle event types

## Implementation Details

### Proposal Store (`improvement/proposal-store.ts`)

**Dual storage (same pattern as metrics):**

**JSONL primary:** `data/proposals.jsonl`
- One `AgentProposal` per line.
- Append-only for new proposals.
- Status updates overwrite the entire line (rewrite file with updated record).

**SQLite secondary:** New table in `data/agent-metrics.db`

```sql
CREATE TABLE IF NOT EXISTS proposals (
  proposal_id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  current_version TEXT NOT NULL,
  proposed_version TEXT NOT NULL,
  version_bump TEXT NOT NULL,
  weakness_report_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  meta_review_id TEXT,
  evaluation_id TEXT,
  rationale TEXT NOT NULL,
  diff TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_agent ON proposals(agent_name);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_created ON proposals(created_at);
```

Note: Full definitions (current and proposed `.md` content) stored in JSONL only (too large for SQLite column in practice). SQLite stores metadata for querying.

**Query API:**

```typescript
class ProposalStore {
  constructor(
    private jsonlPath: string,
    private sqliteStore: SqliteStore
  ) {}

  // Create
  append(proposal: AgentProposal): void;

  // Read
  getById(proposalId: string): AgentProposal | null;
  getByAgent(agentName: string, status?: ProposalStatus): AgentProposal[];
  getByStatus(status: ProposalStatus): AgentProposal[];
  getByDateRange(since: string, until: string): AgentProposal[];
  getLatestForAgent(agentName: string): AgentProposal | null;

  // Update
  updateStatus(proposalId: string, status: ProposalStatus): void;
  setMetaReviewId(proposalId: string, reviewId: string): void;
  setEvaluationId(proposalId: string, evaluationId: string): void;
}
```

**Status transition rules:**

```
pending_meta_review -> meta_approved     (meta-review passes)
pending_meta_review -> meta_rejected     (meta-review fails)
pending_meta_review -> pending_human_review  (self-review bypass)
meta_approved       -> validating        (A/B test initiated, PLAN-005-4)
validating          -> validated_positive (A/B test positive, PLAN-005-4)
validating          -> validated_negative (A/B test negative, PLAN-005-4)
validated_positive  -> promoted          (human/auto approves, PLAN-005-4/5)
validated_positive  -> rejected          (human rejects, PLAN-005-4)
validated_negative  -> rejected          (automatic, PLAN-005-4)
meta_rejected       -> [terminal]        (no further transitions)
rejected            -> [terminal]
promoted            -> [terminal]
```

The store enforces valid transitions. Invalid transitions throw an error.

### Agent State Transition: ACTIVE -> UNDER_REVIEW

Extend `registry.ts`:

```typescript
transitionToUnderReview(name: string): void {
  const record = this.agents.get(name);
  if (!record) throw new Error(`Agent '${name}' not found`);

  // Guards:
  // 1. Agent must be ACTIVE
  if (record.state !== 'ACTIVE') {
    throw new Error(
      `Cannot transition '${name}' to UNDER_REVIEW: current state is ${record.state} (must be ACTIVE)`
    );
  }

  // 2. Observation threshold must be met (or forced) - checked by caller
  // 3. Not rate-limited - checked by caller

  record.state = 'UNDER_REVIEW';
  this.auditLogger.log({
    event_type: 'agent_state_changed',
    agent_name: name,
    details: { from: 'ACTIVE', to: 'UNDER_REVIEW' }
  });
}
```

### CLI Command: `agent analyze`

**`agent analyze <name> [--force]`**

```
$ agent analyze code-executor

Analyzing agent 'code-executor' (v1.0.0)...

Observation state: 15/10 invocations (threshold reached)
Invoking performance-analyst...

Weakness Report:
  Overall Assessment: needs_improvement
  
  Weaknesses:
    - test-coverage (medium): Avg score 2.8/5.0, declining trend
      Affected domains: python
      Focus: Emphasize test generation for non-TypeScript domains
    
    - code-quality (low): Avg score 3.2/5.0, stable
      Affected domains: infrastructure
      Focus: Apply design patterns for infrastructure code

  Strengths:
    - correctness score stable at 4.2
    - spec-adherence consistently above 4.0
  
  Recommendation: propose_modification

Generating proposal...
  Proposal ID: a1b2c3d4-...
  Version bump: patch (1.0.0 -> 1.0.1)
  Status: pending_meta_review

Running meta-review...
  Verdict: approved (0 blockers, 1 warning)
  Status: meta_approved

Agent 'code-executor' is now UNDER_REVIEW.
Next step: A/B validation (run 'agent compare code-executor')
```

**Error cases:**
```
$ agent analyze code-executor
Error: Agent 'code-executor' is FROZEN. Cannot analyze frozen agents.

$ agent analyze code-executor
Error: Agent 'code-executor' is already UNDER_REVIEW.

$ agent analyze code-executor
Observation state: 5/10 invocations (collecting)
Error: Threshold not reached. Use --force to bypass.

$ agent analyze code-executor --force
Forcing analysis (bypassing threshold)...
[analysis proceeds]
```

### Audit Log Events for Improvement Lifecycle

Extend `audit.ts` with these event types:

| Event Type | When | Details Fields |
|------------|------|----------------|
| `analysis_triggered` | Observation threshold crossed | `agent_name`, `invocation_count`, `threshold`, `forced` |
| `weakness_report_generated` | Analysis produces report | `agent_name`, `report_id`, `overall_assessment`, `weakness_count` |
| `proposal_generated` | Proposal created | `agent_name`, `proposal_id`, `current_version`, `proposed_version`, `version_bump` |
| `proposal_rejected_constraint_violation` | Hard-coded constraint check fails | `agent_name`, `proposal_id`, `violations[]` |
| `meta_review_completed` | Meta-review finishes | `agent_name`, `proposal_id`, `review_id`, `verdict`, `findings_count`, `blockers_count` |
| `meta_review_bypassed_self_referential` | Self-review bypass | `agent_name`, `proposal_id` |
| `modification_rate_limited` | Rate limit hit | `agent_name`, `current_count`, `max_per_week`, `next_allowed_at` |
| `agent_state_changed` | Registry state transition | `agent_name`, `from`, `to` |

Each event follows the existing `AuditEvent` format with timestamp, event_type, agent_name, and details object.

## Acceptance Criteria

1. Proposals persisted to JSONL and indexed in SQLite.
2. Proposals queryable by agent name, status, and date range.
3. Status transitions enforced: invalid transitions throw error.
4. All valid status transition paths work correctly.
5. ACTIVE -> UNDER_REVIEW transition enforced with guards (must be ACTIVE).
6. State transition logged to audit log.
7. `agent analyze <name>` triggers analysis when threshold met.
8. `agent analyze <name> --force` bypasses threshold check.
9. `agent analyze` displays error for FROZEN or already-under-review agents.
10. All 8 improvement lifecycle audit events logged with correct details.
11. Audit events include all specified detail fields.

## Test Cases

### Proposal Store Tests

```
test_append_and_retrieve_proposal
  Action: append proposal, getById
  Expected: returned proposal matches appended

test_query_by_agent
  Setup: 2 proposals for "code-executor", 1 for "prd-author"
  Action: getByAgent("code-executor")
  Expected: returns 2

test_query_by_status
  Setup: 1 meta_approved, 2 meta_rejected
  Action: getByStatus("meta_approved")
  Expected: returns 1

test_query_by_date_range
  Setup: proposals at days -10, -5, -1
  Action: getByDateRange(day-7, now)
  Expected: returns proposals at -5 and -1

test_update_status_valid_transition
  Setup: proposal in "pending_meta_review"
  Action: updateStatus(id, "meta_approved")
  Expected: status updated

test_update_status_invalid_transition
  Setup: proposal in "meta_rejected"
  Action: updateStatus(id, "validating")
  Expected: error thrown (meta_rejected is terminal)

test_get_latest_for_agent
  Setup: 3 proposals for agent at different times
  Action: getLatestForAgent("agent")
  Expected: returns most recent by created_at

test_set_meta_review_id
  Action: setMetaReviewId(proposalId, reviewId)
  Expected: proposal.meta_review_id set

test_set_evaluation_id
  Action: setEvaluationId(proposalId, evalId)
  Expected: proposal.evaluation_id set
```

### State Transition Tests

```
test_active_to_under_review
  Setup: agent in ACTIVE state
  Action: transitionToUnderReview("agent")
  Expected: state = UNDER_REVIEW

test_frozen_to_under_review_fails
  Setup: agent in FROZEN state
  Action: transitionToUnderReview("agent")
  Expected: error "must be ACTIVE"

test_under_review_to_under_review_fails
  Setup: agent already in UNDER_REVIEW
  Action: transitionToUnderReview("agent")
  Expected: error "must be ACTIVE"

test_state_change_logged
  Action: transitionToUnderReview("agent")
  Expected: audit log contains agent_state_changed with from=ACTIVE, to=UNDER_REVIEW
```

### CLI Tests

```
test_analyze_threshold_met
  Setup: agent with 15 invocations (threshold=10)
  Action: agent analyze code-executor
  Expected: analysis runs, report displayed

test_analyze_threshold_not_met
  Setup: agent with 5 invocations (threshold=10)
  Action: agent analyze code-executor
  Expected: error message with current/threshold counts

test_analyze_force_flag
  Setup: agent with 5 invocations (below threshold)
  Action: agent analyze code-executor --force
  Expected: analysis runs despite low count

test_analyze_frozen_agent
  Action: agent analyze agent-meta-reviewer (frozen)
  Expected: error "Agent is FROZEN"

test_analyze_already_under_review
  Setup: agent in UNDER_REVIEW state
  Action: agent analyze code-executor
  Expected: error "already UNDER_REVIEW"

test_analyze_displays_weakness_report
  Action: successful analysis
  Expected: output includes overall assessment, weaknesses, strengths, recommendation
```

### Audit Event Tests

```
test_analysis_triggered_event
  Action: observation trigger fires
  Expected: audit event with type=analysis_triggered, includes invocation_count and threshold

test_weakness_report_generated_event
  Action: analysis completes
  Expected: audit event with report_id and overall_assessment

test_proposal_generated_event
  Action: proposal created
  Expected: audit event with proposal_id, versions, bump type

test_constraint_violation_event
  Action: proposal rejected for tools change
  Expected: audit event with violation details

test_meta_review_completed_event
  Action: meta-review finishes
  Expected: audit event with verdict, findings_count

test_meta_review_bypassed_event
  Action: self-review bypass for agent-meta-reviewer
  Expected: audit event with type=meta_review_bypassed_self_referential

test_rate_limited_event
  Action: rate limit hit
  Expected: audit event with current_count, max_per_week

test_state_changed_event
  Action: ACTIVE -> UNDER_REVIEW
  Expected: audit event with from and to states
```
