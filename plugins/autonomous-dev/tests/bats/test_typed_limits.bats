#!/usr/bin/env bats
###############################################################################
# test_typed_limits.bats - resolve_phase_timeout / resolve_max_retries
#
# Covers SPEC-018-2-02 acceptance criteria.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    LIB="${PLUGIN_DIR}/bin/lib/typed-limits.sh"
    FIXTURES="${PLUGIN_DIR}/tests/fixtures/state/typed"

    if ! command -v jq >/dev/null 2>&1; then
        skip "jq not available"
    fi

    # Sandbox config so global lookup is deterministic.
    export HOME="${BATS_TEST_TMPDIR}/home"
    mkdir -p "${HOME}/.claude"
    export AUTONOMOUS_DEV_CONFIG="${HOME}/.claude/autonomous-dev.json"
    cat > "${AUTONOMOUS_DEV_CONFIG}" <<'JSON'
{ "phase_timeout_seconds": 14400, "max_retries": 3 }
JSON

    # shellcheck disable=SC1090
    source "${LIB}"
}

copy_fixture() {
    local name="$1"
    cp "${FIXTURES}/${name}" "${BATS_TEST_TMPDIR}/state.json"
    printf '%s\n' "${BATS_TEST_TMPDIR}/state.json"
}

@test "resolve_phase_timeout returns hotfix override (1800)" {
    local sf; sf=$(copy_fixture hotfix.json)
    run resolve_phase_timeout "${sf}" code
    [ "${status}" -eq 0 ]
    [ "${output}" = "1800" ]
}

@test "resolve_phase_timeout falls back to global default for feature" {
    local sf; sf=$(copy_fixture feature.json)
    run resolve_phase_timeout "${sf}" code
    [ "${status}" -eq 0 ]
    [ "${output}" = "14400" ]
}

@test "resolve_phase_timeout falls back to hardcoded 14400 when global config absent" {
    local sf; sf=$(copy_fixture feature.json)
    rm -f "${AUTONOMOUS_DEV_CONFIG}"
    run resolve_phase_timeout "${sf}" code
    [ "${status}" -eq 0 ]
    [ "${output}" = "14400" ]
}

@test "resolve_max_retries returns 5 for bug" {
    local sf; sf=$(copy_fixture bug.json)
    run resolve_max_retries "${sf}"
    [ "${status}" -eq 0 ]
    [ "${output}" = "5" ]
}

@test "resolve_max_retries returns 2 for infra" {
    local sf; sf=$(copy_fixture infra.json)
    run resolve_max_retries "${sf}"
    [ "${status}" -eq 0 ]
    [ "${output}" = "2" ]
}

@test "resolve_max_retries returns 3 (default) for feature" {
    local sf; sf=$(copy_fixture feature.json)
    run resolve_max_retries "${sf}"
    [ "${status}" -eq 0 ]
    [ "${output}" = "3" ]
}

@test "resolve_max_retries returns 3 when type_config absent" {
    local sf="${BATS_TEST_TMPDIR}/state.json"
    cat > "${sf}" <<'JSON'
{"id":"legacy","current_phase":"intake"}
JSON
    run resolve_max_retries "${sf}"
    [ "${status}" -eq 0 ]
    [ "${output}" = "3" ]
}

@test "timeout escalation message matches contract regex" {
    # Synthesize the message format the supervisor emits.
    local msg="Phase 'code' exceeded timeout (1800 seconds, type=hotfix)"
    [[ "${msg}" =~ ^Phase\ \'[a-z_]+\'\ (exceeded\ timeout|exhausted\ retries)\ \(.*type=(feature|bug|infra|refactor|hotfix)\)$ ]]
}

@test "retry escalation message matches contract regex" {
    local msg="Phase 'tdd' exhausted retries (limit=5, type=bug)"
    [[ "${msg}" =~ ^Phase\ \'[a-z_]+\'\ (exceeded\ timeout|exhausted\ retries)\ \(.*type=(feature|bug|infra|refactor|hotfix)\)$ ]]
}
