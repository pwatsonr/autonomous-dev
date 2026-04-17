#!/usr/bin/env bash
# test_cleanup_engine.sh -- Unit tests for retention, archival, and cleanup functions
# Part of SPEC-010-4-05: Unit and Integration Tests for Cleanup and Retention
#
# Tests: get_artifact_age_days(), is_artifact_expired(), archive_request(),
#        cleanup_request_dir(), cleanup_worktree(), cleanup_remote_branch(),
#        rotate_daemon_logs(), cleanup_observations(), prune_archived_requests()
#
# Test count: 24
#
# Requires: jq (1.6+), tar, bash 4+
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source shared test harness
source "${PROJECT_ROOT}/tests/test_harness.sh"

# Source the module under test
source "${PROJECT_ROOT}/lib/cleanup_engine.sh"

# =============================================================================
# Override assert_eq to accept a label as the first arg (spec convention)
# Signature: assert_eq "label" "expected" "actual"
# =============================================================================
assert_eq() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" == "$actual" ]]; then return 0; fi
  echo "  ASSERT_EQ FAILED [${label}]: expected='${expected}' actual='${actual}'" >&2
  return 1
}

# =============================================================================
# Test Setup / Teardown
# =============================================================================
setup() {
  TEST_DIR=$(mktemp -d)
  _TEST_DIR="$TEST_DIR"
  export HOME="${TEST_DIR}/home"
  mkdir -p "${HOME}/.autonomous-dev/archive"
  mkdir -p "${HOME}/.autonomous-dev/logs"

  FAKE_REPO="${TEST_DIR}/repo"
  mkdir -p "${FAKE_REPO}/.git"
  mkdir -p "${FAKE_REPO}/.autonomous-dev/requests"
  mkdir -p "${FAKE_REPO}/.autonomous-dev/observations/archive"

  export PLUGIN_ROOT="$PROJECT_ROOT"
}

# =============================================================================
# Utility: Backdate files cross-platform (macOS / Linux)
# =============================================================================
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

# =============================================================================
# Mock config generator
# =============================================================================
make_config() {
  local req_days="${1:-30}" log_days="${2:-30}" obs_days="${3:-90}" \
        obs_archive_days="${4:-365}" archive_days="${5:-365}" \
        config_val_days="${6:-7}" event_log_days="${7:-90}"
  jq -nc \
    --argjson rd "$req_days" \
    --argjson ld "$log_days" \
    --argjson od "$obs_days" \
    --argjson oad "$obs_archive_days" \
    --argjson ad "$archive_days" \
    --argjson cvd "$config_val_days" \
    --argjson eld "$event_log_days" \
    '{
      retention: {
        completed_request_days: $rd,
        daemon_log_days: $ld,
        observation_report_days: $od,
        observation_archive_days: $oad,
        archive_days: $ad,
        config_validation_log_days: $cvd,
        event_log_days: $eld
      },
      cleanup: {delete_remote_branches: false},
      parallel: {worktree_cleanup_delay_seconds: 300},
      repositories: {allowlist: []}
    }'
}

# =============================================================================
# Test 1: age_request_from_updated_at
# Request updated_at is 31 days ago. get_artifact_age_days returns 31.
# =============================================================================
test_age_request_from_updated_at() {
  create_test_request "REQ-age01" "completed" 31
  local age
  age=$(get_artifact_age_days "request" "${FAKE_REPO}/.autonomous-dev/requests/REQ-age01")
  assert_eq "age_request_from_updated_at" "31" "$age"
}

# =============================================================================
# Test 2: age_request_within_retention
# updated_at is 29 days ago, retention 30. is_artifact_expired returns false.
# =============================================================================
test_age_request_within_retention() {
  create_test_request "REQ-age02" "completed" 29
  local config
  config=$(make_config 30)
  if is_artifact_expired "request" "${FAKE_REPO}/.autonomous-dev/requests/REQ-age02" "$config"; then
    echo "  FAIL: should not be expired at 29 days with 30-day retention" >&2
    return 1
  fi
  return 0
}

# =============================================================================
# Test 3: age_request_past_retention
# updated_at is 31 days ago, retention 30. Returns true.
# =============================================================================
test_age_request_past_retention() {
  create_test_request "REQ-age03" "completed" 31
  local config
  config=$(make_config 30)
  if is_artifact_expired "request" "${FAKE_REPO}/.autonomous-dev/requests/REQ-age03" "$config"; then
    return 0
  fi
  echo "  FAIL: should be expired at 31 days with 30-day retention" >&2
  return 1
}

# =============================================================================
# Test 4: age_log_from_mtime
# Daemon log file mtime is 31 days ago. Age is 31.
# =============================================================================
test_age_log_from_mtime() {
  local log_file="${HOME}/.autonomous-dev/logs/daemon.log.test"
  touch "$log_file"
  backdate_file "$log_file" 31
  local age
  age=$(get_artifact_age_days "daemon_log" "$log_file")
  assert_eq "age_log_from_mtime" "31" "$age"
}

# =============================================================================
# Test 5: age_observation_from_created_at
# Observation JSON has created_at 91 days ago. Age is 91.
# =============================================================================
test_age_observation_from_created_at() {
  local obs_file="${FAKE_REPO}/.autonomous-dev/observations/obs-test.json"
  local created_at
  if [[ "$(uname)" == "Darwin" ]]; then
    created_at=$(date -u -v "-91d" +"%Y-%m-%dT%H:%M:%SZ")
  else
    created_at=$(date -u -d "-91 days" +"%Y-%m-%dT%H:%M:%SZ")
  fi
  echo "{\"created_at\":\"${created_at}\"}" > "$obs_file"
  local age
  age=$(get_artifact_age_days "observation" "$obs_file")
  assert_eq "age_observation_from_created_at" "91" "$age"
}

# =============================================================================
# Test 6: age_fallback_to_mtime
# state.json has no updated_at. Falls back to file mtime.
# =============================================================================
test_age_fallback_to_mtime() {
  local req_dir="${FAKE_REPO}/.autonomous-dev/requests/REQ-fallback"
  mkdir -p "$req_dir"
  echo '{"request_id":"REQ-fallback","status":"completed"}' > "${req_dir}/state.json"
  backdate_file "${req_dir}/state.json" 25
  local age
  age=$(get_artifact_age_days "request" "$req_dir")
  # Should be approximately 25 (mtime fallback)
  if (( age >= 24 && age <= 26 )); then
    return 0
  fi
  echo "  FAIL: expected age ~25 from mtime fallback, got $age" >&2
  return 1
}

# =============================================================================
# Test 7: archive_creates_tarball
# Request dir has state.json and events.jsonl. archive_request creates valid .tar.gz.
# =============================================================================
test_archive_creates_tarball() {
  create_test_request "REQ-arc01" "completed" 35
  archive_request "${FAKE_REPO}/.autonomous-dev/requests/REQ-arc01"
  local archive="${HOME}/.autonomous-dev/archive/REQ-arc01.tar.gz"
  assert_eq "archive_creates_tarball" "true" "$(test -f "$archive" && echo true || echo false)"
  # Verify it is a valid tar.gz
  tar -tzf "$archive" >/dev/null 2>&1
  assert_eq "archive_is_valid_targz" "0" "$?"
}

# =============================================================================
# Test 8: archive_tarball_contents
# tar -tzf lists exactly REQ-xxx/state.json and REQ-xxx/events.jsonl.
# =============================================================================
test_archive_tarball_contents() {
  create_test_request "REQ-arc02" "completed" 35
  archive_request "${FAKE_REPO}/.autonomous-dev/requests/REQ-arc02"
  local archive="${HOME}/.autonomous-dev/archive/REQ-arc02.tar.gz"
  local contents
  contents=$(tar -tzf "$archive" | sort)
  local expected
  expected=$(printf "REQ-arc02/events.jsonl\nREQ-arc02/state.json")
  assert_eq "archive_tarball_contents" "$expected" "$contents"
}

# =============================================================================
# Test 9: archive_without_events
# Request has no events.jsonl. Archive contains only state.json.
# =============================================================================
test_archive_without_events() {
  local req_dir="${FAKE_REPO}/.autonomous-dev/requests/REQ-noev"
  mkdir -p "$req_dir"
  echo '{"request_id":"REQ-noev","status":"completed","updated_at":"2026-03-01T00:00:00Z"}' > "${req_dir}/state.json"
  # Intentionally no events.jsonl
  archive_request "$req_dir"
  local archive="${HOME}/.autonomous-dev/archive/REQ-noev.tar.gz"
  local file_count
  file_count=$(tar -tzf "$archive" | wc -l | tr -d ' ')
  assert_eq "archive_without_events" "1" "$file_count"
  # Verify it's state.json
  local contents
  contents=$(tar -tzf "$archive")
  assert_eq "archive_only_state" "REQ-noev/state.json" "$contents"
}

# =============================================================================
# Test 10: archive_idempotent
# Archive already exists. Second call skips, returns 0.
# =============================================================================
test_archive_idempotent() {
  create_test_request "REQ-idem" "completed" 35
  archive_request "${FAKE_REPO}/.autonomous-dev/requests/REQ-idem"
  local first_mtime
  if [[ "$(uname)" == "Darwin" ]]; then
    first_mtime=$(stat -f "%m" "${HOME}/.autonomous-dev/archive/REQ-idem.tar.gz")
  else
    first_mtime=$(stat -c "%Y" "${HOME}/.autonomous-dev/archive/REQ-idem.tar.gz")
  fi
  # Second call should skip
  archive_request "${FAKE_REPO}/.autonomous-dev/requests/REQ-idem"
  local second_mtime
  if [[ "$(uname)" == "Darwin" ]]; then
    second_mtime=$(stat -f "%m" "${HOME}/.autonomous-dev/archive/REQ-idem.tar.gz")
  else
    second_mtime=$(stat -c "%Y" "${HOME}/.autonomous-dev/archive/REQ-idem.tar.gz")
  fi
  assert_eq "archive_idempotent" "$first_mtime" "$second_mtime"
}

# =============================================================================
# Test 11: archive_directory_created
# ~/.autonomous-dev/archive/ does not exist. Created automatically.
# =============================================================================
test_archive_directory_created() {
  rm -rf "${HOME}/.autonomous-dev/archive"
  create_test_request "REQ-mkdir" "completed" 35
  archive_request "${FAKE_REPO}/.autonomous-dev/requests/REQ-mkdir"
  assert_eq "archive_directory_created" "true" "$(test -d "${HOME}/.autonomous-dev/archive" && echo true || echo false)"
  assert_eq "archive_file_created" "true" "$(test -f "${HOME}/.autonomous-dev/archive/REQ-mkdir.tar.gz" && echo true || echo false)"
}

# =============================================================================
# Test 12: cleanup_dir_after_archive
# Archive exists and is valid. State dir deleted.
# =============================================================================
test_cleanup_dir_after_archive() {
  create_test_request "REQ-clean01" "completed" 35
  archive_request "${FAKE_REPO}/.autonomous-dev/requests/REQ-clean01"
  cleanup_request_dir "${FAKE_REPO}/.autonomous-dev/requests/REQ-clean01"
  assert_eq "cleanup_dir_after_archive" "false" "$(test -d "${FAKE_REPO}/.autonomous-dev/requests/REQ-clean01" && echo true || echo false)"
}

# =============================================================================
# Test 13: cleanup_dir_without_archive
# No archive. State dir NOT deleted.
# =============================================================================
test_cleanup_dir_without_archive() {
  create_test_request "REQ-noarc" "completed" 35
  # Do not call archive_request
  local exit_code=0
  cleanup_request_dir "${FAKE_REPO}/.autonomous-dev/requests/REQ-noarc" 2>/dev/null || exit_code=$?
  assert_eq "cleanup_refused_exit_code" "1" "$exit_code"
  assert_eq "cleanup_dir_without_archive" "true" "$(test -d "${FAKE_REPO}/.autonomous-dev/requests/REQ-noarc" && echo true || echo false)"
}

# =============================================================================
# Test 14: cleanup_dir_corrupt_archive
# Archive is not a valid tar.gz. State dir NOT deleted.
# =============================================================================
test_cleanup_dir_corrupt_archive() {
  create_test_request "REQ-corrupt" "completed" 35
  # Create a corrupt archive file
  mkdir -p "${HOME}/.autonomous-dev/archive"
  echo "NOT_A_VALID_TARBALL" > "${HOME}/.autonomous-dev/archive/REQ-corrupt.tar.gz"
  local exit_code=0
  cleanup_request_dir "${FAKE_REPO}/.autonomous-dev/requests/REQ-corrupt" 2>/dev/null || exit_code=$?
  assert_eq "corrupt_archive_exit_code" "1" "$exit_code"
  assert_eq "cleanup_dir_corrupt_archive" "true" "$(test -d "${FAKE_REPO}/.autonomous-dev/requests/REQ-corrupt" && echo true || echo false)"
}

# =============================================================================
# Test 15: worktree_within_delay
# Completed 100s ago, delay 300s. Not cleaned.
# =============================================================================
test_worktree_within_delay() {
  # Create a request completed very recently (0 days ago = now)
  local req_dir="${FAKE_REPO}/.autonomous-dev/requests/REQ-wt-delay"
  mkdir -p "$req_dir"
  local now_ts
  now_ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  echo "{\"request_id\":\"REQ-wt-delay\",\"status\":\"completed\",\"updated_at\":\"${now_ts}\"}" > "${req_dir}/state.json"

  local config
  config=$(jq -nc '{
    parallel: {worktree_cleanup_delay_seconds: 300},
    cleanup: {delete_remote_branches: false},
    retention: {completed_request_days: 30}
  }')

  # cleanup_worktree should return 0 (deferred, not an error)
  local exit_code=0
  cleanup_worktree "$FAKE_REPO" "REQ-wt-delay" "$req_dir" "$config" || exit_code=$?
  assert_eq "worktree_within_delay" "0" "$exit_code"
}

# =============================================================================
# Test 16: worktree_past_delay
# Completed 400s ago, delay 300s. Would be cleaned (no actual worktree to remove).
# =============================================================================
test_worktree_past_delay() {
  local req_dir="${FAKE_REPO}/.autonomous-dev/requests/REQ-wt-past"
  mkdir -p "$req_dir"
  # Set updated_at to 400 seconds ago
  local past_ts
  if [[ "$(uname)" == "Darwin" ]]; then
    past_ts=$(date -u -v "-400S" +"%Y-%m-%dT%H:%M:%SZ")
  else
    past_ts=$(date -u -d "-400 seconds" +"%Y-%m-%dT%H:%M:%SZ")
  fi
  echo "{\"request_id\":\"REQ-wt-past\",\"status\":\"completed\",\"updated_at\":\"${past_ts}\"}" > "${req_dir}/state.json"

  local config
  config=$(jq -nc '{
    parallel: {worktree_cleanup_delay_seconds: 300},
    cleanup: {delete_remote_branches: false},
    retention: {completed_request_days: 30}
  }')

  # cleanup_worktree should return 0 (no worktree found, which is normal)
  local exit_code=0
  cleanup_worktree "$FAKE_REPO" "REQ-wt-past" "$req_dir" "$config" 2>/dev/null || exit_code=$?
  assert_eq "worktree_past_delay" "0" "$exit_code"
}

# =============================================================================
# Test 17: worktree_zero_delay
# Delay is 0. Cleaned immediately (no actual worktree to find).
# =============================================================================
test_worktree_zero_delay() {
  local req_dir="${FAKE_REPO}/.autonomous-dev/requests/REQ-wt-zero"
  mkdir -p "$req_dir"
  local now_ts
  now_ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  echo "{\"request_id\":\"REQ-wt-zero\",\"status\":\"completed\",\"updated_at\":\"${now_ts}\"}" > "${req_dir}/state.json"

  local config
  config=$(jq -nc '{
    parallel: {worktree_cleanup_delay_seconds: 0},
    cleanup: {delete_remote_branches: false},
    retention: {completed_request_days: 30}
  }')

  # With zero delay, should proceed past delay check immediately
  local exit_code=0
  cleanup_worktree "$FAKE_REPO" "REQ-wt-zero" "$req_dir" "$config" 2>/dev/null || exit_code=$?
  assert_eq "worktree_zero_delay" "0" "$exit_code"
}

# =============================================================================
# Test 18: branch_delete_enabled
# delete_remote_branches=true. Deletion attempted (no remote, so returns 0 for "not found").
# =============================================================================
test_branch_delete_enabled() {
  local config
  config=$(jq -nc '{
    cleanup: {delete_remote_branches: true},
    retention: {completed_request_days: 30}
  }')

  # No actual remote, so ls-remote will fail -> branch "not found" -> return 0
  local exit_code=0
  cleanup_remote_branch "$FAKE_REPO" "REQ-branch-en" "$config" 2>/dev/null || exit_code=$?
  assert_eq "branch_delete_enabled" "0" "$exit_code"
}

# =============================================================================
# Test 19: branch_delete_disabled
# delete_remote_branches=false. Skipped.
# =============================================================================
test_branch_delete_disabled() {
  local config
  config=$(jq -nc '{
    cleanup: {delete_remote_branches: false},
    retention: {completed_request_days: 30}
  }')

  local exit_code=0
  cleanup_remote_branch "$FAKE_REPO" "REQ-branch-dis" "$config" 2>/dev/null || exit_code=$?
  assert_eq "branch_delete_disabled" "0" "$exit_code"
}

# =============================================================================
# Test 20: log_rotation_expired
# Daemon log 31 days old, retention 30. Deleted.
# =============================================================================
test_log_rotation_expired() {
  local log_file="${HOME}/.autonomous-dev/logs/daemon.log.old"
  touch "$log_file"
  backdate_file "$log_file" 31

  local config
  config=$(make_config 30 30)
  rotate_daemon_logs "$config"

  assert_eq "log_rotation_expired" "false" "$(test -f "$log_file" && echo true || echo false)"
}

# =============================================================================
# Test 21: log_rotation_current
# Daemon log 5 days old, retention 30. Preserved.
# =============================================================================
test_log_rotation_current() {
  local log_file="${HOME}/.autonomous-dev/logs/daemon.log.current"
  touch "$log_file"
  backdate_file "$log_file" 5

  local config
  config=$(make_config 30 30)
  rotate_daemon_logs "$config"

  assert_eq "log_rotation_current" "true" "$(test -f "$log_file" && echo true || echo false)"
}

# =============================================================================
# Test 22: observation_lifecycle
# Active obs 91 days old moved to archive. Archived obs 366 days old deleted.
# =============================================================================
test_observation_lifecycle() {
  local obs_dir="${FAKE_REPO}/.autonomous-dev/observations"

  # Create an active observation 91 days old
  local created_at_91
  if [[ "$(uname)" == "Darwin" ]]; then
    created_at_91=$(date -u -v "-91d" +"%Y-%m-%dT%H:%M:%SZ")
  else
    created_at_91=$(date -u -d "-91 days" +"%Y-%m-%dT%H:%M:%SZ")
  fi
  echo "{\"created_at\":\"${created_at_91}\"}" > "${obs_dir}/obs-old.json"
  backdate_file "${obs_dir}/obs-old.json" 91

  # Create an archived observation 366 days old
  echo "{\"created_at\":\"2025-04-08T00:00:00Z\"}" > "${obs_dir}/archive/obs-ancient.json"
  backdate_file "${obs_dir}/archive/obs-ancient.json" 366

  local config
  config=$(make_config 30 30 90 365)
  cleanup_observations "$FAKE_REPO" "$config"

  # Active obs should have moved to archive
  assert_eq "obs_moved_to_archive" "true" "$(test -f "${obs_dir}/archive/obs-old.json" && echo true || echo false)"
  assert_eq "obs_removed_from_active" "false" "$(test -f "${obs_dir}/obs-old.json" && echo true || echo false)"

  # Ancient archived obs should be deleted
  assert_eq "obs_ancient_deleted" "false" "$(test -f "${obs_dir}/archive/obs-ancient.json" && echo true || echo false)"
}

# =============================================================================
# Test 23: tarball_pruning
# Tarball 366 days old, retention 365. Deleted.
# =============================================================================
test_tarball_pruning() {
  local tarball="${HOME}/.autonomous-dev/archive/REQ-old-tar.tar.gz"
  # Create a minimal valid tarball
  local tmp_dir
  tmp_dir=$(mktemp -d)
  mkdir -p "${tmp_dir}/REQ-old-tar"
  echo '{"status":"completed"}' > "${tmp_dir}/REQ-old-tar/state.json"
  tar -czf "$tarball" -C "$tmp_dir" "REQ-old-tar/state.json"
  rm -rf "$tmp_dir"
  backdate_file "$tarball" 366

  local config
  config=$(make_config 30 30 90 365 365)
  prune_archived_requests "$config"

  assert_eq "tarball_pruning" "false" "$(test -f "$tarball" && echo true || echo false)"
}

# =============================================================================
# Test 24: dry_run_no_side_effects
# Run with dry_run=true. No files created, moved, or deleted.
# =============================================================================
test_dry_run_no_side_effects() {
  create_test_request "REQ-dry" "completed" 35

  local obs_dir="${FAKE_REPO}/.autonomous-dev/observations"
  local created_at_95
  if [[ "$(uname)" == "Darwin" ]]; then
    created_at_95=$(date -u -v "-95d" +"%Y-%m-%dT%H:%M:%SZ")
  else
    created_at_95=$(date -u -d "-95 days" +"%Y-%m-%dT%H:%M:%SZ")
  fi
  echo "{\"created_at\":\"${created_at_95}\"}" > "${obs_dir}/obs-dry.json"
  backdate_file "${obs_dir}/obs-dry.json" 95

  local old_log="${HOME}/.autonomous-dev/logs/daemon.log.dry"
  touch "$old_log"
  backdate_file "$old_log" 35

  local config
  config=$(jq -nc --arg repo "$FAKE_REPO" '{
    retention: {
      completed_request_days: 30,
      daemon_log_days: 30,
      observation_report_days: 90,
      observation_archive_days: 365,
      archive_days: 365,
      config_validation_log_days: 7,
      event_log_days: 90,
      cost_ledger_months: 12
    },
    cleanup: {delete_remote_branches: false},
    parallel: {worktree_cleanup_delay_seconds: 0},
    repositories: {allowlist: [$repo]}
  }')

  # Run in dry-run mode
  local result
  result=$(cleanup_run "$config" true 2>/dev/null) || true

  # Verify no side effects
  assert_eq "dry: REQ-dry still exists" "true" "$(test -d "${FAKE_REPO}/.autonomous-dev/requests/REQ-dry" && echo true || echo false)"
  assert_eq "dry: no archive created" "false" "$(test -f "${HOME}/.autonomous-dev/archive/REQ-dry.tar.gz" && echo true || echo false)"
  assert_eq "dry: old log still exists" "true" "$(test -f "$old_log" && echo true || echo false)"
  assert_eq "dry: obs still in active" "true" "$(test -f "${obs_dir}/obs-dry.json" && echo true || echo false)"
}

# =============================================================================
# Run all tests
# =============================================================================
run_test "age_request_from_updated_at" test_age_request_from_updated_at
run_test "age_request_within_retention" test_age_request_within_retention
run_test "age_request_past_retention" test_age_request_past_retention
run_test "age_log_from_mtime" test_age_log_from_mtime
run_test "age_observation_from_created_at" test_age_observation_from_created_at
run_test "age_fallback_to_mtime" test_age_fallback_to_mtime
run_test "archive_creates_tarball" test_archive_creates_tarball
run_test "archive_tarball_contents" test_archive_tarball_contents
run_test "archive_without_events" test_archive_without_events
run_test "archive_idempotent" test_archive_idempotent
run_test "archive_directory_created" test_archive_directory_created
run_test "cleanup_dir_after_archive" test_cleanup_dir_after_archive
run_test "cleanup_dir_without_archive" test_cleanup_dir_without_archive
run_test "cleanup_dir_corrupt_archive" test_cleanup_dir_corrupt_archive
run_test "worktree_within_delay" test_worktree_within_delay
run_test "worktree_past_delay" test_worktree_past_delay
run_test "worktree_zero_delay" test_worktree_zero_delay
run_test "branch_delete_enabled" test_branch_delete_enabled
run_test "branch_delete_disabled" test_branch_delete_disabled
run_test "log_rotation_expired" test_log_rotation_expired
run_test "log_rotation_current" test_log_rotation_current
run_test "observation_lifecycle" test_observation_lifecycle
run_test "tarball_pruning" test_tarball_pruning
run_test "dry_run_no_side_effects" test_dry_run_no_side_effects

report
