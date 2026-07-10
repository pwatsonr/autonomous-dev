#!/usr/bin/env bats
###############################################################################
# supervisor_recovery.bats — REQ-000070 Fix B regression suite
#
# Tests for the lifecycle-status short-circuit in restore_interrupted_session():
#   B-01 — paused state.json is NOT overwritten by checkpoint
#   B-02a — cancelled state is also protected
#   B-02b — failed state is also protected
#   B-03 — active status still restores normally (regression guard)
#   B-04 — events.jsonl records skipped_restore_lifecycle_status
#   B-05 — REQ-000059 cancellation-tombstone still takes precedence over Fix B
#
# IMPORTANT: HOME must be set to a temp dir BEFORE sourcing supervisor-loop.sh
# because GATE_DECISIONS_DIR and other vars are readonly at source time.
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
        '{repositories:{allowlist:[$repo]}, daemon:{}}' \
        > "${EFFECTIVE_CONFIG}"

    # Source supervisor-loop.sh; BASH_SOURCE guard prevents main from running.
    set +e
    # shellcheck source=../../bin/supervisor-loop.sh
    source "${PLUGIN_DIR}/bin/supervisor-loop.sh"
    set -e

    # GATE_DECISIONS_DIR is readonly = ${DAEMON_HOME}/gate-decisions; create it.
    mkdir -p "${GATE_DECISIONS_DIR}"
    mkdir -p "${ALERTS_DIR}"

    # Build fixture paths — req dir is inside REPO
    REQ_ID="REQ-TEST"
    REQ_DIR="${REPO}/.autonomous-dev/requests/${REQ_ID}"
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
# Helpers
###############################################################################

# write_state(status, [session_active])
write_state() {
    local status="${1}"
    local session_active="${2:-true}"
    jq -n \
        --arg id "${REQ_ID}" \
        --arg status "${status}" \
        --argjson sa "${session_active}" \
        '{
            id: $id,
            status: $status,
            current_phase: "code",
            phase_started_at: "2026-07-09T21:11:00Z",
            current_phase_metadata: { session_active: $sa }
        }' > "${STATE_FILE}"
}

# write_checkpoint() — always represents a stale active/session_active=true snapshot
write_checkpoint() {
    jq -n \
        --arg id "${REQ_ID}" \
        '{
            id: $id,
            status: "active",
            current_phase: "code",
            current_phase_metadata: {
                session_active: true,
                dispatched_phase: "code"
            }
        }' > "${CHECKPOINT_FILE}"
}

###############################################################################
# B-01 — paused state.json is NOT overwritten by checkpoint
###############################################################################

@test "B-01: paused state.json is not overwritten by stale checkpoint" {
    write_state "paused"
    write_checkpoint

    restore_interrupted_session "${REQ_ID}" "${REQ_DIR}" "${REPO}"

    # status must still be paused
    status_val=$(jq -r '.status' "${STATE_FILE}")
    [ "${status_val}" = "paused" ]

    # session_active must have been cleared
    session_active=$(jq -r '.current_phase_metadata.session_active' "${STATE_FILE}")
    [ "${session_active}" = "false" ]

    # dispatched_phase from checkpoint must NOT be present
    dispatched_phase=$(jq -r '.current_phase_metadata.dispatched_phase // ""' "${STATE_FILE}")
    [ "${dispatched_phase}" = "" ]
}

###############################################################################
# B-02a — cancelled state is also protected
###############################################################################

@test "B-02a: cancelled state.json is not overwritten by stale checkpoint" {
    write_state "cancelled"
    write_checkpoint

    restore_interrupted_session "${REQ_ID}" "${REQ_DIR}" "${REPO}"

    status_val=$(jq -r '.status' "${STATE_FILE}")
    [ "${status_val}" = "cancelled" ]

    session_active=$(jq -r '.current_phase_metadata.session_active' "${STATE_FILE}")
    [ "${session_active}" = "false" ]
}

###############################################################################
# B-02b — failed state is also protected
###############################################################################

@test "B-02b: failed state.json is not overwritten by stale checkpoint" {
    write_state "failed"
    write_checkpoint

    restore_interrupted_session "${REQ_ID}" "${REQ_DIR}" "${REPO}"

    status_val=$(jq -r '.status' "${STATE_FILE}")
    [ "${status_val}" = "failed" ]

    session_active=$(jq -r '.current_phase_metadata.session_active' "${STATE_FILE}")
    [ "${session_active}" = "false" ]
}

###############################################################################
# B-03 — active status still restores (regression guard)
###############################################################################

@test "B-03: active state.json is replaced by checkpoint (normal restore path)" {
    write_state "active"
    write_checkpoint

    restore_interrupted_session "${REQ_ID}" "${REQ_DIR}" "${REPO}"

    # Checkpoint had dispatched_phase=code — verify it was copied over
    dispatched_phase=$(jq -r '.current_phase_metadata.dispatched_phase // ""' "${STATE_FILE}")
    [ "${dispatched_phase}" = "code" ]

    # session_active must be cleared by the tail of restore_interrupted_session
    session_active=$(jq -r '.current_phase_metadata.session_active' "${STATE_FILE}")
    [ "${session_active}" = "false" ]

    # events.jsonl must contain restored_from_checkpoint event
    # Use jq -s 'last' to handle both compact and pretty-printed JSON events
    recovery_action=$(jq -rs 'last | .details.recovery_action' "${EVENTS_FILE}")
    [ "${recovery_action}" = "restored_from_checkpoint" ]
}

###############################################################################
# B-04 — events.jsonl records skipped_restore_lifecycle_status
###############################################################################

@test "B-04: events.jsonl records skipped_restore_lifecycle_status for paused request" {
    write_state "paused"
    write_checkpoint

    restore_interrupted_session "${REQ_ID}" "${REQ_DIR}" "${REPO}"

    # Parse the last event from events.jsonl
    # (the Fix B write uses compact output; jq -s 'last' handles both formats)
    event_json=$(jq -cs 'last' "${EVENTS_FILE}")
    [ -n "${event_json}" ]
    [ "${event_json}" != "null" ]

    event_type=$(echo "${event_json}" | jq -r '.type')
    [ "${event_type}" = "session_interrupted" ]

    recovery_action=$(echo "${event_json}" | jq -r '.details.recovery_action')
    [ "${recovery_action}" = "skipped_restore_lifecycle_status" ]

    lifecycle_status=$(echo "${event_json}" | jq -r '.details.lifecycle_status')
    [ "${lifecycle_status}" = "paused" ]

    request_id_val=$(echo "${event_json}" | jq -r '.request_id')
    [ "${request_id_val}" = "${REQ_ID}" ]
}

###############################################################################
# B-05 — REQ-000059 cancellation-tombstone still takes precedence over Fix B
###############################################################################

@test "B-05: cancellation tombstone short-circuits before Fix B lifecycle check" {
    # state.json is 'active' so Fix B would NOT trigger for this status.
    # Place a tombstone so the REQ-000059 short-circuit fires first.
    write_state "active"
    write_checkpoint
    touch "${REQ_DIR}/cancelled.tombstone"

    restore_interrupted_session "${REQ_ID}" "${REQ_DIR}" "${REPO}"

    # events.jsonl must NOT contain skipped_restore_lifecycle_status
    if grep -q "skipped_restore_lifecycle_status" "${EVENTS_FILE}" 2>/dev/null; then
        echo "FAIL: skipped_restore_lifecycle_status event found — Fix B ran before tombstone check" >&2
        false
    fi

    # The checkpoint dispatched_phase=code must NOT have been restored
    # (tombstone short-circuit prevents the checkpoint copy)
    dispatched_phase=$(jq -r '.current_phase_metadata.dispatched_phase // ""' "${STATE_FILE}")
    [ "${dispatched_phase}" != "code" ]
}
