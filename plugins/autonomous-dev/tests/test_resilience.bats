#!/usr/bin/env bats
###############################################################################
# test_resilience.bats - Comprehensive tests for Plan 3 resilience features
#
# Covers: crash counter, circuit breaker, error backoff, retry exhaustion,
#         turn exhaustion, sleep/wake recovery, state corruption, cost ledger
#         corruption, graceful shutdown, log rotation, and log cleanup.
#
# SPEC-001-3-04 Task 12
###############################################################################

load test_helpers

setup() {
    setup_test_env
    source_functions

    # Set short timeouts for tests
    export GRACEFUL_SHUTDOWN_TIMEOUT=1
    export ERROR_BACKOFF_BASE=30
    export ERROR_BACKOFF_MAX=900
    export MAX_RETRIES_PER_PHASE=3
    export LOG_MAX_SIZE_MB=1
    export LOG_RETENTION_DAYS=1
}

teardown() {
    # Kill any lingering child processes
    [[ -n "${CHILD_PIDS:-}" ]] && kill ${CHILD_PIDS} 2>/dev/null || true
    teardown_test_env
}

###############################################################################
# Crash Counter Tests (5 tests)
###############################################################################

@test "crash counter: increment on failure increases counter" {
    CONSECUTIVE_CRASHES=0
    record_crash "REQ-001" "1"
    [ "${CONSECUTIVE_CRASHES}" -eq 1 ]
    record_crash "REQ-001" "1"
    [ "${CONSECUTIVE_CRASHES}" -eq 2 ]
}

@test "crash counter: reset on success" {
    CONSECUTIVE_CRASHES=5
    record_success
    [ "${CONSECUTIVE_CRASHES}" -eq 0 ]
}

@test "crash counter: persist across simulated daemon restart" {
    CONSECUTIVE_CRASHES=2
    CIRCUIT_BREAKER_TRIPPED=false
    save_crash_state "1" "REQ-001" "code"

    # Simulate restart: reset in-memory state then reload
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false
    load_crash_state

    [ "${CONSECUTIVE_CRASHES}" -eq 2 ]
    [ "${CIRCUIT_BREAKER_TRIPPED}" == "false" ]
}

@test "crash counter: corrupt crash state handled on load" {
    echo "not valid json" > "${CRASH_STATE_FILE}"
    load_crash_state
    [ "${CONSECUTIVE_CRASHES}" -eq 0 ]
    [ "${CIRCUIT_BREAKER_TRIPPED}" == "false" ]
    assert_log_contains "corrupt"
}

@test "crash counter: starts at 0 on fresh start" {
    rm -f "${CRASH_STATE_FILE}"
    load_crash_state
    [ "${CONSECUTIVE_CRASHES}" -eq 0 ]
    [ "${CIRCUIT_BREAKER_TRIPPED}" == "false" ]
}

###############################################################################
# Circuit Breaker Tests (5 tests)
###############################################################################

@test "circuit breaker: trips at threshold" {
    CIRCUIT_BREAKER_THRESHOLD=3
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false
    record_crash "REQ-001" "1"
    record_crash "REQ-001" "1"
    [ "${CIRCUIT_BREAKER_TRIPPED}" == "false" ]
    record_crash "REQ-001" "1"
    [ "${CIRCUIT_BREAKER_TRIPPED}" == "true" ]
}

@test "circuit breaker: gate rejects when tripped" {
    CIRCUIT_BREAKER_TRIPPED=true
    run check_gates
    [ "$status" -eq 1 ]
    assert_log_contains "Circuit breaker is tripped"
}

@test "circuit breaker: record_success clears breaker" {
    CIRCUIT_BREAKER_TRIPPED=true
    CONSECUTIVE_CRASHES=5
    record_success
    [ "${CIRCUIT_BREAKER_TRIPPED}" == "false" ]
    [ "${CONSECUTIVE_CRASHES}" -eq 0 ]
}

@test "circuit breaker: gate passes after reset" {
    CIRCUIT_BREAKER_TRIPPED=false
    CONSECUTIVE_CRASHES=0
    rm -f "${KILL_SWITCH_FILE}"
    run check_gates
    [ "$status" -eq 0 ]
}

@test "circuit breaker: alert file created on trip" {
    CIRCUIT_BREAKER_THRESHOLD=1
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false
    record_crash "REQ-001" "1"

    # Check that an alert file was created
    local alert_count
    alert_count=$(ls "${ALERTS_DIR}"/alert-circuit_breaker-* 2>/dev/null | wc -l)
    [ "${alert_count}" -gt 0 ]
}

###############################################################################
# Error Backoff Tests (4 tests)
###############################################################################

@test "error backoff: exponential delay computation" {
    ERROR_BACKOFF_BASE=30
    ERROR_BACKOFF_MAX=900

    # retry_count=1: delay=30*2^0=30
    local ts1
    ts1=$(compute_next_retry_after 1)
    [ -n "${ts1}" ]

    # retry_count=2: delay=30*2^1=60
    local ts2
    ts2=$(compute_next_retry_after 2)
    [ -n "${ts2}" ]

    # retry_count=3: delay=30*2^2=120
    local ts3
    ts3=$(compute_next_retry_after 3)
    [ -n "${ts3}" ]

    # Verify ordering: ts1 < ts2 < ts3
    local e1 e2 e3
    e1=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${ts1}" +%s 2>/dev/null || date -u -d "${ts1}" +%s 2>/dev/null)
    e2=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${ts2}" +%s 2>/dev/null || date -u -d "${ts2}" +%s 2>/dev/null)
    e3=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${ts3}" +%s 2>/dev/null || date -u -d "${ts3}" +%s 2>/dev/null)
    [ "${e1}" -lt "${e2}" ]
    [ "${e2}" -lt "${e3}" ]
}

@test "error backoff: cap at max" {
    ERROR_BACKOFF_BASE=30
    ERROR_BACKOFF_MAX=900

    # retry_count=20: delay=30*2^19 >> 900, so capped at 900
    local ts_high
    ts_high=$(compute_next_retry_after 20)
    [ -n "${ts_high}" ]

    # The timestamp should be approximately now + 900s
    local now_epoch high_epoch
    now_epoch=$(date -u +%s)
    high_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${ts_high}" +%s 2>/dev/null || date -u -d "${ts_high}" +%s 2>/dev/null)
    local diff=$(( high_epoch - now_epoch ))
    # Should be close to 900, within a 5-second tolerance
    [ "${diff}" -ge 895 ]
    [ "${diff}" -le 905 ]
}

@test "error backoff: request skipped during backoff" {
    local repo_dir="${TEST_DAEMON_HOME}/repo"
    mkdir -p "${repo_dir}"
    setup_mock_config "${repo_dir}"

    local req_dir
    req_dir=$(create_request_fixture "${repo_dir}" "REQ-BACKOFF" "code" 1)

    # Set next_retry_after far in the future
    local future_ts
    future_ts=$(date -u -j -f "%s" "$(( $(date -u +%s) + 9999 ))" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
                || date -u -d "@$(( $(date -u +%s) + 9999 ))" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)
    local tmp="${req_dir}/state.json.tmp"
    jq --arg nra "${future_ts}" '.current_phase_metadata.next_retry_after = $nra' "${req_dir}/state.json" > "${tmp}"
    mv "${tmp}" "${req_dir}/state.json"

    local result
    result=$(select_request)
    [ -z "${result}" ]
}

@test "error backoff: request selectable after backoff expires" {
    local repo_dir="${TEST_DAEMON_HOME}/repo"
    mkdir -p "${repo_dir}"
    setup_mock_config "${repo_dir}"

    local req_dir
    req_dir=$(create_request_fixture "${repo_dir}" "REQ-READY" "code" 1)

    # Set next_retry_after in the past
    local past_ts
    past_ts=$(date -u -j -f "%s" "$(( $(date -u +%s) - 60 ))" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
              || date -u -d "@$(( $(date -u +%s) - 60 ))" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)
    local tmp="${req_dir}/state.json.tmp"
    jq --arg nra "${past_ts}" '.current_phase_metadata.next_retry_after = $nra' "${req_dir}/state.json" > "${tmp}"
    mv "${tmp}" "${req_dir}/state.json"

    local result
    result=$(select_request)
    [ -n "${result}" ]
    [[ "${result}" == *"REQ-READY"* ]]
}

###############################################################################
# Retry Exhaustion Tests (3 tests)
###############################################################################

@test "retry exhaustion: escalation to paused after max retries" {
    local repo_dir="${TEST_DAEMON_HOME}/repo"
    mkdir -p "${repo_dir}"
    setup_mock_config "${repo_dir}"
    MAX_RETRIES_PER_PHASE=3

    local req_dir
    req_dir=$(create_request_fixture "${repo_dir}" "REQ-EXHAUST" "code" 1)

    # Set retry_count at the threshold
    local tmp="${req_dir}/state.json.tmp"
    jq '.current_phase_metadata.retry_count = 3' "${req_dir}/state.json" > "${tmp}"
    mv "${tmp}" "${req_dir}/state.json"

    run check_retry_exhaustion "REQ-EXHAUST" "${repo_dir}"
    [ "$status" -eq 1 ]

    # Verify request is now paused
    local new_status
    new_status=$(jq -r '.status' "${req_dir}/state.json")
    [ "${new_status}" == "paused" ]
}

@test "retry exhaustion: event written to events.jsonl" {
    local repo_dir="${TEST_DAEMON_HOME}/repo"
    mkdir -p "${repo_dir}"
    setup_mock_config "${repo_dir}"
    MAX_RETRIES_PER_PHASE=1

    local req_dir
    req_dir=$(create_request_fixture "${repo_dir}" "REQ-EVENT" "code" 1)

    # Set retry_count at the threshold
    local tmp="${req_dir}/state.json.tmp"
    jq '.current_phase_metadata.retry_count = 1' "${req_dir}/state.json" > "${tmp}"
    mv "${tmp}" "${req_dir}/state.json"

    check_retry_exhaustion "REQ-EVENT" "${repo_dir}" || true

    # Check that events.jsonl contains a retry_exhaustion event
    local events_file="${req_dir}/events.jsonl"
    [ -f "${events_file}" ]
    grep -q "retry_exhaustion" "${events_file}"
}

@test "retry exhaustion: alert emitted" {
    local repo_dir="${TEST_DAEMON_HOME}/repo"
    mkdir -p "${repo_dir}"
    setup_mock_config "${repo_dir}"
    MAX_RETRIES_PER_PHASE=1

    local req_dir
    req_dir=$(create_request_fixture "${repo_dir}" "REQ-ALERT" "code" 1)

    local tmp="${req_dir}/state.json.tmp"
    jq '.current_phase_metadata.retry_count = 1' "${req_dir}/state.json" > "${tmp}"
    mv "${tmp}" "${req_dir}/state.json"

    check_retry_exhaustion "REQ-ALERT" "${repo_dir}" || true

    local alert_count
    alert_count=$(ls "${ALERTS_DIR}"/alert-retry_exhaustion-* 2>/dev/null | wc -l)
    [ "${alert_count}" -gt 0 ]
}

###############################################################################
# Turn Exhaustion Tests (3 tests)
###############################################################################

@test "turn exhaustion: exit code 2 detection" {
    run detect_turn_exhaustion 2 "/nonexistent"
    [ "$status" -eq 0 ]
}

@test "turn exhaustion: output field detection" {
    local output_file="${TEST_DAEMON_HOME}/session-output.json"
    echo '{"reason": "max_turns_reached"}' > "${output_file}"

    run detect_turn_exhaustion 1 "${output_file}"
    [ "$status" -eq 0 ]
}

@test "turn exhaustion: not detected for normal failure" {
    run detect_turn_exhaustion 1 "/nonexistent"
    [ "$status" -eq 1 ]
}

###############################################################################
# Sleep/Wake Recovery Tests (4 tests)
###############################################################################

@test "sleep/wake: stale heartbeat with active session restores from checkpoint" {
    local repo_dir="${TEST_DAEMON_HOME}/repo"
    mkdir -p "${repo_dir}"
    setup_mock_config "${repo_dir}"

    # Create a stale heartbeat (1 hour old)
    create_stale_heartbeat 3600

    # Create an active session with checkpoint
    local req_dir
    req_dir=$(create_active_session_fixture "${repo_dir}" "REQ-SLEEP")

    # Run recovery
    recover_from_stale_heartbeat

    # Verify session_active is false (restored from checkpoint)
    local session_active
    session_active=$(jq -r '.current_phase_metadata.session_active' "${req_dir}/state.json")
    [ "${session_active}" == "false" ]
}

@test "sleep/wake: no active sessions is clean pass" {
    local repo_dir="${TEST_DAEMON_HOME}/repo"
    mkdir -p "${repo_dir}"
    setup_mock_config "${repo_dir}"

    create_stale_heartbeat 3600

    # Create a request that is NOT active
    create_request_fixture "${repo_dir}" "REQ-IDLE" "code" 1

    run recover_from_stale_heartbeat
    [ "$status" -eq 0 ]
    assert_log_contains "Sleep/wake recovery complete"
}

@test "sleep/wake: no checkpoint clears session_active only" {
    local repo_dir="${TEST_DAEMON_HOME}/repo"
    mkdir -p "${repo_dir}"
    setup_mock_config "${repo_dir}"

    create_stale_heartbeat 3600

    # Create active session WITHOUT checkpoint
    local req_dir
    req_dir=$(create_request_fixture "${repo_dir}" "REQ-NOCKPT" "code" 1)
    local tmp="${req_dir}/state.json.tmp"
    jq '.current_phase_metadata.session_active = true' "${req_dir}/state.json" > "${tmp}"
    mv "${tmp}" "${req_dir}/state.json"
    # No checkpoint.json created

    recover_from_stale_heartbeat

    local session_active
    session_active=$(jq -r '.current_phase_metadata.session_active' "${req_dir}/state.json")
    [ "${session_active}" == "false" ]
}

@test "sleep/wake: crash counter not incremented for sleep events" {
    local repo_dir="${TEST_DAEMON_HOME}/repo"
    mkdir -p "${repo_dir}"
    setup_mock_config "${repo_dir}"

    # Create a very stale heartbeat (2 hours) with NO recent crash state
    # This classifies as a sleep event
    create_stale_heartbeat 7200
    rm -f "${CRASH_STATE_FILE}"

    CONSECUTIVE_CRASHES=0

    recover_from_stale_heartbeat

    # Crash counter should remain at 0 (sleep events don't increment)
    [ "${CONSECUTIVE_CRASHES}" -eq 0 ]
    assert_log_contains "sleep/wake event"
}

###############################################################################
# State Corruption Tests (3 tests)
###############################################################################

@test "state corruption: restore from checkpoint" {
    local repo_dir="${TEST_DAEMON_HOME}/repo"
    mkdir -p "${repo_dir}"

    local req_dir
    req_dir=$(create_request_fixture "${repo_dir}" "REQ-CORRUPT" "code" 1)

    # Create a valid checkpoint
    cp "${req_dir}/state.json" "${req_dir}/checkpoint.json"

    # Corrupt the state file
    echo "not json" > "${req_dir}/state.json"

    run validate_state_file "${req_dir}/state.json"
    [ "$status" -eq 0 ]

    # Verify state was restored from checkpoint
    jq empty "${req_dir}/state.json"
    assert_log_contains "Restored state.json from checkpoint"
}

@test "state corruption: both corrupt transitions to failed" {
    local repo_dir="${TEST_DAEMON_HOME}/repo"
    mkdir -p "${repo_dir}"

    local req_dir
    req_dir=$(create_request_fixture "${repo_dir}" "REQ-BOTH-CORRUPT" "code" 1)

    # Corrupt both files
    echo "not json" > "${req_dir}/state.json"
    echo "also not json" > "${req_dir}/checkpoint.json"

    run validate_state_file "${req_dir}/state.json"
    [ "$status" -eq 1 ]

    # The state should now be a minimal "failed" state
    local new_status
    new_status=$(jq -r '.status' "${req_dir}/state.json")
    [ "${new_status}" == "failed" ]
}

@test "state corruption: valid state fast path" {
    local repo_dir="${TEST_DAEMON_HOME}/repo"
    mkdir -p "${repo_dir}"

    local req_dir
    req_dir=$(create_request_fixture "${repo_dir}" "REQ-VALID" "code" 1)

    run validate_state_file "${req_dir}/state.json"
    [ "$status" -eq 0 ]
}

###############################################################################
# Cost Ledger Corruption Tests (2 tests)
###############################################################################

@test "cost ledger corruption: gate blocks on corruption" {
    echo "not json at all" > "${COST_LEDGER_FILE}"
    run check_cost_caps
    [ "$status" -eq 1 ]
    assert_log_contains "corrupt"
}

@test "cost ledger corruption: alert message logged" {
    echo "not json" > "${COST_LEDGER_FILE}"
    run check_cost_caps
    [ "$status" -eq 1 ]
    assert_log_contains "corrupt"
}

###############################################################################
# Graceful Shutdown Tests (3 tests)
###############################################################################

@test "graceful shutdown: child exits within grace period, no signals sent" {
    # Start a short-lived background process
    sleep 0.5 &
    CURRENT_CHILD_PID=$!
    GRACEFUL_SHUTDOWN_TIMEOUT=10

    # Wait briefly for child to exit naturally
    sleep 1

    graceful_shutdown_child

    assert_log_contains "already exited"
    # Process should be gone
    ! kill -0 "${CURRENT_CHILD_PID}" 2>/dev/null || true
}

@test "graceful shutdown: child survives grace period, SIGTERM sent" {
    # Start a background process that traps SIGTERM and exits
    bash -c 'trap "exit 0" TERM; while true; do sleep 0.1; done' &
    CURRENT_CHILD_PID=$!
    GRACEFUL_SHUTDOWN_TIMEOUT=1

    graceful_shutdown_child

    assert_log_contains "Sending SIGTERM"
    # Process should be gone (it handles SIGTERM by exiting)
    sleep 0.5
    ! kill -0 "${CURRENT_CHILD_PID}" 2>/dev/null
}

@test "graceful shutdown: child survives SIGTERM, SIGKILL sent" {
    # Start a background process that ignores SIGTERM
    bash -c 'trap "" TERM; while true; do sleep 0.1; done' &
    CURRENT_CHILD_PID=$!
    GRACEFUL_SHUTDOWN_TIMEOUT=1

    graceful_shutdown_child

    assert_log_contains "Sending SIGKILL"
    # Process should be gone
    sleep 0.5
    ! kill -0 "${CURRENT_CHILD_PID}" 2>/dev/null
}

@test "graceful shutdown: no child PID returns immediately" {
    CURRENT_CHILD_PID=""
    run graceful_shutdown_child
    [ "$status" -eq 0 ]
}

###############################################################################
# Log Rotation Tests (4 tests)
###############################################################################

@test "log rotation: under size limit, no rotation" {
    # Write a small log file (well under 1 MB)
    echo '{"test":"small"}' > "${LOG_FILE}"
    LOG_MAX_SIZE_MB=1

    rotate_logs_if_needed

    # No rotation should have occurred
    [ ! -f "${LOG_FILE}.1" ]
}

@test "log rotation: over size limit, rotation occurs" {
    LOG_MAX_SIZE_MB=1

    # Write more than 1 MB to the log file
    dd if=/dev/zero bs=1024 count=1100 2>/dev/null | tr '\0' 'x' > "${LOG_FILE}"

    rotate_logs_if_needed

    # daemon.log.1 should exist (the old log)
    [ -f "${LOG_FILE}.1" ]

    # daemon.log should be small (just the rotation log message)
    local size
    if [[ "$(uname)" == "Darwin" ]]; then
        size=$(stat -f%z "${LOG_FILE}" 2>/dev/null)
    else
        size=$(stat -c%s "${LOG_FILE}" 2>/dev/null)
    fi
    [ "${size}" -lt 1048576 ]
}

@test "log rotation: chain works (log.1 -> log.2, log -> log.1)" {
    LOG_MAX_SIZE_MB=1

    # Create pre-existing daemon.log.1 with identifiable content
    echo "OLD_LOG_1_CONTENT" > "${LOG_FILE}.1"

    # Write more than 1 MB to the current log file
    dd if=/dev/zero bs=1024 count=1100 2>/dev/null | tr '\0' 'y' > "${LOG_FILE}"

    rotate_logs_if_needed

    # daemon.log.2 should now contain what was in daemon.log.1
    [ -f "${LOG_FILE}.2" ]
    grep -q "OLD_LOG_1_CONTENT" "${LOG_FILE}.2"

    # daemon.log.1 should contain the rotated data (y's)
    [ -f "${LOG_FILE}.1" ]

    # daemon.log should be fresh
    local size
    if [[ "$(uname)" == "Darwin" ]]; then
        size=$(stat -f%z "${LOG_FILE}" 2>/dev/null)
    else
        size=$(stat -c%s "${LOG_FILE}" 2>/dev/null)
    fi
    [ "${size}" -lt 1048576 ]
}

@test "log rotation: oldest file deleted during rotation" {
    LOG_MAX_SIZE_MB=1

    # Create pre-existing daemon.log.2 with identifiable content
    echo "VERY_OLD_CONTENT" > "${LOG_FILE}.2"
    echo "OLD_CONTENT" > "${LOG_FILE}.1"

    # Write more than 1 MB to the current log file
    dd if=/dev/zero bs=1024 count=1100 2>/dev/null | tr '\0' 'z' > "${LOG_FILE}"

    rotate_logs_if_needed

    # daemon.log.2 should now contain the OLD_CONTENT (moved from .1), not VERY_OLD_CONTENT
    [ -f "${LOG_FILE}.2" ]
    grep -q "OLD_CONTENT" "${LOG_FILE}.2"
    ! grep -q "VERY_OLD_CONTENT" "${LOG_FILE}.2"
}

###############################################################################
# Log Cleanup Tests (2 tests)
###############################################################################

@test "log cleanup: old files are deleted" {
    LOG_RETENTION_DAYS=1

    # Create old session files with old modification times (48 hours ago)
    touch -t "$(date -v-48H +%Y%m%d%H%M.%S 2>/dev/null || date -d '48 hours ago' +%Y%m%d%H%M.%S 2>/dev/null)" "${LOG_DIR}/session-OLD-123.json"
    touch -t "$(date -v-48H +%Y%m%d%H%M.%S 2>/dev/null || date -d '48 hours ago' +%Y%m%d%H%M.%S 2>/dev/null)" "${LOG_DIR}/daemon.log.old"

    cleanup_old_logs

    # Old session file should be deleted
    [ ! -f "${LOG_DIR}/session-OLD-123.json" ]
}

@test "log cleanup: preserves recent files" {
    LOG_RETENTION_DAYS=7

    # Create a recent session file (modified now)
    echo '{"recent": true}' > "${LOG_DIR}/session-RECENT-456.json"

    cleanup_old_logs

    # Recent file should still exist
    [ -f "${LOG_DIR}/session-RECENT-456.json" ]
}

###############################################################################
# Integration Tests (4 tests)
###############################################################################

@test "integration: three consecutive failures trip breaker, reset clears it" {
    CIRCUIT_BREAKER_THRESHOLD=3
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false

    # Three consecutive failures
    record_crash "REQ-INT1" "1"
    record_crash "REQ-INT1" "1"
    record_crash "REQ-INT1" "1"

    [ "${CIRCUIT_BREAKER_TRIPPED}" == "true" ]

    # Gate should reject
    run check_gates
    [ "$status" -eq 1 ]

    # Reset
    record_success

    [ "${CIRCUIT_BREAKER_TRIPPED}" == "false" ]
    [ "${CONSECUTIVE_CRASHES}" -eq 0 ]

    # Gate should now pass
    rm -f "${KILL_SWITCH_FILE}"
    run check_gates
    [ "$status" -eq 0 ]
}

@test "integration: sleep/wake recovery restores from checkpoint" {
    local repo_dir="${TEST_DAEMON_HOME}/repo"
    mkdir -p "${repo_dir}"
    setup_mock_config "${repo_dir}"

    # Create stale heartbeat (30 min old)
    create_stale_heartbeat 1800

    # Remove crash state so it classifies as sleep event
    rm -f "${CRASH_STATE_FILE}"

    # Create a request with active session and checkpoint
    local req_dir
    req_dir=$(create_active_session_fixture "${repo_dir}" "REQ-SLEEP-INT")

    # Run recovery
    recover_from_stale_heartbeat

    # Verify restored from checkpoint
    local session_active
    session_active=$(jq -r '.current_phase_metadata.session_active' "${req_dir}/state.json")
    [ "${session_active}" == "false" ]

    # Crash counter should not be incremented (sleep event)
    [ "${CONSECUTIVE_CRASHES}" -eq 0 ]
}

@test "integration: corrupt state with valid checkpoint recovers" {
    local repo_dir="${TEST_DAEMON_HOME}/repo"
    mkdir -p "${repo_dir}"
    setup_mock_config "${repo_dir}"

    local req_dir
    req_dir=$(create_request_fixture "${repo_dir}" "REQ-CORRUPT-INT" "code" 1)

    # Create valid checkpoint
    cp "${req_dir}/state.json" "${req_dir}/checkpoint.json"

    # Corrupt the state file
    echo "garbage" > "${req_dir}/state.json"

    # Validate and recover
    validate_state_file "${req_dir}/state.json"

    # State should be restored and valid
    jq empty "${req_dir}/state.json"
    local req_id
    req_id=$(jq -r '.id' "${req_dir}/state.json")
    [ "${req_id}" == "REQ-CORRUPT-INT" ]
}

@test "integration: log rotation followed by cleanup in sequence" {
    LOG_MAX_SIZE_MB=1
    LOG_RETENTION_DAYS=1

    # Write more than 1 MB
    dd if=/dev/zero bs=1024 count=1100 2>/dev/null | tr '\0' 'a' > "${LOG_FILE}"

    # Rotate
    rotate_logs_if_needed
    [ -f "${LOG_FILE}.1" ]

    # Create an old session file
    touch -t "$(date -v-48H +%Y%m%d%H%M.%S 2>/dev/null || date -d '48 hours ago' +%Y%m%d%H%M.%S 2>/dev/null)" "${LOG_DIR}/session-OLD-789.json"

    # Cleanup
    cleanup_old_logs
    [ ! -f "${LOG_DIR}/session-OLD-789.json" ]

    # Recent rotated file should still exist
    [ -f "${LOG_FILE}.1" ]
}
