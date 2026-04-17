#!/usr/bin/env bash
# test_lifecycle_edge_cases.sh -- Unit tests for SPEC-002-3-05 (Task 12)
# Tests invalid transitions, timeout enforcement, retry accounting,
# and dependency evaluation. 31+ test cases.
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

# Common timestamp
TS="2026-04-08T10:00:00Z"

###############################################################################
# Helper: Assert that a transition fails with exit code 1 and specific text
###############################################################################
_assert_rejects() {
  local state="$1"
  local event="$2"
  local metadata="$3"
  local expected_text="$4"
  local msg="${5:-}"

  local exit_code=0 stderr_output=""
  stderr_output="$(state_transition "$state" "$event" "$metadata" "$TS" 2>&1 1>/dev/null)" || exit_code=$?
  assert_eq "1" "$exit_code" "should reject: ${msg}"
  if [[ -n "$expected_text" ]]; then
    assert_contains "$stderr_output" "$expected_text" "error should mention: ${expected_text}"
  fi
}

###############################################################################
# Invalid Transitions (15 tests)
###############################################################################

# =============================================================================
# Test 1: reject advance from cancelled
# =============================================================================
test_reject_advance_from_cancelled() {
  local state
  state="$(build_state --status cancelled)"
  _assert_rejects "$state" "advance" '{}' "cancelled" "advance from cancelled"
}

# =============================================================================
# Test 2: reject advance from monitor (no forward successor)
# =============================================================================
test_reject_advance_from_monitor() {
  local state
  state="$(build_state --status monitor)"
  _assert_rejects "$state" "advance" '{}' "no forward transition" "advance from monitor"
}

# =============================================================================
# Test 3: reject advance from paused (must resume first)
# =============================================================================
test_reject_advance_from_paused() {
  local state
  state="$(build_state --status paused --paused-from prd --paused-reason manual_pause)"
  _assert_rejects "$state" "advance" '{}' "meta-state" "advance from paused"
}

# =============================================================================
# Test 4: reject advance from failed (must retry first)
# =============================================================================
test_reject_advance_from_failed() {
  local state
  state="$(build_state --status failed --last-checkpoint code)"
  _assert_rejects "$state" "advance" '{}' "meta-state" "advance from failed"
}

# =============================================================================
# Test 5: reject skip intake to tdd (no two-hop advance)
# =============================================================================
test_reject_skip_intake_to_tdd() {
  local state result
  state="$(build_state --status intake)"
  # Advance once: intake -> prd
  result="$(state_transition "$state" "advance" '{}' "$TS")"
  assert_eq "prd" "$(echo "$result" | jq -r '.status')"
  # Advancing again goes to prd_review, not tdd
  result="$(state_transition "$result" "advance" '{}' "$TS")"
  assert_eq "prd_review" "$(echo "$result" | jq -r '.status')" \
    "second advance should go to prd_review, not skip to tdd"
}

# =============================================================================
# Test 6: reject review_fail from non-review state
# =============================================================================
test_reject_review_fail_from_non_review() {
  local state
  state="$(build_state --status prd)"
  _assert_rejects "$state" "review_fail" '{}' "review_fail only valid from _review" \
    "review_fail from prd"
}

# =============================================================================
# Test 7: reject resume from non-paused state
# =============================================================================
test_reject_resume_from_non_paused() {
  local state
  state="$(build_state --status code)"
  _assert_rejects "$state" "resume" '{}' "resume only valid from paused" \
    "resume from code"
}

# =============================================================================
# Test 8: reject retry from non-failed state
# =============================================================================
test_reject_retry_from_non_failed() {
  local state
  state="$(build_state --status prd)"
  _assert_rejects "$state" "retry" '{}' "retry only valid from failed" \
    "retry from prd"
}

# =============================================================================
# Test 9: reject retry without checkpoint
# =============================================================================
test_reject_retry_without_checkpoint() {
  local state
  state="$(build_state --status failed)"
  # failed state built without --last-checkpoint, so last_checkpoint is null
  _assert_rejects "$state" "retry" '{}' "no checkpoint" \
    "retry without checkpoint"
}

# =============================================================================
# Test 10: reject pause from cancelled
# =============================================================================
test_reject_pause_from_cancelled() {
  local state
  state="$(build_state --status cancelled)"
  _assert_rejects "$state" "pause" '{}' "cancelled" \
    "pause from cancelled"
}

# =============================================================================
# Test 11: reject unknown event type
# =============================================================================
test_reject_unknown_event_type() {
  local state
  state="$(build_state --status prd)"
  _assert_rejects "$state" "teleport" '{}' "unrecognized event_type" \
    "unknown event type"
}

# =============================================================================
# Test 12: reject missing arguments
# =============================================================================
test_reject_missing_arguments() {
  local exit_code=0 stderr_output=""
  stderr_output="$(state_transition "" "advance" '{}' "$TS" 2>&1 1>/dev/null)" || exit_code=$?
  assert_eq "1" "$exit_code" "should reject empty state_json"
  assert_contains "$stderr_output" "missing required arguments"
}

# =============================================================================
# Test 13: reject no transition to intake (cannot go backward to intake)
# =============================================================================
test_reject_no_transition_to_intake() {
  # There's no review_fail from prd (not a review state), and no explicit
  # backward path to intake from any state
  local state
  state="$(build_state --status prd)"
  _assert_rejects "$state" "review_fail" '{}' "review_fail only valid from _review" \
    "review_fail from prd trying to reach intake"
}

# =============================================================================
# Test 14: reject double pause
# =============================================================================
test_reject_double_pause() {
  local state
  state="$(build_state --status paused --paused-from code --paused-reason manual_pause)"
  _assert_rejects "$state" "pause" '{}' "already paused" \
    "double pause"
}

# =============================================================================
# Test 15: error messages are specific (verify error text names the rule)
# =============================================================================
test_error_messages_are_specific() {
  local state exit_code stderr_output

  # Test 1: advance from monitor names the state
  state="$(build_state --status monitor)"
  exit_code=0
  stderr_output="$(state_transition "$state" "advance" '{}' "$TS" 2>&1 1>/dev/null)" || exit_code=$?
  assert_eq "1" "$exit_code"
  assert_contains "$stderr_output" "monitor" "error should name the state 'monitor'"

  # Test 2: unknown event names the event
  state="$(build_state --status prd)"
  exit_code=0
  stderr_output="$(state_transition "$state" "explode" '{}' "$TS" 2>&1 1>/dev/null)" || exit_code=$?
  assert_eq "1" "$exit_code"
  assert_contains "$stderr_output" "explode" "error should name the event 'explode'"

  # Test 3: resume from wrong state names the state
  state="$(build_state --status code)"
  exit_code=0
  stderr_output="$(state_transition "$state" "resume" '{}' "$TS" 2>&1 1>/dev/null)" || exit_code=$?
  assert_eq "1" "$exit_code"
  assert_contains "$stderr_output" "code" "error should name the current state 'code'"
}

###############################################################################
# Timeout Enforcement (5 tests)
###############################################################################

# Common timeouts config
TIMEOUTS_JSON='{"prd": 3600, "prd_review": 1800, "code": 7200, "monitor": -1, "max_retries": 3}'

# =============================================================================
# Test 16: timeout not reached
# =============================================================================
test_timeout_not_reached() {
  local state result
  state="$(build_state --status prd --entered-at "2026-04-08T09:00:00Z")"
  # 30 min later, timeout is 3600s (1hr)
  result="$(check_phase_timeout "$state" "$TIMEOUTS_JSON" "2026-04-08T09:30:00Z")"
  assert_eq "false" "$(echo "$result" | jq -r '.timed_out')"
  assert_eq "none" "$(echo "$result" | jq -r '.action')"
}

# =============================================================================
# Test 17: timeout reached -> retry (retries remain)
# =============================================================================
test_timeout_reached_retry() {
  local state result
  state="$(build_state --status prd --entered-at "2026-04-08T09:00:00Z" --retry-count 0)"
  # 2 hours later, timeout is 3600s (1hr)
  result="$(check_phase_timeout "$state" "$TIMEOUTS_JSON" "2026-04-08T11:00:00Z")"
  assert_eq "true" "$(echo "$result" | jq -r '.timed_out')"
  assert_eq "retry" "$(echo "$result" | jq -r '.action')"
}

# =============================================================================
# Test 18: timeout reached -> fail (retries exhausted, non-review phase)
# =============================================================================
test_timeout_reached_fail() {
  local state result
  state="$(build_state --status code --entered-at "2026-04-08T09:00:00Z" --retry-count 3)"
  # Retries exhausted (3 >= max_retries 3), non-review phase -> fail
  result="$(check_phase_timeout "$state" "$TIMEOUTS_JSON" "2026-04-08T12:00:00Z")"
  assert_eq "true" "$(echo "$result" | jq -r '.timed_out')"
  assert_eq "fail" "$(echo "$result" | jq -r '.action')"
}

# =============================================================================
# Test 19: timeout reached -> pause (retries exhausted, review phase)
# =============================================================================
test_timeout_reached_pause_review() {
  local state result
  state="$(build_state --status prd_review --entered-at "2026-04-08T09:00:00Z" --retry-count 3)"
  # Retries exhausted, review phase -> pause (escalation)
  result="$(check_phase_timeout "$state" "$TIMEOUTS_JSON" "2026-04-08T10:00:00Z")"
  assert_eq "true" "$(echo "$result" | jq -r '.timed_out')"
  assert_eq "pause" "$(echo "$result" | jq -r '.action')"
}

# =============================================================================
# Test 20: monitor is timeout exempt
# =============================================================================
test_timeout_monitor_exempt() {
  local state result
  state="$(build_state --status monitor --entered-at "2026-04-08T09:00:00Z")"
  # Even after a long time, monitor should not time out
  result="$(check_phase_timeout "$state" "$TIMEOUTS_JSON" "2026-04-10T09:00:00Z")"
  assert_eq "false" "$(echo "$result" | jq -r '.timed_out')"
  assert_eq "none" "$(echo "$result" | jq -r '.action')"
  assert_eq "-1" "$(echo "$result" | jq '.timeout_seconds')"
}

###############################################################################
# Retry Accounting (6 tests)
###############################################################################

# =============================================================================
# Test 21: retry count increments on review_fail
# =============================================================================
test_retry_count_increments_on_review_fail() {
  local state result
  state="$(build_state --status prd_review --retry-count 1)"
  result="$(state_transition "$state" "review_fail" '{"review_feedback":"try again"}' "$TS")"
  assert_eq "2" "$(echo "$result" | jq '.phase_history[-1].retry_count')" \
    "retry_count should increment from 1 to 2"
}

# =============================================================================
# Test 22: retry count resets on advance
# =============================================================================
test_retry_count_resets_on_advance() {
  local state result
  state="$(build_state --status prd --retry-count 2)"
  result="$(state_transition "$state" "advance" '{}' "$TS")"
  assert_eq "0" "$(echo "$result" | jq '.phase_history[-1].retry_count')" \
    "retry_count should be 0 on new phase after advance"
}

# =============================================================================
# Test 23: retry count resets on retry command
# =============================================================================
test_retry_count_resets_on_retry_cmd() {
  local state result
  state="$(build_state --status failed --last-checkpoint code --retry-count 3)"
  result="$(state_transition "$state" "retry" '{}' "$TS")"
  assert_eq "0" "$(echo "$result" | jq '.phase_history[-1].retry_count')" \
    "retry_count should be 0 after retry from failed"
}

# =============================================================================
# Test 24: retry count resets on resume
# =============================================================================
test_retry_count_resets_on_resume() {
  local state result
  state="$(build_state --status paused --paused-from prd --paused-reason manual_pause --retry-count 2)"
  result="$(state_transition "$state" "resume" '{}' "$TS")"
  assert_eq "0" "$(echo "$result" | jq '.phase_history[-1].retry_count')" \
    "retry_count should be 0 after resume"
}

# =============================================================================
# Test 25: retry exhaustion triggers pause (via review_fail)
# =============================================================================
test_retry_exhaustion_triggers_pause() {
  local state result
  state="$(build_state --status prd_review --retry-count 3)"
  # max_retries=3, retry_count=3 -> exhausted -> escalate to paused
  result="$(state_transition "$state" "review_fail" '{"max_retries": 3}' "$TS" 2>/dev/null)"
  assert_eq "paused" "$(echo "$result" | jq -r '.status')"
  assert_eq "review_retries_exhausted" "$(echo "$result" | jq -r '.paused_reason')"
}

# =============================================================================
# Test 26: retry exhaustion triggers fail (via trigger_error_transition)
# =============================================================================
test_retry_exhaustion_triggers_fail() {
  local state result
  state="$(build_state --status code --retry-count 3)"
  # session_crash with exhausted retries -> fail
  result="$(trigger_error_transition "$state" "session_crash" '{"max_retries": 3}' "$TS")"
  assert_eq "failed" "$(echo "$result" | jq -r '.status')"
  assert_eq "session_crash_retries_exhausted" "$(echo "$result" | jq -r '.failure_reason')"
}

###############################################################################
# Dependency Evaluation (5 tests)
###############################################################################

# Mock state reader functions for dependency tests (no real file I/O)
_mock_state_reader_active() {
  # Returns a state at "code" status (not completed)
  local req_id="$1"
  build_state --status code --id "$req_id"
}

_mock_state_reader_completed() {
  # Returns a state at "deploy" status (completed)
  local req_id="$1"
  build_state --status deploy --id "$req_id"
}

_mock_state_reader_unknown() {
  # Simulates an unreadable/unknown dependency
  return 1
}

# Circular dependency mock: A -> B -> A
_mock_state_reader_circular() {
  local req_id="$1"
  case "$req_id" in
    REQ-20260408-aaaa)
      build_state --status code --id "REQ-20260408-aaaa" --blocked-by '["REQ-20260408-bbbb"]'
      ;;
    REQ-20260408-bbbb)
      build_state --status code --id "REQ-20260408-bbbb" --blocked-by '["REQ-20260408-aaaa"]'
      ;;
    *)
      return 1
      ;;
  esac
}

# =============================================================================
# Test 27: not blocked when dependencies are empty
# =============================================================================
test_not_blocked_empty_deps() {
  local state result
  state="$(build_state --status code)"
  result="$(is_blocked "$state" "_mock_state_reader_active")"
  assert_eq "false" "$(echo "$result" | jq -r '.blocked')"
  assert_eq "no dependencies" "$(echo "$result" | jq -r '.reason')"
}

# =============================================================================
# Test 28: blocked by active (not completed) dependency
# =============================================================================
test_blocked_by_active_dep() {
  local state result
  state="$(build_state --status code --blocked-by '["REQ-20260408-b001"]')"
  result="$(is_blocked "$state" "_mock_state_reader_active")"
  assert_eq "true" "$(echo "$result" | jq -r '.blocked')"
  assert_contains "$(echo "$result" | jq -r '.blocking_ids[]')" "REQ-20260408-b001"
}

# =============================================================================
# Test 29: not blocked when dependency is completed
# =============================================================================
test_not_blocked_completed_dep() {
  local state result
  state="$(build_state --status code --blocked-by '["REQ-20260408-c001"]')"
  result="$(is_blocked "$state" "_mock_state_reader_completed")"
  assert_eq "false" "$(echo "$result" | jq -r '.blocked')"
}

# =============================================================================
# Test 30: blocked by unknown (unreadable) dependency
# =============================================================================
test_blocked_by_unknown_dep() {
  local state result
  state="$(build_state --status code --blocked-by '["REQ-20260408-d001"]')"
  result="$(is_blocked "$state" "_mock_state_reader_unknown")"
  assert_eq "true" "$(echo "$result" | jq -r '.blocked')"
}

# =============================================================================
# Test 31: circular dependency detected
# =============================================================================
test_circular_dependency_detected() {
  local exit_code=0
  detect_circular_dependencies "REQ-20260408-aaaa" "_mock_state_reader_circular" 10 2>/dev/null || exit_code=$?
  assert_eq "1" "$exit_code" "circular dependency should be detected"
}

###############################################################################
# Run Tests
###############################################################################

# Invalid transitions (15)
run_test "reject_advance_from_cancelled" test_reject_advance_from_cancelled
run_test "reject_advance_from_monitor" test_reject_advance_from_monitor
run_test "reject_advance_from_paused" test_reject_advance_from_paused
run_test "reject_advance_from_failed" test_reject_advance_from_failed
run_test "reject_skip_intake_to_tdd" test_reject_skip_intake_to_tdd
run_test "reject_review_fail_from_non_review" test_reject_review_fail_from_non_review
run_test "reject_resume_from_non_paused" test_reject_resume_from_non_paused
run_test "reject_retry_from_non_failed" test_reject_retry_from_non_failed
run_test "reject_retry_without_checkpoint" test_reject_retry_without_checkpoint
run_test "reject_pause_from_cancelled" test_reject_pause_from_cancelled
run_test "reject_unknown_event_type" test_reject_unknown_event_type
run_test "reject_missing_arguments" test_reject_missing_arguments
run_test "reject_no_transition_to_intake" test_reject_no_transition_to_intake
run_test "reject_double_pause" test_reject_double_pause
run_test "error_messages_are_specific" test_error_messages_are_specific

# Timeout enforcement (5)
run_test "timeout_not_reached" test_timeout_not_reached
run_test "timeout_reached_retry" test_timeout_reached_retry
run_test "timeout_reached_fail" test_timeout_reached_fail
run_test "timeout_reached_pause_review" test_timeout_reached_pause_review
run_test "timeout_monitor_exempt" test_timeout_monitor_exempt

# Retry accounting (6)
run_test "retry_count_increments_on_review_fail" test_retry_count_increments_on_review_fail
run_test "retry_count_resets_on_advance" test_retry_count_resets_on_advance
run_test "retry_count_resets_on_retry_cmd" test_retry_count_resets_on_retry_cmd
run_test "retry_count_resets_on_resume" test_retry_count_resets_on_resume
run_test "retry_exhaustion_triggers_pause" test_retry_exhaustion_triggers_pause
run_test "retry_exhaustion_triggers_fail" test_retry_exhaustion_triggers_fail

# Dependency evaluation (5)
run_test "not_blocked_empty_deps" test_not_blocked_empty_deps
run_test "blocked_by_active_dep" test_blocked_by_active_dep
run_test "not_blocked_completed_dep" test_not_blocked_completed_dep
run_test "blocked_by_unknown_dep" test_blocked_by_unknown_dep
run_test "circular_dependency_detected" test_circular_dependency_detected

report
