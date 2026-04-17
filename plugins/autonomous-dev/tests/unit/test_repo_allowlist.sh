#!/usr/bin/env bash
# test_repo_allowlist.sh -- Unit tests for repository allowlist validation
# Part of SPEC-010-3-04: Unit and Integration Tests for Resource Monitoring
#
# Tests: validate_repository(), get_repo_override()
#        in lib/repo_allowlist.sh
# Test count: 10
#
# Requires: jq (1.6+), bash 4+, realpath
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source shared test harness
source "${SCRIPT_DIR}/../test_harness.sh"

# Source the module under test
source "${PROJECT_ROOT}/lib/repo_allowlist.sh"

# =============================================================================
# Override setup to create test repos and symlinks
# =============================================================================
setup() {
  _TEST_DIR="$(mktemp -d)"
  chmod 0700 "$_TEST_DIR"

  # Create test repos
  mkdir -p "${_TEST_DIR}/repo-a/.git"
  mkdir -p "${_TEST_DIR}/repo-b/.git"
  mkdir -p "${_TEST_DIR}/not-a-repo"

  # Create symlink to repo-a
  ln -s "${_TEST_DIR}/repo-a" "${_TEST_DIR}/link-to-repo-a"
}

# =============================================================================
# Test 1: exact_match -- /test/repo-a in allowlist. Validates.
# =============================================================================
test_exact_match() {
  local config
  config=$(jq -nc --arg repo "${_TEST_DIR}/repo-a" '{repositories: {allowlist: [$repo]}}')

  local rc=0
  validate_repository "${_TEST_DIR}/repo-a" "$config" 2>/dev/null || rc=$?
  assert_eq "0" "$rc" "exact match should validate"
}

# =============================================================================
# Test 2: symlink_match -- Allowlist has repo-a. Input is link-to-repo-a. Validates.
# =============================================================================
test_symlink_match() {
  local config
  config=$(jq -nc --arg repo "${_TEST_DIR}/repo-a" '{repositories: {allowlist: [$repo]}}')

  local rc=0
  validate_repository "${_TEST_DIR}/link-to-repo-a" "$config" 2>/dev/null || rc=$?
  assert_eq "0" "$rc" "symlink should resolve and validate"
}

# =============================================================================
# Test 3: not_in_allowlist -- repo-b not in allowlist. Rejected.
# =============================================================================
test_not_in_allowlist() {
  local config
  config=$(jq -nc --arg repo "${_TEST_DIR}/repo-a" '{repositories: {allowlist: [$repo]}}')

  local rc=0
  validate_repository "${_TEST_DIR}/repo-b" "$config" 2>/dev/null || rc=$?
  assert_eq "1" "$rc" "repo not in allowlist should be rejected"
}

# =============================================================================
# Test 4: non_existent_path -- /test/does-not-exist. Rejected.
# =============================================================================
test_non_existent_path() {
  local config
  config=$(jq -nc --arg repo "${_TEST_DIR}/repo-a" '{repositories: {allowlist: [$repo]}}')

  local rc=0
  validate_repository "${_TEST_DIR}/does-not-exist" "$config" 2>/dev/null || rc=$?
  assert_eq "1" "$rc" "non-existent path should be rejected"
}

# =============================================================================
# Test 5: no_git_directory -- not-a-repo has no .git. Rejected.
# =============================================================================
test_no_git_directory() {
  local config
  config=$(jq -nc --arg repo "${_TEST_DIR}/not-a-repo" '{repositories: {allowlist: [$repo]}}')

  local rc=0
  validate_repository "${_TEST_DIR}/not-a-repo" "$config" 2>/dev/null || rc=$?
  assert_eq "1" "$rc" "path without .git should be rejected"
}

# =============================================================================
# Test 6: empty_allowlist -- Allowlist is []. Any repo rejected.
# =============================================================================
test_empty_allowlist() {
  local config
  config=$(jq -nc '{repositories: {allowlist: []}}')

  local rc=0
  validate_repository "${_TEST_DIR}/repo-a" "$config" 2>/dev/null || rc=$?
  assert_eq "1" "$rc" "empty allowlist should reject everything"
}

# =============================================================================
# Test 7: single_entry_allowlist -- One repo in list. That repo passes, others fail.
# =============================================================================
test_single_entry_allowlist() {
  local config
  config=$(jq -nc --arg repo "${_TEST_DIR}/repo-a" '{repositories: {allowlist: [$repo]}}')

  # repo-a should pass
  local rc_a=0
  validate_repository "${_TEST_DIR}/repo-a" "$config" 2>/dev/null || rc_a=$?
  assert_eq "0" "$rc_a" "listed repo should validate"

  # repo-b should fail
  local rc_b=0
  validate_repository "${_TEST_DIR}/repo-b" "$config" 2>/dev/null || rc_b=$?
  assert_eq "1" "$rc_b" "unlisted repo should be rejected"
}

# =============================================================================
# Test 8: allowlist_entry_is_symlink -- Allowlist contains link-to-repo-a.
#   Input is repo-a. Both resolve to same realpath. Validates.
# =============================================================================
test_allowlist_entry_is_symlink() {
  local config
  config=$(jq -nc --arg repo "${_TEST_DIR}/link-to-repo-a" '{repositories: {allowlist: [$repo]}}')

  local rc=0
  validate_repository "${_TEST_DIR}/repo-a" "$config" 2>/dev/null || rc=$?
  assert_eq "0" "$rc" "symlink in allowlist should resolve and match real path"
}

# =============================================================================
# Test 9: multiple_repos_in_allowlist -- Both repo-a and repo-b. Both validate.
# =============================================================================
test_multiple_repos_in_allowlist() {
  local config
  config=$(jq -nc \
    --arg a "${_TEST_DIR}/repo-a" \
    --arg b "${_TEST_DIR}/repo-b" \
    '{repositories: {allowlist: [$a, $b]}}')

  local rc_a=0
  validate_repository "${_TEST_DIR}/repo-a" "$config" 2>/dev/null || rc_a=$?
  assert_eq "0" "$rc_a" "repo-a should validate"

  local rc_b=0
  validate_repository "${_TEST_DIR}/repo-b" "$config" 2>/dev/null || rc_b=$?
  assert_eq "0" "$rc_b" "repo-b should validate"
}

# =============================================================================
# Test 10: allowlist_path_resolution_failure -- Allowlist contains /test/gone (deleted).
#   That entry is skipped with warning. Other entries still work.
# =============================================================================
test_allowlist_path_resolution_failure() {
  # Create a path, add it to allowlist, then delete it
  local gone_dir="${_TEST_DIR}/gone-repo"
  mkdir -p "${gone_dir}/.git"

  local config
  config=$(jq -nc \
    --arg gone "$gone_dir" \
    --arg repo "${_TEST_DIR}/repo-a" \
    '{repositories: {allowlist: [$gone, $repo]}}')

  # Now remove the gone directory
  rm -rf "$gone_dir"

  # repo-a should still validate even though gone-repo is in the list and can't resolve
  local rc=0
  validate_repository "${_TEST_DIR}/repo-a" "$config" 2>/dev/null || rc=$?
  assert_eq "0" "$rc" "repo-a should validate even when another allowlist entry is gone"
}

# =============================================================================
# Run all tests
# =============================================================================
echo "SPEC-010-3-04: Repository Allowlist Unit Tests"
echo "================================================"

run_test "Exact match validates"                               test_exact_match
run_test "Symlink match validates"                             test_symlink_match
run_test "Not in allowlist rejected"                           test_not_in_allowlist
run_test "Non-existent path rejected"                          test_non_existent_path
run_test "No .git directory rejected"                          test_no_git_directory
run_test "Empty allowlist rejects all"                         test_empty_allowlist
run_test "Single entry: listed passes, other fails"            test_single_entry_allowlist
run_test "Allowlist entry is symlink"                          test_allowlist_entry_is_symlink
run_test "Multiple repos in allowlist"                         test_multiple_repos_in_allowlist
run_test "Allowlist path resolution failure"                   test_allowlist_path_resolution_failure

report
