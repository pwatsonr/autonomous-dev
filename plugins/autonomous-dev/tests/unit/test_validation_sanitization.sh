#!/usr/bin/env bash
# test_validation_sanitization.sh -- Unit tests for SPEC-002-2-03
# Tests: validate_request_id() and sanitize_input() in request_tracker.sh
# Tests: Path traversal prevention via create_request_directory()
#
# Requires: jq (1.6+), bash 4+
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source shared test harness
source "${SCRIPT_DIR}/../test_harness.sh"

# Source the module under test (request_tracker.sh sources state_file_manager.sh
# and event_logger.sh internally)
source "${PROJECT_ROOT}/lib/state/request_tracker.sh"

# =============================================================================
# Test 1: Valid ID accepted
# validate_request_id "REQ-20260408-a3f1" returns 0
# =============================================================================
test_valid_id_accepted() {
  validate_request_id "REQ-20260408-a3f1"
}

# =============================================================================
# Test 2: Path traversal rejected
# validate_request_id "REQ-20260408-../../etc" returns 1, stderr has "path traversal"
# =============================================================================
test_path_traversal_rejected() {
  local stderr_output
  stderr_output="$(validate_request_id "REQ-20260408-../../etc" 2>&1 >/dev/null)" && return 1
  assert_contains "$stderr_output" "path traversal"
}

# =============================================================================
# Test 3: Slash rejected
# validate_request_id "REQ-20260408/a3f1" returns 1, stderr has "path separator"
# =============================================================================
test_slash_rejected() {
  local stderr_output
  stderr_output="$(validate_request_id "REQ-20260408/a3f1" 2>&1 >/dev/null)" && return 1
  assert_contains "$stderr_output" "path separator"
}

# =============================================================================
# Test 4: Space rejected
# validate_request_id "REQ 20260408 a3f1" returns 1
# =============================================================================
test_space_rejected() {
  local exit_code=0
  validate_request_id "REQ 20260408 a3f1" > /dev/null 2>&1 || exit_code=$?
  assert_eq "1" "$exit_code"
}

# =============================================================================
# Test 5: Wrong format rejected
# validate_request_id "INVALID-ID" returns 1, stderr has "invalid format"
# =============================================================================
test_wrong_format_rejected() {
  local stderr_output
  stderr_output="$(validate_request_id "INVALID-ID" 2>&1 >/dev/null)" && return 1
  assert_contains "$stderr_output" "invalid format"
}

# =============================================================================
# Test 6: Empty string rejected
# validate_request_id "" returns 1
# =============================================================================
test_empty_string_rejected() {
  local exit_code=0
  validate_request_id "" > /dev/null 2>&1 || exit_code=$?
  assert_eq "1" "$exit_code"
}

# =============================================================================
# Test 7: Uppercase hex rejected
# validate_request_id "REQ-20260408-A3F1" returns 1
# =============================================================================
test_uppercase_hex_rejected() {
  local exit_code=0
  validate_request_id "REQ-20260408-A3F1" > /dev/null 2>&1 || exit_code=$?
  assert_eq "1" "$exit_code"
}

# =============================================================================
# Test 8: Too short hex rejected
# validate_request_id "REQ-20260408-a3f" returns 1
# =============================================================================
test_too_short_hex_rejected() {
  local exit_code=0
  validate_request_id "REQ-20260408-a3f" > /dev/null 2>&1 || exit_code=$?
  assert_eq "1" "$exit_code"
}

# =============================================================================
# Test 9: Too long hex rejected
# validate_request_id "REQ-20260408-a3f1a" returns 1
# =============================================================================
test_too_long_hex_rejected() {
  local exit_code=0
  validate_request_id "REQ-20260408-a3f1a" > /dev/null 2>&1 || exit_code=$?
  assert_eq "1" "$exit_code"
}

# =============================================================================
# Test 10: Sanitize shell metacharacters
# sanitize_input '$(rm -rf /)' -- output contains the literal text safely encoded
# =============================================================================
test_sanitize_shell_metacharacters() {
  local output
  output="$(sanitize_input '$(rm -rf /)')"

  # The output should contain the text, not execute it
  # When passed through jq -Rs, $ is preserved literally
  assert_contains "$output" 'rm -rf'

  # Verify it is safe for jq --arg usage (round-trip through jq)
  local json_result
  json_result="$(jq -n --arg val "$output" '{test: $val}')"
  # Must produce valid JSON
  echo "$json_result" | jq empty
}

# =============================================================================
# Test 11: Sanitize quotes and backslashes
# sanitize_input 'He said "hello" and C:\path' -- output has escaped chars
# =============================================================================
test_sanitize_quotes_and_backslashes() {
  local output
  output="$(sanitize_input 'He said "hello" and C:\path')"

  # The escaped string should contain escaped quotes and backslashes
  # jq -Rs encodes " as \" and \ as \\
  assert_contains "$output" '\"'
  assert_contains "$output" '\\'
}

# =============================================================================
# Test 12: Sanitize truncation
# 300-char input, max_length 200 -- output is 200 chars, stderr has WARNING
# =============================================================================
test_sanitize_truncation() {
  # Build a 300-character string
  local long_input
  long_input="$(printf 'x%.0s' $(seq 1 300))"

  local stderr_output
  local output
  output="$(sanitize_input "$long_input" 200 2>"${_TEST_DIR}/stderr.txt")"
  stderr_output="$(cat "${_TEST_DIR}/stderr.txt")"

  # Output should be exactly 200 characters
  local output_len=${#output}
  assert_eq "200" "$output_len" "output length"

  # Stderr should contain WARNING about truncation
  assert_contains "$stderr_output" "WARNING"
}

# =============================================================================
# Test 13: Sanitize within limit
# sanitize_input "short string" 200 -- output is "short string", no warning
# =============================================================================
test_sanitize_within_limit() {
  local output
  local stderr_output
  output="$(sanitize_input "short string" 200 2>"${_TEST_DIR}/stderr.txt")"
  stderr_output="$(cat "${_TEST_DIR}/stderr.txt")"

  assert_eq "short string" "$output"

  # No warning should be emitted
  if [[ -n "$stderr_output" ]]; then
    echo "  UNEXPECTED stderr output: ${stderr_output}" >&2
    return 1
  fi
}

# =============================================================================
# Test 14: Sanitize control characters
# sanitize_input with null byte -- null byte is safely handled
# =============================================================================
test_sanitize_control_characters() {
  local input
  input="$(printf 'hello\x00world')"

  local output
  output="$(sanitize_input "$input" 100)"

  # The output should exist and be non-empty (jq handles null bytes by encoding)
  if [[ -z "$output" ]]; then
    echo "  Output is empty after sanitizing control characters" >&2
    return 1
  fi

  # Verify the result is safe for jq --arg
  local json_result
  json_result="$(jq -n --arg val "$output" '{test: $val}')"
  echo "$json_result" | jq empty
}

# =============================================================================
# Test 15: Path construction uses validation
# create_request_directory with ID "../../../etc" returns 1, no directory created
# =============================================================================
test_path_construction_uses_validation() {
  local base_dir="${_TEST_DIR}/requests"
  mkdir -p "$base_dir"

  local exit_code=0
  create_request_directory "$base_dir" "../../../etc" "Test Title" "Description" "/tmp/repo" 5 '[]' '[]' \
    > /dev/null 2>&1 || exit_code=$?

  assert_eq "1" "$exit_code" "create_request_directory should fail"

  # Verify no directory was created (especially not a traversal path)
  assert_dir_not_exists "${base_dir}/../../../etc"
  # Also verify nothing was created inside base_dir
  local dir_count
  dir_count="$(ls -1A "$base_dir" 2>/dev/null | wc -l | tr -d ' ')"
  assert_eq "0" "$dir_count" "no directories should be created"
}

# =============================================================================
# Run all tests
# =============================================================================
echo "SPEC-002-2-03: Validation and Sanitization Tests"
echo "================================================="

run_test "Valid ID accepted"                      test_valid_id_accepted
run_test "Path traversal rejected"                test_path_traversal_rejected
run_test "Slash rejected"                         test_slash_rejected
run_test "Space rejected"                         test_space_rejected
run_test "Wrong format rejected"                  test_wrong_format_rejected
run_test "Empty string rejected"                  test_empty_string_rejected
run_test "Uppercase hex rejected"                 test_uppercase_hex_rejected
run_test "Too short hex rejected"                 test_too_short_hex_rejected
run_test "Too long hex rejected"                  test_too_long_hex_rejected
run_test "Sanitize shell metacharacters"          test_sanitize_shell_metacharacters
run_test "Sanitize quotes and backslashes"        test_sanitize_quotes_and_backslashes
run_test "Sanitize truncation"                    test_sanitize_truncation
run_test "Sanitize within limit"                  test_sanitize_within_limit
run_test "Sanitize control characters"            test_sanitize_control_characters
run_test "Path construction uses validation"      test_path_construction_uses_validation

report
