#!/usr/bin/env bash
# test_lifecycle_transitions.sh -- Unit tests for SPEC-002-3-05 (Task 11)
# Tests all 30 valid transitions: 13 forward, 5 backward, 12 meta-state.
# Each test constructs a state fixture, applies a transition, and verifies
# the output state including phase history mutations and side effects.
#
# Requires: jq (1.6+), bash 4+
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source shared test harness
source "${SCRIPT_DIR}/../test_harness.sh"

# Source the fixture builder
source "${SCRIPT_DIR}/../fixtures/state_builder.sh"

# Source the module under test
source "${PROJECT_ROOT}/lib/state/lifecycle_engine.sh"

# Common timestamp for transitions
TS="2026-04-08T10:00:00Z"

###############################################################################
# Helper: Assert common forward transition properties
###############################################################################
_assert_forward_transition() {
  local result="$1"
  local expected_status="$2"
  local expected_exit_reason="$3"
  local expected_prev_status="$4"

  # Correct to_state
  assert_eq "$expected_status" "$(echo "$result" | jq -r '.status')" \
    "status should be ${expected_status}"

  # Previous phase history entry has exited_at set
  local prev_exit
  prev_exit="$(echo "$result" | jq -r '.phase_history[-2].exited_at')"
  assert_eq "$TS" "$prev_exit" "previous entry exited_at should be set"

  # Previous entry has correct exit_reason
  local prev_reason
  prev_reason="$(echo "$result" | jq -r '.phase_history[-2].exit_reason')"
  assert_eq "$expected_exit_reason" "$prev_reason" \
    "previous entry exit_reason should be ${expected_exit_reason}"

  # New entry has entered_at set, null exited_at, zero retry_count
  assert_eq "$TS" "$(echo "$result" | jq -r '.phase_history[-1].entered_at')" \
    "new entry entered_at should be timestamp"
  assert_eq "null" "$(echo "$result" | jq -r '.phase_history[-1].exited_at')" \
    "new entry exited_at should be null"
  assert_eq "0" "$(echo "$result" | jq '.phase_history[-1].retry_count')" \
    "new entry retry_count should be 0"

  # last_checkpoint updated to previous status
  assert_eq "$expected_prev_status" "$(echo "$result" | jq -r '.last_checkpoint')" \
    "last_checkpoint should be ${expected_prev_status}"

  # updated_at updated
  assert_eq "$TS" "$(echo "$result" | jq -r '.updated_at')" \
    "updated_at should be timestamp"
}

###############################################################################
# Forward Transitions (13 tests)
###############################################################################

# =============================================================================
# Test 1: advance intake -> prd
# =============================================================================
test_advance_intake_to_prd() {
  local state result old_len new_len
  state="$(build_state --status intake)"
  old_len="$(echo "$state" | jq '.phase_history | length')"
  result="$(state_transition "$state" "advance" '{}' "$TS")"
  new_len="$(echo "$result" | jq '.phase_history | length')"
  _assert_forward_transition "$result" "prd" "completed" "intake"
  assert_eq "$(( old_len + 1 ))" "$new_len" "phase history should grow by 1"
}

# =============================================================================
# Test 2: advance prd -> prd_review
# =============================================================================
test_advance_prd_to_prd_review() {
  local state result old_len new_len
  state="$(build_state --status prd)"
  old_len="$(echo "$state" | jq '.phase_history | length')"
  result="$(state_transition "$state" "advance" '{}' "$TS")"
  new_len="$(echo "$result" | jq '.phase_history | length')"
  _assert_forward_transition "$result" "prd_review" "completed" "prd"
  assert_eq "$(( old_len + 1 ))" "$new_len" "phase history should grow by 1"
}

# =============================================================================
# Test 3: advance prd_review -> tdd (exit_reason: review_pass)
# =============================================================================
test_advance_prd_review_to_tdd() {
  local state result
  state="$(build_state --status prd_review)"
  result="$(state_transition "$state" "advance" '{}' "$TS")"
  _assert_forward_transition "$result" "tdd" "review_pass" "prd_review"
}

# =============================================================================
# Test 4: advance tdd -> tdd_review
# =============================================================================
test_advance_tdd_to_tdd_review() {
  local state result
  state="$(build_state --status tdd)"
  result="$(state_transition "$state" "advance" '{}' "$TS")"
  _assert_forward_transition "$result" "tdd_review" "completed" "tdd"
}

# =============================================================================
# Test 5: advance tdd_review -> plan (exit_reason: review_pass)
# =============================================================================
test_advance_tdd_review_to_plan() {
  local state result
  state="$(build_state --status tdd_review)"
  result="$(state_transition "$state" "advance" '{}' "$TS")"
  _assert_forward_transition "$result" "plan" "review_pass" "tdd_review"
}

# =============================================================================
# Test 6: advance plan -> plan_review
# =============================================================================
test_advance_plan_to_plan_review() {
  local state result
  state="$(build_state --status plan)"
  result="$(state_transition "$state" "advance" '{}' "$TS")"
  _assert_forward_transition "$result" "plan_review" "completed" "plan"
}

# =============================================================================
# Test 7: advance plan_review -> spec (exit_reason: review_pass)
# =============================================================================
test_advance_plan_review_to_spec() {
  local state result
  state="$(build_state --status plan_review)"
  result="$(state_transition "$state" "advance" '{}' "$TS")"
  _assert_forward_transition "$result" "spec" "review_pass" "plan_review"
}

# =============================================================================
# Test 8: advance spec -> spec_review
# =============================================================================
test_advance_spec_to_spec_review() {
  local state result
  state="$(build_state --status spec)"
  result="$(state_transition "$state" "advance" '{}' "$TS")"
  _assert_forward_transition "$result" "spec_review" "completed" "spec"
}

# =============================================================================
# Test 9: advance spec_review -> code (exit_reason: review_pass)
# =============================================================================
test_advance_spec_review_to_code() {
  local state result
  state="$(build_state --status spec_review)"
  result="$(state_transition "$state" "advance" '{}' "$TS")"
  _assert_forward_transition "$result" "code" "review_pass" "spec_review"
}

# =============================================================================
# Test 10: advance code -> code_review
# =============================================================================
test_advance_code_to_code_review() {
  local state result
  state="$(build_state --status code)"
  result="$(state_transition "$state" "advance" '{}' "$TS")"
  _assert_forward_transition "$result" "code_review" "completed" "code"
}

# =============================================================================
# Test 11: advance code_review -> integration (exit_reason: review_pass)
# =============================================================================
test_advance_code_review_to_integration() {
  local state result
  state="$(build_state --status code_review)"
  result="$(state_transition "$state" "advance" '{}' "$TS")"
  _assert_forward_transition "$result" "integration" "review_pass" "code_review"
}

# =============================================================================
# Test 12: advance integration -> deploy
# =============================================================================
test_advance_integration_to_deploy() {
  local state result
  state="$(build_state --status integration)"
  result="$(state_transition "$state" "advance" '{}' "$TS")"
  _assert_forward_transition "$result" "deploy" "completed" "integration"
}

# =============================================================================
# Test 13: advance deploy -> monitor
# =============================================================================
test_advance_deploy_to_monitor() {
  local state result
  state="$(build_state --status deploy)"
  result="$(state_transition "$state" "advance" '{}' "$TS")"
  _assert_forward_transition "$result" "monitor" "completed" "deploy"
}

###############################################################################
# Backward Transitions (5 tests)
###############################################################################

# Helper: Assert common backward transition properties
_assert_backward_transition() {
  local result="$1"
  local expected_status="$2"
  local expected_retry_count="$3"

  assert_eq "$expected_status" "$(echo "$result" | jq -r '.status')" \
    "status should be ${expected_status}"
  assert_eq "$expected_retry_count" "$(echo "$result" | jq '.phase_history[-1].retry_count')" \
    "retry_count should be ${expected_retry_count}"

  # Previous (review) entry should have exit_reason: review_fail
  assert_eq "review_fail" "$(echo "$result" | jq -r '.phase_history[-2].exit_reason')" \
    "review entry exit_reason should be review_fail"
  assert_eq "$TS" "$(echo "$result" | jq -r '.phase_history[-2].exited_at')" \
    "review entry exited_at should be timestamp"
}

# =============================================================================
# Test 14: review_fail prd_review -> prd
# =============================================================================
test_review_fail_prd_review_to_prd() {
  local state result
  state="$(build_state --status prd_review)"
  result="$(state_transition "$state" "review_fail" '{"review_feedback":"needs more detail"}' "$TS")"
  _assert_backward_transition "$result" "prd" "1"
  # Verify review_feedback preserved
  assert_eq "needs more detail" "$(echo "$result" | jq -r '.current_phase_metadata.review_feedback')"
}

# =============================================================================
# Test 15: review_fail tdd_review -> tdd
# =============================================================================
test_review_fail_tdd_review_to_tdd() {
  local state result
  state="$(build_state --status tdd_review)"
  result="$(state_transition "$state" "review_fail" '{"review_feedback":"incomplete design"}' "$TS")"
  _assert_backward_transition "$result" "tdd" "1"
  assert_eq "incomplete design" "$(echo "$result" | jq -r '.current_phase_metadata.review_feedback')"
}

# =============================================================================
# Test 16: review_fail plan_review -> plan
# =============================================================================
test_review_fail_plan_review_to_plan() {
  local state result
  state="$(build_state --status plan_review)"
  result="$(state_transition "$state" "review_fail" '{"review_feedback":"rework estimates"}' "$TS")"
  _assert_backward_transition "$result" "plan" "1"
  assert_eq "rework estimates" "$(echo "$result" | jq -r '.current_phase_metadata.review_feedback')"
}

# =============================================================================
# Test 17: review_fail spec_review -> spec
# =============================================================================
test_review_fail_spec_review_to_spec() {
  local state result
  state="$(build_state --status spec_review)"
  result="$(state_transition "$state" "review_fail" '{"review_feedback":"missing edge cases"}' "$TS")"
  _assert_backward_transition "$result" "spec" "1"
  assert_eq "missing edge cases" "$(echo "$result" | jq -r '.current_phase_metadata.review_feedback')"
}

# =============================================================================
# Test 18: review_fail code_review -> code
# =============================================================================
test_review_fail_code_review_to_code() {
  local state result
  state="$(build_state --status code_review)"
  result="$(state_transition "$state" "review_fail" '{"review_feedback":"fix linting errors"}' "$TS")"
  _assert_backward_transition "$result" "code" "1"
  assert_eq "fix linting errors" "$(echo "$result" | jq -r '.current_phase_metadata.review_feedback')"
}

###############################################################################
# Meta-State Transitions (12 tests)
###############################################################################

# =============================================================================
# Test 19: pause from active state (prd -> paused, paused_from set)
# =============================================================================
test_pause_from_active() {
  local state result
  state="$(build_state --status prd)"
  result="$(state_transition "$state" "pause" '{"reason":"manual_pause"}' "$TS")"
  assert_eq "paused" "$(echo "$result" | jq -r '.status')"
  assert_eq "prd" "$(echo "$result" | jq -r '.paused_from')"
  assert_eq "manual_pause" "$(echo "$result" | jq -r '.paused_reason')"
  assert_eq "$TS" "$(echo "$result" | jq -r '.updated_at')"
  # Previous entry (prd) should be closed with exit_reason: paused
  assert_eq "paused" "$(echo "$result" | jq -r '.phase_history[-2].exit_reason')"
}

# =============================================================================
# Test 20: pause from review state (prd_review -> paused)
# =============================================================================
test_pause_from_review() {
  local state result
  state="$(build_state --status prd_review)"
  result="$(state_transition "$state" "pause" '{"reason":"manual_pause"}' "$TS")"
  assert_eq "paused" "$(echo "$result" | jq -r '.status')"
  assert_eq "prd_review" "$(echo "$result" | jq -r '.paused_from')"
}

# =============================================================================
# Test 21: pause with escalation count increment (review-triggered)
# =============================================================================
test_pause_escalation_count() {
  local state result
  state="$(build_state --status prd_review --escalation-count 1)"
  result="$(state_transition "$state" "pause" '{"reason":"review_retries_exhausted"}' "$TS")"
  assert_eq "paused" "$(echo "$result" | jq -r '.status')"
  assert_eq "2" "$(echo "$result" | jq '.escalation_count')" \
    "escalation_count should be incremented"
}

# =============================================================================
# Test 22: resume from paused (paused -> prd, paused_from cleared)
# =============================================================================
test_resume_from_paused() {
  local state result
  state="$(build_state --status paused --paused-from prd --paused-reason manual_pause)"
  result="$(state_transition "$state" "resume" '{}' "$TS")"
  assert_eq "prd" "$(echo "$result" | jq -r '.status')"
  assert_eq "null" "$(echo "$result" | jq -r '.paused_from')"
  assert_eq "null" "$(echo "$result" | jq -r '.paused_reason')"
  assert_eq "$TS" "$(echo "$result" | jq -r '.updated_at')"
  # Paused entry should be closed
  assert_eq "completed" "$(echo "$result" | jq -r '.phase_history[-2].exit_reason')"
}

# =============================================================================
# Test 23: fail from active state (code -> failed, error populated)
# =============================================================================
test_fail_from_active() {
  local state result
  state="$(build_state --status code)"
  result="$(state_transition "$state" "fail" '{"reason":"session_crash","message":"Agent crashed","code":"session_crash"}' "$TS")"
  assert_eq "failed" "$(echo "$result" | jq -r '.status')"
  assert_eq "session_crash" "$(echo "$result" | jq -r '.failure_reason')"
  assert_eq "Agent crashed" "$(echo "$result" | jq -r '.error.message')"
  assert_eq "session_crash" "$(echo "$result" | jq -r '.error.code')"
  assert_eq "code" "$(echo "$result" | jq -r '.error.phase')"
  assert_eq "$TS" "$(echo "$result" | jq -r '.error.timestamp')"
  # Previous entry (code) should be closed with exit_reason: error
  assert_eq "error" "$(echo "$result" | jq -r '.phase_history[-2].exit_reason')"
}

# =============================================================================
# Test 24: fail from review state (tdd_review -> failed)
# =============================================================================
test_fail_from_review() {
  local state result
  state="$(build_state --status tdd_review)"
  result="$(state_transition "$state" "fail" '{"reason":"unexpected_error","message":"Review timeout","code":"timeout"}' "$TS")"
  assert_eq "failed" "$(echo "$result" | jq -r '.status')"
  assert_eq "tdd_review" "$(echo "$result" | jq -r '.error.phase')"
}

# =============================================================================
# Test 25: retry from failed (failed -> checkpoint state, error cleared)
# =============================================================================
test_retry_from_failed() {
  local state result
  state="$(build_state --status failed --last-checkpoint code)"
  result="$(state_transition "$state" "retry" '{}' "$TS")"
  assert_eq "code" "$(echo "$result" | jq -r '.status')"
  assert_eq "null" "$(echo "$result" | jq '.error')"
  assert_eq "null" "$(echo "$result" | jq -r '.failure_reason')"
  assert_eq "$TS" "$(echo "$result" | jq -r '.updated_at')"
  # Failed entry should be closed
  assert_eq "completed" "$(echo "$result" | jq -r '.phase_history[-2].exit_reason')"
}

# =============================================================================
# Test 26: retry resets retry counter
# =============================================================================
test_retry_resets_counter() {
  local state result
  state="$(build_state --status failed --last-checkpoint prd --retry-count 2)"
  result="$(state_transition "$state" "retry" '{}' "$TS")"
  assert_eq "prd" "$(echo "$result" | jq -r '.status')"
  assert_eq "0" "$(echo "$result" | jq '.phase_history[-1].retry_count')" \
    "retry_count should be reset to 0"
}

# =============================================================================
# Test 27: cancel from active state (spec -> cancelled)
# =============================================================================
test_cancel_from_active() {
  local state result
  state="$(build_state --status spec)"
  result="$(state_transition "$state" "cancel" '{}' "$TS")"
  assert_eq "cancelled" "$(echo "$result" | jq -r '.status')"
  assert_eq "$TS" "$(echo "$result" | jq -r '.updated_at')"
  # Previous entry (spec) should be closed with exit_reason: cancelled
  assert_eq "cancelled" "$(echo "$result" | jq -r '.phase_history[-2].exit_reason')"
}

# =============================================================================
# Test 28: cancel from failed state (failed -> cancelled)
# =============================================================================
test_cancel_from_failed() {
  local state result
  state="$(build_state --status failed --last-checkpoint code)"
  result="$(state_transition "$state" "cancel" '{}' "$TS")"
  assert_eq "cancelled" "$(echo "$result" | jq -r '.status')"
}

# =============================================================================
# Test 29: cancel from paused state (paused -> cancelled)
# =============================================================================
test_cancel_from_paused() {
  local state result
  state="$(build_state --status paused --paused-from prd --paused-reason manual_pause)"
  result="$(state_transition "$state" "cancel" '{}' "$TS")"
  assert_eq "cancelled" "$(echo "$result" | jq -r '.status')"
}

# =============================================================================
# Test 30: cancel is terminal (no transitions after cancel)
# =============================================================================
test_cancel_is_terminal() {
  local state exit_code
  state="$(build_state --status cancelled)"

  for event in advance review_fail pause resume fail retry cancel; do
    exit_code=0
    state_transition "$state" "$event" '{}' "$TS" > /dev/null 2>&1 || exit_code=$?
    assert_eq "1" "$exit_code" "event '${event}' from cancelled should fail"
  done
}

###############################################################################
# Run Tests
###############################################################################

# Forward transitions (13)
run_test "advance_intake_to_prd" test_advance_intake_to_prd
run_test "advance_prd_to_prd_review" test_advance_prd_to_prd_review
run_test "advance_prd_review_to_tdd" test_advance_prd_review_to_tdd
run_test "advance_tdd_to_tdd_review" test_advance_tdd_to_tdd_review
run_test "advance_tdd_review_to_plan" test_advance_tdd_review_to_plan
run_test "advance_plan_to_plan_review" test_advance_plan_to_plan_review
run_test "advance_plan_review_to_spec" test_advance_plan_review_to_spec
run_test "advance_spec_to_spec_review" test_advance_spec_to_spec_review
run_test "advance_spec_review_to_code" test_advance_spec_review_to_code
run_test "advance_code_to_code_review" test_advance_code_to_code_review
run_test "advance_code_review_to_integration" test_advance_code_review_to_integration
run_test "advance_integration_to_deploy" test_advance_integration_to_deploy
run_test "advance_deploy_to_monitor" test_advance_deploy_to_monitor

# Backward transitions (5)
run_test "review_fail_prd_review_to_prd" test_review_fail_prd_review_to_prd
run_test "review_fail_tdd_review_to_tdd" test_review_fail_tdd_review_to_tdd
run_test "review_fail_plan_review_to_plan" test_review_fail_plan_review_to_plan
run_test "review_fail_spec_review_to_spec" test_review_fail_spec_review_to_spec
run_test "review_fail_code_review_to_code" test_review_fail_code_review_to_code

# Meta-state transitions (12)
run_test "pause_from_active" test_pause_from_active
run_test "pause_from_review" test_pause_from_review
run_test "pause_escalation_count" test_pause_escalation_count
run_test "resume_from_paused" test_resume_from_paused
run_test "fail_from_active" test_fail_from_active
run_test "fail_from_review" test_fail_from_review
run_test "retry_from_failed" test_retry_from_failed
run_test "retry_resets_counter" test_retry_resets_counter
run_test "cancel_from_active" test_cancel_from_active
run_test "cancel_from_failed" test_cancel_from_failed
run_test "cancel_from_paused" test_cancel_from_paused
run_test "cancel_is_terminal" test_cancel_is_terminal

report
