#!/usr/bin/env bats
###############################################################################
# test_spawn_session_flags.bats - Snapshot tests for type-aware spawn flags
#
# Covers SPEC-018-2-03 acceptance criteria for spawn-session.sh's flag
# assembly: --bug-context-path, ENHANCED_GATES, --expedited.
#
# Snapshots use the literal string ${STATE_DIR} (not interpolated) as the
# placeholder for the absolute path of the BATS_TEST_TMPDIR/state directory.
# Set BATS_UPDATE_SNAPSHOTS=1 to regenerate snapshots in place.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    SPAWN="${PLUGIN_DIR}/bin/spawn-session.sh"
    FIXTURES="${PLUGIN_DIR}/tests/fixtures/state/typed"
    SNAPSHOTS="${PLUGIN_DIR}/tests/fixtures/snapshots"

    if ! command -v jq >/dev/null 2>&1; then
        skip "jq not available"
    fi

    STATE_DIR="${BATS_TEST_TMPDIR}/state"
    mkdir -p "${STATE_DIR}"
    STATE_FILE="${STATE_DIR}/state.json"
    CAPTURE="${BATS_TEST_TMPDIR}/captured.txt"
    : > "${CAPTURE}"
    export CAPTURE_SPAWN_TO="${CAPTURE}"
}

# assert_snapshot(snapshot_name)
#   Compare the captured-spawn output to the named snapshot. When
#   BATS_UPDATE_SNAPSHOTS=1, write the captured output to the snapshot
#   instead.
assert_snapshot() {
    local snapshot_name="$1"
    local snapshot_path="${SNAPSHOTS}/${snapshot_name}"

    if [[ "${BATS_UPDATE_SNAPSHOTS:-0}" == "1" ]]; then
        cp "${CAPTURE}" "${snapshot_path}"
        return 0
    fi

    if ! diff -u "${snapshot_path}" "${CAPTURE}"; then
        echo "Snapshot drift: ${snapshot_name}" >&2
        echo "Expected: $(cat "${snapshot_path}")" >&2
        echo "Got:      $(cat "${CAPTURE}")" >&2
        return 1
    fi
}

@test "bug + tdd spawn appends --bug-context-path" {
    cp "${FIXTURES}/bug.json" "${STATE_FILE}"
    run "${SPAWN}" "${STATE_FILE}" tdd tdd-author
    [ "${status}" -eq 0 ]
    assert_snapshot "spawn-bug-tdd.txt"
}

@test "infra + tdd spawn prefixes env ENHANCED_GATES" {
    cp "${FIXTURES}/infra.json" "${STATE_FILE}"
    run "${SPAWN}" "${STATE_FILE}" tdd tdd-author
    [ "${status}" -eq 0 ]
    assert_snapshot "spawn-infra-tdd.txt"
}

@test "bug + tdd_review spawn appends --expedited" {
    cp "${FIXTURES}/bug.json" "${STATE_FILE}"
    run "${SPAWN}" "${STATE_FILE}" tdd_review tdd-reviewer
    [ "${status}" -eq 0 ]
    assert_snapshot "spawn-bug-tdd-review.txt"
}

@test "feature + tdd does NOT append --bug-context-path or --expedited" {
    cp "${FIXTURES}/feature.json" "${STATE_FILE}"
    run "${SPAWN}" "${STATE_FILE}" tdd tdd-author
    [ "${status}" -eq 0 ]
    [[ "$(cat "${CAPTURE}")" != *"--bug-context-path"* ]]
    [[ "$(cat "${CAPTURE}")" != *"--expedited"* ]]
    [[ "$(cat "${CAPTURE}")" != *"ENHANCED_GATES"* ]]
}

@test "feature + code_review (expedited_reviews=false) does NOT append --expedited" {
    cp "${FIXTURES}/feature.json" "${STATE_FILE}"
    run "${SPAWN}" "${STATE_FILE}" code_review code-reviewer
    [ "${status}" -eq 0 ]
    [[ "$(cat "${CAPTURE}")" != *"--expedited"* ]]
}

@test "infra + tdd_review (review phase) does NOT prefix ENHANCED_GATES" {
    cp "${FIXTURES}/infra.json" "${STATE_FILE}"
    run "${SPAWN}" "${STATE_FILE}" tdd_review tdd-reviewer
    [ "${status}" -eq 0 ]
    [[ "$(cat "${CAPTURE}")" != *"ENHANCED_GATES"* ]]
}
