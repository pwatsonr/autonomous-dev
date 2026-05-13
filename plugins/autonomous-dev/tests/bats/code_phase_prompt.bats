#!/usr/bin/env bats
###############################################################################
# code_phase_prompt.bats - Tests for code phase prompt template
#
# Covers TASK-010, TASK-011 (SPEC-039-2-04) acceptance criteria:
# - Code phase prompt contains branch instruction, PR instruction, artifact instruction
# - Non-code phase lacks code instructions
# - Invalid request_id in code phase returns error
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"

    # Source the supervisor-loop.sh to get functions
    # shellcheck source=../../bin/supervisor-loop.sh
    source "${PLUGIN_DIR}/bin/supervisor-loop.sh"

    # Mock EFFECTIVE_CONFIG if not set
    export EFFECTIVE_CONFIG="${EFFECTIVE_CONFIG:-/dev/null}"
}

@test "code_phase_prompt_contains_branch_instruction" {
    result=$(resolve_phase_prompt "code" "REQ-123456" "/tmp/project")
    [[ "${result}" == *"autonomous/REQ-"* ]]
}

@test "code_phase_prompt_contains_pr_instruction" {
    result=$(resolve_phase_prompt "code" "REQ-123456" "/tmp/project")
    [[ "${result}" == *"gh pr create"* ]]
}

@test "code_phase_prompt_contains_artifact_instruction" {
    result=$(resolve_phase_prompt "code" "REQ-123456" "/tmp/project")
    [[ "${result}" == *"phase-result"* ]]
    [[ "${result}" == *"artifacts"* ]]
}

@test "non_code_phase_lacks_code_instructions" {
    result=$(resolve_phase_prompt "prd" "REQ-123456" "/tmp/project")
    [[ "${result}" != *"gh pr create"* ]]
}

@test "regression_guard_variable_name" {
    # This test ensures the code-phase block runs by checking for specific code-phase content
    result=$(resolve_phase_prompt "code" "REQ-123456" "/tmp/project")
    [[ "${result}" == *"Branch and PR Instructions"* ]]
}

@test "invalid_request_id_in_code_phase_returns_error" {
    run resolve_phase_prompt "code" "INVALID-ID" "/tmp/project"
    [[ $status -ne 0 ]]
    [[ "${output}" == *"ERROR"* ]]
}