#!/usr/bin/env bats
###############################################################################
# revise_feedback_prompt.bats — #500
#
# resolve_phase_prompt() injects operator artifact-comment feedback into the
# author prompt when a feedback artifact exists for the phase being run:
#   ${project}/.autonomous-dev/requests/${id}/artifact-feedback/${phase}.json
# This is how the re-dispatched author (reset by consume_revise_markers) is
# told what the operator wants revised.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    # shellcheck source=../../bin/lib/phase-helpers.sh
    source "${PLUGIN_DIR}/bin/lib/phase-helpers.sh"

    PROJECT="$(mktemp -d)"
    REQ="REQ-000500"
}

teardown() { rm -rf "${PROJECT}"; }

_write_feedback() { # $1=phase $2=feedback-text
    mkdir -p "${PROJECT}/.autonomous-dev/requests/${REQ}/artifact-feedback"
    jq -n --arg p "$1" --arg f "$2" \
        '{v:1,id:"REQ-000500",repo:"r",phase:$p,feedback:$f}' \
        > "${PROJECT}/.autonomous-dev/requests/${REQ}/artifact-feedback/$1.json"
}

@test "feedback is injected into the author prompt when present" {
    _write_feedback "prd" "Tighten the scope section and add non-goals."
    result=$(resolve_phase_prompt "prd" "${REQ}" "${PROJECT}")
    [[ "${result}" == *"OPERATOR REVISION REQUEST"* ]]
    [[ "${result}" == *"Tighten the scope section and add non-goals."* ]]
}

@test "no feedback file: prompt has no revision block" {
    result=$(resolve_phase_prompt "prd" "${REQ}" "${PROJECT}")
    [[ "${result}" != *"OPERATOR REVISION REQUEST"* ]]
}

@test "feedback for a DIFFERENT phase is not injected" {
    _write_feedback "spec" "spec-only feedback"
    result=$(resolve_phase_prompt "prd" "${REQ}" "${PROJECT}")
    [[ "${result}" != *"spec-only feedback"* ]]
    [[ "${result}" != *"OPERATOR REVISION REQUEST"* ]]
}

@test "empty feedback string: no revision block" {
    _write_feedback "prd" ""
    result=$(resolve_phase_prompt "prd" "${REQ}" "${PROJECT}")
    [[ "${result}" != *"OPERATOR REVISION REQUEST"* ]]
}

@test "feedback injection coexists with the code-phase instructions" {
    _write_feedback "code" "address the inline comment on the auth handler"
    result=$(resolve_phase_prompt "code" "${REQ}" "${PROJECT}")
    [[ "${result}" == *"OPERATOR REVISION REQUEST"* ]]
    [[ "${result}" == *"address the inline comment on the auth handler"* ]]
    [[ "${result}" == *"Branch and PR Instructions"* ]]
}
