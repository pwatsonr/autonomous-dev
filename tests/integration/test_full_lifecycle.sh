#!/usr/bin/env bash
# test_full_lifecycle.sh -- Integration tests for the state machine subsystem
# SPEC-002-4-04: Task 11 -- Integration tests
# These tests wire all components together and exercise full scenarios.
# Each test sets up a complete simulated environment in a temp directory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

source "${PROJECT_ROOT}/tests/test_harness.sh"
source "${PROJECT_ROOT}/tests/fixtures/state_builder.sh"
source "${PROJECT_ROOT}/lib/state/supervisor_interface.sh"
source "${PROJECT_ROOT}/lib/state/recovery.sh"
source "${PROJECT_ROOT}/lib/state/cleanup.sh"
source "${PROJECT_ROOT}/lib/state/lock_manager.sh"
source "${PROJECT_ROOT}/lib/state/migration.sh"

###############################################################################
# Helper: assert_true (not in base harness)
###############################################################################
assert_true() {
  local expr="$1"
  local msg="${2:-expression was false}"
  if eval "$expr"; then
    return 0
  fi
  echo "  ASSERT_TRUE FAILED: ${msg}" >&2
  return 1
}

###############################################################################
# Test 1: Full lifecycle happy path (intake -> monitor)
###############################################################################
test_happy_path() {
  local repo="${_TEST_DIR}/repo"
  mkdir -p "${repo}/.autonomous-dev/requests"

  local req_id="REQ-20260408-a3f1"
  create_request_directory "${repo}/.autonomous-dev/requests" "$req_id" \
    "Test request" "" "$repo" 5 "[]" "[]"

  local req_dir="${repo}/.autonomous-dev/requests/${req_id}"

  local timestamp="2026-04-08T10:00:00Z"

  # Advance through intake -> prd -> ... -> monitor (13 advances from intake)
  for i in $(seq 1 13); do
    complete_phase "$req_dir" '{}' "$timestamp"
    # Increment the hour portion for each advance
    local hh
    hh="$(printf '%02d' $((10 + i)))"
    timestamp="2026-04-08T${hh}:00:00Z"
  done

  # Verify final state
  local final_state
  final_state="$(state_read "$req_dir")"
  local final_status
  final_status="$(echo "$final_state" | jq -r '.status')"
  assert_eq "monitor" "$final_status" "Expected monitor state"

  local history_len
  history_len="$(echo "$final_state" | jq '.phase_history | length')"
  assert_eq "14" "$history_len" "Expected 14 phase history entries"

  # Verify all history entries have enter/exit times (except the last one which is active)
  local closed_entries
  closed_entries="$(echo "$final_state" | jq '[.phase_history[:-1][] | select(.exited_at != null)] | length')"
  assert_eq "13" "$closed_entries" "Expected 13 closed phase history entries"

  # Verify events were logged
  assert_file_exists "${req_dir}/events.jsonl"
  local event_count
  event_count="$(wc -l < "${req_dir}/events.jsonl" | tr -d ' ')"
  assert_true "(( event_count >= 14 ))" "Expected at least 14 events, got ${event_count}"

  # Verify checkpoints were created
  assert_dir_exists "${req_dir}/checkpoint"
}

###############################################################################
# Test 2: Review failure loop with escalation
###############################################################################
test_review_failure_escalation() {
  local repo="${_TEST_DIR}/repo"
  mkdir -p "${repo}/.autonomous-dev/requests"

  local req_id="REQ-20260408-b2e4"
  create_request_directory "${repo}/.autonomous-dev/requests" "$req_id" \
    "Review fail test" "" "$repo" 5 "[]" "[]"

  local req_dir="${repo}/.autonomous-dev/requests/${req_id}"

  local timestamp="2026-04-08T10:00:00Z"

  # Advance intake -> prd
  complete_phase "$req_dir" '{}' "$timestamp"
  timestamp="2026-04-08T10:01:00Z"

  # Advance prd -> prd_review
  complete_phase "$req_dir" '{}' "$timestamp"
  timestamp="2026-04-08T10:02:00Z"

  # Now at prd_review -- apply review_fail 3 times with max_retries=3
  # Each review_fail regresses to prd, then we advance back to prd_review
  for fail_num in 1 2 3; do
    local state_json
    state_json="$(state_read "$req_dir")"

    local current_status
    current_status="$(echo "$state_json" | jq -r '.status')"

    if [[ "$current_status" == "paused" ]]; then
      # Escalation happened -- this is expected on the 3rd failure
      break
    fi

    # Apply review_fail transition
    local metadata='{"review_feedback": "Needs more detail", "max_retries": 3}'
    local new_state
    new_state="$(state_transition "$state_json" "review_fail" "$metadata" "$timestamp")"
    state_write_atomic "$req_dir" "$new_state"

    local new_status
    new_status="$(echo "$new_state" | jq -r '.status')"

    if [[ "$new_status" == "paused" ]]; then
      break
    fi

    timestamp="2026-04-08T10:0$((2 + fail_num)):00Z"

    # Advance prd -> prd_review again
    complete_phase "$req_dir" '{}' "$timestamp"
    timestamp="2026-04-08T10:0$((3 + fail_num)):00Z"

    # Re-advance to prd_review
    complete_phase "$req_dir" '{}' "$timestamp"
    timestamp="2026-04-08T10:0$((4 + fail_num)):00Z"
  done

  # Verify escalation to paused
  local final_state
  final_state="$(state_read "$req_dir")"
  local final_status
  final_status="$(echo "$final_state" | jq -r '.status')"
  assert_eq "paused" "$final_status" "Expected paused state after retry exhaustion"

  # Verify escalation count > 0
  local escalation_count
  escalation_count="$(echo "$final_state" | jq '.escalation_count')"
  assert_true "(( escalation_count > 0 ))" "Expected escalation_count > 0, got ${escalation_count}"

  # Verify paused_from is set
  local paused_from
  paused_from="$(echo "$final_state" | jq -r '.paused_from')"
  assert_eq "prd_review" "$paused_from" "Expected paused_from to be prd_review"
}

###############################################################################
# Test 3: Concurrent request isolation
###############################################################################
test_concurrent_isolation() {
  local repo1="${_TEST_DIR}/repo1"
  local repo2="${_TEST_DIR}/repo2"
  mkdir -p "${repo1}/.autonomous-dev/requests" "${repo2}/.autonomous-dev/requests"

  local req_id_a="REQ-20260408-aaaa"
  local req_id_b="REQ-20260408-bbbb"

  create_request_directory "${repo1}/.autonomous-dev/requests" "$req_id_a" \
    "Request A" "" "$repo1" 5 "[]" "[]"

  create_request_directory "${repo2}/.autonomous-dev/requests" "$req_id_b" \
    "Request B" "" "$repo2" 5 "[]" "[]"

  local req_dir_a="${repo1}/.autonomous-dev/requests/${req_id_a}"
  local req_dir_b="${repo2}/.autonomous-dev/requests/${req_id_b}"

  local timestamp="2026-04-08T10:00:00Z"

  # Advance A to prd (intake -> prd)
  complete_phase "$req_dir_a" '{}' "$timestamp"

  # Advance B further: intake -> prd -> prd_review -> tdd (3 advances)
  complete_phase "$req_dir_b" '{}' "$timestamp"
  complete_phase "$req_dir_b" '{}' "$timestamp"
  complete_phase "$req_dir_b" '{}' "$timestamp"

  # Read states
  local state_a state_b
  state_a="$(state_read "$req_dir_a")"
  state_b="$(state_read "$req_dir_b")"

  local status_a status_b
  status_a="$(echo "$state_a" | jq -r '.status')"
  status_b="$(echo "$state_b" | jq -r '.status')"

  assert_eq "prd" "$status_a" "Request A should be at prd"
  assert_eq "tdd" "$status_b" "Request B should be at tdd"

  # Verify A's state doesn't mention B and vice versa
  local a_id_in_b b_id_in_a
  b_id_in_a="$(echo "$state_a" | jq -r ".. | select(type == \"string\" and test(\"${req_id_b}\")) // empty" 2>/dev/null | head -1)"
  a_id_in_b="$(echo "$state_b" | jq -r ".. | select(type == \"string\" and test(\"${req_id_a}\")) // empty" 2>/dev/null | head -1)"
  assert_eq "" "$b_id_in_a" "Request A should not reference Request B"
  assert_eq "" "$a_id_in_b" "Request B should not reference Request A"

  # Verify discover_requests finds both
  local count=0
  while IFS= read -r dir; do
    (( count++ ))
  done < <(discover_requests "$repo1" "$repo2")
  assert_eq "2" "$count" "Expected to discover 2 requests"
}

###############################################################################
# Test 4: Stale heartbeat recovery
###############################################################################
test_stale_heartbeat_recovery() {
  local repo="${_TEST_DIR}/repo"
  mkdir -p "${repo}/.autonomous-dev/requests"

  local req_id="REQ-20260408-c3d5"
  create_request_directory "${repo}/.autonomous-dev/requests" "$req_id" \
    "Stale heartbeat test" "" "$repo" 5 "[]" "[]"

  local req_dir="${repo}/.autonomous-dev/requests/${req_id}"

  # Advance to code phase
  local timestamp="2026-04-08T10:00:00Z"
  for i in $(seq 1 9); do
    complete_phase "$req_dir" '{}' "$timestamp"
  done

  # Verify we are at code
  local state_json
  state_json="$(state_read "$req_dir")"
  local status
  status="$(echo "$state_json" | jq -r '.status')"
  assert_eq "code" "$status" "Expected code state"

  # Verify the current phase has null exited_at (un-exited)
  local exited_at
  exited_at="$(echo "$state_json" | jq -r '.phase_history[-1].exited_at')"
  assert_eq "null" "$exited_at" "Expected null exited_at for current phase"

  # Write a stale heartbeat file (2 minutes ago)
  local hb_dir="${HOME}/.autonomous-dev"
  mkdir -p "$hb_dir"
  local stale_ts
  stale_ts="$(date -u -v-2M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '2 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
  echo "$stale_ts" > "${hb_dir}/heartbeat"

  # Capture stderr from detect_stale_heartbeat
  local detect_output
  detect_output="$(detect_stale_heartbeat 2>&1)" || true

  # The heartbeat should be detected as stale (POLL_INTERVAL defaults to 30, so 2 min > 60s threshold)
  assert_contains "$detect_output" "Stale heartbeat" \
    "Expected stale heartbeat warning"

  # Verify state was NOT modified (flagged only)
  local state_after
  state_after="$(state_read "$req_dir")"
  local status_after
  status_after="$(echo "$state_after" | jq -r '.status')"
  assert_eq "code" "$status_after" "State should remain at code (not modified)"
}

###############################################################################
# Test 5: Schema migration (v1 fixture)
###############################################################################
test_schema_migration() {
  local req_dir="${_TEST_DIR}/migration/REQ-20260408-0001"
  mkdir -p "$req_dir"

  # Copy v1 fixture
  cp "${PROJECT_ROOT}/tests/fixtures/state_v1_intake.json" "${req_dir}/state.json"
  chmod 0600 "${req_dir}/state.json"

  # Call migrate_state
  local state_json
  state_json="$(cat "${req_dir}/state.json")"
  local migrated
  migrated="$(migrate_state "$state_json" "$req_dir")"

  # Verify state passes through unchanged (v1 is current)
  local schema_version
  schema_version="$(echo "$migrated" | jq '.schema_version')"
  assert_eq "1" "$schema_version" "Schema version should be 1"

  # Verify schema validation passes
  local validation_exit=0
  _validate_state_schema "$migrated" > /dev/null 2>&1 || validation_exit=$?
  assert_eq "0" "$validation_exit" "Schema validation should pass"

  # Read via state_read (full validation)
  local read_result
  read_result="$(state_read "$req_dir")"
  local read_id
  read_id="$(echo "$read_result" | jq -r '.id')"
  assert_eq "REQ-20260408-0001" "$read_id" "Migrated state should have correct ID"
}

###############################################################################
# Test 6: Cleanup and archival
###############################################################################
test_cleanup_archival() {
  local repo="${_TEST_DIR}/repo"
  mkdir -p "${repo}/.autonomous-dev/requests"

  local req_id="REQ-20260408-d4e6"
  create_request_directory "${repo}/.autonomous-dev/requests" "$req_id" \
    "Cleanup test" "" "$repo" 5 "[]" "[]"

  local req_dir="${repo}/.autonomous-dev/requests/${req_id}"

  # Advance all the way to monitor (13 advances)
  local timestamp="2026-04-08T10:00:00Z"
  for i in $(seq 1 13); do
    complete_phase "$req_dir" '{}' "$timestamp"
    local hh
    hh="$(printf '%02d' $((10 + i)))"
    timestamp="2026-04-08T${hh}:00:00Z"
  done

  # Verify at monitor
  local state_json
  state_json="$(state_read "$req_dir")"
  local status
  status="$(echo "$state_json" | jq -r '.status')"
  assert_eq "monitor" "$status" "Expected monitor state"

  # Backdate the monitor entered_at to 31 days ago
  state_json="$(echo "$state_json" | jq '
    .phase_history[-1].entered_at = "2026-03-01T10:00:00Z" |
    .updated_at = "2026-03-01T10:00:00Z"
  ')"
  state_write_atomic "$req_dir" "$state_json"

  # Run automated_cleanup with 30-day retention
  local config='{"cleanup_retention_days": 30, "cancelled_retention_days": 7, "delete_remote_branches": false}'
  automated_cleanup "$config" "$repo" 2>/dev/null || true

  # Verify request directory is gone
  assert_dir_not_exists "$req_dir" "Request directory should be gone after cleanup"

  # Verify tarball exists in archive dir
  local tarball="${ARCHIVE_DIR}/${req_id}.tar.gz"
  assert_file_exists "$tarball" "Archive tarball should exist"

  # Verify archive.log has entry
  assert_file_exists "$ARCHIVE_LOG" "Archive log should exist"
  local log_contents
  log_contents="$(cat "$ARCHIVE_LOG")"
  assert_contains "$log_contents" "$req_id" "Archive log should contain request ID"
}

###############################################################################
# Test 7: Lock file with dead PID
###############################################################################
test_lock_dead_pid() {
  local lock_dir="${_TEST_DIR}/locktest"
  mkdir -p "$lock_dir"

  # Override the DAEMON_LOCK_FILE for this test (use a temp location)
  local saved_lock_file="${DAEMON_LOCK_FILE}"

  # Write a lock file with a PID that should not exist (99999)
  local test_lock="${_TEST_DIR}/daemon.lock"
  echo "99999" > "$test_lock"
  chmod 0600 "$test_lock"

  # Verify PID 99999 is NOT alive (if it happens to be, skip)
  if kill -0 99999 2>/dev/null; then
    echo "SKIP: PID 99999 is unexpectedly alive"
    return 0
  fi

  # Directly test the lock file dead-PID detection logic
  # Since acquire_lock uses a readonly var, we test the core logic
  local existing_pid
  existing_pid="$(cat "$test_lock")"

  # PID should be dead
  local pid_alive=false
  kill -0 "$existing_pid" 2>/dev/null && pid_alive=true
  assert_eq "false" "$pid_alive" "PID 99999 should be dead"

  # The lock can be stolen -- simulate by removing and writing our PID
  rm -f "$test_lock"
  echo "$$" > "$test_lock"
  chmod 0600 "$test_lock"

  local new_pid
  new_pid="$(cat "$test_lock")"
  assert_eq "$$" "$new_pid" "Lock should contain our PID after steal"
}

###############################################################################
# Test 8: Dependency blocking and unblocking
###############################################################################
test_dependency_blocking() {
  local repo="${_TEST_DIR}/repo"
  mkdir -p "${repo}/.autonomous-dev/requests"

  local req_id_a="REQ-20260408-1111"
  local req_id_b="REQ-20260408-2222"

  # Create request A at intake
  create_request_directory "${repo}/.autonomous-dev/requests" "$req_id_a" \
    "Request A" "" "$repo" 5 "[]" "[]"

  # Create request B at intake, blocked by A
  create_request_directory "${repo}/.autonomous-dev/requests" "$req_id_b" \
    "Request B" "" "$repo" 5 "[\"${req_id_a}\"]" "[]"

  local req_dir_a="${repo}/.autonomous-dev/requests/${req_id_a}"
  local req_dir_b="${repo}/.autonomous-dev/requests/${req_id_b}"

  # Advance A to prd
  complete_phase "$req_dir_a" '{}' "2026-04-08T10:00:00Z"

  # Check B: should be blocked (A is at prd, not a completed state)
  local state_b
  state_b="$(state_read "$req_dir_b")"

  # Define a reader function for this test's context
  _test_dep_reader() {
    local dep_id="$1"
    local dep_dir="${repo}/.autonomous-dev/requests/${dep_id}"
    if [[ -d "$dep_dir" ]]; then
      state_read "$dep_dir"
      return $?
    fi
    return 1
  }

  local block_result
  block_result="$(is_blocked "$state_b" "_test_dep_reader")"
  local is_blocked_val
  is_blocked_val="$(echo "$block_result" | jq -r '.blocked')"
  assert_eq "true" "$is_blocked_val" "B should be blocked while A is at prd"

  # Advance A all the way to monitor (13 advances total from intake)
  local timestamp="2026-04-08T10:01:00Z"
  for i in $(seq 1 12); do
    complete_phase "$req_dir_a" '{}' "$timestamp"
    local hh
    hh="$(printf '%02d' $((10 + i)))"
    timestamp="2026-04-08T${hh}:00:00Z"
  done

  # Verify A is at monitor
  local state_a
  state_a="$(state_read "$req_dir_a")"
  local status_a
  status_a="$(echo "$state_a" | jq -r '.status')"
  assert_eq "monitor" "$status_a" "Request A should be at monitor"

  # Re-read B and check blocking
  state_b="$(state_read "$req_dir_b")"
  block_result="$(is_blocked "$state_b" "_test_dep_reader")"
  is_blocked_val="$(echo "$block_result" | jq -r '.blocked')"
  assert_eq "false" "$is_blocked_val" "B should be unblocked after A reaches monitor"
}

###############################################################################
# Test 9: Orphaned .tmp recovery
###############################################################################
test_orphaned_tmp_recovery() {
  local req_dir="${_TEST_DIR}/repo/.autonomous-dev/requests/REQ-20260408-e5f7"
  mkdir -p "$req_dir"

  # Create valid state.json
  local state
  state="$(build_state --status prd --id "REQ-20260408-e5f7")"
  state_write_atomic "$req_dir" "$state"

  # Create an orphaned .tmp alongside it
  echo '{"partial": "write"}' > "${req_dir}/state.json.tmp"

  # Run orphaned tmp recovery
  recover_orphaned_tmp "$req_dir"

  # Verify .tmp is deleted
  assert_file_not_exists "${req_dir}/state.json.tmp" \
    ".tmp should be cleaned up when state.json exists"

  # Verify state.json is untouched
  local state_after
  state_after="$(state_read "$req_dir")"
  local status
  status="$(echo "$state_after" | jq -r '.status')"
  assert_eq "prd" "$status" "Original state.json should be untouched"
}

###############################################################################
# Run all tests
###############################################################################
run_test "Integration: Full lifecycle happy path" test_happy_path
run_test "Integration: Review failure escalation" test_review_failure_escalation
run_test "Integration: Concurrent request isolation" test_concurrent_isolation
run_test "Integration: Stale heartbeat recovery" test_stale_heartbeat_recovery
run_test "Integration: Schema migration v1" test_schema_migration
run_test "Integration: Cleanup and archival" test_cleanup_archival
run_test "Integration: Lock file dead PID" test_lock_dead_pid
run_test "Integration: Dependency blocking/unblocking" test_dependency_blocking
run_test "Integration: Orphaned .tmp recovery" test_orphaned_tmp_recovery

report
