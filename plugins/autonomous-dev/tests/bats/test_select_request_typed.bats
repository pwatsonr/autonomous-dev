#!/usr/bin/env bats
###############################################################################
# test_select_request_typed.bats - Type-Aware Phase Progression (PLAN-018-2)
#
# Covers SPEC-018-2-01 (next_phase_for_state, is_enhanced_phase, legacy
# fallback warning) and SPEC-018-2-03 (gate-presence check).
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    SUPERVISOR="${PLUGIN_DIR}/bin/supervisor-loop.sh"
    FIXTURES="${PLUGIN_DIR}/tests/fixtures/state/typed"
    LIB_DIR="${PLUGIN_DIR}/bin/lib"

    # Some tests need the supervisor's helper functions but not its main
    # loop side-effects. Source the file with BASH_SOURCE != $0 by passing
    # it as a positional argument to bash -c, which preserves the sourcing
    # guard at the bottom of the script.
    if ! command -v jq >/dev/null 2>&1; then
        skip "jq not available"
    fi

    # Sandbox HOME so the supervisor's $CONFIG_FILE lookup does not touch
    # the operator's real ~/.claude directory.
    export HOME="${BATS_TEST_TMPDIR}/home"
    mkdir -p "${HOME}/.claude"
    # Empty config so resolve_phase_timeout falls through to its default.
    echo '{}' > "${HOME}/.claude/autonomous-dev.json"

    # Source helpers directly to avoid running main_loop.
    # shellcheck disable=SC1090
    source "${LIB_DIR}/phase-legacy.sh"
}

# Helper: copy a fixture into BATS_TEST_TMPDIR for isolation
copy_fixture() {
    local name="$1"
    cp "${FIXTURES}/${name}" "${BATS_TEST_TMPDIR}/state.json"
    printf '%s\n' "${BATS_TEST_TMPDIR}/state.json"
}

# Helper: source supervisor-loop in a way that does not run main.
# Re-uses the same trick as test_cli_dispatcher.bats. The supervisor's
# `readonly PLUGIN_DIR` is computed from $0 at source time; under bats $0
# points at the bats binary, which yields a wrong PLUGIN_DIR. We strip
# the readonly declarations and re-assert the test-provided values after
# sourcing.
source_supervisor_helpers() {
    local tmp
    tmp="$(mktemp)"
    awk '/^# Main Entry Point$/{exit} {print}' "${SUPERVISOR}" \
        | sed -E 's/^readonly (PLUGIN_DIR|LIB_DIR|AUTONOMOUS_DEV_CONFIG|CONFIG_FILE)=/\1=/' \
        > "${tmp}"
    # shellcheck disable=SC1090
    source "${tmp}"
    rm -f "${tmp}"
    # Force the test-provided paths regardless of what the script computed.
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    LIB_DIR="${PLUGIN_DIR}/bin/lib"
    export PLUGIN_DIR LIB_DIR
}

@test "feature-typed state advances intake -> prd" {
    source_supervisor_helpers
    local sf; sf=$(copy_fixture feature.json)
    run next_phase_for_state "${sf}"
    [ "${status}" -eq 0 ]
    [ "${output}" = "prd" ]
}

@test "bug-typed state advances intake -> tdd (PRD skipped)" {
    source_supervisor_helpers
    local sf; sf=$(copy_fixture bug.json)
    run next_phase_for_state "${sf}"
    [ "${status}" -eq 0 ]
    [ "${output}" = "tdd" ]
}

@test "infra-typed state in tdd_review awaits security_review gate" {
    source_supervisor_helpers
    local sf; sf=$(copy_fixture infra.json)
    # No gate artifact present yet
    run check_phase_advancement_blocked "${sf}"
    [ "${status}" -eq 1 ]
    local reason
    reason=$(jq -r '.status_reason' "${sf}")
    [ "${reason}" = "awaiting gate: security_review" ]
}

@test "infra-typed state in tdd_review advances after gate artifact present" {
    source_supervisor_helpers
    local sf; sf=$(copy_fixture infra.json)
    mkdir -p "${BATS_TEST_TMPDIR}/gates"
    echo '{"gate":"security_review","status":"passed"}' \
        > "${BATS_TEST_TMPDIR}/gates/security_review.json"
    run check_phase_advancement_blocked "${sf}"
    [ "${status}" -eq 0 ]
    # And the next phase progression returns plan
    run next_phase_for_state "${sf}"
    [ "${status}" -eq 0 ]
    [ "${output}" = "plan" ]
}

@test "refactor-typed state advances intake -> tdd" {
    source_supervisor_helpers
    local sf; sf=$(copy_fixture refactor.json)
    run next_phase_for_state "${sf}"
    [ "${status}" -eq 0 ]
    [ "${output}" = "tdd" ]
}

@test "hotfix-typed state in code phase respects 1800s timeout" {
    source_supervisor_helpers
    # shellcheck disable=SC1090
    source "${LIB_DIR}/typed-limits.sh"
    local sf; sf=$(copy_fixture hotfix.json)
    run resolve_phase_timeout "${sf}" code
    [ "${status}" -eq 0 ]
    [ "${output}" = "1800" ]
}

@test "select_request returns empty string at terminal phase" {
    source_supervisor_helpers
    local sf; sf=$(copy_fixture bug.json)
    # Mutate to terminal phase
    jq '.current_phase = "validate"' "${sf}" > "${sf}.tmp" && mv "${sf}.tmp" "${sf}"
    run next_phase_for_state "${sf}"
    [ "${status}" -eq 0 ]
    [ "${output}" = "" ]
}

@test "v1.0 state without phase_overrides falls back to legacy sequence with warning" {
    source_supervisor_helpers
    local sf="${BATS_TEST_TMPDIR}/state.json"
    cat > "${sf}" <<'JSON'
{"id":"legacy","current_phase":"intake"}
JSON
    # Capture stdout and stderr separately to avoid the warning being
    # interleaved into ${output}. bats' --separate-stderr exposes
    # ${stderr} as a sibling to ${output}; on bats versions that lack
    # the flag, fall back to greping the merged output.
    if run --separate-stderr next_phase_for_state "${sf}"; then
        :  # success path; locals populated
    fi
    [ "${status}" -eq 0 ]
    [ "${output}" = "prd" ]
    [[ "${stderr}" == *"lacks phase_overrides"* ]]
}
