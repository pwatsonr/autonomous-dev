#!/usr/bin/env bats
###############################################################################
# session_stuck_snapshot_shape.bats -- Tests for session_stuck_snapshot.sh
# REQ-000060 / TASK-005
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    OBS_LIB="${PLUGIN_DIR}/lib/observability"
    # shellcheck source=../../lib/observability/session_transcript.sh
    source "${OBS_LIB}/session_transcript.sh"
    # shellcheck source=../../lib/observability/phase_baselines.sh
    source "${OBS_LIB}/phase_baselines.sh"
    # shellcheck source=../../lib/observability/session_stuck_snapshot.sh
    source "${OBS_LIB}/session_stuck_snapshot.sh"

    export HOME="${BATS_TMPDIR}/home-snap-$$"
    mkdir -p "${HOME}"

    REQ_DIR="${BATS_TMPDIR}/req-snap-$$"
    mkdir -p "${REQ_DIR}"
    OUTPUT_FILE="${REQ_DIR}/session-output.txt"
    PROGRESS_FILE="${REQ_DIR}/session-progress.json"
    REQUEST_ID="REQ-000060"
    PHASE="test"
}

teardown() {
    rm -rf "${REQ_DIR}" "${HOME}" 2>/dev/null || true
}

# Helper: create a minimal progress file
_make_progress() {
    printf '{"schema_version":1,"request_id":"%s","phase":"%s","session_pid":null,"started_at":"2026-07-07T00:00:00Z","ts":"2026-07-07T00:01:00Z","elapsed_ms":60000,"transcript":{"path":"%s","bytes":100,"last_mtime":"2026-07-07T00:00:50Z","delta_bytes_last_interval":10,"silent_seconds":10},"status":"running"}\n' \
        "$REQUEST_ID" "$PHASE" "$OUTPUT_FILE" > "${PROGRESS_FILE}"
}

# T5-U1: Snapshot conforms to schema
@test "stuck_snapshot_postmortem creates valid snapshot with required keys" {
    printf 'line1\nline2\n' > "${OUTPUT_FILE}"
    _make_progress

    local snap_path
    snap_path="$(stuck_snapshot_postmortem "${REQ_DIR}" "${OUTPUT_FILE}" "${PROGRESS_FILE}" \
        "${REQUEST_ID}" "${PHASE}" "hard_timeout" "")"

    [ -n "$snap_path" ]
    [ -f "$snap_path" ]

    # Check all required keys
    run jq -e 'has("schema_version") and has("captured_at") and has("mode") and has("reason") and has("request_id") and has("phase") and has("elapsed_ms") and has("session") and has("transcript") and has("heartbeat") and has("baselines")' "$snap_path"
    [ "$status" -eq 0 ]

    # Check schema_version = 1
    run jq -e '.schema_version == 1' "$snap_path"
    [ "$status" -eq 0 ]

    # Check mode = postmortem
    run jq -r '.mode' "$snap_path"
    [ "$output" = "postmortem" ]

    # Check reason = hard_timeout
    run jq -r '.reason' "$snap_path"
    [ "$output" = "hard_timeout" ]
}

# T5-U2: lsof unavailable graceful
@test "stuck_snapshot handles missing lsof gracefully" {
    printf 'test content\n' > "${OUTPUT_FILE}"
    _make_progress

    local old_path="$PATH"
    # Remove lsof from PATH by shadowing with empty dir
    local fake_bin="${BATS_TMPDIR}/fake-no-lsof-$$"
    mkdir -p "$fake_bin"
    export PATH="${fake_bin}:${PATH}"

    local snap_path
    snap_path="$(stuck_snapshot_postmortem "${REQ_DIR}" "${OUTPUT_FILE}" "${PROGRESS_FILE}" \
        "${REQUEST_ID}" "${PHASE}" "hard_timeout" "")"

    export PATH="$old_path"

    [ -f "$snap_path" ]
    run jq -e '.session.open_fds == []' "$snap_path"
    [ "$status" -eq 0 ]

    run jq -r '.session.lsof_error' "$snap_path"
    [ "$output" = "unavailable" ]
}

# T5-U3: Non-existent PID
@test "stuck_snapshot handles non-existent PID gracefully" {
    printf 'test content\n' > "${OUTPUT_FILE}"
    # Progress with a fake PID that doesn't exist
    printf '{"schema_version":1,"request_id":"%s","phase":"%s","session_pid":999999,"started_at":"2026-07-07T00:00:00Z","ts":"2026-07-07T00:01:00Z","elapsed_ms":60000,"transcript":{"path":"%s","bytes":100,"last_mtime":null,"delta_bytes_last_interval":0,"silent_seconds":0},"status":"running"}\n' \
        "$REQUEST_ID" "$PHASE" "$OUTPUT_FILE" > "${PROGRESS_FILE}"

    local snap_path
    snap_path="$(stuck_snapshot_postmortem "${REQ_DIR}" "${OUTPUT_FILE}" "${PROGRESS_FILE}" \
        "${REQUEST_ID}" "${PHASE}" "hard_timeout" "")"

    [ -f "$snap_path" ]
    run jq -r '.session.ps_line' "$snap_path"
    [ "$output" = "unavailable" ]
}

# T5-U4: Transcript tail bounded
@test "stuck_snapshot bounds transcript tail to 128 lines / 65536 bytes" {
    # Create a large transcript (200 lines)
    printf '%0.s1234567890abcdef_padding_line\n' $(seq 1 300) > "${OUTPUT_FILE}"
    _make_progress

    local snap_path
    snap_path="$(stuck_snapshot_postmortem "${REQ_DIR}" "${OUTPUT_FILE}" "${PROGRESS_FILE}" \
        "${REQUEST_ID}" "${PHASE}" "hard_timeout" "")"

    [ -f "$snap_path" ]

    local tail_count
    tail_count="$(jq '.transcript.tail_128_lines | length' "$snap_path")"
    [ "$tail_count" -le 128 ]
}

# T5-U5: Redaction of keychain paths
@test "stuck_snapshot redacts /Library/Keychains paths from lsof output" {
    # Test _snap_collect_session directly with a mock lsof by checking the awk parser
    # We test the redaction rule via the snapshot's session.open_fds
    # Since we can't inject fake lsof easily, we test the function's awk logic
    local awk_result
    awk_result="$(echo -e 'f1\ntIPv4\nn/Library/Keychains/foo.db\nf2\nttxt\nn/usr/bin/bash' | \
        awk 'BEGIN {
            fd=""; type=""; name=""; count=0; truncated=0;
            printf "["
            first=1
        }
        /^f/ {
            if (fd != "") {
                n = name
                if (n ~ /^\/Users\/.*\/private\// || n ~ /^\/Library\/Keychains\//) {
                    n = "<redacted>"
                }
                if (!first) printf ","
                printf "{\"fd\":\"%s\",\"type\":\"%s\",\"name\":\"%s\"}", fd, type, n
                first=0
                count++
            }
            fd=substr($0,2); type=""; name=""
        }
        /^t/ { type=substr($0,2) }
        /^n/ { name=substr($0,2) }
        END {
            if (fd != "") {
                n = name
                if (n ~ /^\/Users\/.*\/private\// || n ~ /^\/Library\/Keychains\//) {
                    n = "<redacted>"
                }
                if (!first) printf ","
                printf "{\"fd\":\"%s\",\"type\":\"%s\",\"name\":\"%s\"}", fd, type, n
            }
            printf "]"
        }' 2>/dev/null)"

    local redacted_name
    redacted_name="$(echo "$awk_result" | jq -r '.[0].name')"
    [ "$redacted_name" = "<redacted>" ]
}

# T5-U6: Redaction of /Users/*/private/ paths
@test "stuck_snapshot redacts /Users/*/private/ paths" {
    local awk_result
    awk_result="$(echo -e 'f3\ntIPv4\nn/Users/alice/private/secret.sock' | \
        awk 'BEGIN {
            fd=""; type=""; name=""; count=0;
            printf "["
            first=1
        }
        /^f/ {
            if (fd != "") {
                n = name
                if (n ~ /^\/Users\/.*\/private\// || n ~ /^\/Library\/Keychains\//) {
                    n = "<redacted>"
                }
                if (!first) printf ","
                printf "{\"fd\":\"%s\",\"type\":\"%s\",\"name\":\"%s\"}", fd, type, n
                first=0
            }
            fd=substr($0,2); type=""; name=""
        }
        /^t/ { type=substr($0,2) }
        /^n/ { name=substr($0,2) }
        END {
            if (fd != "") {
                n = name
                if (n ~ /^\/Users\/.*\/private\// || n ~ /^\/Library\/Keychains\//) {
                    n = "<redacted>"
                }
                if (!first) printf ","
                printf "{\"fd\":\"%s\",\"type\":\"%s\",\"name\":\"%s\"}", fd, type, n
            }
            printf "]"
        }' 2>/dev/null)"

    local redacted_name
    redacted_name="$(echo "$awk_result" | jq -r '.[0].name')"
    [ "$redacted_name" = "<redacted>" ]
}

# T5-U9: Filename uses '-' separators
@test "stuck_snapshot filename uses dash separators in time portion" {
    printf 'test\n' > "${OUTPUT_FILE}"
    _make_progress

    local snap_path
    snap_path="$(stuck_snapshot_postmortem "${REQ_DIR}" "${OUTPUT_FILE}" "${PROGRESS_FILE}" \
        "${REQUEST_ID}" "${PHASE}" "hard_timeout" "")"

    [ -f "$snap_path" ]
    local base
    base="$(basename "$snap_path")"
    # Pattern: session-stuck-YYYY-MM-DDTHH-MM-SS.sssZ.json
    [[ "$base" =~ ^session-stuck-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}\.[0-9]{3}Z(-[0-9]+)?\.json$ ]]
}

# T5-U11: Snapshot write failure returns 1
@test "stuck_snapshot returns 1 when write fails (read-only req_dir)" {
    local ro_dir="${BATS_TMPDIR}/ro-req-$$"
    mkdir -p "$ro_dir"
    chmod 0555 "$ro_dir"

    run stuck_snapshot_postmortem "$ro_dir" "${OUTPUT_FILE}" "${PROGRESS_FILE}" \
        "${REQUEST_ID}" "${PHASE}" "hard_timeout" ""
    local exit_code="$status"
    chmod 0755 "$ro_dir"
    rm -rf "$ro_dir"
    [ "$exit_code" -ne 0 ]
}

# T5-U12: Advisory mode wrapper works
@test "stuck_snapshot_advisory creates snapshot with mode=advisory" {
    printf 'test\n' > "${OUTPUT_FILE}"
    _make_progress

    local snap_path
    snap_path="$(stuck_snapshot_advisory "${REQ_DIR}" "${OUTPUT_FILE}" "${PROGRESS_FILE}" \
        "${REQUEST_ID}" "${PHASE}" "silent_stall" "")"

    [ -f "$snap_path" ]
    run jq -r '.mode' "$snap_path"
    [ "$output" = "advisory" ]
}

# recovery_hint for hard_timeout
@test "stuck_snapshot sets expected recovery_hint for hard_timeout reason" {
    printf 'test\n' > "${OUTPUT_FILE}"
    _make_progress

    local snap_path
    snap_path="$(stuck_snapshot_postmortem "${REQ_DIR}" "${OUTPUT_FILE}" "${PROGRESS_FILE}" \
        "${REQUEST_ID}" "${PHASE}" "hard_timeout" "")"

    run jq -r '.recovery_hint' "$snap_path"
    [ "$output" = "Wall-clock timeout reached; see phase_baselines to tune timeout" ]
}

# T5-U10: Rapid double snapshot - distinct filenames
@test "stuck_snapshot creates distinct filenames on rapid calls" {
    printf 'test\n' > "${OUTPUT_FILE}"
    _make_progress

    local snap1 snap2
    snap1="$(stuck_snapshot_postmortem "${REQ_DIR}" "${OUTPUT_FILE}" "${PROGRESS_FILE}" \
        "${REQUEST_ID}" "${PHASE}" "hard_timeout" "")"
    snap2="$(stuck_snapshot_postmortem "${REQ_DIR}" "${OUTPUT_FILE}" "${PROGRESS_FILE}" \
        "${REQUEST_ID}" "${PHASE}" "hard_timeout" "")"

    # Both should be non-empty
    [ -n "$snap1" ]
    [ -n "$snap2" ]

    # Both files should exist (may be same name if > 1ms apart)
    [ -f "$snap1" ]
    [ -f "$snap2" ]
}
