#!/usr/bin/env bats
###############################################################################
# test_spawn_session_flags.bats - Snapshot tests for type-aware spawn flags
#
# Covers SPEC-018-2-03 (type-aware injection) as re-baselined by PLAN-039
# SPEC-039-2-08 / RESEARCH-039: spawn-session.sh now emits the *real* claude
# CLI contract (--print --output-format json --agent --add-dir --permission-mode
# --max-budget-usd <prompt>). The bogus --state / --bug-context-path /
# --expedited / --max-turns flags are gone. Type-aware behaviour now maps to:
#   - bug + tdd      -> (no extra flag; state.json carries bug fields, named in the prompt)
#   - infra + !review -> env ENHANCED_GATES=... prefix (env var, not a CLI flag)
#   - expedited + review -> --append-system-prompt "Expedited review: ..."
#
# Snapshots use the literal placeholders ${STATE_DIR}, ${PROJECT_DIR},
# ${PHASE_PROMPT} (not interpolated) for host-stable diffing.
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

@test "bug + tdd spawn: corrected claude flags, no --bug-context-path (state via --add-dir + prompt)" {
    cp "${FIXTURES}/bug.json" "${STATE_FILE}"
    run "${SPAWN}" "${STATE_FILE}" tdd tdd-author
    [ "${status}" -eq 0 ]
    assert_snapshot "spawn-bug-tdd.txt"
    [[ "$(cat "${CAPTURE}")" != *"--bug-context-path"* ]]
    [[ "$(cat "${CAPTURE}")" != *"--state "* ]]
    [[ "$(cat "${CAPTURE}")" == *"--add-dir"* ]]
}

@test "infra + tdd spawn prefixes env ENHANCED_GATES" {
    cp "${FIXTURES}/infra.json" "${STATE_FILE}"
    run "${SPAWN}" "${STATE_FILE}" tdd tdd-author
    [ "${status}" -eq 0 ]
    assert_snapshot "spawn-infra-tdd.txt"
}

@test "expedited tdd_review uses --append-system-prompt, not --expedited" {
    cp "${FIXTURES}/bug.json" "${STATE_FILE}"
    run "${SPAWN}" "${STATE_FILE}" tdd_review tdd-reviewer
    [ "${status}" -eq 0 ]
    assert_snapshot "spawn-bug-tdd-review.txt"
    [[ "$(cat "${CAPTURE}")" != *"--expedited"* ]]
    [[ "$(cat "${CAPTURE}")" == *"--append-system-prompt"* ]]
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
