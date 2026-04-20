#!/usr/bin/env bash
# test_sleep_wake_state_corruption.sh -- Unit tests for SPEC-001-3-03
# Tests: recover_from_stale_heartbeat(), compute_heartbeat_staleness(),
#        restore_interrupted_session(), validate_state_file(),
#        check_cost_caps() corruption handling, update_cost_ledger() corruption handling
#
# Requires: jq (1.6+), bash 4+
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source shared test harness
source "${SCRIPT_DIR}/../test_harness.sh"

###############################################################################
# Test Environment Setup
###############################################################################

_base_setup() { setup; }

spec03_setup() {
    _base_setup

    # Override paths to use temp directory
    DAEMON_HOME="${_TEST_DIR}"
    LOG_DIR="${_TEST_DIR}/logs"
    LOG_FILE="${LOG_DIR}/daemon.log"
    LOCK_FILE="${_TEST_DIR}/daemon.lock"
    HEARTBEAT_FILE="${_TEST_DIR}/heartbeat.json"
    CRASH_STATE_FILE="${_TEST_DIR}/crash-state.json"
    KILL_SWITCH_FILE="${_TEST_DIR}/kill-switch.flag"
    COST_LEDGER_FILE="${_TEST_DIR}/cost-ledger.json"
    ALERTS_DIR="${_TEST_DIR}/alerts"
    CONFIG_FILE="${_TEST_DIR}/user-config.json"
    DEFAULTS_FILE="${PROJECT_ROOT}/config/defaults.json"
    EFFECTIVE_CONFIG="${_TEST_DIR}/effective-config.json"

    # Reset state
    ONCE_MODE=false
    SHUTDOWN_REQUESTED=false
    CURRENT_CHILD_PID=""
    ITERATION_COUNT=0
    POLL_INTERVAL=1
    HEARTBEAT_INTERVAL=30
    IDLE_BACKOFF_MAX=4
    IDLE_BACKOFF_CURRENT=1
    IDLE_BACKOFF_BASE=1
    DAILY_COST_CAP=50.00
    MONTHLY_COST_CAP=500.00
    CIRCUIT_BREAKER_THRESHOLD=3
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false
    ERROR_BACKOFF_BASE=30
    ERROR_BACKOFF_MAX=900
    MAX_RETRIES_PER_PHASE=3
    GRACEFUL_SHUTDOWN_TIMEOUT=300
    LOG_MAX_SIZE_MB=50
    LOG_RETENTION_DAYS=7

    mkdir -p "${LOG_DIR}" "${ALERTS_DIR}"
}

# Helper to create a fake project repo with a request
create_test_repo() {
    local repo_dir="${_TEST_DIR}/repos/test-project"
    local request_id="${1:-REQ-20260408-abcd}"
    local req_dir="${repo_dir}/.autonomous-dev/requests/${request_id}"
    mkdir -p "${req_dir}"
    echo "${repo_dir}"
}

# Helper to write a minimal valid state.json
write_test_state() {
    local req_dir="$1"
    local session_active="${2:-false}"
    local status="${3:-code}"
    cat > "${req_dir}/state.json" <<EOF
{
    "id": "REQ-20260408-abcd",
    "status": "${status}",
    "priority": 5,
    "title": "Test request",
    "repository": "/tmp/repo",
    "branch": "autonomous/REQ-20260408-abcd",
    "created_at": "2026-04-08T10:00:00Z",
    "updated_at": "2026-04-08T12:00:00Z",
    "cost_accrued_usd": 1.50,
    "turn_count": 10,
    "escalation_count": 0,
    "blocked_by": [],
    "phase_history": [],
    "current_phase_metadata": {
        "session_active": ${session_active},
        "retry_count": 0
    },
    "error": null,
    "last_checkpoint": null
}
EOF
}

# Helper to write effective config with a repo in the allowlist
write_test_config() {
    local repo_dir="$1"
    cat > "${EFFECTIVE_CONFIG}" <<EOF
{
    "daemon": {
        "poll_interval_seconds": 1,
        "heartbeat_interval_seconds": 30,
        "circuit_breaker_threshold": 3
    },
    "repositories": {
        "allowlist": ["${repo_dir}"]
    }
}
EOF
}

# Helper to write a heartbeat file with a given timestamp and PID
write_test_heartbeat() {
    local ts="$1"
    local pid="${2:-99999}"
    cat > "${HEARTBEAT_FILE}" <<EOF
{
    "timestamp": "${ts}",
    "pid": ${pid},
    "iteration_count": 5,
    "active_request_id": null
}
EOF
}

# Source the supervisor-loop.sh functions
source "${PROJECT_ROOT}/bin/supervisor-loop.sh"

###############################################################################
# Task 7: Sleep/Wake Recovery Tests
###############################################################################

# =============================================================================
# Test 1: test_sleep_recovery_restores_checkpoint
# Create a request with session_active: true and a valid checkpoint.
# Backdate heartbeat by 30 minutes. Call recover_from_stale_heartbeat.
# Assert state.json is restored from checkpoint. Assert session_active == false.
# =============================================================================
test_sleep_recovery_restores_checkpoint() {
    spec03_setup

    local repo_dir
    repo_dir=$(create_test_repo "REQ-20260408-abcd")
    local req_dir="${repo_dir}/.autonomous-dev/requests/REQ-20260408-abcd"

    # Write state with session_active: true
    write_test_state "${req_dir}" "true" "code"

    # Write a checkpoint (different cost to verify restoration)
    cat > "${req_dir}/checkpoint.json" <<'EOF'
{
    "id": "REQ-20260408-abcd",
    "status": "code",
    "priority": 5,
    "title": "Test request",
    "repository": "/tmp/repo",
    "branch": "autonomous/REQ-20260408-abcd",
    "created_at": "2026-04-08T10:00:00Z",
    "updated_at": "2026-04-08T11:30:00Z",
    "cost_accrued_usd": 0.75,
    "turn_count": 5,
    "escalation_count": 0,
    "blocked_by": [],
    "phase_history": [],
    "current_phase_metadata": {
        "session_active": false,
        "retry_count": 0
    },
    "error": null,
    "last_checkpoint": null
}
EOF

    # Backdate heartbeat by 30 minutes
    local old_ts
    old_ts=$(date -u -v-30M +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
             || date -u -d "30 minutes ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)
    write_test_heartbeat "${old_ts}"

    write_test_config "${repo_dir}"

    # Run recovery
    recover_from_stale_heartbeat

    # Assert: state was restored from checkpoint (cost should be 0.75)
    local cost
    cost=$(jq -r '.cost_accrued_usd' "${req_dir}/state.json")
    assert_eq "0.75" "${cost}" "State should be restored from checkpoint (cost 0.75)"

    # Assert: session_active should be false
    local sa
    sa=$(jq -r '.current_phase_metadata.session_active' "${req_dir}/state.json")
    assert_eq "false" "${sa}" "session_active should be false after recovery"
}

# =============================================================================
# Test 2: test_sleep_recovery_event_logged
# After recovery, read events.jsonl. Assert last entry has type: session_interrupted.
# =============================================================================
test_sleep_recovery_event_logged() {
    spec03_setup

    local repo_dir
    repo_dir=$(create_test_repo "REQ-20260408-abcd")
    local req_dir="${repo_dir}/.autonomous-dev/requests/REQ-20260408-abcd"

    write_test_state "${req_dir}" "true" "code"

    # Write a valid checkpoint
    cp "${req_dir}/state.json" "${req_dir}/checkpoint.json"

    # Backdate heartbeat
    local old_ts
    old_ts=$(date -u -v-30M +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
             || date -u -d "30 minutes ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)
    write_test_heartbeat "${old_ts}"

    write_test_config "${repo_dir}"

    recover_from_stale_heartbeat

    # Assert events.jsonl exists and has session_interrupted event
    assert_file_exists "${req_dir}/events.jsonl"
    local event_type
    event_type=$(tail -1 "${req_dir}/events.jsonl" | jq -r '.event_type')
    assert_eq "session_interrupted" "${event_type}" "Last event should be session_interrupted"
}

# =============================================================================
# Test 3: test_sleep_recovery_no_crash_increment
# Set CONSECUTIVE_CRASHES=0. Simulate sleep recovery. Assert still 0.
# =============================================================================
test_sleep_recovery_no_crash_increment() {
    spec03_setup
    CONSECUTIVE_CRASHES=0

    local repo_dir
    repo_dir=$(create_test_repo "REQ-20260408-abcd")
    local req_dir="${repo_dir}/.autonomous-dev/requests/REQ-20260408-abcd"

    write_test_state "${req_dir}" "false" "code"

    # Backdate heartbeat by 30 minutes (sleep event)
    local old_ts
    old_ts=$(date -u -v-30M +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
             || date -u -d "30 minutes ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)
    write_test_heartbeat "${old_ts}"

    write_test_config "${repo_dir}"

    recover_from_stale_heartbeat

    assert_eq "0" "${CONSECUTIVE_CRASHES}" "CONSECUTIVE_CRASHES should still be 0 for sleep event"
}

# =============================================================================
# Test 4: test_sleep_recovery_no_active_sessions
# Create requests with session_active: false. Backdate heartbeat. Call recovery.
# Assert no state files were modified (check updated_at is unchanged).
# =============================================================================
test_sleep_recovery_no_active_sessions() {
    spec03_setup

    local repo_dir
    repo_dir=$(create_test_repo "REQ-20260408-abcd")
    local req_dir="${repo_dir}/.autonomous-dev/requests/REQ-20260408-abcd"

    write_test_state "${req_dir}" "false" "code"

    # Record original updated_at
    local original_updated
    original_updated=$(jq -r '.updated_at' "${req_dir}/state.json")

    # Backdate heartbeat
    local old_ts
    old_ts=$(date -u -v-30M +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
             || date -u -d "30 minutes ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)
    write_test_heartbeat "${old_ts}"

    write_test_config "${repo_dir}"

    recover_from_stale_heartbeat

    # Assert updated_at is unchanged
    local new_updated
    new_updated=$(jq -r '.updated_at' "${req_dir}/state.json")
    assert_eq "${original_updated}" "${new_updated}" "State file should not have been modified"

    # Assert no events.jsonl was created
    assert_file_not_exists "${req_dir}/events.jsonl"
}

# =============================================================================
# Test 5: test_sleep_recovery_no_checkpoint
# Create a request with session_active: true but no checkpoint file.
# Call recovery. Assert session_active is cleared. Assert log contains
# "No checkpoint found".
# =============================================================================
test_sleep_recovery_no_checkpoint() {
    spec03_setup

    local repo_dir
    repo_dir=$(create_test_repo "REQ-20260408-abcd")
    local req_dir="${repo_dir}/.autonomous-dev/requests/REQ-20260408-abcd"

    write_test_state "${req_dir}" "true" "code"
    # No checkpoint.json

    # Backdate heartbeat
    local old_ts
    old_ts=$(date -u -v-30M +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
             || date -u -d "30 minutes ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)
    write_test_heartbeat "${old_ts}"

    write_test_config "${repo_dir}"

    recover_from_stale_heartbeat

    # Assert session_active is cleared
    local sa
    sa=$(jq -r '.current_phase_metadata.session_active' "${req_dir}/state.json")
    assert_eq "false" "${sa}" "session_active should be false after recovery without checkpoint"

    # Assert log contains "No checkpoint found"
    assert_contains "$(cat "${LOG_FILE}")" "No checkpoint found"
}

# =============================================================================
# Test 6: test_sleep_vs_crash_classification_sleep
# Backdate heartbeat by 30 minutes. No recent crash state update.
# Assert classified as sleep.
# =============================================================================
test_sleep_vs_crash_classification_sleep() {
    spec03_setup

    local repo_dir
    repo_dir=$(create_test_repo "REQ-20260408-abcd")
    local req_dir="${repo_dir}/.autonomous-dev/requests/REQ-20260408-abcd"
    write_test_state "${req_dir}" "false" "code"

    # Backdate heartbeat by 30 minutes
    local old_ts
    old_ts=$(date -u -v-30M +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
             || date -u -d "30 minutes ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)
    write_test_heartbeat "${old_ts}"

    # No crash state file
    rm -f "${CRASH_STATE_FILE}"

    write_test_config "${repo_dir}"

    recover_from_stale_heartbeat

    assert_contains "$(cat "${LOG_FILE}")" "sleep/wake event"
}

# =============================================================================
# Test 7: test_sleep_vs_crash_classification_crash
# Backdate heartbeat by 2 minutes. Assert classified as potential crash.
# =============================================================================
test_sleep_vs_crash_classification_crash() {
    spec03_setup

    local repo_dir
    repo_dir=$(create_test_repo "REQ-20260408-abcd")
    local req_dir="${repo_dir}/.autonomous-dev/requests/REQ-20260408-abcd"
    write_test_state "${req_dir}" "false" "code"

    # Backdate heartbeat by 2 minutes (under 10 minute sleep threshold)
    local old_ts
    old_ts=$(date -u -v-2M +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
             || date -u -d "2 minutes ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)
    write_test_heartbeat "${old_ts}"

    write_test_config "${repo_dir}"

    recover_from_stale_heartbeat

    assert_contains "$(cat "${LOG_FILE}")" "potential crash event"
}

###############################################################################
# Task 8: State File Corruption Recovery Tests
###############################################################################

# =============================================================================
# Test 8: test_validate_state_valid
# Create a valid state.json. Call validate_state_file. Assert return 0.
# =============================================================================
test_validate_state_valid() {
    spec03_setup

    local repo_dir
    repo_dir=$(create_test_repo "REQ-20260408-abcd")
    local req_dir="${repo_dir}/.autonomous-dev/requests/REQ-20260408-abcd"

    write_test_state "${req_dir}" "false" "code"

    local rc=0
    validate_state_file "${req_dir}/state.json" || rc=$?
    assert_eq "0" "${rc}" "validate_state_file should return 0 for valid state"
}

# =============================================================================
# Test 9: test_validate_state_corrupt_with_checkpoint
# Write invalid JSON to state.json. Create a valid checkpoint.json.
# Call validate_state_file. Assert return 0. Assert state.json is now valid.
# =============================================================================
test_validate_state_corrupt_with_checkpoint() {
    spec03_setup

    local repo_dir
    repo_dir=$(create_test_repo "REQ-20260408-abcd")
    local req_dir="${repo_dir}/.autonomous-dev/requests/REQ-20260408-abcd"

    # Write corrupt state
    echo "not valid json{{{" > "${req_dir}/state.json"

    # Write valid checkpoint
    write_test_state "${req_dir}" "false" "code"
    cp "${req_dir}/state.json" "${req_dir}/checkpoint.json"
    # Re-corrupt the state
    echo "not valid json{{{" > "${req_dir}/state.json"

    local rc=0
    validate_state_file "${req_dir}/state.json" || rc=$?
    assert_eq "0" "${rc}" "validate_state_file should return 0 after checkpoint recovery"

    # Assert state.json is now valid JSON
    jq empty "${req_dir}/state.json" 2>/dev/null
    local jq_rc=$?
    assert_eq "0" "${jq_rc}" "state.json should be valid JSON after recovery"

    # Assert log contains restoration message
    assert_contains "$(cat "${LOG_FILE}")" "Restored state.json from checkpoint"
}

# =============================================================================
# Test 10: test_validate_state_both_corrupt
# Write invalid JSON to both state.json and checkpoint.json.
# Call validate_state_file. Assert return 1. Assert state.json has status: failed.
# Assert alert file created.
# =============================================================================
test_validate_state_both_corrupt() {
    spec03_setup

    local repo_dir
    repo_dir=$(create_test_repo "REQ-20260408-abcd")
    local req_dir="${repo_dir}/.autonomous-dev/requests/REQ-20260408-abcd"

    # Write corrupt files
    echo "not valid json{{{" > "${req_dir}/state.json"
    echo "also not valid{{{" > "${req_dir}/checkpoint.json"

    local rc=0
    validate_state_file "${req_dir}/state.json" || rc=$?
    assert_eq "1" "${rc}" "validate_state_file should return 1 when both are corrupt"

    # Assert state.json now has status: failed
    local status
    status=$(jq -r '.status' "${req_dir}/state.json")
    assert_eq "failed" "${status}" "State should be failed after unrecoverable corruption"

    # Assert failure_reason is state_corruption
    local reason
    reason=$(jq -r '.current_phase_metadata.failure_reason' "${req_dir}/state.json")
    assert_eq "state_corruption" "${reason}" "failure_reason should be state_corruption"

    # Assert alert file created
    local found
    found=$(find "${ALERTS_DIR}" -name "alert-state_corruption-*.json" -type f 2>/dev/null | head -1)
    assert_file_exists "${found}"
}

# =============================================================================
# Test 11: test_validate_state_missing
# Remove state.json. Call validate_state_file. Assert return 1.
# =============================================================================
test_validate_state_missing() {
    spec03_setup

    local repo_dir
    repo_dir=$(create_test_repo "REQ-20260408-abcd")
    local req_dir="${repo_dir}/.autonomous-dev/requests/REQ-20260408-abcd"

    # No state.json
    rm -f "${req_dir}/state.json"

    local rc=0
    validate_state_file "${req_dir}/state.json" || rc=$?
    assert_eq "1" "${rc}" "validate_state_file should return 1 for missing file"
}

###############################################################################
# Task 9: Cost Ledger Corruption Recovery Tests
###############################################################################

# =============================================================================
# Test 12: test_cost_ledger_corrupt_blocks
# Write "not json" to cost ledger. Call check_cost_caps.
# Assert return 1. Assert log contains "Recovery: Run".
# =============================================================================
test_cost_ledger_corrupt_blocks() {
    spec03_setup

    echo "not json" > "${COST_LEDGER_FILE}"

    local rc=0
    check_cost_caps || rc=$?
    assert_eq "1" "${rc}" "check_cost_caps should return 1 for corrupt ledger"

    assert_contains "$(cat "${LOG_FILE}")" "Recovery: Run"
}

# =============================================================================
# Test 13: test_cost_ledger_corrupt_alert
# Write "not json" to cost ledger. Call check_cost_caps.
# Assert alert file created with type cost_ledger_corruption.
# =============================================================================
test_cost_ledger_corrupt_alert() {
    spec03_setup

    echo "not json" > "${COST_LEDGER_FILE}"

    check_cost_caps || true

    local found
    found=$(find "${ALERTS_DIR}" -name "alert-cost_ledger_corruption-*.json" -type f 2>/dev/null | head -1)
    assert_file_exists "${found}"

    # Verify alert content
    local atype
    atype=$(jq -r '.event_type' "${found}")
    assert_eq "cost_ledger_corruption" "${atype}" "Alert event_type should be cost_ledger_corruption"
}

# =============================================================================
# Test 14: test_cost_ledger_update_corrupt
# Write "not json" to cost ledger. Call update_cost_ledger "5.00".
# Assert return 1. Assert alert emitted.
# =============================================================================
test_cost_ledger_update_corrupt() {
    spec03_setup

    echo "not json" > "${COST_LEDGER_FILE}"

    local rc=0
    update_cost_ledger "5.00" "REQ-test" || rc=$?
    assert_eq "1" "${rc}" "update_cost_ledger should return 1 for corrupt ledger"

    # Assert alert emitted
    local found
    found=$(find "${ALERTS_DIR}" -name "alert-cost_ledger_corruption-*.json" -type f 2>/dev/null | head -1)
    assert_file_exists "${found}"
}

###############################################################################
# Run Tests
###############################################################################

run_test "sleep_recovery_restores_checkpoint" test_sleep_recovery_restores_checkpoint
run_test "sleep_recovery_event_logged" test_sleep_recovery_event_logged
run_test "sleep_recovery_no_crash_increment" test_sleep_recovery_no_crash_increment
run_test "sleep_recovery_no_active_sessions" test_sleep_recovery_no_active_sessions
run_test "sleep_recovery_no_checkpoint" test_sleep_recovery_no_checkpoint
run_test "sleep_vs_crash_classification_sleep" test_sleep_vs_crash_classification_sleep
run_test "sleep_vs_crash_classification_crash" test_sleep_vs_crash_classification_crash
run_test "validate_state_valid" test_validate_state_valid
run_test "validate_state_corrupt_with_checkpoint" test_validate_state_corrupt_with_checkpoint
run_test "validate_state_both_corrupt" test_validate_state_both_corrupt
run_test "validate_state_missing" test_validate_state_missing
run_test "cost_ledger_corrupt_blocks" test_cost_ledger_corrupt_blocks
run_test "cost_ledger_corrupt_alert" test_cost_ledger_corrupt_alert
run_test "cost_ledger_update_corrupt" test_cost_ledger_update_corrupt

report
