#!/usr/bin/env bats
###############################################################################
# test_select_request_size.bats - Task-Size Phase Routing (#526)
#
# Drives next_phase_for_state across a trivial-docs state whose
# phase_overrides[] skips all upfront design phases. Asserts the realized
# sequence is:
#   intake -> spec -> spec_review -> code -> code_review
#          -> integration -> deploy -> monitor
# and that prd / tdd / plan (and their reviews) NEVER appear.
#
# Mirrors test_select_request_typed.bats' sourcing trick so we exercise the
# real supervisor helper without running main_loop.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    SUPERVISOR="${PLUGIN_DIR}/bin/supervisor-loop.sh"
    FIXTURES="${PLUGIN_DIR}/tests/fixtures/state/typed"
    LIB_DIR="${PLUGIN_DIR}/bin/lib"

    if ! command -v jq >/dev/null 2>&1; then
        skip "jq not available"
    fi

    export HOME="${BATS_TEST_TMPDIR}/home"
    mkdir -p "${HOME}/.claude"
    echo '{}' > "${HOME}/.claude/autonomous-dev.json"

    # shellcheck disable=SC1090
    source "${LIB_DIR}/phase-legacy.sh"
}

copy_fixture() {
    local name="$1"
    cp "${FIXTURES}/${name}" "${BATS_TEST_TMPDIR}/state.json"
    printf '%s\n' "${BATS_TEST_TMPDIR}/state.json"
}

# Same source-without-main trick as test_select_request_typed.bats.
source_supervisor_helpers() {
    local tmp
    tmp="$(mktemp)"
    awk '/^# Main Entry Point$/{exit} {print}' "${SUPERVISOR}" \
        | sed -E 's/^readonly (PLUGIN_DIR|LIB_DIR|AUTONOMOUS_DEV_CONFIG|CONFIG_FILE)=/\1=/' \
        > "${tmp}"
    # shellcheck disable=SC1090
    source "${tmp}"
    rm -f "${tmp}"
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    LIB_DIR="${PLUGIN_DIR}/bin/lib"
    export PLUGIN_DIR LIB_DIR
    # shellcheck disable=SC1090
    source "${LIB_DIR}/phase-legacy.sh"
}

# Helper: set .current_phase in the state file.
set_phase() {
    local sf="$1" phase="$2"
    jq --arg p "${phase}" '.current_phase = $p' "${sf}" > "${sf}.tmp" \
        && mv "${sf}.tmp" "${sf}"
}

# Helper: assert next_phase_for_state(current) == expected.
assert_next() {
    local sf="$1" current="$2" expected="$3"
    set_phase "${sf}" "${current}"
    run --separate-stderr next_phase_for_state "${sf}"
    [ "${status}" -eq 0 ]
    [ "${output}" = "${expected}" ]
}

@test "trivial-docs state advances intake -> spec (prd skipped)" {
    source_supervisor_helpers
    local sf; sf=$(copy_fixture trivial-docs.json)
    assert_next "${sf}" "intake" "spec"
}

@test "trivial-docs realized sequence skips prd/tdd/plan entirely" {
    source_supervisor_helpers
    local sf; sf=$(copy_fixture trivial-docs.json)

    # Walk the full 8-phase sequence step by step.
    assert_next "${sf}" "intake"      "spec"
    assert_next "${sf}" "spec"        "spec_review"
    assert_next "${sf}" "spec_review" "code"
    assert_next "${sf}" "code"        "code_review"
    assert_next "${sf}" "code_review" "integration"
    assert_next "${sf}" "integration" "deploy"
    assert_next "${sf}" "deploy"      "monitor"

    # Terminal phase -> empty string, exit 0.
    set_phase "${sf}" "monitor"
    run --separate-stderr next_phase_for_state "${sf}"
    [ "${status}" -eq 0 ]
    [ "${output}" = "" ]
}

@test "trivial-docs phase_overrides contains no design phases" {
    source_supervisor_helpers
    local sf; sf=$(copy_fixture trivial-docs.json)
    local overrides
    overrides=$(jq -r '.phase_overrides[]' "${sf}")
    # None of the skipped design phases may appear.
    for forbidden in prd prd_review tdd tdd_review plan plan_review; do
        run bash -c "printf '%s\n' \"${overrides}\" | grep -Fxq '${forbidden}'"
        [ "${status}" -ne 0 ]
    done
}
