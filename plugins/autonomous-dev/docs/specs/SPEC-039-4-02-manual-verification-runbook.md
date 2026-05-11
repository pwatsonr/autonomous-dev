# SPEC-039-4-02: Manual verification runbook

## Metadata
- **Parent Plan**: PLAN-039
- **Parent TDD**: TDD-038
- **Parent PRD**: PRD-019
- **Tasks Covered**: PLAN-039 TASK-022
- **Dependencies**: SPEC-039-4-01
- **Estimated effort**: 2 hours
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-11

## Objective

Produce a manual-verification runbook that an operator follows after the implementation lands and before declaring PLAN-039 done. Covers a real end-to-end submit, daemon advancement, portal observation, and at least one gate interaction. Validates the smoke test's assertions hold under real conditions (live Anthropic API, real agents writing real artifacts).

## Acceptance Criteria

1. Runbook lives at `plugins/autonomous-dev/docs/manual_verification/PLAN-039-e2e-pipeline-verification.md`.
2. Steps are reproducible: a new operator with no prior context can follow and reach a green outcome.
3. Each step has expected output that the operator visually compares.
4. Failure modes documented inline (what to check if step N fails).
5. Runbook ends with a "PLAN-039 GREEN" checklist mapped to all 20 AC-038-NN items.

## Implementation

**Files created**
- `plugins/autonomous-dev/docs/manual_verification/PLAN-039-e2e-pipeline-verification.md`

**Runbook outline**
```markdown
# PLAN-039 — Manual E2E verification

## Preconditions
- [ ] Daemon running: `autonomous-dev daemon status` → healthy
- [ ] Portal serving: `curl -sf http://127.0.0.1:19280/health`
- [ ] Test repo cloned at $TEST_REPO, on a fresh feature branch
- [ ] ANTHROPIC_API_KEY in env (real-API run)

## Step 1 — submit
Command:
  autonomous-dev request submit "Add hello world to README" --repo $TEST_REPO --type feature
Expected: stdout contains "Request REQ-NNNNNN queued"
Check: `sqlite3 ~/.autonomous-dev/intake.db "SELECT request_id, status, current_phase FROM requests ORDER BY created_at DESC LIMIT 1"` → status=queued, current_phase=intake.
Check: `cat $TEST_REPO/.autonomous-dev/requests/REQ-*/state.json` exists.

## Step 2 — daemon picks up
Wait up to ~10s. Re-query SQLite: status=running, current_phase=prd.
Check events.jsonl for `intake_to_prd` event.

## Step 3 — PRD phase
Wait up to 5 minutes. Check `$TEST_REPO/docs/prd/*.md` exists.
Check state.json `current_phase=prd_review, status=gate`.
Check portal `~/.autonomous-dev/portal/request-actions/REQ-*.json` shows status=gate, waitedMin increasing.

## Step 4 — gate approval
Use the portal UI (or CLI) to approve. Daemon should advance to tdd phase.

## Step 5..8 — TDD, Plan, Spec, Code phases
[Follow similar pattern; expected artifacts under docs/tdd/, docs/plans/, docs/specs/, and a PR.]

## Step 9 — Final PR
Check `gh pr list --head 'autonomous/REQ-NNNNNN'` returns one open PR linked to the request.

## Step 10 — Failure-path drill (optional but recommended)
Force a review failure 3x; observe state machine transition to `status=failed`.

## PLAN-039 GREEN checklist
- [ ] AC-038-01..03 verified via Step 1
- [ ] AC-038-05..09 verified via Steps 1-3
- [ ] AC-038-10..14 verified via Steps 3-8
- [ ] AC-038-16 verified via Step 3 (portal file presence)
- [ ] AC-038-19 verified via Step 9 (PR created)
- [ ] All open questions OQ-039-1..6 resolved
```

## Tests

None — this is a runbook for human execution. The output of executing the runbook (filled-in checklist + any captured logs) is the verification artifact.

## Verification

- The runbook itself is verified by running it end-to-end at least once before PLAN-039 is closed.
- Operator records date, version, any deviations as appendix entries.
