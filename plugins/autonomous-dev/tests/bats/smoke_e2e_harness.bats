#!/usr/bin/env bats
###############################################################################
# smoke_e2e_harness.bats - unit tests for the smoke-test mock `claude` fixture
#
# (The smoke test itself, test/e2e/smoke-e2e.sh, is a standalone shell script
# invoked directly, not from bats. These tests just pin the fixture's
# contract: argv parsing + which artifacts it writes per --agent.)
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    MOCK="${PLUGIN_DIR}/test/e2e/fixtures/mock-claude.sh"
    [ -x "${MOCK}" ] || skip "mock-claude fixture missing/not executable"
    command -v jq >/dev/null 2>&1 || skip "jq not available"
}

@test "mock-claude responds to --version" {
    run "${MOCK}" --version
    [ "$status" -eq 0 ]
    [[ "$output" == *"claude-mock"* ]]
}

@test "mock-claude writes a PRD artifact + phase-result for prd-author" {
    local tmp; tmp=$(mktemp -d)
    local req="${tmp}/req" proj="${tmp}/project"
    mkdir -p "${req}" "${proj}"
    echo '{"id":"REQ-000001","current_phase":"prd","type":"feature"}' > "${req}/state.json"

    SMOKE_MOCK_LOG="${tmp}/mock.log" run "${MOCK}" \
        --print --output-format json --agent prd-author \
        --add-dir "${req}" --add-dir "${proj}" \
        --permission-mode acceptEdits --max-budget-usd 5.0 \
        "Read your request context from ${req}/state.json, perform the prd phase."

    [ "$status" -eq 0 ]
    [[ "$output" == *"total_cost_usd"* ]]
    [ -f "${proj}/docs/prd/REQ-000001-smoke-feature.md" ]
    [ -f "${req}/phase-result-prd.json" ]
    [ "$(jq -r '.status' "${req}/phase-result-prd.json")" = "pass" ]

    rm -rf "${tmp}"
}

@test "mock-claude writes a generic phase-result for non-prd-author agents" {
    local tmp; tmp=$(mktemp -d)
    local req="${tmp}/req" proj="${tmp}/project"
    mkdir -p "${req}" "${proj}"
    echo '{"id":"REQ-000001","current_phase":"tdd","type":"feature"}' > "${req}/state.json"

    SMOKE_MOCK_LOG="${tmp}/mock.log" run "${MOCK}" \
        --print --output-format json --agent tdd-author \
        --add-dir "${req}" --add-dir "${proj}" \
        --permission-mode acceptEdits --max-budget-usd 5.0 \
        "Read your request context from ${req}/state.json, perform the tdd phase."

    [ "$status" -eq 0 ]
    [[ "$output" == *"total_cost_usd"* ]]
    [ -f "${req}/phase-result-tdd.json" ]
    [ "$(jq -r '.status' "${req}/phase-result-tdd.json")" = "pass" ]
    [ ! -f "${proj}/docs/prd/REQ-000001-smoke-feature.md" ]

    rm -rf "${tmp}"
}

@test "mock-claude fails (exit 1) when SMOKE_MOCK_FAIL=1" {
    SMOKE_MOCK_FAIL=1 SMOKE_MOCK_LOG=/dev/null run "${MOCK}" \
        --print --output-format json --agent prd-author "prompt"
    [ "$status" -eq 1 ]
}
