#!/usr/bin/env bats
###############################################################################
# observability_events_roundtrip.bats -- Tests for observability_events.sh
# REQ-000060 / TASK-006
#
# NOTE: In bats 1.x, each test body runs in a subprocess where bash arrays
# (readonly -a) from setup() are NOT inherited. We source required files
# inside each test body that needs them.
#
# NOTE 2: `run` creates a subprocess where bash arrays are not available.
# For functions that depend on VALID_EVENT_TYPES array (event_append, emitters),
# we call them directly (not via `run`) and check $? manually.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    OBS_LIB="${PLUGIN_DIR}/lib/observability"
    STATE_LIB="${PLUGIN_DIR}/lib/state"

    # Use a REQ-ID that passes event_logger's regex: REQ-NNNNNNNN-NNNN
    TEST_REQ_ID="REQ-00000060-0000"
    TEST_SESSION_ID="sess-test-123"
    EVENTS_FILE="${BATS_TMPDIR}/events-roundtrip-$$.jsonl"
}

teardown() {
    rm -f "${EVENTS_FILE}" 2>/dev/null || true
}

# T6-U2: Enum accepts the three new event types (verified by array iteration)
@test "VALID_EVENT_TYPES includes session_hung_suspected" {
    source "${PLUGIN_DIR}/lib/state/event_logger.sh"
    local found=0
    for t in "${VALID_EVENT_TYPES[@]}"; do
        [[ "$t" == "session_hung_suspected" ]] && found=1 && break
    done
    [ "$found" -eq 1 ]
}

@test "VALID_EVENT_TYPES includes session_stuck" {
    source "${PLUGIN_DIR}/lib/state/event_logger.sh"
    local found=0
    for t in "${VALID_EVENT_TYPES[@]}"; do
        [[ "$t" == "session_stuck" ]] && found=1 && break
    done
    [ "$found" -eq 1 ]
}

@test "VALID_EVENT_TYPES includes session_recovered_after_stall" {
    source "${PLUGIN_DIR}/lib/state/event_logger.sh"
    local found=0
    for t in "${VALID_EVENT_TYPES[@]}"; do
        [[ "$t" == "session_recovered_after_stall" ]] && found=1 && break
    done
    [ "$found" -eq 1 ]
}

# T6-U2: event_append accepts new types (call directly — `run` loses array)
@test "event_append accepts session_hung_suspected event type" {
    source "${PLUGIN_DIR}/lib/state/event_logger.sh"
    local payload
    payload="$(jq -cn \
        --arg et "session_hung_suspected" \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg req "${TEST_REQ_ID}" \
        --arg sess "${TEST_SESSION_ID}" \
        '{schema_version:1, event_type:$et, timestamp:$ts, request_id:$req, session_id:$sess}')"
    event_append "${EVENTS_FILE}" "$payload"
}

@test "event_append accepts session_stuck event type" {
    source "${PLUGIN_DIR}/lib/state/event_logger.sh"
    local payload
    payload="$(jq -cn \
        --arg et "session_stuck" \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg req "${TEST_REQ_ID}" \
        --arg sess "${TEST_SESSION_ID}" \
        '{schema_version:1, event_type:$et, timestamp:$ts, request_id:$req, session_id:$sess}')"
    event_append "${EVENTS_FILE}" "$payload"
}

@test "event_append accepts session_recovered_after_stall event type" {
    source "${PLUGIN_DIR}/lib/state/event_logger.sh"
    local payload
    payload="$(jq -cn \
        --arg et "session_recovered_after_stall" \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg req "${TEST_REQ_ID}" \
        --arg sess "${TEST_SESSION_ID}" \
        '{schema_version:1, event_type:$et, timestamp:$ts, request_id:$req, session_id:$sess}')"
    event_append "${EVENTS_FILE}" "$payload"
}

# T6-U3: emit_session_hung_suspected round-trip
@test "emit_session_hung_suspected writes correct event_type to events file" {
    source "${PLUGIN_DIR}/lib/state/event_logger.sh"
    source "${PLUGIN_DIR}/lib/observability/session_transcript.sh"
    source "${PLUGIN_DIR}/lib/observability/observability_events.sh"

    emit_session_hung_suspected \
        "${EVENTS_FILE}" "${TEST_REQ_ID}" "${TEST_SESSION_ID}" \
        "test" "silent_stall" '{"silent_seconds":400}' "/tmp/snap.json"
    [ "$?" -eq 0 ]
    [ -f "${EVENTS_FILE}" ]
    local event_type
    event_type="$(tail -1 "${EVENTS_FILE}" | jq -r '.event_type')"
    [ "$event_type" = "session_hung_suspected" ]
}

# T6-U4: emit_session_stuck round-trip
@test "emit_session_stuck writes correct event_type to events file" {
    source "${PLUGIN_DIR}/lib/state/event_logger.sh"
    source "${PLUGIN_DIR}/lib/observability/session_transcript.sh"
    source "${PLUGIN_DIR}/lib/observability/observability_events.sh"

    emit_session_stuck \
        "${EVENTS_FILE}" "${TEST_REQ_ID}" "${TEST_SESSION_ID}" \
        "test" "hard_timeout" "/tmp/snap.json" "60000"
    [ "$?" -eq 0 ]
    [ -f "${EVENTS_FILE}" ]
    local event_type
    event_type="$(tail -1 "${EVENTS_FILE}" | jq -r '.event_type')"
    [ "$event_type" = "session_stuck" ]
}

# T6-U5: emit_session_recovered_after_stall round-trip
@test "emit_session_recovered_after_stall writes correct event and suspected_count" {
    source "${PLUGIN_DIR}/lib/state/event_logger.sh"
    source "${PLUGIN_DIR}/lib/observability/session_transcript.sh"
    source "${PLUGIN_DIR}/lib/observability/observability_events.sh"

    emit_session_recovered_after_stall \
        "${EVENTS_FILE}" "${TEST_REQ_ID}" "${TEST_SESSION_ID}" \
        "test" "3"
    [ "$?" -eq 0 ]
    [ -f "${EVENTS_FILE}" ]
    local event_type
    event_type="$(tail -1 "${EVENTS_FILE}" | jq -r '.event_type')"
    [ "$event_type" = "session_recovered_after_stall" ]
    local sc
    sc="$(tail -1 "${EVENTS_FILE}" | jq -r '.suspected_count')"
    [ "$sc" = "3" ]
}

# T6-U6: Unknown event_type rejected
@test "event_append rejects unknown event_type" {
    source "${PLUGIN_DIR}/lib/state/event_logger.sh"
    local payload
    payload="$(jq -cn \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg req "${TEST_REQ_ID}" \
        --arg sess "${TEST_SESSION_ID}" \
        '{schema_version:1, event_type:"garbage_type_xyz", timestamp:$ts, request_id:$req, session_id:$sess}')"
    # Should fail; use set +e to capture exit code
    set +e
    event_append "${EVENTS_FILE}" "$payload" 2>/dev/null
    local rc=$?
    set -e
    [ "$rc" -ne 0 ]
}

# T6-U7: Emitter on write failure returns non-zero (write to read-only dir)
@test "emit_session_hung_suspected on write failure returns non-zero" {
    # Create a read-only directory so writes fail, then test in a subshell
    # (subshell sources event_logger.sh fresh so set -e is active for the test)
    local ro_dir="${BATS_TMPDIR}/ro-events-$$"
    mkdir -p "$ro_dir"
    chmod 0555 "$ro_dir"

    # Use || rc=$? so set -e in the outer test body doesn't catch the
    # subshell's non-zero exit before we can capture it.
    local rc=0
    (
        source "${PLUGIN_DIR}/lib/state/event_logger.sh"
        source "${PLUGIN_DIR}/lib/observability/session_transcript.sh"
        source "${PLUGIN_DIR}/lib/observability/observability_events.sh"
        emit_session_hung_suspected \
            "${ro_dir}/events.jsonl" "${TEST_REQ_ID}" "${TEST_SESSION_ID}" \
            "test" "silent_stall" '{}' "" 2>/dev/null
    ) || rc=$?

    chmod 0755 "$ro_dir"
    rm -rf "$ro_dir"
    [ "$rc" -ne 0 ]
}
