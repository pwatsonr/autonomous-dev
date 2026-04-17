# SPEC-010-4-05: Unit and Integration Tests for Cleanup and Retention

## Metadata
- **Parent Plan**: PLAN-010-4
- **Tasks Covered**: Task 15, Task 16
- **Estimated effort**: 9 hours

## Description

Build unit tests for retention age calculation, archive creation, dry-run mode, worktree cleanup, remote branch deletion, log rotation, cost ledger rotation, and tarball pruning. Build integration tests that create a set of test artifacts at various ages, run cleanup, and verify correct behavior.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Create | `test/unit/test_cleanup_engine.sh` | Retention, archival, and cleanup unit tests |
| Create | `test/unit/test_ledger_rotation.sh` | Cost ledger rotation and pruning tests |
| Create | `test/integration/test_cleanup_integration.sh` | End-to-end cleanup test with real artifacts |

## Implementation Details

### test/unit/test_cleanup_engine.sh

**Test setup**: Creates temp directories with backdated artifacts.

```bash
setup() {
  TEST_DIR=$(mktemp -d)
  export HOME="${TEST_DIR}/home"
  mkdir -p "${HOME}/.autonomous-dev/archive"
  mkdir -p "${HOME}/.autonomous-dev/logs"
  
  FAKE_REPO="${TEST_DIR}/repo"
  mkdir -p "${FAKE_REPO}/.git"
  mkdir -p "${FAKE_REPO}/.autonomous-dev/requests"
  mkdir -p "${FAKE_REPO}/.autonomous-dev/observations/archive"
  
  export PLUGIN_ROOT="$PROJECT_ROOT"
}
```

**Utility for backdating files**:

```bash
backdate_file() {
  local file="$1"
  local days_ago="$2"
  if [[ "$(uname)" == "Darwin" ]]; then
    local ts
    ts=$(date -u -v "-${days_ago}d" +"%Y%m%d%H%M.%S")
    touch -t "$ts" "$file"
  else
    touch -d "-${days_ago} days" "$file"
  fi
}

create_test_request() {
  local request_id="$1"
  local status="$2"
  local days_ago="$3"
  
  local req_dir="${FAKE_REPO}/.autonomous-dev/requests/${request_id}"
  mkdir -p "$req_dir"
  
  local updated_at
  if [[ "$(uname)" == "Darwin" ]]; then
    updated_at=$(date -u -v "-${days_ago}d" +"%Y-%m-%dT%H:%M:%SZ")
  else
    updated_at=$(date -u -d "-${days_ago} days" +"%Y-%m-%dT%H:%M:%SZ")
  fi
  
  cat > "${req_dir}/state.json" <<EOF
{"request_id":"${request_id}","status":"${status}","updated_at":"${updated_at}","cost_accrued_usd":5.00,"phase_history":[{"phase":"prd","cost_usd":5.00}]}
EOF
  echo '{"event":"test"}' > "${req_dir}/events.jsonl"
  backdate_file "${req_dir}/state.json" "$days_ago"
  backdate_file "${req_dir}/events.jsonl" "$days_ago"
}
```

**Test cases** (20 minimum):

1. **age_request_from_updated_at**: Request `updated_at` is 31 days ago. `get_artifact_age_days` returns 31.
2. **age_request_within_retention**: `updated_at` is 29 days ago, retention 30. `is_artifact_expired` returns false.
3. **age_request_past_retention**: `updated_at` is 31 days ago, retention 30. Returns true.
4. **age_log_from_mtime**: Daemon log file mtime is 31 days ago. Age is 31.
5. **age_observation_from_created_at**: Observation JSON has `created_at` 91 days ago. Age is 91.
6. **age_fallback_to_mtime**: `state.json` has no `updated_at`. Falls back to file mtime.
7. **archive_creates_tarball**: Request dir has state.json and events.jsonl. `archive_request` creates valid .tar.gz.
8. **archive_tarball_contents**: `tar -tzf` lists exactly `REQ-xxx/state.json` and `REQ-xxx/events.jsonl`.
9. **archive_without_events**: Request has no events.jsonl. Archive contains only state.json.
10. **archive_idempotent**: Archive already exists. Second call skips, returns 0.
11. **archive_directory_created**: `~/.autonomous-dev/archive/` does not exist. Created automatically.
12. **cleanup_dir_after_archive**: Archive exists and is valid. State dir deleted.
13. **cleanup_dir_without_archive**: No archive. State dir NOT deleted.
14. **cleanup_dir_corrupt_archive**: Archive is not a valid tar.gz. State dir NOT deleted.
15. **worktree_within_delay**: Completed 100s ago, delay 300s. Not cleaned.
16. **worktree_past_delay**: Completed 400s ago, delay 300s. Cleaned.
17. **worktree_zero_delay**: Delay is 0. Cleaned immediately.
18. **branch_delete_enabled**: `delete_remote_branches=true`. Deletion attempted.
19. **branch_delete_disabled**: `delete_remote_branches=false`. Skipped.
20. **log_rotation_expired**: Daemon log 31 days old, retention 30. Deleted.
21. **log_rotation_current**: Daemon log 5 days old, retention 30. Preserved.
22. **observation_lifecycle**: Active obs 91 days old moved to archive. Archived obs 366 days old deleted.
23. **tarball_pruning**: Tarball 366 days old, retention 365. Deleted.
24. **dry_run_no_side_effects**: Run with dry_run=true. No files created, moved, or deleted.

### test/unit/test_ledger_rotation.sh

**Test cases** (10 minimum):

```bash
setup() {
  TEST_DIR=$(mktemp -d)
  export HOME="${TEST_DIR}/home"
  mkdir -p "${HOME}/.autonomous-dev"
  export COST_LEDGER_PATH="${HOME}/.autonomous-dev/cost-ledger.jsonl"
}
```

1. **rotation_splits_by_month**: Ledger has March and April entries. After rotation, `cost-ledger-2026-03.jsonl` has March entries, active ledger has April only.
2. **rotation_idempotent**: Rotate twice. `cost-ledger-2026-03.jsonl` not duplicated. Active ledger unchanged.
3. **rotation_empty_ledger**: No-op, no error.
4. **rotation_all_current_month**: Only April entries. No rotation needed.
5. **rotation_multi_month**: Jan, Feb, Mar, Apr. Three archive files created.
6. **rotation_preserves_format**: Each line in archive is valid JSONL.
7. **archive_pruning_expired**: `cost-ledger-2025-01.jsonl` is 15 months old. Retention 12. Deleted.
8. **archive_pruning_within_retention**: `cost-ledger-2025-06.jsonl` is 10 months old. Retention 12. Preserved.
9. **archive_pruning_no_archives**: No archive files exist. No-op.
10. **archive_filename_parsing**: Correctly extracts `2025-01` from `cost-ledger-2025-01.jsonl`.

### test/integration/test_cleanup_integration.sh

**Full end-to-end test** with real filesystem artifacts at various ages:

```bash
setup() {
  TEST_DIR=$(mktemp -d)
  export HOME="${TEST_DIR}/home"
  FAKE_REPO="${TEST_DIR}/repo"
  
  mkdir -p "${HOME}/.autonomous-dev/archive"
  mkdir -p "${HOME}/.autonomous-dev/logs"
  mkdir -p "${FAKE_REPO}/.git"
  mkdir -p "${FAKE_REPO}/.autonomous-dev/requests"
  mkdir -p "${FAKE_REPO}/.autonomous-dev/observations/archive"
  
  export PLUGIN_ROOT="$PROJECT_ROOT"
  
  # Create config with short retention for testing
  mkdir -p "${HOME}/.claude"
  cat > "${HOME}/.claude/autonomous-dev.json" <<EOF
{
  "repositories": {"allowlist": ["${FAKE_REPO}"]},
  "retention": {
    "completed_request_days": 30,
    "daemon_log_days": 30,
    "observation_report_days": 90,
    "observation_archive_days": 365,
    "archive_days": 365,
    "config_validation_log_days": 7,
    "cost_ledger_months": 12
  },
  "cleanup": {"delete_remote_branches": false, "auto_cleanup_interval_iterations": 100},
  "parallel": {"worktree_cleanup_delay_seconds": 0}
}
EOF
}
```

#### Test 1: Full Cleanup Lifecycle

```bash
test_full_cleanup_lifecycle() {
  # Create artifacts at various ages:
  # - REQ-old: completed 35 days ago (should be archived + deleted)
  # - REQ-recent: completed 10 days ago (should be preserved)
  # - REQ-active: in_progress (should be untouched)
  create_test_request "REQ-old" "completed" 35
  create_test_request "REQ-recent" "completed" 10
  create_test_request "REQ-active" "in_progress" 5
  
  # Create an observation file 95 days old (should be archived)
  echo '{"created_at":"2026-01-03T00:00:00Z"}' > "${FAKE_REPO}/.autonomous-dev/observations/obs-old.json"
  backdate_file "${FAKE_REPO}/.autonomous-dev/observations/obs-old.json" 95
  
  # Create a daemon log 35 days old (should be deleted)
  touch "${HOME}/.autonomous-dev/logs/daemon.log.old"
  backdate_file "${HOME}/.autonomous-dev/logs/daemon.log.old" 35
  
  # Create a daemon log 5 days old (should be preserved)
  touch "${HOME}/.autonomous-dev/logs/daemon.log.current"
  backdate_file "${HOME}/.autonomous-dev/logs/daemon.log.current" 5
  
  local config
  config=$(load_config)
  
  # --- Dry run first ---
  local dry_result
  dry_result=$(cleanup_run "$config" true)
  
  # Verify dry run: no side effects
  assert_eq "dry: REQ-old still exists" "true" "$(test -d "${FAKE_REPO}/.autonomous-dev/requests/REQ-old" && echo true || echo false)"
  assert_eq "dry: no archive created" "false" "$(test -f "${HOME}/.autonomous-dev/archive/REQ-old.tar.gz" && echo true || echo false)"
  assert_eq "dry: old log still exists" "true" "$(test -f "${HOME}/.autonomous-dev/logs/daemon.log.old" && echo true || echo false)"
  
  # --- Real cleanup ---
  local real_result
  real_result=$(cleanup_run "$config" false)
  
  # Verify: REQ-old archived and deleted
  assert_eq "archive created" "true" "$(test -f "${HOME}/.autonomous-dev/archive/REQ-old.tar.gz" && echo true || echo false)"
  assert_eq "state dir deleted" "false" "$(test -d "${FAKE_REPO}/.autonomous-dev/requests/REQ-old" && echo true || echo false)"
  
  # Verify: REQ-recent preserved
  assert_eq "recent request preserved" "true" "$(test -d "${FAKE_REPO}/.autonomous-dev/requests/REQ-recent" && echo true || echo false)"
  
  # Verify: REQ-active untouched
  assert_eq "active request untouched" "true" "$(test -d "${FAKE_REPO}/.autonomous-dev/requests/REQ-active" && echo true || echo false)"
  
  # Verify: observation archived
  assert_eq "obs moved to archive" "true" "$(test -f "${FAKE_REPO}/.autonomous-dev/observations/archive/obs-old.json" && echo true || echo false)"
  assert_eq "obs removed from active" "false" "$(test -f "${FAKE_REPO}/.autonomous-dev/observations/obs-old.json" && echo true || echo false)"
  
  # Verify: old log deleted, current preserved
  assert_eq "old log deleted" "false" "$(test -f "${HOME}/.autonomous-dev/logs/daemon.log.old" && echo true || echo false)"
  assert_eq "current log preserved" "true" "$(test -f "${HOME}/.autonomous-dev/logs/daemon.log.current" && echo true || echo false)"
}
```

#### Test 2: Idempotency

```bash
test_idempotency() {
  create_test_request "REQ-old" "completed" 35
  
  local config
  config=$(load_config)
  
  # First run
  cleanup_run "$config" false
  assert_eq "first run: archived" "true" "$(test -f "${HOME}/.autonomous-dev/archive/REQ-old.tar.gz" && echo true || echo false)"
  
  # Second run: should be a no-op (no errors, no duplicate archives)
  local result
  result=$(cleanup_run "$config" false)
  local errors
  errors=$(echo "$result" | jq -r '.errors')
  assert_eq "second run: zero errors" "0" "$errors"
}
```

#### Test 3: Archive Content Verification

```bash
test_archive_contents() {
  create_test_request "REQ-verify" "completed" 35
  
  local config
  config=$(load_config)
  cleanup_run "$config" false
  
  local archive="${HOME}/.autonomous-dev/archive/REQ-verify.tar.gz"
  assert_eq "archive exists" "true" "$(test -f "$archive" && echo true || echo false)"
  
  # Verify contents
  local contents
  contents=$(tar -tzf "$archive" | sort)
  assert_eq "archive has state.json" "true" "$(echo "$contents" | grep -q 'state.json' && echo true || echo false)"
  assert_eq "archive has events.jsonl" "true" "$(echo "$contents" | grep -q 'events.jsonl' && echo true || echo false)"
  
  # Verify no extra files
  local file_count
  file_count=$(tar -tzf "$archive" | wc -l | tr -d ' ')
  assert_eq "archive has exactly 2 files" "2" "$file_count"
}
```

## Acceptance Criteria

1. `test_cleanup_engine.sh` has at least 24 test cases.
2. `test_ledger_rotation.sh` has at least 10 test cases.
3. Integration test covers the full lifecycle: create artifacts at various ages, dry-run, real cleanup, verify.
4. Age calculation tests cover all artifact types with their correct time sources.
5. Archive creation tests verify tarball contents (correct files, no extras).
6. Dry-run test verifies zero side effects.
7. Idempotency test verifies second run produces no errors or duplicates.
8. Worktree delay tests verify the configurable delay is respected.
9. Branch deletion tests verify the enable/disable flag is honored.
10. Log rotation tests verify expired logs are deleted and current logs are preserved.
11. Cost ledger rotation tests verify month-based splitting.
12. All tests clean up temp artifacts.
13. Tests work on both macOS and Linux (cross-platform `touch` and `date`).

## Test Cases

All test cases are enumerated in the Implementation Details sections above:
- 24 cleanup engine unit tests
- 10 ledger rotation unit tests
- 3 integration test scenarios (full lifecycle, idempotency, archive content verification)
- Total: 37 test cases
