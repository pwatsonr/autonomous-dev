# SPEC-005-4-4: Human-Approved Promotion and Rejection Workflows

## Metadata
- **Parent Plan**: PLAN-005-4
- **Tasks Covered**: Task 9 (Human-approved promotion workflow), Task 10 (Rejection workflow)
- **Estimated effort**: 11 hours

## Description

Implement the promotion workflow that writes a validated agent improvement to disk, commits it to git with conventional commit messages, and reloads the registry, and the rejection workflow that cleanly returns an agent to ACTIVE state. These complete the Phase 2 improvement lifecycle: a human operator reviews the A/B results and approves or rejects the change.

## Files to Create/Modify

### New Files

**`src/agent-factory/promotion/promoter.ts`**
- Exports: `Promoter` class with `promote(agentName: string, proposalId: string): PromotionResult`

**`src/agent-factory/promotion/rejector.ts`**
- Exports: `Rejector` class with `reject(agentName: string, proposalId: string, reason: string): RejectionResult`

## Implementation Details

### Promotion Workflow (`promotion/promoter.ts`)

```typescript
interface PromotionResult {
  success: boolean;
  agentName: string;
  previousVersion: string;
  newVersion: string;
  commitHash: string;
  error?: string;
}
```

**Promotion steps:**

**Step 1: Validate prerequisites**
- Proposal must exist and have status `validated_positive` (or `meta_approved` for self-review bypassed proposals).
- Agent must be in state `VALIDATING` (or `UNDER_REVIEW` for bypassed).
- Proposal must belong to the specified agent.

**Step 2: Present review summary to operator**
Display the following for human review before proceeding:
```
Promotion Review: {agent_name} ({current_version} -> {proposed_version})
═══════════════════════════════════════════════════════════════

Weakness Report Summary:
  Assessment: {overall_assessment}
  Weaknesses: {count} ({dimensions})

Meta-Review:
  Verdict: {verdict}
  Findings: {count} ({blockers} blockers, {warnings} warnings)

A/B Validation Results:
  Verdict: {verdict}
  Proposed wins: {N}/{total} inputs
  Mean quality delta: {delta}
  
  Per-Input Breakdown:
  | Input | Domain | Current | Proposed | Delta | Winner |
  |-------|--------|---------|----------|-------|--------|
  {for each ABInput}

  Per-Dimension Summary:
  | Dimension | Mean Delta | Improved? |
  |-----------|-----------|-----------|
  {for each dimension}

Diff:
{unified diff}
```

**Step 3: Write new agent definition**
- Write the `proposed_definition` from the proposal to `agents/<name>.md`.
- The proposed definition already has the updated `version` and `version_history` fields.

**Step 4: Commit to git**

Commit message follows semver conventions (TDD 3.6.2):

```
# For minor and major bumps:
feat(agents): update {name} v{old} -> v{new} -- {rationale}

# For patch bumps:
fix(agents): update {name} v{old} -> v{new} -- {rationale}
```

Where `{rationale}` is a one-line summary derived from the weakness report's primary weakness.

Git commands:
```bash
git add agents/{name}.md
git commit -m "{message}"
```

**Step 5: Reload registry**
- Call `registry.reload()`.
- Verify the new version is loaded: `registry.get(name).agent.version === newVersion`.

**Step 6: Update state and records**
- Update proposal status to `promoted`.
- Transition agent state: VALIDATING -> PROMOTED -> ACTIVE (two transitions, PROMOTED is transient).
- Reset observation tracker for the agent: `observationTracker.resetForPromotion(name, newVersion)`.
- Log `agent_promoted` event to audit log with both versions, commit hash, proposal_id.
- Emit promotion metric event.

**Step 7: Error handling**
- If git commit fails (e.g., conflict): abort, restore original file, agent stays at current state.
- If registry reload fails after commit: log critical error (file is committed but registry is stale). Operator must manually reload.

### Rejection Workflow (`promotion/rejector.ts`)

```typescript
interface RejectionResult {
  success: boolean;
  agentName: string;
  version: string;
  reason: string;
  proposalId: string;
}
```

**Rejection steps:**

1. **Validate**: Proposal must exist. Agent must be in `UNDER_REVIEW` or `VALIDATING` state.
2. **Update proposal**: Set status to `rejected`.
3. **Transition agent state**: UNDER_REVIEW/VALIDATING -> ACTIVE (current version continues).
4. **Reset observation tracker**: The agent's observation counter resets, so a new cycle of invocations is needed before the next analysis.
5. **Log**: `agent_proposal_rejected` event to audit log with proposal_id, agent_name, reason.
6. **Emit metric**: Rejection metric event to metrics engine.

**Auto-rejection on negative A/B:**
- When A/B validation produces a `negative` verdict, the rejection is automatic (no human action needed).
- The orchestrator calls `reject()` directly.
- Status transition: `validated_negative` -> `rejected`.

## Acceptance Criteria

1. Promotion writes new agent definition to `.md` file.
2. `version` and `version_history` updated in the committed file.
3. Commit message uses `feat(agents):` for minor/major, `fix(agents):` for patch.
4. Registry reloaded after promotion; new version is active.
5. Observation tracker reset after promotion.
6. Proposal status updated to `promoted`.
7. Agent state transitions: VALIDATING -> PROMOTED -> ACTIVE.
8. Audit log records `agent_promoted` event.
9. Git commit failure does not leave agent in inconsistent state.
10. Rejection updates proposal status to `rejected`.
11. Rejection transitions agent back to ACTIVE.
12. Rejection reason logged to audit log.
13. Negative A/B verdict triggers automatic rejection.

## Test Cases

### Promotion Tests

```
test_promote_writes_file
  Action: promote("code-executor", proposalId)
  Expected: agents/code-executor.md contains proposed definition

test_promote_version_updated
  Setup: current v1.0.0, proposed v1.0.1
  Expected: file has version: "1.0.1" in frontmatter

test_promote_version_history_updated
  Expected: version_history includes entry for v1.0.1

test_promote_commit_message_patch
  Setup: patch bump (1.0.0 -> 1.0.1)
  Expected: commit message starts with "fix(agents):"

test_promote_commit_message_minor
  Setup: minor bump (1.0.0 -> 1.1.0)
  Expected: commit message starts with "feat(agents):"

test_promote_commit_message_major
  Setup: major bump (1.0.0 -> 2.0.0)
  Expected: commit message starts with "feat(agents):"

test_promote_registry_reloaded
  Action: promote
  Expected: registry.get("code-executor").agent.version === "1.0.1"

test_promote_observation_reset
  Action: promote
  Expected: observationTracker invocations_since_promotion = 0

test_promote_proposal_status
  Action: promote
  Expected: proposal.status === "promoted"

test_promote_state_transition
  Action: promote
  Expected: agent state goes from VALIDATING to ACTIVE

test_promote_audit_log
  Action: promote
  Expected: audit log has agent_promoted event

test_promote_prerequisite_check
  Setup: proposal status = "pending_meta_review"
  Action: promote
  Expected: error "Proposal must be validated_positive"

test_promote_wrong_agent_check
  Setup: proposal for "prd-author", attempt promote "code-executor"
  Expected: error "Proposal does not belong to this agent"

test_promote_git_failure_rollback
  Setup: simulate git commit failure
  Expected: original file restored, agent state unchanged, error returned

test_promote_includes_rationale
  Expected: commit message includes one-line rationale from weakness report
```

### Rejection Tests

```
test_reject_updates_status
  Action: reject("code-executor", proposalId, "Quality regression in python domain")
  Expected: proposal.status === "rejected"

test_reject_returns_to_active
  Setup: agent in VALIDATING state
  Action: reject
  Expected: agent state = ACTIVE

test_reject_from_under_review
  Setup: agent in UNDER_REVIEW state
  Action: reject
  Expected: agent state = ACTIVE

test_reject_resets_observation
  Action: reject
  Expected: observation counter reset

test_reject_logs_reason
  Action: reject with reason "Quality regression"
  Expected: audit log has agent_proposal_rejected with reason field

test_auto_reject_on_negative_ab
  Setup: A/B validation produces negative verdict
  Expected: reject() called automatically

test_reject_nonexistent_proposal
  Action: reject with invalid proposalId
  Expected: error returned

test_reject_emits_metric
  Action: reject
  Expected: rejection metric event recorded
```

### Integration Tests

```
test_full_promotion_cycle
  Setup: create proposal -> meta-approve -> A/B validate (positive) -> promote
  Expected: agent file updated, git commit created, registry reloaded, new version active

test_full_rejection_cycle
  Setup: create proposal -> meta-approve -> A/B validate (negative) -> auto-reject
  Expected: proposal rejected, agent returns to ACTIVE

test_promotion_then_new_observation
  Setup: promote v1.0.1
  Action: record 10 new invocations
  Expected: observation counter reaches threshold for v1.0.1
```
