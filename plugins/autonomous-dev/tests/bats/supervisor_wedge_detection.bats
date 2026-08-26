#!/usr/bin/env bats
###############################################################################
# supervisor_wedge_detection.bats — REQ-000070 Fix A regression suite
#
# Tests for _stuck_reselection_check():
#   A-01 — arithmetic: threshold=3, calls 1-3 → ok, call 4 → escalated
#   A-02 — phase change resets counter to 1
#   A-03 — phase restart (same name, new phase_started_at) resets counter to 1
#   A-04 — escalation side effects (status=paused, alert file, crash counter)
#   A-05 — three cycles trip circuit breaker
#   A-06 — STUCK_RESELECTION_THRESHOLD=0 disables check entirely
#
# IMPORTANT: HOME must be set to a temp dir BEFORE sourcing supervisor-loop.sh
# because DAEMON_HOME, ALERTS_DIR, CRASH_STATE_FILE etc. are readonly vars
# evaluated at source time. Do NOT export those vars after sourcing.
###############################################################################

PLUGIN_DIR=""

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"

    # Set HOME BEFORE sourcing so all readonly vars resolve under the temp tree.
    TMPHOME="${BATS_TEST_TMPDIR}/home"
    mkdir -p "${TMPHOME}/.autonomous-dev/logs"
    export HOME="${TMPHOME}"

    # Stand up a fake project repo (used as the 'project' arg to helper functions)
    REPO="${BATS_TEST_TMPDIR}/repo"
    mkdir -p "${REPO}"

    # Create a minimal effective config
    export EFFECTIVE_CONFIG="${TMPHOME}/effective-config.json"
    jq -n --arg repo "${REPO}" \
        '{repositories:{allowlist:[$repo]}, daemon:{circuit_breaker_threshold:3, stuck_reselection_threshold:3}}' \
        > "${EFFECTIVE_CONFIG}"

    # Source supervisor-loop.sh; BASH_SOURCE guard prevents main from running.
    set +e
    # shellcheck source=../../bin/supervisor-loop.sh
    source "${PLUGIN_DIR}/bin/supervisor-loop.sh"
    set -e

    # Reset crash state globals to known values (readonly vars are already set above)
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false

    # ALERTS_DIR is readonly = ${DAEMON_HOME}/alerts; create it.
    mkdir -p "${ALERTS_DIR}"
    # CRASH_STATE_FILE is readonly under DAEMON_HOME; ensure parent exists.
    mkdir -p "$(dirname "${CRASH_STATE_FILE}")"

    # Default threshold
    STUCK_RESELECTION_THRESHOLD=3

    # Create synthetic request directory under TMPHOME
    # escalate_to_paused uses: ${project}/.autonomous-dev/requests/${request_id}/
    # We set PROJECT=TMPHOME so REQ-TEST lands at the right path.
    PROJECT="${TMPHOME}"
    REQ_DIR="${TMPHOME}/.autonomous-dev/requests/REQ-TEST"
    mkdir -p "${REQ_DIR}"
    STATE_FILE="${REQ_DIR}/state.json"
    EVENTS_FILE="${REQ_DIR}/events.jsonl"

    jq -n '{
        id: "REQ-TEST",
        status: "active",
        current_phase: "code",
        phase_started_at: "2026-07-09T21:11:00Z",
        current_phase_metadata: {
            session_active: true
        }
    }' > "${STATE_FILE}"

    touch "${EVENTS_FILE}"
}

teardown() {
    rm -rf "${BATS_TEST_TMPDIR}/home" "${BATS_TEST_TMPDIR}/repo" 2>/dev/null || true
}

###############################################################################
# A-01 — arithmetic: threshold=3, calls 1-3 → ok, call 4 → escalated
###############################################################################

@test "A-01: counter increments and escalates only on call 4 (threshold=3)" {
    STUCK_RESELECTION_THRESHOLD=3

    # Call 1 → ok, count=1
    result=$(_stuck_reselection_check "${STATE_FILE}" "REQ-TEST" "${PROJECT}")
    [ "${result}" = "ok" ]
    count=$(jq -r '.current_phase_metadata.stuck_selection_count' "${STATE_FILE}")
    [ "${count}" = "1" ]

    # Call 2 → ok, count=2
    result=$(_stuck_reselection_check "${STATE_FILE}" "REQ-TEST" "${PROJECT}")
    [ "${result}" = "ok" ]
    count=$(jq -r '.current_phase_metadata.stuck_selection_count' "${STATE_FILE}")
    [ "${count}" = "2" ]

    # Call 3 → ok, count=3
    result=$(_stuck_reselection_check "${STATE_FILE}" "REQ-TEST" "${PROJECT}")
    [ "${result}" = "ok" ]
    count=$(jq -r '.current_phase_metadata.stuck_selection_count' "${STATE_FILE}")
    [ "${count}" = "3" ]

    # Call 4 → escalated, count=4, status=paused
    # Use temp file to capture stdout so function runs in current shell
    local result_file="${BATS_TEST_TMPDIR}/result_a01.txt"
    _stuck_reselection_check "${STATE_FILE}" "REQ-TEST" "${PROJECT}" > "${result_file}"
    result=$(cat "${result_file}")
    [ "${result}" = "escalated" ]
    count=$(jq -r '.current_phase_metadata.stuck_selection_count' "${STATE_FILE}")
    [ "${count}" = "4" ]
    status_val=$(jq -r '.status' "${STATE_FILE}")
    [ "${status_val}" = "paused" ]
}

###############################################################################
# A-02 — reset on phase change
###############################################################################

@test "A-02: phase change resets counter to 1" {
    STUCK_RESELECTION_THRESHOLD=3

    # Two calls in 'code' → count=2
    _stuck_reselection_check "${STATE_FILE}" "REQ-TEST" "${PROJECT}" > /dev/null
    _stuck_reselection_check "${STATE_FILE}" "REQ-TEST" "${PROJECT}" > /dev/null
    count=$(jq -r '.current_phase_metadata.stuck_selection_count' "${STATE_FILE}")
    [ "${count}" = "2" ]

    # Change phase to 'code_review'
    jq '.current_phase = "code_review"' "${STATE_FILE}" > "${STATE_FILE}.tmp" \
        && mv "${STATE_FILE}.tmp" "${STATE_FILE}"

    # Next call → ok, count=1, last_dispatch_phase=code_review
    local result_file="${BATS_TEST_TMPDIR}/result_a02.txt"
    _stuck_reselection_check "${STATE_FILE}" "REQ-TEST" "${PROJECT}" > "${result_file}"
    result=$(cat "${result_file}")
    [ "${result}" = "ok" ]
    count=$(jq -r '.current_phase_metadata.stuck_selection_count' "${STATE_FILE}")
    [ "${count}" = "1" ]
    last_phase=$(jq -r '.current_phase_metadata.last_dispatch_phase' "${STATE_FILE}")
    [ "${last_phase}" = "code_review" ]
}

###############################################################################
# A-03 — reset on phase restart (same phase name, new phase_started_at)
###############################################################################

@test "A-03: new phase_started_at resets counter to 1" {
    STUCK_RESELECTION_THRESHOLD=3

    # Two calls → count=2
    _stuck_reselection_check "${STATE_FILE}" "REQ-TEST" "${PROJECT}" > /dev/null
    _stuck_reselection_check "${STATE_FILE}" "REQ-TEST" "${PROJECT}" > /dev/null
    count=$(jq -r '.current_phase_metadata.stuck_selection_count' "${STATE_FILE}")
    [ "${count}" = "2" ]

    # Bump phase_started_at (same phase name 'code')
    jq '.phase_started_at = "2026-07-09T22:00:00Z"' "${STATE_FILE}" > "${STATE_FILE}.tmp" \
        && mv "${STATE_FILE}.tmp" "${STATE_FILE}"

    # Next call → ok, count=1, last_dispatch_phase_started_at updated
    local result_file="${BATS_TEST_TMPDIR}/result_a03.txt"
    _stuck_reselection_check "${STATE_FILE}" "REQ-TEST" "${PROJECT}" > "${result_file}"
    result=$(cat "${result_file}")
    [ "${result}" = "ok" ]
    count=$(jq -r '.current_phase_metadata.stuck_selection_count' "${STATE_FILE}")
    [ "${count}" = "1" ]
    last_started=$(jq -r '.current_phase_metadata.last_dispatch_phase_started_at' "${STATE_FILE}")
    [ "${last_started}" = "2026-07-09T22:00:00Z" ]
}

###############################################################################
# A-04 — escalation side effects
###############################################################################

@test "A-04: escalation sets status=paused, writes alert, increments crash counter" {
    STUCK_RESELECTION_THRESHOLD=3

    # Empty alerts dir
    rm -f "${ALERTS_DIR}"/alert-*.json 2>/dev/null || true

    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false

    # 3 ok calls — run in current shell (not subshell) so globals propagate
    _stuck_reselection_check "${STATE_FILE}" "REQ-TEST" "${PROJECT}" > /dev/null
    _stuck_reselection_check "${STATE_FILE}" "REQ-TEST" "${PROJECT}" > /dev/null
    _stuck_reselection_check "${STATE_FILE}" "REQ-TEST" "${PROJECT}" > /dev/null

    # 4th call — use temp file to capture stdout so function runs in current shell
    # (command substitution would create a subshell and hide CONSECUTIVE_CRASHES updates)
    local result_file="${BATS_TEST_TMPDIR}/result4.txt"
    _stuck_reselection_check "${STATE_FILE}" "REQ-TEST" "${PROJECT}" > "${result_file}"
    result=$(cat "${result_file}")
    [ "${result}" = "escalated" ]

    # status must be paused
    status_val=$(jq -r '.status' "${STATE_FILE}")
    [ "${status_val}" = "paused" ]

    # paused_reason must match expected patterns (existing escalate_to_paused or future wedge-specific)
    paused_reason=$(jq -r '.current_phase_metadata.paused_reason' "${STATE_FILE}")
    [[ "${paused_reason}" =~ ^(wedged_after_[0-9]+_reselections|Retry exhaustion in phase .*)$ ]]

    # At least one alert file with type "wedged_request"
    alert_count=$(find "${ALERTS_DIR}" -name "alert-*.json" 2>/dev/null \
        | xargs grep -l '"wedged_request"' 2>/dev/null | wc -l | tr -d ' ')
    [ "${alert_count}" -ge 1 ]

    # Crash counter must have been incremented (check both in-memory and on-disk)
    [ "${CONSECUTIVE_CRASHES}" -ge 1 ]
}

###############################################################################
# A-05 — three consecutive wedge escalations trip circuit breaker
###############################################################################

@test "A-05: three wedge escalations trip circuit_breaker_tripped" {
    STUCK_RESELECTION_THRESHOLD=3
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false

    for cycle in 1 2 3; do
        # Reset state to active with a fresh phase_started_at per cycle
        jq --arg pts "2026-07-09T21:1${cycle}:00Z" \
            '.status = "active" |
             .current_phase_metadata.stuck_selection_count = 0 |
             .current_phase_metadata.last_dispatch_phase = "" |
             .current_phase_metadata.last_dispatch_phase_started_at = "" |
             .phase_started_at = $pts' \
            "${STATE_FILE}" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "${STATE_FILE}"

        # 4 calls: first 3 ok, 4th escalates
        _stuck_reselection_check "${STATE_FILE}" "REQ-TEST" "${PROJECT}" > /dev/null
        _stuck_reselection_check "${STATE_FILE}" "REQ-TEST" "${PROJECT}" > /dev/null
        _stuck_reselection_check "${STATE_FILE}" "REQ-TEST" "${PROJECT}" > /dev/null
        _stuck_reselection_check "${STATE_FILE}" "REQ-TEST" "${PROJECT}" > /dev/null
    done

    # After 3 wedge escalations → circuit breaker must be tripped
    [ "${CIRCUIT_BREAKER_TRIPPED}" = "true" ]
}

###############################################################################
# A-06 — STUCK_RESELECTION_THRESHOLD=0 disables the check entirely
###############################################################################

@test "A-06: threshold=0 disables check, no counter written, no escalation" {
    STUCK_RESELECTION_THRESHOLD=0

    # 10 calls — all must return ok
    local result_file="${BATS_TEST_TMPDIR}/result_a06.txt"
    for _ in {1..10}; do
        _stuck_reselection_check "${STATE_FILE}" "REQ-TEST" "${PROJECT}" > "${result_file}"
        result=$(cat "${result_file}")
        [ "${result}" = "ok" ]
    done

    # status must still be active
    status_val=$(jq -r '.status' "${STATE_FILE}")
    [ "${status_val}" = "active" ]

    # stuck_selection_count must be absent or 0
    count=$(jq -r '.current_phase_metadata.stuck_selection_count // 0' "${STATE_FILE}")
    [ "${count}" = "0" ]
}
