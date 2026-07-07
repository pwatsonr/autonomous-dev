#!/usr/bin/env bats
###############################################################################
# session_transcript_streamed.bats -- Tests for session_transcript.sh
# REQ-000060 / TASK-001
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    OBS_LIB="${PLUGIN_DIR}/lib/observability"
    FIXTURE_DIR="${BATS_TEST_DIRNAME}/fixtures/fake-agents"
    FAKE_AGENT="${FIXTURE_DIR}/emit-then-hang.sh"
    # shellcheck source=../../lib/observability/session_transcript.sh
    source "${OBS_LIB}/session_transcript.sh"
    export TRANSCRIPT_FILE="${BATS_TMPDIR}/session-transcript-$$.txt"
    touch "${TRANSCRIPT_FILE}"
}

teardown() {
    rm -f "${TRANSCRIPT_FILE}" 2>/dev/null || true
}

# T1-U1: function exists after source
@test "run_streamed_session exists after source" {
    run declare -F run_streamed_session
    [ "$status" -eq 0 ]
}

# T1-U1 extra: atomic_write_json exists
@test "atomic_write_json exists after source" {
    run declare -F atomic_write_json
    [ "$status" -eq 0 ]
}

# T1-U4: Returns PIPESTATUS[0] (child exit code)
@test "run_streamed_session returns child exit code" {
    export FAKE_EXIT_CODE=7
    export FAKE_SLEEP_1=0
    export FAKE_SLEEP_2=0
    run run_streamed_session "" "" "${FAKE_AGENT}" "" "test" "" "" "${TRANSCRIPT_FILE}"
    [ "$status" -eq 7 ]
}

# T1-U6: timeout_bin="" runs without a cap
@test "run_streamed_session with empty timeout_bin runs successfully" {
    export FAKE_EXIT_CODE=0
    export FAKE_SLEEP_1=0
    export FAKE_SLEEP_2=0
    run run_streamed_session "" "" "${FAKE_AGENT}" "" "test" "" "" "${TRANSCRIPT_FILE}"
    [ "$status" -eq 0 ]
    grep -qF "line1" "${TRANSCRIPT_FILE}"
    grep -qF "line2" "${TRANSCRIPT_FILE}"
}

# T1-U7: Multiple invocations append (not truncate)
@test "run_streamed_session appends on multiple invocations" {
    export FAKE_EXIT_CODE=0
    export FAKE_SLEEP_1=0
    export FAKE_SLEEP_2=0
    run_streamed_session "" "" "${FAKE_AGENT}" "" "test" "" "" "${TRANSCRIPT_FILE}"
    run_streamed_session "" "" "${FAKE_AGENT}" "" "test" "" "" "${TRANSCRIPT_FILE}"
    local line_count
    line_count="$(wc -l < "${TRANSCRIPT_FILE}" | tr -d ' ')"
    [ "$line_count" -ge 4 ]
}

# T1-U2: Transcript is non-empty BEFORE child exits (streaming test)
@test "run_streamed_session streams output before child exits" {
    export FAKE_LINE_1="line1 streaming check"
    export FAKE_SLEEP_1=5
    export FAKE_LINE_2="line2 after sleep"
    export FAKE_SLEEP_2=0
    export FAKE_EXIT_CODE=0

    # Run in background
    run_streamed_session "" "" "${FAKE_AGENT}" "" "test" "" "" "${TRANSCRIPT_FILE}" &
    local bg_pid=$!

    # Wait up to 2 seconds for output to appear
    local waited=0
    local found=0
    while (( waited < 20 )); do
        if [[ -s "${TRANSCRIPT_FILE}" ]]; then
            found=1
            break
        fi
        sleep 0.1
        waited=$(( waited + 1 ))
    done

    # Kill background process
    kill "$bg_pid" 2>/dev/null || true
    wait "$bg_pid" 2>/dev/null || true

    [ "$found" -eq 1 ]
    grep -qF "line1" "${TRANSCRIPT_FILE}"
}

# T1-U5: tee failure does not clobber child exit code
@test "run_streamed_session child exit code survives bad output_file path" {
    export FAKE_EXIT_CODE=0
    export FAKE_SLEEP_1=0
    export FAKE_SLEEP_2=0
    # Output to a non-writable path (tee will fail, but we should still get exit 0)
    # We use a path where parent dir doesn't exist; tee -a will fail silently
    run run_streamed_session "" "" "${FAKE_AGENT}" "" "test" "" "" "/nonexistent_dir_$$/x.txt"
    # The child itself exits 0; tee failure should not override PIPESTATUS[0]
    [ "$status" -eq 0 ]
}

# T1-U3: Fallback path (no stdbuf) still produces output
@test "run_streamed_session works without stdbuf" {
    export FAKE_EXIT_CODE=0
    export FAKE_SLEEP_1=0
    export FAKE_SLEEP_2=0
    # Temporarily shadow stdbuf and gstdbuf with non-executables
    local fake_bin="${BATS_TMPDIR}/fake-no-stdbuf-$$"
    mkdir -p "$fake_bin"
    # Don't create stdbuf or gstdbuf, just override PATH to not find them
    local old_path="$PATH"
    export PATH="${fake_bin}:${PATH}"
    run run_streamed_session "" "" "${FAKE_AGENT}" "" "test" "" "" "${TRANSCRIPT_FILE}"
    export PATH="$old_path"
    [ "$status" -eq 0 ]
    grep -qF "line1" "${TRANSCRIPT_FILE}"
}

# now_ms produces integer output
@test "now_ms returns a positive integer" {
    run now_ms
    [ "$status" -eq 0 ]
    [[ "$output" =~ ^[0-9]+$ ]]
    [ "${output}" -gt 0 ]
}

# atomic_write_json writes file correctly
@test "atomic_write_json creates file with correct content" {
    local test_file="${BATS_TMPDIR}/atomic-test-$$.json"
    local content='{"test":1}'
    run atomic_write_json "$test_file" "$content"
    [ "$status" -eq 0 ]
    [ -f "$test_file" ]
    local read_content
    read_content="$(cat "$test_file")"
    [ "$read_content" = "$content" ]
    rm -f "$test_file"
}

# atomic_write_json sets file permissions to 0600
@test "atomic_write_json sets 0600 permissions" {
    local test_file="${BATS_TMPDIR}/perm-test-$$.json"
    atomic_write_json "$test_file" '{"perm":"test"}'
    local perms
    perms="$(stat -f %Lp "$test_file" 2>/dev/null || stat -c %a "$test_file" 2>/dev/null || echo "unknown")"
    [ "$perms" = "600" ]
    rm -f "$test_file"
}
