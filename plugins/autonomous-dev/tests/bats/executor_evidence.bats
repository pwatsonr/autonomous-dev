#!/usr/bin/env bats
###############################################################################
# executor_evidence.bats — daemon auto-fails executor envelopes that claim
# pass without an `evidence` array.
#
# Background (REQ-000011 post-mortem, 2026-05-19): in the daemon's first
# real end-to-end ship, the integration phase wrote an envelope claiming
# "100% pass rate" without running the test suite (the actual suite had
# 62 failures); the deploy phase claimed "Docker artifacts created" but
# none were committed. Both agents DID write envelopes, so the reviewer
# fail-closed check (PR #338) doesn't catch them.
#
# New contract: integration/deploy/test envelopes with status=pass MUST
# include a non-empty `evidence` array. The daemon overwrites
# evidence-less pass claims with synthesized fail
# (EXECUTOR_CLAIMED_PASS_WITHOUT_EVIDENCE).
#
# These tests stand the guard up in isolation.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    TMP="$(mktemp -d -t advexec)"
    REQ_DIR="${TMP}/.autonomous-dev/requests/REQ-TEST"
    mkdir -p "${REQ_DIR}"

    # Re-implement the confabulation guard so we can call it without
    # going through the full claude-session machinery. Mirrors the
    # block in spawn-session.sh ("Confabulation guard").
    guard() {
        local req_dir="$1" target_phase="$2"
        case "${target_phase}" in
            integration|deploy|test) ;;
            *) return 0 ;;
        esac
        local result_path="${req_dir}/phase-result-${target_phase}.json"
        [[ ! -f "${result_path}" ]] && return 0
        local claimed_status
        claimed_status=$(jq -r '.status // "fail"' "${result_path}" 2>/dev/null || echo "fail")
        [[ "${claimed_status}" != "pass" ]] && return 0
        local evidence_count
        evidence_count=$(jq '(.evidence // []) | length' "${result_path}" 2>/dev/null || echo 0)
        [[ "${evidence_count}" -ge 1 ]] && return 0
        # Overwrite with synthesized fail
        local original_feedback
        original_feedback=$(jq -r '.feedback // ""' "${result_path}" 2>/dev/null || echo "")
        local fail_feedback
        fail_feedback="EXECUTOR_CLAIMED_PASS_WITHOUT_EVIDENCE — agent claimed: ${original_feedback}"
        local tmp_overwrite="${result_path}.tmp.$$"
        local ts_now
        ts_now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        jq -n --arg p "${target_phase}" --arg f "${fail_feedback}" --arg ts "${ts_now}" '{
            status: "fail",
            phase: $p,
            feedback: $f,
            error: "EXECUTOR_CLAIMED_PASS_WITHOUT_EVIDENCE",
            artifacts: [],
            synthesized: true,
            exit_code: 0,
            completed_at: $ts
        }' > "${tmp_overwrite}"
        mv "${tmp_overwrite}" "${result_path}"
    }
}

teardown() {
    rm -rf "${TMP}"
}

# Helper: write an envelope with given status + optional evidence array
write_envelope() {
    local phase="$1" status="$2" evidence_json="${3:-[]}"
    jq -n --arg s "$status" --arg p "$phase" --argjson e "$evidence_json" '{
        status: $s,
        phase: $p,
        feedback: "agent-written",
        evidence: $e
    }' > "${REQ_DIR}/phase-result-${phase}.json"
}

# ─────────────────────────────────────────────────────────────────────
# Confabulation cases: pass without evidence → auto-fail
# ─────────────────────────────────────────────────────────────────────

@test "integration phase, status=pass, empty evidence -> auto-fail" {
    write_envelope "integration" "pass" "[]"
    guard "${REQ_DIR}" "integration"
    local result="${REQ_DIR}/phase-result-integration.json"
    [[ "$(jq -r .status "${result}")" == "fail" ]]
    [[ "$(jq -r .error "${result}")" == "EXECUTOR_CLAIMED_PASS_WITHOUT_EVIDENCE" ]]
}

@test "integration phase, status=pass, missing evidence key -> auto-fail" {
    # Even an entirely absent `evidence` key should trip the guard.
    jq -n '{status:"pass",phase:"integration",feedback:"100% pass rate"}' \
        > "${REQ_DIR}/phase-result-integration.json"
    guard "${REQ_DIR}" "integration"
    [[ "$(jq -r .error "${REQ_DIR}/phase-result-integration.json")" == "EXECUTOR_CLAIMED_PASS_WITHOUT_EVIDENCE" ]]
}

@test "deploy phase, status=pass, empty evidence -> auto-fail" {
    write_envelope "deploy" "pass" "[]"
    guard "${REQ_DIR}" "deploy"
    [[ "$(jq -r .error "${REQ_DIR}/phase-result-deploy.json")" == "EXECUTOR_CLAIMED_PASS_WITHOUT_EVIDENCE" ]]
}

@test "test phase, status=pass, empty evidence -> auto-fail" {
    write_envelope "test" "pass" "[]"
    guard "${REQ_DIR}" "test"
    [[ "$(jq -r .error "${REQ_DIR}/phase-result-test.json")" == "EXECUTOR_CLAIMED_PASS_WITHOUT_EVIDENCE" ]]
}

@test "auto-fail preserves the original feedback inside the new feedback" {
    jq -n '{status:"pass",phase:"integration",feedback:"All 32 tests pass",evidence:[]}' \
        > "${REQ_DIR}/phase-result-integration.json"
    guard "${REQ_DIR}" "integration"
    local fb
    fb=$(jq -r .feedback "${REQ_DIR}/phase-result-integration.json")
    [[ "${fb}" == *"agent claimed: All 32 tests pass"* ]]
}

# ─────────────────────────────────────────────────────────────────────
# Honest cases: pass WITH evidence → guard is a no-op
# ─────────────────────────────────────────────────────────────────────

@test "integration phase, status=pass, evidence with one command -> guard skips" {
    write_envelope "integration" "pass" '[{"command":"bun test","exit_code":0,"output_tail":"1559 pass / 0 fail"}]'
    guard "${REQ_DIR}" "integration"
    local result="${REQ_DIR}/phase-result-integration.json"
    [[ "$(jq -r .status "${result}")" == "pass" ]]
    [[ "$(jq -r '.error // "none"' "${result}")" == "none" ]]
}

@test "deploy phase, status=pass, evidence with multiple commands -> guard skips" {
    write_envelope "deploy" "pass" '[{"command":"docker build .","exit_code":0,"output_tail":"Successfully built abc123"},{"command":"docker run --rm img -e","exit_code":0,"output_tail":"healthcheck OK"}]'
    guard "${REQ_DIR}" "deploy"
    [[ "$(jq -r .status "${REQ_DIR}/phase-result-deploy.json")" == "pass" ]]
}

# ─────────────────────────────────────────────────────────────────────
# Honest fail cases: status=fail bypasses the guard entirely
# ─────────────────────────────────────────────────────────────────────

@test "integration phase, status=fail, no evidence -> guard is a no-op (already fail)" {
    write_envelope "integration" "fail" "[]"
    guard "${REQ_DIR}" "integration"
    local result="${REQ_DIR}/phase-result-integration.json"
    [[ "$(jq -r .status "${result}")" == "fail" ]]
    # error key should NOT be set by the guard since it didn't overwrite
    [[ "$(jq -r '.error // "no-error-key"' "${result}")" == "no-error-key" ]]
}

# ─────────────────────────────────────────────────────────────────────
# Non-executor phases: guard never applies
# ─────────────────────────────────────────────────────────────────────

@test "prd phase, status=pass, no evidence -> guard skips (not an executor phase)" {
    write_envelope "prd" "pass" "[]"
    guard "${REQ_DIR}" "prd"
    local result="${REQ_DIR}/phase-result-prd.json"
    [[ "$(jq -r .status "${result}")" == "pass" ]]
}

@test "code_review phase, status=pass, no evidence -> guard skips (review, not executor)" {
    # The reviewer fail-closed (PR #338) handles missing envelopes;
    # this executor guard only runs against integration/deploy/test.
    write_envelope "code_review" "pass" "[]"
    guard "${REQ_DIR}" "code_review"
    [[ "$(jq -r .status "${REQ_DIR}/phase-result-code_review.json")" == "pass" ]]
}
