#!/usr/bin/env bash
# test_rate_limit_handler.sh -- Unit tests for rate-limit detection and backoff
# Part of SPEC-010-3-04: Unit and Integration Tests for Resource Monitoring
#
# Tests: detect_rate_limit(), handle_rate_limit(), check_rate_limit_state(),
#        clear_rate_limit_state(), write_rate_limit_state()
#        in lib/rate_limit_handler.sh
# Test count: 23
#
# Requires: jq (1.6+), bash 4+
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source shared test harness
source "${SCRIPT_DIR}/../test_harness.sh"

# Source the module under test
source "${PROJECT_ROOT}/lib/rate_limit_handler.sh"

# =============================================================================
# Override setup/teardown to create isolated HOME for each test
# =============================================================================
setup() {
  _TEST_DIR="$(mktemp -d)"
  chmod 0700 "$_TEST_DIR"
  export HOME="${_TEST_DIR}/home"
  mkdir -p "${HOME}/.autonomous-dev"
  export PLUGIN_ROOT="$PROJECT_ROOT"
}

# =============================================================================
# Default config for backoff tests (base=30, max=900)
# =============================================================================
DEFAULT_CONFIG='{"governance":{"rate_limit_backoff_base_seconds":30,"rate_limit_backoff_max_seconds":900}}'

# =============================================================================
# Test 1: detect_http_429 -- Output has "HTTP/1.1 429". Detected.
# =============================================================================
test_detect_http_429() {
  local output="Response received: HTTP/1.1 429 Too Many Requests"
  detect_rate_limit "$output"
  local rc=$?
  assert_eq "0" "$rc" "HTTP 429 should be detected"
}

# =============================================================================
# Test 2: detect_status_429 -- Output has "status: 429". Detected.
# =============================================================================
test_detect_status_429() {
  local output="Error: request failed with status: 429"
  detect_rate_limit "$output"
  local rc=$?
  assert_eq "0" "$rc" "status: 429 should be detected"
}

# =============================================================================
# Test 3: detect_rate_limit_exceeded -- Output has "Rate limit exceeded". Detected.
# =============================================================================
test_detect_rate_limit_exceeded() {
  local output="Error: Rate limit exceeded. Please try again later."
  detect_rate_limit "$output"
  local rc=$?
  assert_eq "0" "$rc" "Rate limit exceeded should be detected"
}

# =============================================================================
# Test 4: detect_rate_limit_underscore -- Output has "rate_limit_exceeded". Detected.
# =============================================================================
test_detect_rate_limit_underscore() {
  local output='{"error":{"type":"rate_limit_exceeded","message":"Too many requests"}}'
  detect_rate_limit "$output"
  local rc=$?
  assert_eq "0" "$rc" "rate_limit_exceeded should be detected"
}

# =============================================================================
# Test 5: detect_too_many_requests -- Output has "Too many requests". Detected.
# =============================================================================
test_detect_too_many_requests() {
  local output="Error: Too many requests. Slow down."
  detect_rate_limit "$output"
  local rc=$?
  assert_eq "0" "$rc" "Too many requests should be detected"
}

# =============================================================================
# Test 6: detect_anthropic_specific -- Output has "anthropic api rate limit". Detected.
# =============================================================================
test_detect_anthropic_specific() {
  local output="Anthropic API rate limit has been reached"
  detect_rate_limit "$output"
  local rc=$?
  assert_eq "0" "$rc" "Anthropic API rate limit should be detected"
}

# =============================================================================
# Test 7: no_false_positive_approval_rate -- "approval rate threshold exceeded". NOT detected.
# =============================================================================
test_no_false_positive_approval_rate() {
  local output="The approval rate threshold exceeded expectations this quarter."
  local rc=0
  detect_rate_limit "$output" || rc=$?
  assert_eq "1" "$rc" "approval rate should NOT be detected as rate limit"
}

# =============================================================================
# Test 8: no_false_positive_error_rate -- "error rate is 5%". NOT detected.
# =============================================================================
test_no_false_positive_error_rate() {
  local output="The error rate is 5% which is within acceptable limits."
  local rc=0
  detect_rate_limit "$output" || rc=$?
  assert_eq "1" "$rc" "error rate should NOT be detected as rate limit"
}

# =============================================================================
# Test 9: normal_output_no_detection -- Standard output with no rate-limit indicators.
# =============================================================================
test_normal_output_no_detection() {
  local output="Session completed successfully. Total cost: \$1.85. Tokens used: 5000."
  local rc=0
  detect_rate_limit "$output" || rc=$?
  assert_eq "1" "$rc" "normal output should NOT be detected as rate limit"
}

# =============================================================================
# Test 10: backoff_step_1 -- First rate limit. consecutive=1, backoff=30.
# =============================================================================
test_backoff_step_1() {
  handle_rate_limit "$DEFAULT_CONFIG" 2>/dev/null

  local state
  state=$(cat "${HOME}/.autonomous-dev/rate-limit-state.json")

  local consecutive backoff
  consecutive=$(echo "$state" | jq -r '.consecutive_rate_limits')
  backoff=$(echo "$state" | jq -r '.current_backoff_seconds')

  assert_eq "1" "$consecutive" "consecutive should be 1"
  assert_eq "30" "$backoff" "backoff should be 30"
}

# =============================================================================
# Test 11: backoff_step_2 -- consecutive=2, backoff=60.
# =============================================================================
test_backoff_step_2() {
  # Step 1
  handle_rate_limit "$DEFAULT_CONFIG" 2>/dev/null
  # Step 2
  handle_rate_limit "$DEFAULT_CONFIG" 2>/dev/null

  local state
  state=$(cat "${HOME}/.autonomous-dev/rate-limit-state.json")

  local consecutive backoff
  consecutive=$(echo "$state" | jq -r '.consecutive_rate_limits')
  backoff=$(echo "$state" | jq -r '.current_backoff_seconds')

  assert_eq "2" "$consecutive" "consecutive should be 2"
  assert_eq "60" "$backoff" "backoff should be 60"
}

# =============================================================================
# Test 12: backoff_step_3 -- consecutive=3, backoff=120.
# =============================================================================
test_backoff_step_3() {
  for _ in 1 2 3; do
    handle_rate_limit "$DEFAULT_CONFIG" 2>/dev/null
  done

  local state
  state=$(cat "${HOME}/.autonomous-dev/rate-limit-state.json")

  local consecutive backoff
  consecutive=$(echo "$state" | jq -r '.consecutive_rate_limits')
  backoff=$(echo "$state" | jq -r '.current_backoff_seconds')

  assert_eq "3" "$consecutive" "consecutive should be 3"
  assert_eq "120" "$backoff" "backoff should be 120"
}

# =============================================================================
# Test 13: backoff_step_4 -- consecutive=4, backoff=240.
# =============================================================================
test_backoff_step_4() {
  for _ in 1 2 3 4; do
    handle_rate_limit "$DEFAULT_CONFIG" 2>/dev/null
  done

  local state
  state=$(cat "${HOME}/.autonomous-dev/rate-limit-state.json")

  local consecutive backoff
  consecutive=$(echo "$state" | jq -r '.consecutive_rate_limits')
  backoff=$(echo "$state" | jq -r '.current_backoff_seconds')

  assert_eq "4" "$consecutive" "consecutive should be 4"
  assert_eq "240" "$backoff" "backoff should be 240"
}

# =============================================================================
# Test 14: backoff_step_5 -- consecutive=5, backoff=480.
# =============================================================================
test_backoff_step_5() {
  for _ in 1 2 3 4 5; do
    handle_rate_limit "$DEFAULT_CONFIG" 2>/dev/null
  done

  local state
  state=$(cat "${HOME}/.autonomous-dev/rate-limit-state.json")

  local consecutive backoff
  consecutive=$(echo "$state" | jq -r '.consecutive_rate_limits')
  backoff=$(echo "$state" | jq -r '.current_backoff_seconds')

  assert_eq "5" "$consecutive" "consecutive should be 5"
  assert_eq "480" "$backoff" "backoff should be 480"
}

# =============================================================================
# Test 15: backoff_step_6_kill -- consecutive=6, backoff=960 > 900. Kill switch.
# =============================================================================
test_backoff_step_6_kill() {
  for _ in 1 2 3 4 5; do
    handle_rate_limit "$DEFAULT_CONFIG" 2>/dev/null
  done

  # Step 6 should trigger kill switch (960 > 900)
  local rc=0
  handle_rate_limit "$DEFAULT_CONFIG" 2>/dev/null || rc=$?
  assert_eq "1" "$rc" "handle_rate_limit should return 1 for kill switch"

  local state
  state=$(cat "${HOME}/.autonomous-dev/rate-limit-state.json")

  local kill_switch consecutive
  kill_switch=$(echo "$state" | jq -r '.kill_switch')
  consecutive=$(echo "$state" | jq -r '.consecutive_rate_limits')

  assert_eq "true" "$kill_switch" "kill switch should be true"
  assert_eq "6" "$consecutive" "consecutive should be 6"
}

# =============================================================================
# Test 16: state_file_format -- After step 3, state file has all 5 required fields.
# =============================================================================
test_state_file_format() {
  for _ in 1 2 3; do
    handle_rate_limit "$DEFAULT_CONFIG" 2>/dev/null
  done

  local state_file="${HOME}/.autonomous-dev/rate-limit-state.json"
  assert_file_exists "$state_file"

  local state
  state=$(cat "$state_file")

  # Check all required fields exist
  local active triggered_at backoff retry_at consecutive kill_switch
  active=$(echo "$state" | jq -r '.active')
  triggered_at=$(echo "$state" | jq -r '.triggered_at')
  backoff=$(echo "$state" | jq -r '.current_backoff_seconds')
  retry_at=$(echo "$state" | jq -r '.retry_at')
  consecutive=$(echo "$state" | jq -r '.consecutive_rate_limits')
  kill_switch=$(echo "$state" | jq -r '.kill_switch')

  assert_eq "true" "$active" "active should be true"
  assert_eq "120" "$backoff" "backoff should be 120"
  assert_eq "3" "$consecutive" "consecutive should be 3"
  assert_eq "false" "$kill_switch" "kill switch should be false"

  # triggered_at should be a valid ISO timestamp
  if [[ ! "$triggered_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
    echo "  ASSERT FAILED: triggered_at '$triggered_at' is not valid ISO-8601" >&2
    return 1
  fi

  # retry_at should be a valid ISO timestamp (not null)
  if [[ "$retry_at" == "null" ]] || [[ ! "$retry_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
    echo "  ASSERT FAILED: retry_at '$retry_at' is not valid ISO-8601" >&2
    return 1
  fi
}

# =============================================================================
# Test 17: pre_check_active_backoff -- retry_at is 60s in future. Returns 1.
# =============================================================================
test_pre_check_active_backoff() {
  local state_file="${HOME}/.autonomous-dev/rate-limit-state.json"

  # Compute a retry_at 60 seconds in the future
  local future_retry
  if [[ "$(uname)" == "Darwin" ]]; then
    future_retry=$(date -u -v "+60S" +"%Y-%m-%dT%H:%M:%SZ")
  else
    future_retry=$(date -u -d "+60 seconds" +"%Y-%m-%dT%H:%M:%SZ")
  fi

  write_rate_limit_state "$state_file" true 2 60 false "$future_retry"

  local rc=0
  check_rate_limit_state 2>/dev/null || rc=$?
  assert_eq "1" "$rc" "should be blocked when retry_at is in future"
}

# =============================================================================
# Test 18: pre_check_expired_backoff -- retry_at is 60s in past. Returns 0.
# =============================================================================
test_pre_check_expired_backoff() {
  local state_file="${HOME}/.autonomous-dev/rate-limit-state.json"

  # Compute a retry_at 60 seconds in the past
  local past_retry
  if [[ "$(uname)" == "Darwin" ]]; then
    past_retry=$(date -u -v "-60S" +"%Y-%m-%dT%H:%M:%SZ")
  else
    past_retry=$(date -u -d "-60 seconds" +"%Y-%m-%dT%H:%M:%SZ")
  fi

  write_rate_limit_state "$state_file" true 2 60 false "$past_retry"

  local rc=0
  check_rate_limit_state 2>/dev/null || rc=$?
  assert_eq "0" "$rc" "should be allowed when retry_at is in past"
}

# =============================================================================
# Test 19: pre_check_kill_switch -- Kill switch true. Returns 1.
# =============================================================================
test_pre_check_kill_switch() {
  local state_file="${HOME}/.autonomous-dev/rate-limit-state.json"

  write_rate_limit_state "$state_file" true 6 900 true

  local rc=0
  check_rate_limit_state 2>/dev/null || rc=$?
  assert_eq "1" "$rc" "should be blocked when kill switch is active"
}

# =============================================================================
# Test 20: clear_after_success -- Active state with consecutive=3. After clear,
#   active=false, consecutive=0.
# =============================================================================
test_clear_after_success() {
  # Build up to consecutive=3
  for _ in 1 2 3; do
    handle_rate_limit "$DEFAULT_CONFIG" 2>/dev/null
  done

  local state_before
  state_before=$(cat "${HOME}/.autonomous-dev/rate-limit-state.json")
  local active_before consecutive_before
  active_before=$(echo "$state_before" | jq -r '.active')
  consecutive_before=$(echo "$state_before" | jq -r '.consecutive_rate_limits')
  assert_eq "true" "$active_before" "should be active before clear"
  assert_eq "3" "$consecutive_before" "should have 3 consecutive before clear"

  clear_rate_limit_state 2>/dev/null

  local state_after
  state_after=$(cat "${HOME}/.autonomous-dev/rate-limit-state.json")
  local active_after consecutive_after
  active_after=$(echo "$state_after" | jq -r '.active')
  consecutive_after=$(echo "$state_after" | jq -r '.consecutive_rate_limits')
  assert_eq "false" "$active_after" "should be inactive after clear"
  assert_eq "0" "$consecutive_after" "should have 0 consecutive after clear"
}

# =============================================================================
# Test 21: clear_when_inactive -- Already inactive. No-op.
# =============================================================================
test_clear_when_inactive() {
  local state_file="${HOME}/.autonomous-dev/rate-limit-state.json"

  # Write an already-inactive state
  write_rate_limit_state "$state_file" false 0 0 false

  local before_content
  before_content=$(cat "$state_file")

  clear_rate_limit_state 2>/dev/null

  local after_content
  after_content=$(cat "$state_file")

  # Active should still be false (the file should be unchanged in terms of active/consecutive)
  local active_after
  active_after=$(echo "$after_content" | jq -r '.active')
  assert_eq "false" "$active_after" "should still be inactive after clear"
}

# =============================================================================
# Test 22: missing_state_file -- No file. check_rate_limit_state returns 0.
# =============================================================================
test_missing_state_file() {
  # Ensure no state file exists
  rm -f "${HOME}/.autonomous-dev/rate-limit-state.json"

  local rc=0
  check_rate_limit_state 2>/dev/null || rc=$?
  assert_eq "0" "$rc" "missing state file should return 0 (no active rate limit)"
}

# =============================================================================
# Test 23: corrupted_state_file -- File has "{bad". Deleted, returns 0.
# =============================================================================
test_corrupted_state_file() {
  local state_file="${HOME}/.autonomous-dev/rate-limit-state.json"
  echo "{bad" > "$state_file"

  local rc=0
  check_rate_limit_state 2>/dev/null || rc=$?
  assert_eq "0" "$rc" "corrupted state file should return 0 after deletion"

  # File should have been deleted
  assert_file_not_exists "$state_file"
}

# =============================================================================
# Run all tests
# =============================================================================
echo "SPEC-010-3-04: Rate Limit Handler Unit Tests"
echo "==============================================="

run_test "Detect HTTP 429"                                     test_detect_http_429
run_test "Detect status: 429"                                  test_detect_status_429
run_test "Detect Rate limit exceeded"                          test_detect_rate_limit_exceeded
run_test "Detect rate_limit_exceeded (underscore)"             test_detect_rate_limit_underscore
run_test "Detect Too many requests"                            test_detect_too_many_requests
run_test "Detect Anthropic API rate limit"                     test_detect_anthropic_specific
run_test "No false positive: approval rate"                    test_no_false_positive_approval_rate
run_test "No false positive: error rate"                       test_no_false_positive_error_rate
run_test "Normal output: no detection"                         test_normal_output_no_detection
run_test "Backoff step 1 (30s)"                                test_backoff_step_1
run_test "Backoff step 2 (60s)"                                test_backoff_step_2
run_test "Backoff step 3 (120s)"                               test_backoff_step_3
run_test "Backoff step 4 (240s)"                               test_backoff_step_4
run_test "Backoff step 5 (480s)"                               test_backoff_step_5
run_test "Backoff step 6 (kill switch)"                        test_backoff_step_6_kill
run_test "State file format (5 fields)"                        test_state_file_format
run_test "Pre-check: active backoff (blocked)"                 test_pre_check_active_backoff
run_test "Pre-check: expired backoff (allowed)"                test_pre_check_expired_backoff
run_test "Pre-check: kill switch (blocked)"                    test_pre_check_kill_switch
run_test "Clear after success"                                 test_clear_after_success
run_test "Clear when inactive (no-op)"                         test_clear_when_inactive
run_test "Missing state file (returns 0)"                      test_missing_state_file
run_test "Corrupted state file (deleted)"                      test_corrupted_state_file

report
