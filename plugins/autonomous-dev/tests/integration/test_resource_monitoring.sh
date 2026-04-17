#!/usr/bin/env bash
# test_resource_monitoring.sh -- Integration tests for resource monitoring
# Part of SPEC-010-3-04: Unit and Integration Tests for Resource Monitoring
#
# End-to-end tests using real filesystem operations:
#   1. Disk limit enforcement with actual files
#   2. Rate-limit backoff sequence simulation
#   3. Allowlist rejection with real repos
#
# Test count: 3
#
# Requires: jq (1.6+), bc, bash 4+, git
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source shared test harness
source "${SCRIPT_DIR}/../test_harness.sh"

# Source all modules under test
source "${PROJECT_ROOT}/lib/resource_monitor.sh"
source "${PROJECT_ROOT}/lib/rate_limit_handler.sh"
source "${PROJECT_ROOT}/lib/repo_allowlist.sh"

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
# Test 1: Disk Limit Enforcement
#
# Creates actual files on disk to approach and then exceed a very small disk
# usage limit. Verifies check_disk_usage() transitions from pass to fail.
# =============================================================================
test_disk_limit_enforcement() {
  local config
  config=$(jq -nc '{
    governance: {disk_usage_limit_gb: 0.001, max_concurrent_requests: 5},
    parallel: {disk_warning_threshold_gb: 0.0005, disk_hard_limit_gb: 0.001, max_worktrees: 5},
    repositories: {allowlist: []}
  }')

  # Create files to approach limit (512KB, which is ~0.0005GB, under the 0.001GB limit)
  dd if=/dev/zero of="${HOME}/.autonomous-dev/testfile" bs=1024 count=512 2>/dev/null

  local result exit_code=0
  result=$(check_disk_usage "$config") || exit_code=$?

  local status
  status=$(echo "$result" | jq -r '.status')
  assert_eq "pass" "$status" "under limit: status should be pass"

  # Push over limit (add 1MB more, total ~1.5MB which is ~0.0015GB > 0.001GB limit)
  dd if=/dev/zero of="${HOME}/.autonomous-dev/testfile2" bs=1024 count=1024 2>/dev/null

  local result2 exit_code2=0
  result2=$(check_disk_usage "$config") || exit_code2=$?

  local status2
  status2=$(echo "$result2" | jq -r '.status')
  assert_eq "fail" "$status2" "over limit: status should be fail"

  # Verify the system_disk check shows exceeded
  local sys_status
  sys_status=$(echo "$result2" | jq -r '.checks[] | select(.type=="system_disk") | .status')
  assert_eq "exceeded" "$sys_status" "system_disk check should show exceeded"

  # Clean up
  rm -f "${HOME}/.autonomous-dev/testfile" "${HOME}/.autonomous-dev/testfile2"
}

# =============================================================================
# Test 2: Rate-Limit Backoff Sequence
#
# Simulates consecutive rate limits with small backoffs (base=2s, max=20s)
# and verifies the exponential backoff at each step, the kill switch activation,
# and the state clearing.
# =============================================================================
test_rate_limit_backoff_sequence() {
  local config
  config=$(jq -nc '{governance: {rate_limit_backoff_base_seconds: 2, rate_limit_backoff_max_seconds: 20}}')

  # Simulate 4 consecutive rate limits with small backoffs
  local backoffs=()
  for i in 1 2 3 4; do
    handle_rate_limit "$config" 2>/dev/null
    local state
    state=$(cat "${HOME}/.autonomous-dev/rate-limit-state.json")
    local backoff
    backoff=$(echo "$state" | jq -r '.current_backoff_seconds')
    backoffs+=("$backoff")
    local consecutive
    consecutive=$(echo "$state" | jq -r '.consecutive_rate_limits')
    assert_eq "$i" "$consecutive" "consecutive after step $i"
  done

  assert_eq "2" "${backoffs[0]}" "backoff step 1"
  assert_eq "4" "${backoffs[1]}" "backoff step 2"
  assert_eq "8" "${backoffs[2]}" "backoff step 3"
  assert_eq "16" "${backoffs[3]}" "backoff step 4"

  # Step 5: backoff would be 32 > 20 max -> kill switch
  local rc=0
  handle_rate_limit "$config" 2>/dev/null || rc=$?
  assert_eq "1" "$rc" "step 5 should return 1 (kill switch)"

  local final_state
  final_state=$(cat "${HOME}/.autonomous-dev/rate-limit-state.json")
  local kill_switch
  kill_switch=$(echo "$final_state" | jq -r '.kill_switch')
  assert_eq "true" "$kill_switch" "kill switch activated"

  # Verify check_rate_limit_state blocks when kill switch is active
  local check_rc=0
  check_rate_limit_state 2>/dev/null || check_rc=$?
  assert_eq "1" "$check_rc" "check should block with kill switch"

  # Clear state
  # First we need to manually reset since clear_rate_limit_state only clears active=true states
  # and the kill switch state also has active=true, so clear should work
  clear_rate_limit_state 2>/dev/null

  local cleared_state
  cleared_state=$(cat "${HOME}/.autonomous-dev/rate-limit-state.json")
  local active
  active=$(echo "$cleared_state" | jq -r '.active')
  assert_eq "false" "$active" "cleared active"

  local cleared_consecutive
  cleared_consecutive=$(echo "$cleared_state" | jq -r '.consecutive_rate_limits')
  assert_eq "0" "$cleared_consecutive" "cleared consecutive"
}

# =============================================================================
# Test 3: Allowlist Rejection Integration
#
# Creates real repos with .git directories and validates allowlist enforcement
# with actual filesystem paths and symlinks.
# =============================================================================
test_allowlist_rejection_integration() {
  # Create real git repos
  mkdir -p "${_TEST_DIR}/allowed-repo/.git"
  mkdir -p "${_TEST_DIR}/forbidden-repo/.git"

  local config
  config=$(jq -nc --arg repo "${_TEST_DIR}/allowed-repo" '{repositories: {allowlist: [$repo]}}')

  # Allowed repo should pass
  local rc_allowed=0
  validate_repository "${_TEST_DIR}/allowed-repo" "$config" 2>/dev/null || rc_allowed=$?
  assert_eq "0" "$rc_allowed" "allowed repo passes"

  # Forbidden repo should be rejected
  local rc_forbidden=0
  validate_repository "${_TEST_DIR}/forbidden-repo" "$config" 2>/dev/null || rc_forbidden=$?
  assert_eq "1" "$rc_forbidden" "forbidden repo rejected"

  # Symlink test: create a symlink to allowed-repo
  ln -s "${_TEST_DIR}/allowed-repo" "${_TEST_DIR}/link-to-allowed"

  # Symlink to allowed repo should also pass
  local rc_symlink=0
  validate_repository "${_TEST_DIR}/link-to-allowed" "$config" 2>/dev/null || rc_symlink=$?
  assert_eq "0" "$rc_symlink" "symlink to allowed repo passes"

  # Path without .git should be rejected even if on allowlist
  mkdir -p "${_TEST_DIR}/no-git-repo"
  local config2
  config2=$(jq -nc --arg repo "${_TEST_DIR}/no-git-repo" '{repositories: {allowlist: [$repo]}}')

  local rc_nogit=0
  validate_repository "${_TEST_DIR}/no-git-repo" "$config2" 2>/dev/null || rc_nogit=$?
  assert_eq "1" "$rc_nogit" "no .git directory rejected even if on allowlist"

  # Non-existent path should be rejected
  local rc_nonexist=0
  validate_repository "${_TEST_DIR}/does-not-exist" "$config" 2>/dev/null || rc_nonexist=$?
  assert_eq "1" "$rc_nonexist" "non-existent path rejected"
}

# =============================================================================
# Run all tests
# =============================================================================
echo "SPEC-010-3-04: Resource Monitoring Integration Tests"
echo "======================================================"

run_test "Disk limit enforcement (real files)"                 test_disk_limit_enforcement
run_test "Rate-limit backoff sequence (full walk)"             test_rate_limit_backoff_sequence
run_test "Allowlist rejection (real repos)"                    test_allowlist_rejection_integration

report
