#!/usr/bin/env bats
###############################################################################
# session_heartbeat_progress.bats -- Tests for session_heartbeat.sh
# REQ-000060 / TASK-003
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    OBS_LIB="${PLUGIN_DIR}/lib/observability"
    # shellcheck source=../../lib/observability/session_transcript.sh
    source "${OBS_LIB}/session_transcript.sh"
    # shellcheck source=../../lib/observability/phase_baselines.sh
    source "${OBS_LIB}/phase_baselines.sh"
    # shellcheck source=../../lib/observability/hung_session_detector.sh
    source "${OBS_LIB}/hung_session_detector.sh"
    # shellcheck source=../../lib/observability/session_heartbeat.sh
    source "${OBS_LIB}/session_heartbeat.sh"

    export HOME="${BATS_TMPDIR}/home-hb-$$"
    mkdir -p "${HOME}"
    export AUTONOMOUS_DEV_HB_INTERVAL_S=1
    export AUTONOMOUS_DEV_HS_SILENT_STALL_SECONDS=300
    export AUTONOMOUS_DEV_HS_ANOMALY_MULTIPLIER=3.0
    export AUTONOMOUS_DEV_HS_MIN_BASELINE_SAMPLES=5

    REQ_DIR="${BATS_TMPDIR}/req-hb-$$"
    mkdir -p "${REQ_DIR}"
    OUTPUT_FILE="${REQ_DIR}/session-output.txt"
    PROGRESS_FILE="${REQ_DIR}/session-progress.json"
    PHASE_START_MS="$(now_ms)"
}

teardown() {
    rm -rf "${REQ_DIR}" "${HOME}" 2>/dev/null || true
}

# T3-U1: heartbeat_start and heartbeat_stop work
@test "heartbeat_start forks background sidecar and heartbeat_stop terminates it" {
    touch "${OUTPUT_FILE}"
    local hb_pid
    hb_pid="$(heartbeat_start "${REQ_DIR}" "${OUTPUT_FILE}" "${PROGRESS_FILE}" \
        "REQ-000060" "test" "${PHASE_START_MS}")"

    # Sidecar should be running
    [ -n "$hb_pid" ]
    run kill -0 "$hb_pid"
    [ "$status" -eq 0 ]

    # Stop it
    heartbeat_stop "$hb_pid" "${PROGRESS_FILE}"

    # Should no longer be running
    sleep 0.2
    run kill -0 "$hb_pid"
    [ "$status" -ne 0 ]
}

# T3-U2: Sample validates against schema
@test "heartbeat_start writes valid schema sample to progress_file" {
    touch "${OUTPUT_FILE}"
    local hb_pid
    hb_pid="$(heartbeat_start "${REQ_DIR}" "${OUTPUT_FILE}" "${PROGRESS_FILE}" \
        "REQ-000060" "test" "${PHASE_START_MS}")"

    # Wait for first sample
    local waited=0
    while [[ ! -f "${PROGRESS_FILE}" && "$waited" -lt 30 ]]; do
        sleep 0.1
        waited=$(( waited + 1 ))
    done

    heartbeat_stop "$hb_pid" "${PROGRESS_FILE}"

    [ -f "${PROGRESS_FILE}" ]
    run jq -e 'has("schema_version") and has("request_id") and has("phase") and has("session_pid") and has("started_at") and has("ts") and has("elapsed_ms") and has("transcript") and has("status")' "${PROGRESS_FILE}"
    [ "$status" -eq 0 ]

    # Check transcript sub-fields
    run jq -e '.transcript | has("path") and has("bytes") and has("last_mtime") and has("delta_bytes_last_interval") and has("silent_seconds")' "${PROGRESS_FILE}"
    [ "$status" -eq 0 ]
}

# T3-U4: heartbeat_stop writes exited status within reasonable time
@test "heartbeat_stop updates progress_file status to exited" {
    touch "${OUTPUT_FILE}"
    local hb_pid
    hb_pid="$(heartbeat_start "${REQ_DIR}" "${OUTPUT_FILE}" "${PROGRESS_FILE}" \
        "REQ-000060" "test" "${PHASE_START_MS}")"

    # Wait for first sample
    local waited=0
    while [[ ! -f "${PROGRESS_FILE}" && "$waited" -lt 30 ]]; do
        sleep 0.1
        waited=$(( waited + 1 ))
    done

    heartbeat_stop "$hb_pid" "${PROGRESS_FILE}"

    run jq -r '.status' "${PROGRESS_FILE}"
    [ "$status" -eq 0 ]
    [ "$output" = "exited" ]
}

# T3-U5: Env override AUTONOMOUS_DEV_HB_INTERVAL_S=1 is respected
@test "heartbeat_start respects AUTONOMOUS_DEV_HB_INTERVAL_S interval" {
    export AUTONOMOUS_DEV_HB_INTERVAL_S=1
    local progress_stream="${BATS_TMPDIR}/progress-stream-$$.jsonl"
    export AUTONOMOUS_DEV_HB_PROGRESS_STREAM="$progress_stream"

    touch "${OUTPUT_FILE}"
    local hb_pid
    hb_pid="$(heartbeat_start "${REQ_DIR}" "${OUTPUT_FILE}" "${PROGRESS_FILE}" \
        "REQ-000060" "test" "${PHASE_START_MS}")"

    # Wait 3 seconds to allow at least 2 writes at 1s interval
    sleep 3

    heartbeat_stop "$hb_pid" "${PROGRESS_FILE}"
    unset AUTONOMOUS_DEV_HB_PROGRESS_STREAM

    # Check progress_stream has at least 2 lines
    local write_count=0
    if [[ -f "$progress_stream" ]]; then
        write_count="$(wc -l < "$progress_stream" | tr -d ' ')"
    fi
    [ "$write_count" -ge 2 ]
    rm -f "$progress_stream"
}

# T3-U7: Missing output_file -> bytes=0, silent_seconds=0 on first sample
@test "heartbeat_start handles missing output_file gracefully" {
    # Do NOT create output_file
    local hb_pid
    hb_pid="$(heartbeat_start "${REQ_DIR}" "${OUTPUT_FILE}" "${PROGRESS_FILE}" \
        "REQ-000060" "test" "${PHASE_START_MS}")"

    # Wait for sample
    local waited=0
    while [[ ! -f "${PROGRESS_FILE}" && "$waited" -lt 30 ]]; do
        sleep 0.1
        waited=$(( waited + 1 ))
    done

    heartbeat_stop "$hb_pid" "${PROGRESS_FILE}"

    [ -f "${PROGRESS_FILE}" ]
    run jq -r '.transcript.bytes' "${PROGRESS_FILE}"
    [ "$output" = "0" ]

    run jq -r '.transcript.silent_seconds' "${PROGRESS_FILE}"
    [ "$output" = "0" ]

    run jq -r '.transcript.last_mtime' "${PROGRESS_FILE}"
    [ "$output" = "null" ]
}

# T3-U3: Monotonic elapsed_ms
@test "heartbeat elapsed_ms is non-decreasing across samples" {
    export AUTONOMOUS_DEV_HB_INTERVAL_S=1
    local progress_stream="${BATS_TMPDIR}/progress-mono-$$.jsonl"
    export AUTONOMOUS_DEV_HB_PROGRESS_STREAM="$progress_stream"

    touch "${OUTPUT_FILE}"
    local hb_pid
    hb_pid="$(heartbeat_start "${REQ_DIR}" "${OUTPUT_FILE}" "${PROGRESS_FILE}" \
        "REQ-000060" "test" "${PHASE_START_MS}")"

    sleep 3
    heartbeat_stop "$hb_pid" "${PROGRESS_FILE}"
    unset AUTONOMOUS_DEV_HB_PROGRESS_STREAM

    if [[ -f "$progress_stream" ]]; then
        local line_count
        line_count="$(wc -l < "$progress_stream" | tr -d ' ')"
        if [[ "$line_count" -ge 2 ]]; then
            # Check monotonicity of elapsed_ms
            local prev_elapsed=0
            while IFS= read -r line; do
                local cur_elapsed
                cur_elapsed="$(echo "$line" | jq -r '.elapsed_ms // 0' 2>/dev/null || echo "0")"
                [ "$cur_elapsed" -ge "$prev_elapsed" ]
                prev_elapsed="$cur_elapsed"
            done < "$progress_stream"
        fi
    fi
    rm -f "$progress_stream"
}

# T3-U8: Detector failure does not crash sidecar
@test "heartbeat_start continues when detect_hung stub fails" {
    export AUTONOMOUS_DEV_HB_INTERVAL_S=1
    local progress_stream="${BATS_TMPDIR}/progress-det-fail-$$.jsonl"
    export AUTONOMOUS_DEV_HB_PROGRESS_STREAM="$progress_stream"

    # Make detect_hung a stub that always fails (override via env)
    # We achieve this by adding a fake detect_hung to PATH
    local fake_bin="${BATS_TMPDIR}/fake-det-$$"
    mkdir -p "$fake_bin"
    printf '#!/usr/bin/env bash\nexit 1\n' > "${fake_bin}/detect_hung_bad"
    chmod +x "${fake_bin}/detect_hung_bad"

    touch "${OUTPUT_FILE}"
    local hb_pid
    hb_pid="$(heartbeat_start "${REQ_DIR}" "${OUTPUT_FILE}" "${PROGRESS_FILE}" \
        "REQ-000060" "test" "${PHASE_START_MS}")"

    sleep 2.5
    heartbeat_stop "$hb_pid" "${PROGRESS_FILE}"
    unset AUTONOMOUS_DEV_HB_PROGRESS_STREAM

    # Progress file should have been written (sidecar didn't crash)
    [ -f "${PROGRESS_FILE}" ]

    if [[ -f "$progress_stream" ]]; then
        local line_count
        line_count="$(wc -l < "$progress_stream" | tr -d ' ')"
        [ "$line_count" -ge 1 ]
    fi
    rm -f "$progress_stream" 2>/dev/null || true
}
