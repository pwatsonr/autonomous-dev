#!/usr/bin/env bash
# test_backward_meta_invalid_transitions.sh -- Unit tests for SPEC-002-3-02
# Tests: backward transitions (review_fail), meta-state transitions
#        (pause, resume, fail, retry, cancel), and invalid transition rejection
#
# Requires: jq (1.6+), bash 4+
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source shared test harness
source "${SCRIPT_DIR}/../test_harness.sh"

# Source the module under test
source "${PROJECT_ROOT}/lib/state/lifecycle_engine.sh"

# =============================================================================
# Helper: Build a minimal valid state JSON at a given status
# =============================================================================
_make_state() {
  local status="$1"
  local extra="${2:-}"
  local base
  base="$(jq -n \
    --arg status "$status" \
    '{
      schema_version: 1,
      id: "REQ-20260408-a3f1",
      status: $status,
      priority: 5,
      title: "Test request",
      repository: "/tmp/repo",
      branch: "autonomous/REQ-20260408-a3f1",
      created_at: "2026-04-08T00:00:00Z",
      updated_at: "2026-04-08T00:00:00Z",
      cost_accrued_usd: 0,
      turn_count: 0,
      escalation_count: 0,
      blocked_by: [],
      phase_history: [{
        state: $status,
        entered_at: "2026-04-08T00:00:00Z",
        exited_at: null,
        session_id: null,
        turns_used: 0,
        cost_usd: 0,
        retry_count: 0,
        exit_reason: null
      }],
      current_phase_metadata: {},
      error: null,
      last_checkpoint: null,
      paused_from: null,
      paused_reason: null,
      failure_reason: null
    }')"
  if [[ -n "$extra" ]]; then
    base="$(echo "$base" | jq "$extra")"
  fi
  echo "$base"
}

TS="2026-04-08T01:00:00Z"

# =============================================================================
# Test 1: Review fail prd_review -> prd
# =============================================================================
test_review_fail_prd_review_to_prd() {
  local state result
  state="$(_make_state "prd_review")"
  result="$(state_transition "$state" "review_fail" '{"review_feedback":"fix it"}' "$TS")"
  assert_eq "prd" "$(echo "$result" | jq -r '.status')"
  assert_eq "1" "$(echo "$result" | jq '.phase_history[-1].retry_count')"
}

# =============================================================================
# Test 2: Review fail tdd_review -> tdd
# =============================================================================
test_review_fail_tdd_review_to_tdd() {
  local state result
  state="$(_make_state "tdd_review")"
  result="$(state_transition "$state" "review_fail" '{}' "$TS")"
  assert_eq "tdd" "$(echo "$result" | jq -r '.status')"
}

# =============================================================================
# Test 3: Review fail plan_review -> plan
# =============================================================================
test_review_fail_plan_review_to_plan() {
  local state result
  state="$(_make_state "plan_review")"
  result="$(state_transition "$state" "review_fail" '{}' "$TS")"
  assert_eq "plan" "$(echo "$result" | jq -r '.status')"
}

# =============================================================================
# Test 4: Review fail spec_review -> spec
# =============================================================================
test_review_fail_spec_review_to_spec() {
  local state result
  state="$(_make_state "spec_review")"
  result="$(state_transition "$state" "review_fail" '{}' "$TS")"
  assert_eq "spec" "$(echo "$result" | jq -r '.status')"
}

# =============================================================================
# Test 5: Review fail code_review -> code
# =============================================================================
test_review_fail_code_review_to_code() {
  local state result
  state="$(_make_state "code_review")"
  result="$(state_transition "$state" "review_fail" '{}' "$TS")"
  assert_eq "code" "$(echo "$result" | jq -r '.status')"
}

# =============================================================================
# Test 6: Review fail preserves feedback
# =============================================================================
test_review_fail_preserves_feedback() {
  local state result
  state="$(_make_state "prd_review")"
  result="$(state_transition "$state" "review_fail" '{"review_feedback":"needs more detail"}' "$TS")"
  assert_eq "needs more detail" "$(echo "$result" | jq -r '.current_phase_metadata.review_feedback')"
}

# =============================================================================
# Test 7: Review fail retry exhaustion -> escalate to paused
# =============================================================================
test_review_fail_retry_exhaustion() {
  local state result
  state="$(_make_state "prd_review" '.phase_history[-1].retry_count = 3')"
  # max_retries defaults to 3, retry_count=3 means exhausted
  result="$(state_transition "$state" "review_fail" '{"max_retries":3}' "$TS" 2>/dev/null)"
  assert_eq "paused" "$(echo "$result" | jq -r '.status')"
  assert_eq "prd_review" "$(echo "$result" | jq -r '.paused_from')"
  assert_eq "review_retries_exhausted" "$(echo "$result" | jq -r '.paused_reason')"
}

# =============================================================================
# Test 8: Review fail from non-review state -> error
# =============================================================================
test_review_fail_from_non_review() {
  local state exit_code=0
  state="$(_make_state "prd")"
  state_transition "$state" "review_fail" '{}' "$TS" > /dev/null 2>&1 || exit_code=$?
  assert_eq "1" "$exit_code"
}

# =============================================================================
# Test 9: Pause from active state
# =============================================================================
test_pause_from_active_state() {
  local state result
  state="$(_make_state "code")"
  result="$(state_transition "$state" "pause" '{"reason":"manual_pause"}' "$TS")"
  assert_eq "paused" "$(echo "$result" | jq -r '.status')"
  assert_eq "code" "$(echo "$result" | jq -r '.paused_from')"
}

# =============================================================================
# Test 10: Pause increments escalation_count when review-triggered
# =============================================================================
test_pause_increments_escalation() {
  local state result
  state="$(_make_state "prd_review")"
  result="$(state_transition "$state" "pause" '{"reason":"review_retries_exhausted"}' "$TS")"
  assert_eq "1" "$(echo "$result" | jq '.escalation_count')"
}

# =============================================================================
# Test 11: Pause from already paused -> error
# =============================================================================
test_pause_from_already_paused() {
  local state exit_code=0
  state="$(_make_state "paused" '.paused_from = "tdd"')"
  state_transition "$state" "pause" '{}' "$TS" > /dev/null 2>&1 || exit_code=$?
  assert_eq "1" "$exit_code"
}

# =============================================================================
# Test 12: Resume from paused
# =============================================================================
test_resume_from_paused() {
  local state result
  # Build a paused state with paused_from = "tdd" and a paused phase entry
  state="$(_make_state "paused" '.paused_from = "tdd" | .paused_reason = "manual_pause" | .phase_history = [
    {state:"tdd", entered_at:"2026-04-08T00:00:00Z", exited_at:"2026-04-08T00:30:00Z", session_id:null, turns_used:0, cost_usd:0, retry_count:0, exit_reason:"paused"},
    {state:"paused", entered_at:"2026-04-08T00:30:00Z", exited_at:null, session_id:null, turns_used:0, cost_usd:0, retry_count:0, exit_reason:null}
  ]')"
  result="$(state_transition "$state" "resume" '{}' "$TS")"
  assert_eq "tdd" "$(echo "$result" | jq -r '.status')"
  assert_eq "null" "$(echo "$result" | jq -r '.paused_from')"
  assert_eq "null" "$(echo "$result" | jq -r '.paused_reason')"
}

# =============================================================================
# Test 13: Resume from non-paused -> error
# =============================================================================
test_resume_from_non_paused() {
  local state exit_code=0
  state="$(_make_state "code")"
  state_transition "$state" "resume" '{}' "$TS" > /dev/null 2>&1 || exit_code=$?
  assert_eq "1" "$exit_code"
}

# =============================================================================
# Test 14: Fail from active state
# =============================================================================
test_fail_from_active_state() {
  local state result
  state="$(_make_state "spec")"
  result="$(state_transition "$state" "fail" '{"message":"timeout exceeded","code":"timeout","reason":"timeout"}' "$TS")"
  assert_eq "failed" "$(echo "$result" | jq -r '.status')"
  assert_eq "timeout exceeded" "$(echo "$result" | jq -r '.error.message')"
  assert_eq "timeout" "$(echo "$result" | jq -r '.error.code')"
  assert_eq "spec" "$(echo "$result" | jq -r '.error.phase')"
  assert_eq "$TS" "$(echo "$result" | jq -r '.error.timestamp')"
}

# =============================================================================
# Test 15: Retry from failed (with last_checkpoint)
# =============================================================================
test_retry_from_failed() {
  local state result
  state="$(_make_state "failed" '.last_checkpoint = "prd" | .error = {message:"err",code:"e",phase:"prd",timestamp:"T"} | .failure_reason = "err" | .phase_history = [
    {state:"prd", entered_at:"2026-04-08T00:00:00Z", exited_at:"2026-04-08T00:30:00Z", session_id:null, turns_used:0, cost_usd:0, retry_count:0, exit_reason:"error"},
    {state:"failed", entered_at:"2026-04-08T00:30:00Z", exited_at:null, session_id:null, turns_used:0, cost_usd:0, retry_count:0, exit_reason:null}
  ]')"
  result="$(state_transition "$state" "retry" '{}' "$TS")"
  assert_eq "prd" "$(echo "$result" | jq -r '.status')"
  assert_eq "null" "$(echo "$result" | jq -r '.error')"
  assert_eq "null" "$(echo "$result" | jq -r '.failure_reason')"
}

# =============================================================================
# Test 16: Retry from non-failed -> error
# =============================================================================
test_retry_from_non_failed() {
  local state exit_code=0
  state="$(_make_state "code")"
  state_transition "$state" "retry" '{}' "$TS" > /dev/null 2>&1 || exit_code=$?
  assert_eq "1" "$exit_code"
}

# =============================================================================
# Test 17: Retry without checkpoint -> error
# =============================================================================
test_retry_without_checkpoint() {
  local state exit_code=0
  state="$(_make_state "failed" '.error = {message:"e",code:"e",phase:"p",timestamp:"T"} | .phase_history = [
    {state:"failed", entered_at:"2026-04-08T00:00:00Z", exited_at:null, session_id:null, turns_used:0, cost_usd:0, retry_count:0, exit_reason:null}
  ]')"
  state_transition "$state" "retry" '{}' "$TS" > /dev/null 2>&1 || exit_code=$?
  assert_eq "1" "$exit_code"
}

# =============================================================================
# Test 18: Cancel from active state
# =============================================================================
test_cancel_from_active() {
  local state result
  state="$(_make_state "integration")"
  result="$(state_transition "$state" "cancel" '{}' "$TS")"
  assert_eq "cancelled" "$(echo "$result" | jq -r '.status')"
}

# =============================================================================
# Test 19: Cancel from failed
# =============================================================================
test_cancel_from_failed() {
  local state result
  state="$(_make_state "failed" '.error = {message:"e",code:"e",phase:"p",timestamp:"T"} | .phase_history = [
    {state:"failed", entered_at:"2026-04-08T00:00:00Z", exited_at:null, session_id:null, turns_used:0, cost_usd:0, retry_count:0, exit_reason:null}
  ]')"
  result="$(state_transition "$state" "cancel" '{}' "$TS")"
  assert_eq "cancelled" "$(echo "$result" | jq -r '.status')"
}

# =============================================================================
# Test 20: Cancel from paused
# =============================================================================
test_cancel_from_paused() {
  local state result
  state="$(_make_state "paused" '.paused_from = "tdd" | .phase_history = [
    {state:"paused", entered_at:"2026-04-08T00:00:00Z", exited_at:null, session_id:null, turns_used:0, cost_usd:0, retry_count:0, exit_reason:null}
  ]')"
  result="$(state_transition "$state" "cancel" '{}' "$TS")"
  assert_eq "cancelled" "$(echo "$result" | jq -r '.status')"
}

# =============================================================================
# Test 21: Cancelled is terminal (no further transitions)
# =============================================================================
test_cancelled_is_terminal() {
  local state exit_code=0
  state="$(_make_state "cancelled" '.phase_history = [
    {state:"cancelled", entered_at:"2026-04-08T00:00:00Z", exited_at:null, session_id:null, turns_used:0, cost_usd:0, retry_count:0, exit_reason:null}
  ]')"
  state_transition "$state" "advance" '{}' "$TS" > /dev/null 2>&1 || exit_code=$?
  assert_eq "1" "$exit_code"
}

# =============================================================================
# Test 22: Failed rejects advance
# =============================================================================
test_failed_rejects_advance() {
  local state exit_code=0
  state="$(_make_state "failed" '.error = {message:"e",code:"e",phase:"p",timestamp:"T"} | .phase_history = [
    {state:"failed", entered_at:"2026-04-08T00:00:00Z", exited_at:null, session_id:null, turns_used:0, cost_usd:0, retry_count:0, exit_reason:null}
  ]')"
  state_transition "$state" "advance" '{}' "$TS" > /dev/null 2>&1 || exit_code=$?
  assert_eq "1" "$exit_code"
}

# =============================================================================
# Test 23: Paused rejects advance
# =============================================================================
test_paused_rejects_advance() {
  local state exit_code=0
  state="$(_make_state "paused" '.paused_from = "code" | .phase_history = [
    {state:"paused", entered_at:"2026-04-08T00:00:00Z", exited_at:null, session_id:null, turns_used:0, cost_usd:0, retry_count:0, exit_reason:null}
  ]')"
  state_transition "$state" "advance" '{}' "$TS" > /dev/null 2>&1 || exit_code=$?
  assert_eq "1" "$exit_code"
}

# =============================================================================
# Test 24: No transition to intake
# Verify none of the handlers can produce status: "intake" as output.
# The only way to get to intake is initial creation, not a transition.
# =============================================================================
test_no_transition_to_intake() {
  # advance from intake goes to prd, not intake
  local state result
  state="$(_make_state "intake")"
  result="$(state_transition "$state" "advance" '{}' "$TS")"
  local next_status
  next_status="$(echo "$result" | jq -r '.status')"
  # The result should NOT be intake
  if [[ "$next_status" == "intake" ]]; then
    echo "  FAIL: advance from intake produced status=intake" >&2
    return 1
  fi
  assert_eq "prd" "$next_status"
}

# =============================================================================
# Run all tests
# =============================================================================
run_test "Review fail prd_review -> prd" test_review_fail_prd_review_to_prd
run_test "Review fail tdd_review -> tdd" test_review_fail_tdd_review_to_tdd
run_test "Review fail plan_review -> plan" test_review_fail_plan_review_to_plan
run_test "Review fail spec_review -> spec" test_review_fail_spec_review_to_spec
run_test "Review fail code_review -> code" test_review_fail_code_review_to_code
run_test "Review fail preserves feedback" test_review_fail_preserves_feedback
run_test "Review fail retry exhaustion -> paused" test_review_fail_retry_exhaustion
run_test "Review fail from non-review -> error" test_review_fail_from_non_review
run_test "Pause from active state" test_pause_from_active_state
run_test "Pause increments escalation_count" test_pause_increments_escalation
run_test "Pause from already paused -> error" test_pause_from_already_paused
run_test "Resume from paused" test_resume_from_paused
run_test "Resume from non-paused -> error" test_resume_from_non_paused
run_test "Fail from active state" test_fail_from_active_state
run_test "Retry from failed with checkpoint" test_retry_from_failed
run_test "Retry from non-failed -> error" test_retry_from_non_failed
run_test "Retry without checkpoint -> error" test_retry_without_checkpoint
run_test "Cancel from active state" test_cancel_from_active
run_test "Cancel from failed" test_cancel_from_failed
run_test "Cancel from paused" test_cancel_from_paused
run_test "Cancelled is terminal" test_cancelled_is_terminal
run_test "Failed rejects advance" test_failed_rejects_advance
run_test "Paused rejects advance" test_paused_rejects_advance
run_test "No transition to intake" test_no_transition_to_intake

report
