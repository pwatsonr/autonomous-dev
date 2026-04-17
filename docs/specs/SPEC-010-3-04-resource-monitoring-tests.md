# SPEC-010-3-04: Unit and Integration Tests for Resource Monitoring

## Metadata
- **Parent Plan**: PLAN-010-3
- **Tasks Covered**: Task 11, Task 12
- **Estimated effort**: 9 hours

## Description

Build unit tests for all resource monitoring, rate-limit, and allowlist logic, plus integration tests using real filesystem operations for disk-limit enforcement and rate-limit backoff sequence simulation.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Create | `test/unit/test_resource_monitor.sh` | Disk, worktree, session monitoring tests |
| Create | `test/unit/test_rate_limit_handler.sh` | Rate-limit detection and backoff tests |
| Create | `test/unit/test_repo_allowlist.sh` | Allowlist validation tests |
| Create | `test/integration/test_resource_monitoring.sh` | End-to-end resource monitoring tests |

## Implementation Details

### test/unit/test_resource_monitor.sh

**Test setup**: Uses mocked `du` output and state files in temp directories.

```bash
setup() {
  TEST_DIR=$(mktemp -d)
  export HOME="${TEST_DIR}/home"
  mkdir -p "${HOME}/.autonomous-dev"
  export PLUGIN_ROOT="$PROJECT_ROOT"
}
```

**Test cases** (15 minimum):

1. **disk_under_limit**: Mock `du` returns 5GB. Limit 10GB. Status `ok`.
2. **disk_at_warning**: Mock worktree `du` returns 2.1GB. Warning threshold 2.0GB. Status `warning`.
3. **disk_at_hard_limit**: Mock worktree `du` returns 5.5GB. Hard limit 5.0GB. Status `exceeded`.
4. **system_disk_exceeded**: Mock `~/.autonomous-dev/` at 11GB. Limit 10GB. Status `fail`.
5. **du_failure_skips**: Mock `du` to return non-zero. Check returns `pass` (not blocked).
6. **byte_to_gb_conversion**: 5368709120 bytes = 5.00 GB exactly.
7. **worktree_count_under**: Mock `git worktree list` output with 3 worktrees. Max 5. Pass.
8. **worktree_count_at_max**: 5 worktrees. Max 5. Fail.
9. **worktree_count_zero**: Repo with only main working tree. Count = 0.
10. **worktree_git_failure**: Mock `git worktree list` failure. Assume at max.
11. **sessions_under_max**: Create 2 state files with live mock PIDs. Max 3. Pass.
12. **sessions_at_max**: 3 active. Max 3. Fail.
13. **sessions_dead_pid**: State file has PID 99999 (not running). Not counted.
14. **sessions_terminal_excluded**: State file has `status: completed` with live PID. Not counted.
15. **sessions_malformed_state**: State file has invalid JSON. Skipped.

### test/unit/test_rate_limit_handler.sh

**Test cases** (20 minimum):

1. **detect_http_429**: Output has `HTTP/1.1 429`. Detected.
2. **detect_status_429**: Output has `status: 429`. Detected.
3. **detect_rate_limit_exceeded**: Output has `Rate limit exceeded`. Detected.
4. **detect_rate_limit_underscore**: Output has `rate_limit_exceeded`. Detected.
5. **detect_too_many_requests**: Output has `Too many requests`. Detected.
6. **detect_anthropic_specific**: Output has `anthropic api rate limit`. Detected.
7. **no_false_positive_approval_rate**: Output has `approval rate threshold exceeded`. NOT detected.
8. **no_false_positive_error_rate**: Output has `error rate is 5%`. NOT detected.
9. **normal_output_no_detection**: Standard output with no rate-limit indicators. NOT detected.
10. **backoff_step_1**: First rate limit. `consecutive=1`, `backoff=30` (base=30).
11. **backoff_step_2**: `consecutive=2`, `backoff=60`.
12. **backoff_step_3**: `consecutive=3`, `backoff=120`.
13. **backoff_step_4**: `consecutive=4`, `backoff=240`.
14. **backoff_step_5**: `consecutive=5`, `backoff=480`.
15. **backoff_step_6_kill**: `consecutive=6`, computed `backoff=960 > 900`. Kill switch activated. Escalation emitted.
16. **state_file_format**: After step 3, state file has all 5 required fields with correct values.
17. **pre_check_active_backoff**: `retry_at` is 60s in future. Returns 1.
18. **pre_check_expired_backoff**: `retry_at` is 60s in past. Returns 0.
19. **pre_check_kill_switch**: Kill switch true. Returns 1.
20. **clear_after_success**: Active state with consecutive=3. After clear, `active=false, consecutive=0`.
21. **clear_when_inactive**: Already inactive. No-op.
22. **missing_state_file**: No file. `check_rate_limit_state` returns 0.
23. **corrupted_state_file**: File has `{bad`. Deleted, returns 0.

### test/unit/test_repo_allowlist.sh

**Test cases** (10 minimum):

```bash
setup() {
  TEST_DIR=$(mktemp -d)
  # Create test repos
  mkdir -p "${TEST_DIR}/repo-a/.git"
  mkdir -p "${TEST_DIR}/repo-b/.git"
  mkdir -p "${TEST_DIR}/not-a-repo"
  ln -s "${TEST_DIR}/repo-a" "${TEST_DIR}/link-to-repo-a"
}
```

1. **exact_match**: `/test/repo-a` in allowlist. Validates.
2. **symlink_match**: Allowlist has `/test/repo-a`. Input is `/test/link-to-repo-a`. Validates (after realpath).
3. **not_in_allowlist**: `/test/repo-b` not in allowlist. Rejected.
4. **non_existent_path**: `/test/does-not-exist`. Rejected.
5. **no_git_directory**: `/test/not-a-repo` has no `.git`. Rejected.
6. **empty_allowlist**: Allowlist is `[]`. Any repo rejected.
7. **single_entry_allowlist**: One repo in list. That repo passes, others fail.
8. **allowlist_entry_is_symlink**: Allowlist contains `/test/link-to-repo-a`. Input is `/test/repo-a`. Both resolve to same realpath. Validates.
9. **multiple_repos_in_allowlist**: Both `/test/repo-a` and `/test/repo-b` in allowlist. Both validate.
10. **allowlist_path_resolution_failure**: Allowlist contains `/test/gone` (deleted). That entry is skipped with warning. Other entries still work.

### test/integration/test_resource_monitoring.sh

**End-to-end tests with real filesystem operations.**

#### Test 1: Disk Limit Enforcement

```bash
test_disk_limit_enforcement() {
  local test_dir="${TEST_DIR}/disk_test"
  mkdir -p "$test_dir"
  
  local config
  config=$(jq -nc '{
    governance: {disk_usage_limit_gb: 0.001},
    parallel: {disk_warning_threshold_gb: 0.0005, disk_hard_limit_gb: 0.001, max_worktrees: 5},
    repositories: {allowlist: []},
    "governance": {"max_concurrent_requests": 5, "rate_limit_backoff_base_seconds": 30, "rate_limit_backoff_max_seconds": 900}
  }')
  
  # Create files to approach limit (1MB = ~0.001GB)
  dd if=/dev/zero of="${HOME}/.autonomous-dev/testfile" bs=1024 count=512 2>/dev/null  # 512KB
  
  local result
  result=$(check_disk_usage "$config")
  local status
  status=$(echo "$result" | jq -r '.status')
  assert_eq "under limit" "pass" "$status"
  
  # Push over limit
  dd if=/dev/zero of="${HOME}/.autonomous-dev/testfile2" bs=1024 count=1024 2>/dev/null  # 1MB more
  
  result=$(check_disk_usage "$config")
  status=$(echo "$result" | jq -r '.status')
  assert_eq "over limit" "fail" "$status"
  
  # Clean up
  rm -f "${HOME}/.autonomous-dev/testfile" "${HOME}/.autonomous-dev/testfile2"
}
```

#### Test 2: Rate-Limit Backoff Sequence

```bash
test_rate_limit_backoff_sequence() {
  local config
  config=$(jq -nc '{governance: {rate_limit_backoff_base_seconds: 2, rate_limit_backoff_max_seconds: 20}}')
  
  # Simulate 4 consecutive rate limits with small backoffs (base=2s, max=20s)
  local backoffs=()
  for i in 1 2 3 4; do
    handle_rate_limit "$config"
    local state
    state=$(cat "${HOME}/.autonomous-dev/rate-limit-state.json")
    local backoff
    backoff=$(echo "$state" | jq -r '.current_backoff_seconds')
    backoffs+=("$backoff")
    local consecutive
    consecutive=$(echo "$state" | jq -r '.consecutive_rate_limits')
    assert_eq "consecutive after step $i" "$i" "$consecutive"
  done
  
  assert_eq "backoff step 1" "2" "${backoffs[0]}"
  assert_eq "backoff step 2" "4" "${backoffs[1]}"
  assert_eq "backoff step 3" "8" "${backoffs[2]}"
  assert_eq "backoff step 4" "16" "${backoffs[3]}"
  
  # Step 5: backoff would be 32 > 20 max -> kill switch
  handle_rate_limit "$config"
  local final_state
  final_state=$(cat "${HOME}/.autonomous-dev/rate-limit-state.json")
  local kill_switch
  kill_switch=$(echo "$final_state" | jq -r '.kill_switch')
  assert_eq "kill switch activated" "true" "$kill_switch"
  
  # Clear state
  clear_rate_limit_state
  local cleared_state
  cleared_state=$(cat "${HOME}/.autonomous-dev/rate-limit-state.json")
  local active
  active=$(echo "$cleared_state" | jq -r '.active')
  assert_eq "cleared active" "false" "$active"
}
```

#### Test 3: Allowlist Rejection

```bash
test_allowlist_rejection_integration() {
  mkdir -p "${TEST_DIR}/allowed-repo/.git"
  mkdir -p "${TEST_DIR}/forbidden-repo/.git"
  
  local config
  config=$(jq -nc --arg repo "${TEST_DIR}/allowed-repo" '{repositories: {allowlist: [$repo]}}')
  
  validate_repository "${TEST_DIR}/allowed-repo" "$config"
  assert_eq "allowed repo passes" "0" "$?"
  
  validate_repository "${TEST_DIR}/forbidden-repo" "$config" 2>/dev/null
  assert_eq "forbidden repo rejected" "1" "$?"
}
```

**Cleanup**: All tests use `trap teardown EXIT` to remove temp directories.

## Acceptance Criteria

1. `test_resource_monitor.sh` has at least 15 test cases.
2. `test_rate_limit_handler.sh` has at least 20 test cases.
3. `test_repo_allowlist.sh` has at least 10 test cases.
4. Integration tests use real files and directories (not mocks).
5. Disk-limit test creates actual files to trigger thresholds.
6. Rate-limit test walks through the full backoff sequence and verifies state at each step.
7. Allowlist test creates real repos with `.git` directories.
8. All temp artifacts are cleaned up after tests.
9. Tests cover both macOS and Linux `du` behavior (or document platform-specific skipping).

## Test Cases

All 48+ test cases are enumerated in the Implementation Details section above:
- 15 resource monitor tests
- 23 rate-limit handler tests
- 10 allowlist tests
- 3 integration test scenarios
