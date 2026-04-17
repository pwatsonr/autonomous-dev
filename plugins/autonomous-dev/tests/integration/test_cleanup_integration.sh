#!/usr/bin/env bash
# test_cleanup_integration.sh -- End-to-end cleanup integration tests
# Part of SPEC-010-4-05: Unit and Integration Tests for Cleanup and Retention
#
# Tests: Full cleanup lifecycle with real filesystem artifacts at various ages,
#        idempotency, and archive content verification.
#
# Test count: 3 (full lifecycle, idempotency, archive content verification)
#
# Requires: jq (1.6+), tar, bash 4+
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source shared test harness
source "${PROJECT_ROOT}/tests/test_harness.sh"

# Source the modules under test
source "${PROJECT_ROOT}/lib/cleanup_engine.sh"
source "${PROJECT_ROOT}/lib/ledger_rotation.sh"

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
    "event_log_days": 90,
    "cost_ledger_months": 12
  },
  "cleanup": {"delete_remote_branches": false, "auto_cleanup_interval_iterations": 100},
  "parallel": {"worktree_cleanup_delay_seconds": 0}
}
EOF
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
# Utility: Build a config JSON string for cleanup_run
# =============================================================================
build_test_config() {
  jq -nc --arg repo "$FAKE_REPO" '{
    repositories: {allowlist: [$repo]},
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
    cleanup: {delete_remote_branches: false, auto_cleanup_interval_iterations: 100},
    parallel: {worktree_cleanup_delay_seconds: 0}
  }'
}

# =============================================================================
# Test 1: Full Cleanup Lifecycle
# =============================================================================
test_full_cleanup_lifecycle() {
  # Create artifacts at various ages:
  # - REQ-old: completed 35 days ago (should be archived + deleted)
  # - REQ-recent: completed 10 days ago (should be preserved)
  # - REQ-active: in_progress (should be untouched)
  create_test_request "REQ-old" "completed" 35
  create_test_request "REQ-recent" "completed" 10
  create_test_request "REQ-active" "in_progress" 5

  # Create an observation file 95 days old (should be archived)
  local obs_created_at
  if [[ "$(uname)" == "Darwin" ]]; then
    obs_created_at=$(date -u -v "-95d" +"%Y-%m-%dT%H:%M:%SZ")
  else
    obs_created_at=$(date -u -d "-95 days" +"%Y-%m-%dT%H:%M:%SZ")
  fi
  echo "{\"created_at\":\"${obs_created_at}\"}" > "${FAKE_REPO}/.autonomous-dev/observations/obs-old.json"
  backdate_file "${FAKE_REPO}/.autonomous-dev/observations/obs-old.json" 95

  # Create a daemon log 35 days old (should be deleted)
  touch "${HOME}/.autonomous-dev/logs/daemon.log.old"
  backdate_file "${HOME}/.autonomous-dev/logs/daemon.log.old" 35

  # Create a daemon log 5 days old (should be preserved)
  touch "${HOME}/.autonomous-dev/logs/daemon.log.current"
  backdate_file "${HOME}/.autonomous-dev/logs/daemon.log.current" 5

  local config
  config=$(build_test_config)

  # --- Dry run first ---
  local dry_result
  dry_result=$(cleanup_run "$config" true 2>/dev/null) || true

  # Verify dry run: no side effects
  assert_eq "dry: REQ-old still exists" "true" \
    "$(test -d "${FAKE_REPO}/.autonomous-dev/requests/REQ-old" && echo true || echo false)"
  assert_eq "dry: no archive created" "false" \
    "$(test -f "${HOME}/.autonomous-dev/archive/REQ-old.tar.gz" && echo true || echo false)"
  assert_eq "dry: old log still exists" "true" \
    "$(test -f "${HOME}/.autonomous-dev/logs/daemon.log.old" && echo true || echo false)"

  # --- Real cleanup ---
  local real_result
  real_result=$(cleanup_run "$config" false 2>/dev/null) || true

  # Verify: REQ-old archived and deleted
  assert_eq "archive created" "true" \
    "$(test -f "${HOME}/.autonomous-dev/archive/REQ-old.tar.gz" && echo true || echo false)"
  assert_eq "state dir deleted" "false" \
    "$(test -d "${FAKE_REPO}/.autonomous-dev/requests/REQ-old" && echo true || echo false)"

  # Verify: REQ-recent preserved
  assert_eq "recent request preserved" "true" \
    "$(test -d "${FAKE_REPO}/.autonomous-dev/requests/REQ-recent" && echo true || echo false)"

  # Verify: REQ-active untouched
  assert_eq "active request untouched" "true" \
    "$(test -d "${FAKE_REPO}/.autonomous-dev/requests/REQ-active" && echo true || echo false)"

  # Verify: observation archived
  assert_eq "obs moved to archive" "true" \
    "$(test -f "${FAKE_REPO}/.autonomous-dev/observations/archive/obs-old.json" && echo true || echo false)"
  assert_eq "obs removed from active" "false" \
    "$(test -f "${FAKE_REPO}/.autonomous-dev/observations/obs-old.json" && echo true || echo false)"

  # Verify: old log deleted, current preserved
  assert_eq "old log deleted" "false" \
    "$(test -f "${HOME}/.autonomous-dev/logs/daemon.log.old" && echo true || echo false)"
  assert_eq "current log preserved" "true" \
    "$(test -f "${HOME}/.autonomous-dev/logs/daemon.log.current" && echo true || echo false)"
}

# =============================================================================
# Test 2: Idempotency
# =============================================================================
test_idempotency() {
  create_test_request "REQ-old" "completed" 35

  local config
  config=$(build_test_config)

  # First run
  cleanup_run "$config" false 2>/dev/null || true
  assert_eq "first run: archived" "true" \
    "$(test -f "${HOME}/.autonomous-dev/archive/REQ-old.tar.gz" && echo true || echo false)"

  # Second run: should be a no-op (no errors, no duplicate archives)
  local result
  result=$(cleanup_run "$config" false 2>/dev/null) || true
  local errors
  errors=$(echo "$result" | jq -r '.errors')
  assert_eq "second run: zero errors" "0" "$errors"
}

# =============================================================================
# Test 3: Archive Content Verification
# =============================================================================
test_archive_contents() {
  create_test_request "REQ-verify" "completed" 35

  local config
  config=$(build_test_config)
  cleanup_run "$config" false 2>/dev/null || true

  local archive="${HOME}/.autonomous-dev/archive/REQ-verify.tar.gz"
  assert_eq "archive exists" "true" "$(test -f "$archive" && echo true || echo false)"

  # Verify contents
  local contents
  contents=$(tar -tzf "$archive" | sort)
  assert_eq "archive has state.json" "true" \
    "$(echo "$contents" | grep -q 'state.json' && echo true || echo false)"
  assert_eq "archive has events.jsonl" "true" \
    "$(echo "$contents" | grep -q 'events.jsonl' && echo true || echo false)"

  # Verify no extra files
  local file_count
  file_count=$(tar -tzf "$archive" | wc -l | tr -d ' ')
  assert_eq "archive has exactly 2 files" "2" "$file_count"
}

# =============================================================================
# Run all tests
# =============================================================================
run_test "full_cleanup_lifecycle" test_full_cleanup_lifecycle
run_test "idempotency" test_idempotency
run_test "archive_contents" test_archive_contents

report
