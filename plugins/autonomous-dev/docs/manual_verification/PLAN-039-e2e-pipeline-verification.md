# PLAN-039 Manual End-to-End Pipeline Verification

This runbook validates the complete intake-to-deploy pipeline under real conditions with live Anthropic API. Execute this checklist after PLAN-039 implementation before declaring the feature complete.

## Prerequisites

- [ ] Daemon is running and healthy: `autonomous-dev daemon status`
- [ ] Portal is accessible: `curl -sf http://127.0.0.1:19280/health` (if portal is configured)
- [ ] Test repository available with write access
- [ ] `ANTHROPIC_API_KEY` environment variable set with valid API key
- [ ] Real `claude` CLI available on PATH (not mock)

## Environment Setup

```bash
export TEST_REPO=/path/to/test/repository
export ANTHROPIC_API_KEY=sk-ant-...
cd $TEST_REPO
git checkout -b test-plan-039-$(date +%Y%m%d)
```

## Step 1 - Submit Request

**Command:**
```bash
autonomous-dev request submit "Add hello world functionality to README" --repo "$TEST_REPO" --type feature
```

**Expected Output:**
```
Request REQ-NNNNNN submitted successfully
Status: queued
```

**Verification:**
```bash
# Check SQLite record
sqlite3 ~/.autonomous-dev/intake.db "SELECT request_id, status, current_phase FROM requests ORDER BY created_at DESC LIMIT 1"
# Should show: REQ-NNNNNN|queued|intake

# Check state.json exists
ls "$TEST_REPO/.autonomous-dev/requests/REQ-*/state.json"
```

**If this fails:** Check CLI adapter installation, auth config, repository permissions.

## Step 2 - Daemon Auto-Transition

**Wait:** Up to 30 seconds for daemon pickup

**Command:**
```bash
sqlite3 ~/.autonomous-dev/intake.db "SELECT request_id, status, current_phase FROM requests WHERE request_id='REQ-NNNNNN'"
```

**Expected:**
```
REQ-NNNNNN|running|prd
```

**Verification:**
```bash
# Check daemon logs for intake transition
tail -10 ~/.autonomous-dev/logs/daemon.log | grep "intake_to_prd"
```

**If this fails:** Check daemon is running, repository allowlist, no kill switch.

## Step 3 - PRD Phase Execution

**Wait:** Up to 5 minutes for PRD generation

**Expected Artifacts:**
- `$TEST_REPO/docs/prd/*.md` - Product Requirements Document
- State: `current_phase=prd_review`, `status=gate`

**Command:**
```bash
# Check PRD artifact
ls "$TEST_REPO/docs/prd/"

# Check state transition to review
jq '.current_phase, .status' "$TEST_REPO/.autonomous-dev/requests/REQ-*/state.json"
```

**Expected Output:**
```
"prd_review"
"gate"
```

**Portal Verification (if configured):**
```bash
# Check portal request action
ls ~/.autonomous-dev/request-actions/REQ-*.json

# Check waitedMin is increasing
jq '.phase, .status, .waitedMin' ~/.autonomous-dev/request-actions/REQ-*.json
```

**If this fails:** Check agent dispatch, claude CLI availability, API key validity, budget limits.

## Step 4 - Gate Approval

> **Note:** Gate approval mechanism depends on implementation. Update this step based on actual portal/CLI integration.

**Manual Approval (Portal UI):**
1. Navigate to portal at `http://127.0.0.1:19280` 
2. Find request REQ-NNNNNN in pending approvals
3. Review PRD content
4. Click "Approve"

**Alternative (CLI - if implemented):**
```bash
autonomous-dev request approve REQ-NNNNNN
```

**Verification:**
```bash
# State should advance to tdd phase
jq '.current_phase, .status' "$TEST_REPO/.autonomous-dev/requests/REQ-*/state.json"
# Expected: "tdd", "running"
```

**If this fails:** Check portal connectivity, gate approval implementation, user permissions.

## Step 5 - TDD Phase

**Wait:** Up to 5 minutes for TDD generation

**Expected Artifacts:**
- `$TEST_REPO/docs/tdd/*.md` - Technical Design Document
- State: `current_phase=tdd_review`, `status=gate`

**Verification:**
```bash
ls "$TEST_REPO/docs/tdd/"
jq '.current_phase, .status' "$TEST_REPO/.autonomous-dev/requests/REQ-*/state.json"
```

**If this fails:** Check similar issues as Step 3.

## Step 6 - Plan Phase

**After TDD approval, wait:** Up to 5 minutes

**Expected Artifacts:**
- `$TEST_REPO/docs/plans/*.md` - Implementation Plan
- State: `current_phase=plan_review`, `status=gate`

**Verification:**
```bash
ls "$TEST_REPO/docs/plans/"
jq '.current_phase, .status' "$TEST_REPO/.autonomous-dev/requests/REQ-*/state.json"
```

## Step 7 - Spec Phase

**After Plan approval, wait:** Up to 5 minutes

**Expected Artifacts:**
- `$TEST_REPO/docs/specs/*.md` - Implementation Specifications
- State: `current_phase=spec_review`, `status=gate`

**Verification:**
```bash
ls "$TEST_REPO/docs/specs/"
jq '.current_phase, .status' "$TEST_REPO/.autonomous-dev/requests/REQ-*/state.json"
```

## Step 8 - Code Phase

**After Spec approval, wait:** Up to 10 minutes

**Expected Artifacts:**
- Code changes in working tree
- State: `current_phase=code_review`, `status=gate`

**Verification:**
```bash
git status  # Should show modified/added files
git diff    # Should show hello world implementation
jq '.current_phase, .status' "$TEST_REPO/.autonomous-dev/requests/REQ-*/state.json"
```

## Step 9 - Final PR Creation

**After Code review approval:**

**Expected:**
- Pull request created with `autonomous/REQ-NNNNNN` branch
- State: `current_phase=done`, `status=done`

**Verification:**
```bash
gh pr list --head "autonomous/REQ-NNNNNN"
# Should show one open PR

jq '.current_phase, .status' "$TEST_REPO/.autonomous-dev/requests/REQ-*/state.json"
# Expected: "done", "done"
```

## Step 10 - Failure Path Verification (Optional)

Test retry mechanism by forcing failures:

**Setup:**
```bash
autonomous-dev request submit "Intentionally broken request for testing retry logic" --repo "$TEST_REPO" --type feature
```

**Force Failure:** Modify agent prompts or temporarily break API access to cause 3 consecutive failures

**Expected Result:**
- After 3 retries, state should be `status=failed`
- Error message in `state.json` should indicate max retries exceeded

## PLAN-039 GREEN Checklist

Map to PRD-019 Acceptance Criteria:

- [ ] **AC-038-01**: CLI submission creates SQLite row ✓ (Step 1)
- [ ] **AC-038-02**: state.json file created with correct schema ✓ (Step 1)
- [ ] **AC-038-03**: Daemon picks up queued requests ✓ (Step 2)
- [ ] **AC-038-05**: Auto-transition intake→prd ✓ (Step 2)
- [ ] **AC-038-06**: PRD phase produces markdown artifact ✓ (Step 3)
- [ ] **AC-038-07**: Review phases enter gate status ✓ (Step 3)
- [ ] **AC-038-08**: Gate approval advances to next phase ✓ (Step 4)
- [ ] **AC-038-09**: TDD phase produces artifact ✓ (Step 5)
- [ ] **AC-038-10**: Plan phase produces artifact ✓ (Step 6)
- [ ] **AC-038-11**: Spec phase produces artifact ✓ (Step 7)
- [ ] **AC-038-12**: Code phase modifies working tree ✓ (Step 8)
- [ ] **AC-038-13**: Each phase respects budget limits ✓ (All steps)
- [ ] **AC-038-14**: Retry mechanism works on failures ✓ (Step 10)
- [ ] **AC-038-16**: Portal sync files created ✓ (Step 3)
- [ ] **AC-038-17**: Cost tracking accumulates correctly ✓ (All steps)
- [ ] **AC-038-18**: State transitions logged ✓ (All steps)
- [ ] **AC-038-19**: Final PR created ✓ (Step 9)

## Execution Log

**Date:** ___________  
**Operator:** ___________  
**Version:** ___________  

**Results:**
- Total time: _____ minutes
- Total cost: $_____ USD
- Issues encountered: 

**Sign-off:**
- [ ] All steps completed successfully
- [ ] All artifacts verified
- [ ] No blocking issues found
- [ ] PLAN-039 ready for production

**Notes:**
[Space for additional observations, deviations from expected behavior, or recommendations for improvement]