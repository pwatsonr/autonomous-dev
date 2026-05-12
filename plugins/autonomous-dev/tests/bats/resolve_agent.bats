#!/usr/bin/env bats
###############################################################################
# resolve_agent.bats - Tests for phase-to-agent mapping
#
# Covers TASK-008 (SPEC-039-2-02) acceptance criteria:
# - All 12 phase-to-agent mappings exact per TDD §6.2
# - Unknown phase returns empty + exit 1
# - intake phase returns empty + exit 1
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"

    # Source the supervisor-loop.sh to get resolve_agent function
    # shellcheck source=../../bin/supervisor-loop.sh
    source "${PLUGIN_DIR}/bin/supervisor-loop.sh"
}

@test "prd maps to prd-author" {
    result=$(resolve_agent "prd")
    [[ "${result}" == "prd-author" ]]
    [[ $? -eq 0 ]]
}

@test "prd_review maps to doc-reviewer" {
    result=$(resolve_agent "prd_review")
    [[ "${result}" == "doc-reviewer" ]]
    [[ $? -eq 0 ]]
}

@test "tdd maps to tdd-author" {
    result=$(resolve_agent "tdd")
    [[ "${result}" == "tdd-author" ]]
    [[ $? -eq 0 ]]
}

@test "tdd_review maps to doc-reviewer" {
    result=$(resolve_agent "tdd_review")
    [[ "${result}" == "doc-reviewer" ]]
    [[ $? -eq 0 ]]
}

@test "plan maps to plan-author" {
    result=$(resolve_agent "plan")
    [[ "${result}" == "plan-author" ]]
    [[ $? -eq 0 ]]
}

@test "plan_review maps to doc-reviewer" {
    result=$(resolve_agent "plan_review")
    [[ "${result}" == "doc-reviewer" ]]
    [[ $? -eq 0 ]]
}

@test "spec maps to spec-author" {
    result=$(resolve_agent "spec")
    [[ "${result}" == "spec-author" ]]
    [[ $? -eq 0 ]]
}

@test "spec_review maps to doc-reviewer" {
    result=$(resolve_agent "spec_review")
    [[ "${result}" == "doc-reviewer" ]]
    [[ $? -eq 0 ]]
}

@test "code maps to code-executor" {
    result=$(resolve_agent "code")
    [[ "${result}" == "code-executor" ]]
    [[ $? -eq 0 ]]
}

@test "code_review maps to quality-reviewer" {
    result=$(resolve_agent "code_review")
    [[ "${result}" == "quality-reviewer" ]]
    [[ $? -eq 0 ]]
}

@test "security_review maps to security-reviewer" {
    result=$(resolve_agent "security_review")
    [[ "${result}" == "security-reviewer" ]]
    [[ $? -eq 0 ]]
}

@test "deploy maps to deploy-executor" {
    result=$(resolve_agent "deploy")
    [[ "${result}" == "deploy-executor" ]]
    [[ $? -eq 0 ]]
}

@test "unknown_phase_returns_empty_and_1" {
    run resolve_agent "nonsense"
    [[ "${output}" == "" ]]
    [[ $status -eq 1 ]]
}

@test "empty_input_returns_1" {
    run resolve_agent ""
    [[ "${output}" == "" ]]
    [[ $status -eq 1 ]]
}

@test "intake_returns_empty_and_1" {
    run resolve_agent "intake"
    [[ "${output}" == "" ]]
    [[ $status -eq 1 ]]
}