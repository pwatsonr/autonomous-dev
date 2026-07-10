#!/usr/bin/env bats
###############################################################################
# supervisor_wedge_e2e.bats — REQ-000070 end-to-end incident reproduction
#
# End-to-end reproduction of the incident described in issue #632:
#   E2E-01 — 4 sleep/wake restarts escalate a wedged request to paused
#   E2E-02 — paused status survives sleep/wake recovery (Fix B reproduction)
#
# Both tests must complete in < 10 s wall-clock and exercise no real daemon
# start or network I/O.
#
# IMPORTANT: HOME must be set to a temp dir BEFORE sourcing supervisor-loop.sh.
###############################################################################

PLUGIN_DIR=""

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"

    TMPHOME="${BATS_TEST_TMPDIR}/home"
    mkdir -p "${TMPHOME}/.autonomous-dev/logs"
    export HOME="${TMPHOME}"

    REPO="${BATS_TEST_TMPDIR}/repo"
    mkdir -p "${REPO}"

    export EFFECTIVE_CONFIG="${TMPHOME}/effective-config.json"
    jq -n --arg repo "${REPO}" \
        '{repositories:{allowlist:[$repo]}, daemon:{circuit_breaker_threshold:3, stuck_reselection_threshold:3}}' \
        > "${EFFECTIVE_CONFIG}"

    set +e
    # shellcheck source=../../bin/supervisor-loop.sh
    source "${PLUGIN_DIR}/bin/supervisor-loop.sh"
    set -e

    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false
    STUCK_RESELECTION_THRESHOLD=3

    # Create required dirs (using readonly vars resolved at source time)
    mkdir -p "${ALERTS_DIR}"
    mkdir -p "${GATE_DECISIONS_DIR}"
    mkdir -p "$(dirname "${CRASH_STATE_FILE}")"

    # Request dir: escalate_to_paused uses ${project}/.autonomous-dev/requests/${req_id}/
    # PROJECT = TMPHOME so req dir = ${TMPHOME}/.autonomous-dev/requests/REQ-TEST
    PROJECT="${TMPHOME}"
    REQ_ID="REQ-TEST"
    REQ_DIR="${TMPHOME}/.autonomous-dev/requests/${REQ_ID}"
    STATE_FILE="${REQ_DIR}/state.json"
    CHECKPOINT_FILE="${REQ_DIR}/checkpoint.json"
    EVENTS_FILE="${REQ_DIR}/events.jsonl"
    mkdir -p "${REQ_DIR}"
    touch "${EVENTS_FILE}"
}

teardown() {
    rm -rf "${BATS_TEST_TMPDIR}/home" "${BATS_TEST_TMPDIR}/repo" 2>/dev/null || true
}

###############################################################################
# E2E-01 — 4 sleep/wake restarts escalate a wedged request
#
# Reproduces: request wedged in 'code' phase; daemon restarts 4× with no phase
# progress. On the 4th dispatch attempt, _stuck_reselection_check escalates
# the request to paused. No session is spawned after escalation.
###############################################################################

@test "E2E-01: wedged request in 'code' escalated to paused after 4 dispatch attempts (threshold=3)" {
    STUCK_RESELECTION_THRESHOLD=3
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false

    # Pin phase_started_at to a fixed value — no real clock dependency.
    jq -n '{
        id: "REQ-TEST",
        status: "active",
        current_phase: "code",
        phase_started_at: "2026-07-09T21:11:00Z",
        current_phase_metadata: { session_active: false }
    }' > "${STATE_FILE}"

    # Simulate 4 daemon restarts, each calling _stuck_reselection_check.
    # Use temp file to capture stdout so function runs in current shell
    # (not a subshell) — this ensures CONSECUTIVE_CRASHES updates are visible.
    local result_file="${BATS_TEST_TMPDIR}/e2e01_result.txt"
    for iteration in 1 2 3 4; do
        _stuck_reselection_check "${STATE_FILE}" "${REQ_ID}" "${PROJECT}" > "${result_file}"
        result=$(cat "${result_file}")
        if [ "${iteration}" -lt 4 ]; then
            # Iterations 1-3 must return ok (not escalated yet)
            [ "${result}" = "ok" ] || {
                echo "Expected ok on iteration ${iteration}, got: ${result}" >&2
                false
            }
        else
            # Iteration 4 must return escalated (next_count=4 > threshold=3)
            [ "${result}" = "escalated" ] || {
                echo "Expected escalated on iteration 4, got: ${result}" >&2
                false
            }
        fi
    done

    # After 4th iteration: request must be paused
    status_val=$(jq -r '.status' "${STATE_FILE}")
    [ "${status_val}" = "paused" ]

    # Crash counter must have advanced (record_crash was called on escalation)
    [ "${CONSECUTIVE_CRASHES}" -ge 1 ]

    # No session was spawned — _stuck_reselection_check alone does not spawn,
    # and no session-*.txt files should exist in the req dir.
    session_count=$(find "${REQ_DIR}" -name "session-*.txt" 2>/dev/null | wc -l | tr -d ' ')
    [ "${session_count}" -eq 0 ]
}

###############################################################################
# E2E-02 — paused status survives sleep/wake recovery (Fix B reproduction)
#
# Reproduces: operator pauses request; daemon restarts; sleep/wake checkpoint-
# restore previously overwrote state.json with the stale active checkpoint,
# silently re-activating the paused request.
###############################################################################

@test "E2E-02: paused request is NOT re-activated by sleep/wake checkpoint-restore" {
    # Operator has paused the request
    jq -n '{
        id: "REQ-TEST",
        status: "paused",
        current_phase: "code",
        phase_started_at: "2026-07-09T21:11:00Z",
        current_phase_metadata: {
            session_active: true,
            paused_reason: "Operator paused"
        }
    }' > "${STATE_FILE}"

    # Stale checkpoint has status=active (pre-pause snapshot)
    jq -n '{
        id: "REQ-TEST",
        status: "active",
        current_phase: "code",
        current_phase_metadata: { session_active: true }
    }' > "${CHECKPOINT_FILE}"

    # Simulate daemon sleep/wake recovery
    restore_interrupted_session "${REQ_ID}" "${REQ_DIR}" "${PROJECT}"

    # status must STILL be paused — checkpoint must NOT have overwritten it
    status_val=$(jq -r '.status' "${STATE_FILE}")
    [ "${status_val}" = "paused" ]

    # session_active must be cleared
    session_active=$(jq -r '.current_phase_metadata.session_active' "${STATE_FILE}")
    [ "${session_active}" = "false" ]

    # select_request would skip this request because .status == "paused"
    # (case statement at select_request: done|cancelled|failed|paused) continue ;;)
    # Weaker form: assert final status on disk is "paused"
    final_status=$(jq -r '.status' "${STATE_FILE}")
    [ "${final_status}" = "paused" ]
}
