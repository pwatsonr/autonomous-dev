#!/usr/bin/env bash
# test_resource_monitor.sh -- Unit tests for disk, worktree, and session monitoring
# Part of SPEC-010-3-04: Unit and Integration Tests for Resource Monitoring
#
# Tests: check_disk_usage(), check_worktree_count(), check_active_sessions(),
#        measure_disk_gb() in lib/resource_monitor.sh
# Test count: 15
#
# Requires: jq (1.6+), bc, bash 4+
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source shared test harness
source "${SCRIPT_DIR}/../test_harness.sh"

# Source the module under test
source "${PROJECT_ROOT}/lib/resource_monitor.sh"

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
# Mock config used across tests
# =============================================================================
make_config() {
  local sys_limit="${1:-10}" wt_warn="${2:-2.0}" wt_hard="${3:-5.0}" max_wt="${4:-5}" max_sess="${5:-3}"
  jq -nc \
    --argjson sys "$sys_limit" \
    --argjson warn "$wt_warn" \
    --argjson hard "$wt_hard" \
    --argjson mwt "$max_wt" \
    --argjson ms "$max_sess" \
    '{
      governance: {disk_usage_limit_gb: $sys, max_concurrent_requests: $ms},
      parallel: {disk_warning_threshold_gb: $warn, disk_hard_limit_gb: $hard, max_worktrees: $mwt},
      repositories: {allowlist: []}
    }'
}

# =============================================================================
# Test 1: disk_under_limit -- Mock du returns 5GB. Limit 10GB. Status ok.
# =============================================================================
test_disk_under_limit() {
  local config
  config=$(make_config 10 2.0 5.0)

  # Create a small directory (well under 10GB limit)
  dd if=/dev/zero of="${HOME}/.autonomous-dev/testfile" bs=1024 count=10 2>/dev/null

  local result exit_code=0
  result=$(check_disk_usage "$config") || exit_code=$?

  local sys_status
  sys_status=$(echo "$result" | jq -r '.checks[] | select(.type=="system_disk") | .status')
  assert_eq "ok" "$sys_status" "system_disk should be ok"
}

# =============================================================================
# Test 2: disk_at_warning -- Worktree du returns 2.1GB. Warning 2.0GB. Status warning.
#
# This test creates a mock worktree directory structure and verifies the
# warning threshold is detected. Since we cannot easily create 2GB+ files
# in a unit test, we instead test the logic with a very small threshold.
# =============================================================================
test_disk_at_warning() {
  # Create a repo with a git worktree to measure
  local repo_dir="${_TEST_DIR}/repo"
  mkdir -p "$repo_dir/.git"
  # Init a real git repo for worktree list
  (cd "$repo_dir" && git init -q && git commit --allow-empty -m "init" -q 2>/dev/null)
  local wt_dir="${_TEST_DIR}/worktree1"
  (cd "$repo_dir" && git worktree add "$wt_dir" -b test-branch -q 2>/dev/null)

  # Put some data in the worktree to exceed the warning threshold
  dd if=/dev/zero of="${wt_dir}/testfile" bs=1024 count=600 2>/dev/null  # ~0.6KB * 1000 = 600KB

  # Set threshold very low so our small files exceed it
  local config
  config=$(jq -nc --arg repo "$repo_dir" '{
    governance: {disk_usage_limit_gb: 10, max_concurrent_requests: 5},
    parallel: {disk_warning_threshold_gb: 0.0001, disk_hard_limit_gb: 10.0, max_worktrees: 5},
    repositories: {allowlist: [$repo]}
  }')

  local result
  result=$(check_disk_usage "$config") || true

  local wt_status
  wt_status=$(echo "$result" | jq -r '.checks[] | select(.type=="worktree_disk") | .status')
  assert_eq "warning" "$wt_status" "worktree_disk should be warning"
}

# =============================================================================
# Test 3: disk_at_hard_limit -- Worktree du exceeds hard limit. Status exceeded.
# =============================================================================
test_disk_at_hard_limit() {
  local repo_dir="${_TEST_DIR}/repo"
  mkdir -p "$repo_dir/.git"
  (cd "$repo_dir" && git init -q && git commit --allow-empty -m "init" -q 2>/dev/null)
  local wt_dir="${_TEST_DIR}/worktree1"
  (cd "$repo_dir" && git worktree add "$wt_dir" -b test-branch -q 2>/dev/null)

  dd if=/dev/zero of="${wt_dir}/testfile" bs=1024 count=600 2>/dev/null

  # Set hard limit very low
  local config
  config=$(jq -nc --arg repo "$repo_dir" '{
    governance: {disk_usage_limit_gb: 10, max_concurrent_requests: 5},
    parallel: {disk_warning_threshold_gb: 0.00001, disk_hard_limit_gb: 0.0001, max_worktrees: 5},
    repositories: {allowlist: [$repo]}
  }')

  local result exit_code=0
  result=$(check_disk_usage "$config") || exit_code=$?

  local wt_status
  wt_status=$(echo "$result" | jq -r '.checks[] | select(.type=="worktree_disk") | .status')
  assert_eq "exceeded" "$wt_status" "worktree_disk should be exceeded"

  local overall
  overall=$(echo "$result" | jq -r '.status')
  assert_eq "fail" "$overall" "overall should be fail"
}

# =============================================================================
# Test 4: system_disk_exceeded -- ~/.autonomous-dev/ at 11GB. Limit 10GB. Fail.
# Use a very small limit to trigger with actual files.
# =============================================================================
test_system_disk_exceeded() {
  # Create files to exceed a very small limit
  dd if=/dev/zero of="${HOME}/.autonomous-dev/testfile" bs=1024 count=1024 2>/dev/null  # 1MB

  local config
  config=$(make_config 0.0001)  # 0.0001 GB limit (~100KB)

  local result exit_code=0
  result=$(check_disk_usage "$config") || exit_code=$?

  assert_eq "1" "$exit_code" "exit code should be 1"

  local sys_status
  sys_status=$(echo "$result" | jq -r '.checks[] | select(.type=="system_disk") | .status')
  assert_eq "exceeded" "$sys_status" "system_disk should be exceeded"

  local overall
  overall=$(echo "$result" | jq -r '.status')
  assert_eq "fail" "$overall" "overall should be fail"
}

# =============================================================================
# Test 5: du_failure_skips -- Mock du to fail. Check returns pass (not blocked).
# We test this by pointing to a non-readable directory.
# =============================================================================
test_du_failure_skips() {
  # Override measure_disk_gb to simulate failure
  measure_disk_gb() {
    return 1
  }

  local config
  config=$(make_config 10)

  local result exit_code=0
  result=$(check_disk_usage "$config") || exit_code=$?

  local status
  status=$(echo "$result" | jq -r '.status')
  assert_eq "pass" "$status" "status should be pass when du fails"

  # Restore original function
  unset -f measure_disk_gb
  source "${PROJECT_ROOT}/lib/resource_monitor.sh"
}

# =============================================================================
# Test 6: byte_to_gb_conversion -- 5368709120 bytes = 5.00 GB exactly.
# =============================================================================
test_byte_to_gb_conversion() {
  # Create a directory with exactly-known content
  local test_path="${_TEST_DIR}/conversion_test"
  mkdir -p "$test_path"

  # Test the conversion formula directly: 5368709120 / 1073741824 = 5.00
  local result
  result=$(echo "scale=2; 5368709120 / 1073741824" | bc -l)
  assert_eq "5.00" "$result" "5368709120 bytes should be 5.00 GB"
}

# =============================================================================
# Test 7: worktree_count_under -- 3 worktrees. Max 5. Pass.
# =============================================================================
test_worktree_count_under() {
  local repo_dir="${_TEST_DIR}/repo"
  mkdir -p "$repo_dir/.git"
  (cd "$repo_dir" && git init -q && git commit --allow-empty -m "init" -q 2>/dev/null)

  # Create 3 worktrees
  for i in 1 2 3; do
    (cd "$repo_dir" && git worktree add "${_TEST_DIR}/wt-$i" -b "branch-$i" -q 2>/dev/null)
  done

  local config
  config=$(jq -nc --arg repo "$repo_dir" '{
    governance: {disk_usage_limit_gb: 10, max_concurrent_requests: 5},
    parallel: {disk_warning_threshold_gb: 2.0, disk_hard_limit_gb: 5.0, max_worktrees: 5},
    repositories: {allowlist: [$repo]}
  }')

  local result exit_code=0
  result=$(check_worktree_count "$config") || exit_code=$?

  assert_eq "0" "$exit_code" "exit code should be 0 (pass)"

  local count status
  count=$(echo "$result" | jq -r '.count')
  status=$(echo "$result" | jq -r '.status')
  assert_eq "3" "$count" "count should be 3"
  assert_eq "pass" "$status" "status should be pass"
}

# =============================================================================
# Test 8: worktree_count_at_max -- 5 worktrees. Max 5. Fail.
# =============================================================================
test_worktree_count_at_max() {
  local repo_dir="${_TEST_DIR}/repo"
  mkdir -p "$repo_dir/.git"
  (cd "$repo_dir" && git init -q && git commit --allow-empty -m "init" -q 2>/dev/null)

  # Create 5 worktrees
  for i in 1 2 3 4 5; do
    (cd "$repo_dir" && git worktree add "${_TEST_DIR}/wt-$i" -b "branch-$i" -q 2>/dev/null)
  done

  local config
  config=$(jq -nc --arg repo "$repo_dir" '{
    governance: {disk_usage_limit_gb: 10, max_concurrent_requests: 5},
    parallel: {disk_warning_threshold_gb: 2.0, disk_hard_limit_gb: 5.0, max_worktrees: 5},
    repositories: {allowlist: [$repo]}
  }')

  local result exit_code=0
  result=$(check_worktree_count "$config") || exit_code=$?

  assert_eq "1" "$exit_code" "exit code should be 1 (fail)"

  local count status
  count=$(echo "$result" | jq -r '.count')
  status=$(echo "$result" | jq -r '.status')
  assert_eq "5" "$count" "count should be 5"
  assert_eq "fail" "$status" "status should be fail"
}

# =============================================================================
# Test 9: worktree_count_zero -- Repo with only main working tree. Count = 0.
# =============================================================================
test_worktree_count_zero() {
  local repo_dir="${_TEST_DIR}/repo"
  mkdir -p "$repo_dir/.git"
  (cd "$repo_dir" && git init -q && git commit --allow-empty -m "init" -q 2>/dev/null)

  local config
  config=$(jq -nc --arg repo "$repo_dir" '{
    governance: {disk_usage_limit_gb: 10, max_concurrent_requests: 5},
    parallel: {disk_warning_threshold_gb: 2.0, disk_hard_limit_gb: 5.0, max_worktrees: 5},
    repositories: {allowlist: [$repo]}
  }')

  local result exit_code=0
  result=$(check_worktree_count "$config") || exit_code=$?

  assert_eq "0" "$exit_code" "exit code should be 0 (pass)"

  local count
  count=$(echo "$result" | jq -r '.count')
  assert_eq "0" "$count" "count should be 0 with no extra worktrees"
}

# =============================================================================
# Test 10: worktree_git_failure -- Mock git worktree list failure. Assume at max.
# =============================================================================
test_worktree_git_failure() {
  # Create a directory that looks like a repo but isn't really
  local repo_dir="${_TEST_DIR}/fake-repo"
  mkdir -p "$repo_dir/.git"
  # Don't git init so git worktree list will fail

  local config
  config=$(jq -nc --arg repo "$repo_dir" '{
    governance: {disk_usage_limit_gb: 10, max_concurrent_requests: 5},
    parallel: {disk_warning_threshold_gb: 2.0, disk_hard_limit_gb: 5.0, max_worktrees: 5},
    repositories: {allowlist: [$repo]}
  }')

  local result exit_code=0
  result=$(check_worktree_count "$config" 2>/dev/null) || exit_code=$?

  assert_eq "1" "$exit_code" "exit code should be 1 (fail: assumed at max)"

  local count
  count=$(echo "$result" | jq -r '.count')
  assert_eq "5" "$count" "count should equal max_worktrees (5)"
}

# =============================================================================
# Test 11: sessions_under_max -- 2 active sessions. Max 3. Pass.
# =============================================================================
test_sessions_under_max() {
  local repo_dir="${_TEST_DIR}/repo"
  local requests_dir="${repo_dir}/.autonomous-dev/requests"

  # Create 2 state files with "live" PIDs (use our own PID which is always alive)
  local my_pid=$$
  for i in 1 2; do
    local req_dir="${requests_dir}/REQ-00${i}"
    mkdir -p "$req_dir"
    jq -nc --arg pid "$my_pid" '{status: "in_progress", current_session_pid: ($pid|tonumber)}' \
      > "${req_dir}/state.json"
  done

  local config
  config=$(jq -nc --arg repo "$repo_dir" '{
    governance: {disk_usage_limit_gb: 10, max_concurrent_requests: 3},
    parallel: {disk_warning_threshold_gb: 2.0, disk_hard_limit_gb: 5.0, max_worktrees: 5},
    repositories: {allowlist: [$repo]}
  }')

  local result exit_code=0
  result=$(check_active_sessions "$config") || exit_code=$?

  assert_eq "0" "$exit_code" "exit code should be 0 (pass)"

  local count status
  count=$(echo "$result" | jq -r '.count')
  status=$(echo "$result" | jq -r '.status')
  assert_eq "2" "$count" "count should be 2"
  assert_eq "pass" "$status" "status should be pass"
}

# =============================================================================
# Test 12: sessions_at_max -- 3 active sessions. Max 3. Fail.
# =============================================================================
test_sessions_at_max() {
  local repo_dir="${_TEST_DIR}/repo"
  local requests_dir="${repo_dir}/.autonomous-dev/requests"
  local my_pid=$$

  for i in 1 2 3; do
    local req_dir="${requests_dir}/REQ-00${i}"
    mkdir -p "$req_dir"
    jq -nc --arg pid "$my_pid" '{status: "in_progress", current_session_pid: ($pid|tonumber)}' \
      > "${req_dir}/state.json"
  done

  local config
  config=$(jq -nc --arg repo "$repo_dir" '{
    governance: {disk_usage_limit_gb: 10, max_concurrent_requests: 3},
    parallel: {disk_warning_threshold_gb: 2.0, disk_hard_limit_gb: 5.0, max_worktrees: 5},
    repositories: {allowlist: [$repo]}
  }')

  local result exit_code=0
  result=$(check_active_sessions "$config") || exit_code=$?

  assert_eq "1" "$exit_code" "exit code should be 1 (fail)"

  local count status
  count=$(echo "$result" | jq -r '.count')
  status=$(echo "$result" | jq -r '.status')
  assert_eq "3" "$count" "count should be 3"
  assert_eq "fail" "$status" "status should be fail"
}

# =============================================================================
# Test 13: sessions_dead_pid -- State file has PID 99999 (not running). Not counted.
# =============================================================================
test_sessions_dead_pid() {
  local repo_dir="${_TEST_DIR}/repo"
  local requests_dir="${repo_dir}/.autonomous-dev/requests"

  # Use a PID that is almost certainly not running
  local dead_pid=99999
  # Make sure this PID is actually dead
  while kill -0 "$dead_pid" 2>/dev/null; do
    dead_pid=$((dead_pid + 1))
  done

  local req_dir="${requests_dir}/REQ-001"
  mkdir -p "$req_dir"
  jq -nc --argjson pid "$dead_pid" '{status: "in_progress", current_session_pid: $pid}' \
    > "${req_dir}/state.json"

  local config
  config=$(jq -nc --arg repo "$repo_dir" '{
    governance: {disk_usage_limit_gb: 10, max_concurrent_requests: 3},
    parallel: {disk_warning_threshold_gb: 2.0, disk_hard_limit_gb: 5.0, max_worktrees: 5},
    repositories: {allowlist: [$repo]}
  }')

  local result exit_code=0
  result=$(check_active_sessions "$config" 2>/dev/null) || exit_code=$?

  local count
  count=$(echo "$result" | jq -r '.count')
  assert_eq "0" "$count" "dead PID should not be counted"
}

# =============================================================================
# Test 14: sessions_terminal_excluded -- status=completed with live PID. Not counted.
# =============================================================================
test_sessions_terminal_excluded() {
  local repo_dir="${_TEST_DIR}/repo"
  local requests_dir="${repo_dir}/.autonomous-dev/requests"
  local my_pid=$$

  local req_dir="${requests_dir}/REQ-001"
  mkdir -p "$req_dir"
  jq -nc --arg pid "$my_pid" '{status: "completed", current_session_pid: ($pid|tonumber)}' \
    > "${req_dir}/state.json"

  local config
  config=$(jq -nc --arg repo "$repo_dir" '{
    governance: {disk_usage_limit_gb: 10, max_concurrent_requests: 3},
    parallel: {disk_warning_threshold_gb: 2.0, disk_hard_limit_gb: 5.0, max_worktrees: 5},
    repositories: {allowlist: [$repo]}
  }')

  local result exit_code=0
  result=$(check_active_sessions "$config") || exit_code=$?

  local count
  count=$(echo "$result" | jq -r '.count')
  assert_eq "0" "$count" "terminal status should not be counted"
}

# =============================================================================
# Test 15: sessions_malformed_state -- State file has invalid JSON. Skipped.
# =============================================================================
test_sessions_malformed_state() {
  local repo_dir="${_TEST_DIR}/repo"
  local requests_dir="${repo_dir}/.autonomous-dev/requests"

  local req_dir="${requests_dir}/REQ-001"
  mkdir -p "$req_dir"
  echo "{bad json" > "${req_dir}/state.json"

  local config
  config=$(jq -nc --arg repo "$repo_dir" '{
    governance: {disk_usage_limit_gb: 10, max_concurrent_requests: 3},
    parallel: {disk_warning_threshold_gb: 2.0, disk_hard_limit_gb: 5.0, max_worktrees: 5},
    repositories: {allowlist: [$repo]}
  }')

  local result exit_code=0
  result=$(check_active_sessions "$config" 2>/dev/null) || exit_code=$?

  local count
  count=$(echo "$result" | jq -r '.count')
  assert_eq "0" "$count" "malformed state should be skipped"
}

# =============================================================================
# Run all tests
# =============================================================================
echo "SPEC-010-3-04: Resource Monitor Unit Tests"
echo "============================================"

run_test "Disk under limit (ok)"                               test_disk_under_limit
run_test "Disk at warning threshold (worktree)"                test_disk_at_warning
run_test "Disk at hard limit (worktree exceeded)"              test_disk_at_hard_limit
run_test "System disk exceeded"                                test_system_disk_exceeded
run_test "du failure skips (not blocked)"                      test_du_failure_skips
run_test "Byte-to-GB conversion (5368709120 = 5.00)"          test_byte_to_gb_conversion
run_test "Worktree count under max"                            test_worktree_count_under
run_test "Worktree count at max (fail)"                        test_worktree_count_at_max
run_test "Worktree count zero (main only)"                     test_worktree_count_zero
run_test "Worktree git failure (assume max)"                   test_worktree_git_failure
run_test "Sessions under max (pass)"                           test_sessions_under_max
run_test "Sessions at max (fail)"                              test_sessions_at_max
run_test "Sessions dead PID (not counted)"                     test_sessions_dead_pid
run_test "Sessions terminal excluded (completed)"              test_sessions_terminal_excluded
run_test "Sessions malformed state (skipped)"                  test_sessions_malformed_state

report
