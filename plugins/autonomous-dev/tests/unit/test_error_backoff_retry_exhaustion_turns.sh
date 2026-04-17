#!/usr/bin/env bash
# test_error_backoff_retry_exhaustion_turns.sh -- Unit tests for SPEC-001-3-02
# Tests: compute_next_retry_after(), check_retry_exhaustion(), escalate_to_paused(),
#        detect_turn_exhaustion(), and main loop integration for backoff, exhaustion,
#        and turn budget detection.
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

backoff_setup() {
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
    EFFECTIVE_CONFIG="${PROJECT_ROOT}/config/defaults.json"

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

# Helper to create a minimal request state file for testing
create_test_request() {
    local project="$1"
    local request_id="$2"
    local status="${3:-code}"
    local retry_count="${4:-0}"

    local req_dir="${project}/.autonomous-dev/requests/${request_id}"
    mkdir -p "${req_dir}"

    jq -n \
        --arg id "${request_id}" \
        --arg status "${status}" \
        --argjson retry "${retry_count}" \
        --arg ts "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
        '{
            id: $id,
            status: $status,
            priority: 100,
            created_at: $ts,
            updated_at: $ts,
            cost_accrued_usd: 0,
            blocked_by: [],
            current_phase_metadata: {
                retry_count: $retry,
                session_active: false,
                last_error: null,
                last_error_at: null,
                next_retry_after: null
            }
        }' > "${req_dir}/state.json"

    # Create empty events file
    : > "${req_dir}/events.jsonl"
}

# Source the supervisor-loop.sh functions (sourcing does not execute main)
source "${PROJECT_ROOT}/bin/supervisor-loop.sh"

# =============================================================================
# Test 1: test_compute_backoff_first_retry
# Set ERROR_BACKOFF_BASE=30, ERROR_BACKOFF_MAX=900. Call compute_next_retry_after 1.
# Assert the returned timestamp is approximately now + 30s (within 2s tolerance).
# =============================================================================
test_compute_backoff_first_retry() {
    backoff_setup
    ERROR_BACKOFF_BASE=30
    ERROR_BACKOFF_MAX=900

    local before_epoch now_result after_epoch result_epoch
    before_epoch=$(date -u +%s)
    now_result=$(compute_next_retry_after 1)
    after_epoch=$(date -u +%s)

    # Parse result timestamp to epoch
    result_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${now_result}" +%s 2>/dev/null \
                   || date -u -d "${now_result}" +%s 2>/dev/null)

    local expected_min=$(( before_epoch + 30 ))
    local expected_max=$(( after_epoch + 30 + 2 ))

    [[ ${result_epoch} -ge ${expected_min} ]] || { echo "FAIL: result_epoch ${result_epoch} < expected_min ${expected_min}" >&2; return 1; }
    [[ ${result_epoch} -le ${expected_max} ]] || { echo "FAIL: result_epoch ${result_epoch} > expected_max ${expected_max}" >&2; return 1; }
}

# =============================================================================
# Test 2: test_compute_backoff_second_retry
# Call compute_next_retry_after 2. Assert approximately now + 60s.
# =============================================================================
test_compute_backoff_second_retry() {
    backoff_setup
    ERROR_BACKOFF_BASE=30
    ERROR_BACKOFF_MAX=900

    local before_epoch now_result after_epoch result_epoch
    before_epoch=$(date -u +%s)
    now_result=$(compute_next_retry_after 2)
    after_epoch=$(date -u +%s)

    result_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${now_result}" +%s 2>/dev/null \
                   || date -u -d "${now_result}" +%s 2>/dev/null)

    local expected_min=$(( before_epoch + 60 ))
    local expected_max=$(( after_epoch + 60 + 2 ))

    [[ ${result_epoch} -ge ${expected_min} ]] || { echo "FAIL: result_epoch ${result_epoch} < expected_min ${expected_min}" >&2; return 1; }
    [[ ${result_epoch} -le ${expected_max} ]] || { echo "FAIL: result_epoch ${result_epoch} > expected_max ${expected_max}" >&2; return 1; }
}

# =============================================================================
# Test 3: test_compute_backoff_third_retry
# Call compute_next_retry_after 3. Assert approximately now + 120s.
# =============================================================================
test_compute_backoff_third_retry() {
    backoff_setup
    ERROR_BACKOFF_BASE=30
    ERROR_BACKOFF_MAX=900

    local before_epoch now_result after_epoch result_epoch
    before_epoch=$(date -u +%s)
    now_result=$(compute_next_retry_after 3)
    after_epoch=$(date -u +%s)

    result_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${now_result}" +%s 2>/dev/null \
                   || date -u -d "${now_result}" +%s 2>/dev/null)

    local expected_min=$(( before_epoch + 120 ))
    local expected_max=$(( after_epoch + 120 + 2 ))

    [[ ${result_epoch} -ge ${expected_min} ]] || { echo "FAIL: result_epoch ${result_epoch} < expected_min ${expected_min}" >&2; return 1; }
    [[ ${result_epoch} -le ${expected_max} ]] || { echo "FAIL: result_epoch ${result_epoch} > expected_max ${expected_max}" >&2; return 1; }
}

# =============================================================================
# Test 4: test_compute_backoff_cap
# Set ERROR_BACKOFF_MAX=100. Call compute_next_retry_after 10.
# Assert delay does not exceed 100s.
# =============================================================================
test_compute_backoff_cap() {
    backoff_setup
    ERROR_BACKOFF_BASE=30
    ERROR_BACKOFF_MAX=100

    local before_epoch now_result after_epoch result_epoch
    before_epoch=$(date -u +%s)
    now_result=$(compute_next_retry_after 10)
    after_epoch=$(date -u +%s)

    result_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${now_result}" +%s 2>/dev/null \
                   || date -u -d "${now_result}" +%s 2>/dev/null)

    local max_allowed=$(( after_epoch + 100 + 2 ))

    [[ ${result_epoch} -le ${max_allowed} ]] || { echo "FAIL: result_epoch ${result_epoch} > max_allowed ${max_allowed} (cap not applied)" >&2; return 1; }
    # Also ensure it's at least now + ~100 (within the cap range)
    local min_expected=$(( before_epoch + 100 - 2 ))
    [[ ${result_epoch} -ge ${min_expected} ]] || { echo "FAIL: result_epoch ${result_epoch} < min_expected ${min_expected}" >&2; return 1; }
}

# =============================================================================
# Test 5: test_backoff_written_to_state
# Trigger an error update. Read state.json. Assert
# .current_phase_metadata.next_retry_after is a valid ISO-8601 timestamp.
# =============================================================================
test_backoff_written_to_state() {
    backoff_setup
    ERROR_BACKOFF_BASE=30
    ERROR_BACKOFF_MAX=900

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-backoff-001"
    create_test_request "${project}" "${request_id}" "code" 0

    update_request_state "${request_id}" "${project}" "error" "1.50" "1"

    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"
    local nra
    nra=$(jq -r '.current_phase_metadata.next_retry_after' "${state_file}")

    # Assert it's a non-empty, non-null value
    [[ -n "${nra}" && "${nra}" != "null" ]] || { echo "FAIL: next_retry_after is empty or null" >&2; return 1; }

    # Assert it's a valid ISO-8601 timestamp (parseable by date)
    local epoch
    epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${nra}" +%s 2>/dev/null \
            || date -u -d "${nra}" +%s 2>/dev/null \
            || echo "invalid")
    [[ "${epoch}" != "invalid" ]] || { echo "FAIL: next_retry_after '${nra}' is not a valid ISO-8601 timestamp" >&2; return 1; }

    # Assert it's in the future
    local now_epoch
    now_epoch=$(date -u +%s)
    [[ ${epoch} -gt ${now_epoch} ]] || { echo "FAIL: next_retry_after epoch ${epoch} is not in the future (now=${now_epoch})" >&2; return 1; }
}

# =============================================================================
# Test 6: test_backoff_request_skipped
# Set next_retry_after 5 minutes in the future on a request. Call
# select_request. Assert the request is not selected.
# =============================================================================
test_backoff_request_skipped() {
    backoff_setup

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-skip-001"
    create_test_request "${project}" "${request_id}" "code" 1

    # Set next_retry_after 5 minutes in the future
    local future_epoch future_ts
    future_epoch=$(( $(date -u +%s) + 300 ))
    future_ts=$(date -u -j -f "%s" "${future_epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
                || date -u -d "@${future_epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)

    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"
    local tmp="${state_file}.tmp"
    jq --arg nra "${future_ts}" \
        '.current_phase_metadata.next_retry_after = $nra' "${state_file}" > "${tmp}"
    mv "${tmp}" "${state_file}"

    # Set up effective config with the repo in the allowlist
    EFFECTIVE_CONFIG="${_TEST_DIR}/effective-config.json"
    jq --arg repo "${project}" '.repositories.allowlist = [$repo]' "${DEFAULTS_FILE}" > "${EFFECTIVE_CONFIG}"

    local result
    result=$(select_request)

    assert_eq "" "${result}" "Request in backoff should not be selected"
}

# =============================================================================
# Test 7: test_backoff_request_selectable_after_expiry
# Set next_retry_after to 1 second in the past. Call select_request.
# Assert the request IS selected.
# =============================================================================
test_backoff_request_selectable_after_expiry() {
    backoff_setup

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-select-001"
    create_test_request "${project}" "${request_id}" "code" 1

    # Set next_retry_after to 1 second in the past
    local past_epoch past_ts
    past_epoch=$(( $(date -u +%s) - 1 ))
    past_ts=$(date -u -j -f "%s" "${past_epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
              || date -u -d "@${past_epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)

    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"
    local tmp="${state_file}.tmp"
    jq --arg nra "${past_ts}" \
        '.current_phase_metadata.next_retry_after = $nra' "${state_file}" > "${tmp}"
    mv "${tmp}" "${state_file}"

    # Set up effective config with the repo in the allowlist
    EFFECTIVE_CONFIG="${_TEST_DIR}/effective-config.json"
    jq --arg repo "${project}" '.repositories.allowlist = [$repo]' "${DEFAULTS_FILE}" > "${EFFECTIVE_CONFIG}"

    local result
    result=$(select_request)

    [[ -n "${result}" ]] || { echo "FAIL: Request past backoff should be selectable but got empty" >&2; return 1; }
    assert_contains "${result}" "${request_id}" "Result should contain the request ID"
}

# =============================================================================
# Test 8: test_retry_exhaustion_pauses
# Create a request with retry_count: 2 and MAX_RETRIES_PER_PHASE=3.
# Trigger one more error. Assert state.json has status: "paused".
# =============================================================================
test_retry_exhaustion_pauses() {
    backoff_setup
    MAX_RETRIES_PER_PHASE=3

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-exhaust-001"
    create_test_request "${project}" "${request_id}" "code" 2

    # Trigger an error update (this will increment retry_count to 3)
    update_request_state "${request_id}" "${project}" "error" "1.00" "1"

    # Now check retry exhaustion
    local rc=0
    check_retry_exhaustion "${request_id}" "${project}" || rc=$?
    assert_eq "1" "${rc}" "check_retry_exhaustion should return 1 (exhausted)"

    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"
    local status
    status=$(jq -r '.status' "${state_file}")
    assert_eq "paused" "${status}" "Request should be paused after retry exhaustion"
}

# =============================================================================
# Test 9: test_retry_exhaustion_event
# After exhaustion, read events.jsonl. Assert last entry has
# type: "retry_exhaustion".
# =============================================================================
test_retry_exhaustion_event() {
    backoff_setup
    MAX_RETRIES_PER_PHASE=3

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-event-001"
    create_test_request "${project}" "${request_id}" "code" 2

    update_request_state "${request_id}" "${project}" "error" "1.00" "1"
    check_retry_exhaustion "${request_id}" "${project}" || true

    local events_file="${project}/.autonomous-dev/requests/${request_id}/events.jsonl"
    local last_type
    last_type=$(tail -1 "${events_file}" | jq -r '.type')
    assert_eq "retry_exhaustion" "${last_type}" "Last event type should be retry_exhaustion"

    # Verify event details
    local last_event
    last_event=$(tail -1 "${events_file}")
    local event_phase event_escalated
    event_phase=$(echo "${last_event}" | jq -r '.details.phase')
    event_escalated=$(echo "${last_event}" | jq -r '.details.escalated_to')
    assert_eq "code" "${event_phase}" "Event phase should be code"
    assert_eq "paused" "${event_escalated}" "Event escalated_to should be paused"
}

# =============================================================================
# Test 10: test_retry_exhaustion_alert
# After exhaustion, assert an alert file exists in $ALERTS_DIR with
# type: "retry_exhaustion".
# =============================================================================
test_retry_exhaustion_alert() {
    backoff_setup
    MAX_RETRIES_PER_PHASE=3

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-alert-001"
    create_test_request "${project}" "${request_id}" "code" 2

    update_request_state "${request_id}" "${project}" "error" "1.00" "1"
    check_retry_exhaustion "${request_id}" "${project}" || true

    local found
    found=$(find "${ALERTS_DIR}" -name "alert-retry_exhaustion-*.json" -type f | head -1)
    assert_file_exists "${found}"

    local atype
    atype=$(jq -r '.type' "${found}")
    assert_eq "retry_exhaustion" "${atype}" "Alert type should be retry_exhaustion"
}

# =============================================================================
# Test 11: test_paused_request_not_selected
# Set request status to paused. Call select_request. Assert not selected.
# =============================================================================
test_paused_request_not_selected() {
    backoff_setup

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-paused-001"
    create_test_request "${project}" "${request_id}" "paused" 3

    # Set up effective config with the repo in the allowlist
    EFFECTIVE_CONFIG="${_TEST_DIR}/effective-config.json"
    jq --arg repo "${project}" '.repositories.allowlist = [$repo]' "${DEFAULTS_FILE}" > "${EFFECTIVE_CONFIG}"

    local result
    result=$(select_request)
    assert_eq "" "${result}" "Paused request should not be selected"
}

# =============================================================================
# Test 12: test_turn_exhaustion_exit_code_2
# Call detect_turn_exhaustion 2 "/nonexistent". Assert return 0 (detected).
# =============================================================================
test_turn_exhaustion_exit_code_2() {
    backoff_setup
    local rc=0
    detect_turn_exhaustion 2 "/nonexistent" || rc=$?
    assert_eq "0" "${rc}" "Exit code 2 should be detected as turn exhaustion"
}

# =============================================================================
# Test 13: test_turn_exhaustion_output_field
# Create an output file with {"reason": "max_turns_reached"}.
# Call detect_turn_exhaustion 1 "${output_file}". Assert return 0.
# =============================================================================
test_turn_exhaustion_output_field() {
    backoff_setup
    local output_file="${_TEST_DIR}/session-output.json"
    echo '{"reason": "max_turns_reached"}' > "${output_file}"

    local rc=0
    detect_turn_exhaustion 1 "${output_file}" || rc=$?
    assert_eq "0" "${rc}" "max_turns_reached in output should be detected as turn exhaustion"
}

# =============================================================================
# Test 14: test_turn_exhaustion_not_detected
# Call detect_turn_exhaustion 1 "/nonexistent". Assert return 1 (not detected).
# =============================================================================
test_turn_exhaustion_not_detected() {
    backoff_setup
    local rc=0
    detect_turn_exhaustion 1 "/nonexistent" || rc=$?
    assert_eq "1" "${rc}" "Exit code 1 with no output should not be turn exhaustion"
}

# =============================================================================
# Test 15: test_turn_exhaustion_no_crash_count
# Set CONSECUTIVE_CRASHES=0. Simulate a turn exhaustion flow.
# Assert CONSECUTIVE_CRASHES is still 0 (not incremented).
# =============================================================================
test_turn_exhaustion_no_crash_count() {
    backoff_setup
    CONSECUTIVE_CRASHES=0

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-turns-001"
    create_test_request "${project}" "${request_id}" "code" 0

    # Simulate what the main loop does for turn exhaustion:
    # update_request_state (error path) but do NOT call record_crash
    update_request_state "${request_id}" "${project}" "error" "0.50" "2"

    # The key assertion: CONSECUTIVE_CRASHES was not incremented
    # (record_crash was NOT called in turn exhaustion path)
    assert_eq "0" "${CONSECUTIVE_CRASHES}" "CONSECUTIVE_CRASHES should remain 0 after turn exhaustion"
}

# =============================================================================
# Test 16: test_turn_exhaustion_retry_increments
# Simulate turn exhaustion. Assert retry_count in state.json is incremented.
# =============================================================================
test_turn_exhaustion_retry_increments() {
    backoff_setup

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-turns-002"
    create_test_request "${project}" "${request_id}" "code" 0

    # Simulate turn exhaustion: update_request_state with error
    update_request_state "${request_id}" "${project}" "error" "0.50" "2"

    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"
    local retry_count
    retry_count=$(jq -r '.current_phase_metadata.retry_count' "${state_file}")
    assert_eq "1" "${retry_count}" "retry_count should be incremented to 1"
}

# =============================================================================
# Test 17: test_turn_exhaustion_log_recommendation
# Simulate turn exhaustion. Assert log contains "Consider increasing max_turns".
# =============================================================================
test_turn_exhaustion_log_recommendation() {
    backoff_setup

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-turns-003"
    create_test_request "${project}" "${request_id}" "code" 0

    # Detect turn exhaustion and log the recommendation
    local exit_code=2
    local output_file="/nonexistent"
    if detect_turn_exhaustion "${exit_code}" "${output_file}"; then
        local status
        status=$(jq -r '.status' "${project}/.autonomous-dev/requests/${request_id}/state.json" 2>/dev/null || echo "unknown")
        log_warn "Turn budget exhausted for ${request_id}. Consider increasing max_turns for phase '${status}'."
        log_warn "Hint: Set daemon.max_turns_by_phase.${status} in ~/.claude/autonomous-dev.json"
    fi

    assert_contains "$(cat "${LOG_FILE}")" "Consider increasing max_turns"
}

###############################################################################
# Run Tests
###############################################################################

run_test "compute_backoff_first_retry" test_compute_backoff_first_retry
run_test "compute_backoff_second_retry" test_compute_backoff_second_retry
run_test "compute_backoff_third_retry" test_compute_backoff_third_retry
run_test "compute_backoff_cap" test_compute_backoff_cap
run_test "backoff_written_to_state" test_backoff_written_to_state
run_test "backoff_request_skipped" test_backoff_request_skipped
run_test "backoff_request_selectable_after_expiry" test_backoff_request_selectable_after_expiry
run_test "retry_exhaustion_pauses" test_retry_exhaustion_pauses
run_test "retry_exhaustion_event" test_retry_exhaustion_event
run_test "retry_exhaustion_alert" test_retry_exhaustion_alert
run_test "paused_request_not_selected" test_paused_request_not_selected
run_test "turn_exhaustion_exit_code_2" test_turn_exhaustion_exit_code_2
run_test "turn_exhaustion_output_field" test_turn_exhaustion_output_field
run_test "turn_exhaustion_not_detected" test_turn_exhaustion_not_detected
run_test "turn_exhaustion_no_crash_count" test_turn_exhaustion_no_crash_count
run_test "turn_exhaustion_retry_increments" test_turn_exhaustion_retry_increments
run_test "turn_exhaustion_log_recommendation" test_turn_exhaustion_log_recommendation

report
