#!/usr/bin/env bash
# test_cost_extractor.sh -- Unit tests for cost extraction regex
# Part of SPEC-010-2-04: Unit Tests for Cost Extraction, Ledger, and Budget Enforcement
#
# Tests: extract_session_cost() in lib/cost_extractor.sh
# Test count: 9
#
# Requires: bash 4+
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source shared test harness
source "${SCRIPT_DIR}/../test_harness.sh"

# Source the module under test
source "${PROJECT_ROOT}/lib/cost_extractor.sh"

# =============================================================================
# Test 1: Extract "Total cost: $1.85" -- Returns "1.85"
# =============================================================================
test_extract_total_cost() {
  local output
  output=$(extract_session_cost "Some output text
Total cost: \$1.85
Session ended.")
  assert_eq "1.85" "$output"
}

# =============================================================================
# Test 2: Extract "Session cost: $0.42" -- Returns "0.42"
# =============================================================================
test_extract_session_cost() {
  local output
  output=$(extract_session_cost "Session cost: \$0.42")
  assert_eq "0.42" "$output"
}

# =============================================================================
# Test 3: Extract "Cost: $3.17" -- Returns "3.17"
# =============================================================================
test_extract_cost_minimal() {
  local output
  output=$(extract_session_cost "Cost: \$3.17")
  assert_eq "3.17" "$output"
}

# =============================================================================
# Test 4: Extract "Total cost: $0.00" -- Returns "0.00"
# =============================================================================
test_extract_zero_cost() {
  local output
  output=$(extract_session_cost "Total cost: \$0.00")
  assert_eq "0.00" "$output"
}

# =============================================================================
# Test 5: No cost line in output -- Returns "0.00" with warning
# =============================================================================
test_extract_no_cost_line() {
  local output stderr_output
  output=$(extract_session_cost "Session crashed
No cost information" 2>"${_TEST_DIR}/stderr.txt")
  stderr_output=$(cat "${_TEST_DIR}/stderr.txt")

  assert_eq "0.00" "$output"
  assert_contains "$stderr_output" "WARNING"
  assert_contains "$stderr_output" "No cost found"
}

# =============================================================================
# Test 6: Multiple cost lines -- Takes the last one
# =============================================================================
test_extract_multi_cost_lines() {
  local output
  output=$(extract_session_cost "Cost: \$1.00
Some middle text
Total cost: \$2.50")
  assert_eq "2.50" "$output"
}

# =============================================================================
# Test 7: Large cost "Total cost: $123.45" -- Returns "123.45"
# =============================================================================
test_extract_large_cost() {
  local output
  output=$(extract_session_cost "Total cost: \$123.45")
  assert_eq "123.45" "$output"
}

# =============================================================================
# Test 8: Realistic Claude Code output from fixture file
# =============================================================================
test_extract_embedded_in_long_output() {
  local output fixture_output
  fixture_output=$(cat "$PROJECT_ROOT/tests/fixtures/claude-output-with-cost.txt")
  output=$(extract_session_cost "$fixture_output")
  assert_eq "1.85" "$output"
}

# =============================================================================
# Test 9: Crashed session output from fixture file -- Returns "0.00"
# =============================================================================
test_extract_crashed_output() {
  local output fixture_output
  fixture_output=$(cat "$PROJECT_ROOT/tests/fixtures/claude-output-crashed.txt")
  output=$(extract_session_cost "$fixture_output" 2>/dev/null)
  assert_eq "0.00" "$output"
}

# =============================================================================
# Run all tests
# =============================================================================
echo "SPEC-010-2-04: Cost Extraction Regex Tests"
echo "============================================"

run_test "Extract 'Total cost: \$1.85'"                     test_extract_total_cost
run_test "Extract 'Session cost: \$0.42'"                   test_extract_session_cost
run_test "Extract 'Cost: \$3.17'"                           test_extract_cost_minimal
run_test "Extract 'Total cost: \$0.00' (zero)"              test_extract_zero_cost
run_test "No cost line returns 0.00"                        test_extract_no_cost_line
run_test "Multiple cost lines, takes last"                  test_extract_multi_cost_lines
run_test "Large cost '\$123.45'"                            test_extract_large_cost
run_test "Realistic output from fixture"                    test_extract_embedded_in_long_output
run_test "Crashed output from fixture returns 0.00"         test_extract_crashed_output

report
