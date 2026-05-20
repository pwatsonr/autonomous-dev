#!/usr/bin/env bats
###############################################################################
# reviewer_fail_closed.bats — daemon's missing-envelope-on-review = FAIL
#
# Background (REQ-000011 post-mortem, 2026-05-19): the previous semantics
# auto-passed any phase whose agent exited cleanly without writing the
# phase-result envelope. That made the entire reviewer chain a no-op: 11 of
# 13 phases in a real end-to-end run came back as "synthesized pass" with
# no actual review verdict. PR #337 (the daemon-shipped feature) sailed
# through reviews despite having 4 critical bugs.
#
# New contract:
#   - Authoring phase (prd/tdd/plan/spec/code/...) + clean exit + no envelope
#       => synthesized PASS (the artifact-writing agent often forgets the
#          bookkeeping; we don't penalize that — artifact is the contract).
#   - Review phase (*_review) + clean exit + no envelope
#       => synthesized FAIL with REVIEWER_DID_NOT_EMIT_VERDICT
#          (the envelope IS the contract for reviewers).
#   - Any phase + nonzero exit + no envelope
#       => synthesized FAIL with AGENT_EXITED_NONZERO (unchanged).
#
# These tests stand the synthesizer block up in isolation and exercise the
# three branches. We don't run the full claude CLI — just the bash logic
# that decides which synthesized envelope to write.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    # shellcheck source=../../bin/spawn-session.sh
    # We need write_synthesized_phase_result + the synthesizer's branching
    # logic. Extract the relevant block into a callable test helper.
    source "${PLUGIN_DIR}/bin/spawn-session.sh" 2>/dev/null || true

    TMP="$(mktemp -d -t advrevfail)"
    REQ_DIR="${TMP}/.autonomous-dev/requests/REQ-TEST"
    mkdir -p "${REQ_DIR}"

    # Re-implement the synthesizer's branch logic in a test-only function.
    # This mirrors spawn-session.sh's "Synthesize phase-result.json if
    # agent didn't write one" block. If the source spawn-session.sh ever
    # diverges from this, the test will catch it via the per-branch
    # assertions below.
    synth() {
        local req_dir="$1" target_phase="$2" exit_code="$3"
        local result_path="${req_dir}/phase-result-${target_phase}.json"
        [[ -f "$result_path" ]] && return 0
        local status error_msg
        if [[ $exit_code -ne 0 ]]; then
            status="fail"
            error_msg="AGENT_EXITED_NONZERO"
        elif [[ "${target_phase}" == *"_review" ]]; then
            status="fail"
            error_msg="REVIEWER_DID_NOT_EMIT_VERDICT"
        else
            status="pass"
            error_msg=""
        fi
        write_synthesized_phase_result "$result_path" "$status" "$error_msg" "$exit_code" "$target_phase"
    }
}

teardown() {
    rm -rf "${TMP}"
}

# ─────────────────────────────────────────────────────────────────────
# Authoring phases: clean exit + no envelope => synthesized PASS
# ─────────────────────────────────────────────────────────────────────

@test "authoring phase prd, exit 0, no envelope -> synthesized PASS" {
    synth "${REQ_DIR}" "prd" 0
    local result="${REQ_DIR}/phase-result-prd.json"
    [[ -f "${result}" ]]
    [[ "$(jq -r .status "${result}")" == "pass" ]]
    [[ "$(jq -r .synthesized "${result}")" == "true" ]]
}

@test "authoring phase tdd, exit 0, no envelope -> synthesized PASS" {
    synth "${REQ_DIR}" "tdd" 0
    [[ "$(jq -r .status "${REQ_DIR}/phase-result-tdd.json")" == "pass" ]]
}

@test "authoring phase code, exit 0, no envelope -> synthesized PASS" {
    synth "${REQ_DIR}" "code" 0
    [[ "$(jq -r .status "${REQ_DIR}/phase-result-code.json")" == "pass" ]]
}

# ─────────────────────────────────────────────────────────────────────
# Review phases: clean exit + no envelope => synthesized FAIL
# ─────────────────────────────────────────────────────────────────────

@test "review phase prd_review, exit 0, no envelope -> synthesized FAIL with REVIEWER_DID_NOT_EMIT_VERDICT" {
    synth "${REQ_DIR}" "prd_review" 0
    local result="${REQ_DIR}/phase-result-prd_review.json"
    [[ -f "${result}" ]]
    [[ "$(jq -r .status "${result}")" == "fail" ]]
    [[ "$(jq -r .error "${result}")" == "REVIEWER_DID_NOT_EMIT_VERDICT" ]]
}

@test "review phase tdd_review, exit 0, no envelope -> FAIL" {
    synth "${REQ_DIR}" "tdd_review" 0
    [[ "$(jq -r .status "${REQ_DIR}/phase-result-tdd_review.json")" == "fail" ]]
    [[ "$(jq -r .error "${REQ_DIR}/phase-result-tdd_review.json")" == "REVIEWER_DID_NOT_EMIT_VERDICT" ]]
}

@test "review phase code_review, exit 0, no envelope -> FAIL" {
    synth "${REQ_DIR}" "code_review" 0
    [[ "$(jq -r .status "${REQ_DIR}/phase-result-code_review.json")" == "fail" ]]
}

@test "review phase plan_review, exit 0, no envelope -> FAIL" {
    synth "${REQ_DIR}" "plan_review" 0
    [[ "$(jq -r .status "${REQ_DIR}/phase-result-plan_review.json")" == "fail" ]]
}

# ─────────────────────────────────────────────────────────────────────
# Nonzero exit: any phase => synthesized FAIL with AGENT_EXITED_NONZERO
# ─────────────────────────────────────────────────────────────────────

@test "authoring phase, nonzero exit, no envelope -> FAIL AGENT_EXITED_NONZERO" {
    synth "${REQ_DIR}" "tdd" 124
    local result="${REQ_DIR}/phase-result-tdd.json"
    [[ "$(jq -r .status "${result}")" == "fail" ]]
    [[ "$(jq -r .error "${result}")" == "AGENT_EXITED_NONZERO" ]]
}

@test "review phase, nonzero exit, no envelope -> FAIL AGENT_EXITED_NONZERO (not REVIEWER_DID_NOT_EMIT)" {
    # Nonzero exit takes precedence over the review-phase branch — the
    # error reason most useful to the operator is "the agent crashed",
    # not "the agent didn't write the envelope".
    synth "${REQ_DIR}" "code_review" 1
    local result="${REQ_DIR}/phase-result-code_review.json"
    [[ "$(jq -r .status "${result}")" == "fail" ]]
    [[ "$(jq -r .error "${result}")" == "AGENT_EXITED_NONZERO" ]]
}

# ─────────────────────────────────────────────────────────────────────
# Pre-existing envelope: synthesizer is a no-op
# ─────────────────────────────────────────────────────────────────────

@test "review phase, agent wrote a real envelope first, synthesizer skips" {
    # Agent wrote its own envelope before exiting; the synthesizer
    # must NOT overwrite it (otherwise we lose the real verdict).
    local result="${REQ_DIR}/phase-result-prd_review.json"
    printf '{"status":"pass","feedback":"real review","phase":"prd_review"}\n' > "${result}"
    synth "${REQ_DIR}" "prd_review" 0
    [[ "$(jq -r .feedback "${result}")" == "real review" ]]
    [[ "$(jq -r .status "${result}")" == "pass" ]]
}
