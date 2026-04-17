#!/usr/bin/env bash
# test_crash_counter_circuit_breaker_alerts.sh -- Unit tests for SPEC-001-3-01
# Tests: load_crash_state(), save_crash_state(), record_crash(), record_success(),
#        emit_alert(), and circuit breaker gate integration in check_gates()
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

# Override the setup function from test_harness.sh to include our environment
_base_setup() { setup; }

crash_setup() {
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
    EFFECTIVE_CONFIG=""

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

# Source the supervisor-loop.sh functions
# The BASH_SOURCE guard prevents main from executing when sourced.
source "${PROJECT_ROOT}/bin/supervisor-loop.sh"

# =============================================================================
# Test 1: test_load_crash_state_fresh
# No crash state file. Call load_crash_state. Assert CONSECUTIVE_CRASHES == 0
# and CIRCUIT_BREAKER_TRIPPED == false.
# =============================================================================
test_load_crash_state_fresh() {
    crash_setup
    rm -f "${CRASH_STATE_FILE}"
    load_crash_state
    assert_eq "0" "${CONSECUTIVE_CRASHES}" "CONSECUTIVE_CRASHES should be 0"
    assert_eq "false" "${CIRCUIT_BREAKER_TRIPPED}" "CIRCUIT_BREAKER_TRIPPED should be false"
    assert_contains "$(cat "${LOG_FILE}")" "No crash state file found"
}

# =============================================================================
# Test 2: test_load_crash_state_existing
# Write a crash state with consecutive_crashes: 2. Call load_crash_state.
# Assert CONSECUTIVE_CRASHES == 2.
# =============================================================================
test_load_crash_state_existing() {
    crash_setup
    cat > "${CRASH_STATE_FILE}" <<'EOF'
{
  "consecutive_crashes": 2,
  "circuit_breaker_tripped": false,
  "updated_at": "2026-04-08T14:00:00Z",
  "last_crash_exit_code": 1,
  "last_crash_request_id": "REQ-20260408-abcd",
  "last_crash_phase": "code"
}
EOF
    load_crash_state
    assert_eq "2" "${CONSECUTIVE_CRASHES}" "CONSECUTIVE_CRASHES should be 2"
    assert_eq "false" "${CIRCUIT_BREAKER_TRIPPED}" "CIRCUIT_BREAKER_TRIPPED should be false"
    assert_contains "$(cat "${LOG_FILE}")" "Crash state loaded"
}

# =============================================================================
# Test 3: test_load_crash_state_corrupt
# Write "not json" to crash state file. Call load_crash_state. Assert
# CONSECUTIVE_CRASHES == 0 (reset). Assert log contains "corrupt".
# =============================================================================
test_load_crash_state_corrupt() {
    crash_setup
    echo "not json" > "${CRASH_STATE_FILE}"
    load_crash_state
    assert_eq "0" "${CONSECUTIVE_CRASHES}" "CONSECUTIVE_CRASHES should be 0 after corrupt load"
    assert_eq "false" "${CIRCUIT_BREAKER_TRIPPED}" "CIRCUIT_BREAKER_TRIPPED should be false after corrupt load"
    assert_contains "$(cat "${LOG_FILE}")" "corrupt"
    # Verify the file was overwritten with valid JSON
    jq empty "${CRASH_STATE_FILE}"
}

# =============================================================================
# Test 4: test_save_crash_state_valid_json
# Set CONSECUTIVE_CRASHES=2, CIRCUIT_BREAKER_TRIPPED=false. Call
# save_crash_state "1" "REQ-001" "code". Read file with jq. Assert
# .consecutive_crashes == 2, .last_crash_exit_code == 1,
# .last_crash_request_id == "REQ-001".
# =============================================================================
test_save_crash_state_valid_json() {
    crash_setup
    CONSECUTIVE_CRASHES=2
    CIRCUIT_BREAKER_TRIPPED=false
    save_crash_state "1" "REQ-001" "code"

    # Validate it is valid JSON
    jq empty "${CRASH_STATE_FILE}"

    local crashes exit_code req_id phase
    crashes=$(jq -r '.consecutive_crashes' "${CRASH_STATE_FILE}")
    exit_code=$(jq -r '.last_crash_exit_code' "${CRASH_STATE_FILE}")
    req_id=$(jq -r '.last_crash_request_id' "${CRASH_STATE_FILE}")
    phase=$(jq -r '.last_crash_phase' "${CRASH_STATE_FILE}")

    assert_eq "2" "${crashes}" ".consecutive_crashes should be 2"
    assert_eq "1" "${exit_code}" ".last_crash_exit_code should be 1"
    assert_eq "REQ-001" "${req_id}" ".last_crash_request_id should be REQ-001"
    assert_eq "code" "${phase}" ".last_crash_phase should be code"
}

# =============================================================================
# Test 5: test_record_crash_increments
# Set CONSECUTIVE_CRASHES=0. Call record_crash. Assert CONSECUTIVE_CRASHES == 1.
# =============================================================================
test_record_crash_increments() {
    crash_setup
    CONSECUTIVE_CRASHES=0
    record_crash
    assert_eq "1" "${CONSECUTIVE_CRASHES}" "CONSECUTIVE_CRASHES should be 1 after one crash"
    assert_contains "$(cat "${LOG_FILE}")" "Crash recorded"
}

# =============================================================================
# Test 6: test_record_crash_trips_breaker
# Set CIRCUIT_BREAKER_THRESHOLD=3, CONSECUTIVE_CRASHES=2. Call record_crash.
# Assert CONSECUTIVE_CRASHES == 3 and CIRCUIT_BREAKER_TRIPPED == true.
# Assert log contains "CIRCUIT BREAKER TRIPPED".
# =============================================================================
test_record_crash_trips_breaker() {
    crash_setup
    CIRCUIT_BREAKER_THRESHOLD=3
    CONSECUTIVE_CRASHES=2
    record_crash
    assert_eq "3" "${CONSECUTIVE_CRASHES}" "CONSECUTIVE_CRASHES should be 3"
    assert_eq "true" "${CIRCUIT_BREAKER_TRIPPED}" "CIRCUIT_BREAKER_TRIPPED should be true"
    assert_contains "$(cat "${LOG_FILE}")" "CIRCUIT BREAKER TRIPPED"
}

# =============================================================================
# Test 7: test_record_crash_under_threshold
# Set threshold to 5, crashes to 1. Call record_crash. Assert
# CIRCUIT_BREAKER_TRIPPED == false.
# =============================================================================
test_record_crash_under_threshold() {
    crash_setup
    CIRCUIT_BREAKER_THRESHOLD=5
    CONSECUTIVE_CRASHES=1
    record_crash
    assert_eq "2" "${CONSECUTIVE_CRASHES}" "CONSECUTIVE_CRASHES should be 2"
    assert_eq "false" "${CIRCUIT_BREAKER_TRIPPED}" "CIRCUIT_BREAKER_TRIPPED should be false"
}

# =============================================================================
# Test 8: test_record_success_resets
# Set CONSECUTIVE_CRASHES=3, CIRCUIT_BREAKER_TRIPPED=true. Call record_success.
# Assert both are reset to 0/false. Assert crash-state.json reflects reset.
# =============================================================================
test_record_success_resets() {
    crash_setup
    CONSECUTIVE_CRASHES=3
    CIRCUIT_BREAKER_TRIPPED=true
    record_success
    assert_eq "0" "${CONSECUTIVE_CRASHES}" "CONSECUTIVE_CRASHES should be 0 after success"
    assert_eq "false" "${CIRCUIT_BREAKER_TRIPPED}" "CIRCUIT_BREAKER_TRIPPED should be false after success"

    # Verify crash-state.json reflects the reset
    local crashes tripped
    crashes=$(jq -r '.consecutive_crashes' "${CRASH_STATE_FILE}")
    tripped=$(jq -r '.circuit_breaker_tripped' "${CRASH_STATE_FILE}")
    assert_eq "0" "${crashes}" "crash-state.json .consecutive_crashes should be 0"
    assert_eq "false" "${tripped}" "crash-state.json .circuit_breaker_tripped should be false"
    assert_contains "$(cat "${LOG_FILE}")" "Success recorded. Crash counter reset."
}

# =============================================================================
# Test 9: test_circuit_breaker_blocks_gates
# Set CIRCUIT_BREAKER_TRIPPED=true. Call check_gates. Assert return 1.
# =============================================================================
test_circuit_breaker_blocks_gates() {
    crash_setup
    CIRCUIT_BREAKER_TRIPPED=true
    local rc=0
    check_gates || rc=$?
    assert_eq "1" "${rc}" "check_gates should return 1 when circuit breaker is tripped"
    assert_contains "$(cat "${LOG_FILE}")" "Circuit breaker is tripped"
}

# =============================================================================
# Test 10: test_circuit_breaker_cleared_gates_pass
# Set CIRCUIT_BREAKER_TRIPPED=false. Ensure no kill switch. Call check_gates.
# Assert return 0.
# =============================================================================
test_circuit_breaker_cleared_gates_pass() {
    crash_setup
    CIRCUIT_BREAKER_TRIPPED=false
    rm -f "${KILL_SWITCH_FILE}"
    local rc=0
    check_gates || rc=$?
    assert_eq "0" "${rc}" "check_gates should return 0 when circuit breaker is cleared"
}

# =============================================================================
# Test 11: test_emit_alert_creates_file
# Call emit_alert "test_type" "test message". Assert a file matching
# alert-test_type-*.json exists in $ALERTS_DIR.
# =============================================================================
test_emit_alert_creates_file() {
    crash_setup
    emit_alert "test_type" "test message"
    local found
    found=$(find "${ALERTS_DIR}" -name "alert-test_type-*.json" -type f | head -1)
    assert_file_exists "${found}"
}

# =============================================================================
# Test 12: test_emit_alert_valid_json
# Read the created alert file. Assert it parses with jq and has
# .type == "test_type" and .message == "test message".
# =============================================================================
test_emit_alert_valid_json() {
    crash_setup
    emit_alert "test_type" "test message"
    local alert_file
    alert_file=$(find "${ALERTS_DIR}" -name "alert-test_type-*.json" -type f | head -1)

    # Validate it is valid JSON
    jq empty "${alert_file}"

    local atype amsg apid
    atype=$(jq -r '.type' "${alert_file}")
    amsg=$(jq -r '.message' "${alert_file}")
    apid=$(jq -r '.daemon_pid' "${alert_file}")

    assert_eq "test_type" "${atype}" ".type should be test_type"
    assert_eq "test message" "${amsg}" ".message should be test message"
    # daemon_pid should be a number
    [[ "${apid}" =~ ^[0-9]+$ ]] || { echo "ASSERT FAILED: .daemon_pid should be numeric, got '${apid}'" >&2; return 1; }
}

# =============================================================================
# Test 13: test_emit_alert_logged
# Assert log contains "ALERT [test_type]: test message".
# =============================================================================
test_emit_alert_logged() {
    crash_setup
    emit_alert "test_type" "test message"
    assert_contains "$(cat "${LOG_FILE}")" "ALERT [test_type]: test message"
}

# =============================================================================
# Test 14: test_crash_state_persists_restart
# Set crashes to 2, save. Clear variables. Call load_crash_state. Assert
# CONSECUTIVE_CRASHES == 2.
# =============================================================================
test_crash_state_persists_restart() {
    crash_setup
    CONSECUTIVE_CRASHES=2
    CIRCUIT_BREAKER_TRIPPED=false
    save_crash_state "1" "REQ-002" "plan"

    # Clear variables (simulate restart)
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false

    # Reload from file
    load_crash_state
    assert_eq "2" "${CONSECUTIVE_CRASHES}" "CONSECUTIVE_CRASHES should be 2 after reload"
}

# =============================================================================
# Test 15: test_record_crash_with_alert
# Trip the breaker. Assert an alert file was created in $ALERTS_DIR.
# =============================================================================
test_record_crash_with_alert() {
    crash_setup
    CIRCUIT_BREAKER_THRESHOLD=3
    CONSECUTIVE_CRASHES=2
    record_crash "REQ-003" "1"
    local found
    found=$(find "${ALERTS_DIR}" -name "alert-circuit_breaker-*.json" -type f | head -1)
    assert_file_exists "${found}"

    # Verify alert content
    local atype
    atype=$(jq -r '.type' "${found}")
    assert_eq "circuit_breaker" "${atype}" "Alert type should be circuit_breaker"
}

###############################################################################
# Run Tests
###############################################################################

run_test "load_crash_state_fresh" test_load_crash_state_fresh
run_test "load_crash_state_existing" test_load_crash_state_existing
run_test "load_crash_state_corrupt" test_load_crash_state_corrupt
run_test "save_crash_state_valid_json" test_save_crash_state_valid_json
run_test "record_crash_increments" test_record_crash_increments
run_test "record_crash_trips_breaker" test_record_crash_trips_breaker
run_test "record_crash_under_threshold" test_record_crash_under_threshold
run_test "record_success_resets" test_record_success_resets
run_test "circuit_breaker_blocks_gates" test_circuit_breaker_blocks_gates
run_test "circuit_breaker_cleared_gates_pass" test_circuit_breaker_cleared_gates_pass
run_test "emit_alert_creates_file" test_emit_alert_creates_file
run_test "emit_alert_valid_json" test_emit_alert_valid_json
run_test "emit_alert_logged" test_emit_alert_logged
run_test "crash_state_persists_restart" test_crash_state_persists_restart
run_test "record_crash_with_alert" test_record_crash_with_alert

report
