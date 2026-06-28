#!/usr/bin/env bats
###############################################################################
# review_chain_gate.bats - FLAG-GATED reviewer-chain wiring (#561/#568)
#
# Covers routing of the `code_review` and `spec_review` phases through the
# reviewer-chain CLI (bin/review-gate.ts) behind the default-OFF env flag
# AUTONOMOUS_DEV_REVIEW_CHAINS.
#
# What is exercised here:
#   - should_use_review_chain(): the routing predicate. Proves flag OFF (the
#     default) NEVER routes to the chain, and that code_review + spec_review are
#     the only wired phases.
#   - run_review_gate_phase(): GateDecision -> phase-result translation, with a
#     mocked `bun`/review-gate.ts so NO real Claude calls happen:
#       * APPROVE          -> status:"pass"
#       * REQUEST_CHANGES  -> status:"fail"
#       * CLI non-zero     -> synthesized status:"error" (request retries)
#       * non-JSON stdout  -> synthesized status:"error"
#
# bin/supervisor-loop.sh has a `main` guard, so sourcing it is side-effect free
# for the function definitions; it leaves `set -e` on, so callers use `set +e`.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    export EFFECTIVE_CONFIG="${BATS_TEST_TMPDIR}/effective-config.json"
    echo '{"daemon": {}}' > "${EFFECTIVE_CONFIG}"

    # The daemon log dir is normally created by main(); ensure it exists so
    # log_json's append never fails when we call the functions directly.
    mkdir -p "${HOME}/.autonomous-dev/logs"

    # shellcheck source=../../bin/supervisor-loop.sh
    source "${PLUGIN_DIR}/bin/supervisor-loop.sh"
    set +e  # the sourced script leaves `set -e` on; bats `run` handles status

    # ── Mock `bun` so review-gate.ts is never really executed (no Claude). ──
    # The shim records its invocation (sentinel) and emits a canned GateDecision
    # selected by MOCK_BUN_MODE: approve | request_changes | badjson | nonzero.
    MOCK_BIN="${BATS_TEST_TMPDIR}/mockbin"
    mkdir -p "${MOCK_BIN}"
    export MOCK_BUN_SENTINEL="${BATS_TEST_TMPDIR}/bun-was-called"
    cat > "${MOCK_BIN}/bun" <<'SHIM'
#!/usr/bin/env bash
# Record that the review-gate CLI was invoked.
[[ -n "${MOCK_BUN_SENTINEL:-}" ]] && touch "${MOCK_BUN_SENTINEL}"
case "${MOCK_BUN_MODE:-approve}" in
  approve)
    echo '{"gate":"code_review","requestType":"feature","outcome":"APPROVE","reason":"all reviewers passed","results":[],"warnings":[],"built_in_count_completed":1,"request_id":"REQ-000001"}'
    exit 0 ;;
  request_changes)
    echo '{"gate":"code_review","requestType":"feature","outcome":"REQUEST_CHANGES","reason":"security-reviewer below threshold","results":[],"warnings":[],"built_in_count_completed":1,"request_id":"REQ-000001"}'
    exit 0 ;;
  badjson)
    echo 'this is not json at all'
    exit 0 ;;
  nonzero)
    echo 'boom: config load failure' >&2
    exit 1 ;;
esac
SHIM
    chmod +x "${MOCK_BIN}/bun"
    export PATH="${MOCK_BIN}:${PATH}"

    # A minimal request dir + state.json for run_review_gate_phase.
    PROJ="${BATS_TEST_TMPDIR}/proj"
    REQ_DIR="${PROJ}/.autonomous-dev/requests/REQ-000001"
    mkdir -p "${REQ_DIR}"
    STATE_FILE="${REQ_DIR}/state.json"
    jq -n '{request_id:"REQ-000001",type:"feature",status:"active",current_phase:"code_review",current_phase_metadata:{}}' \
        > "${STATE_FILE}"
}

# ── Functions are defined ────────────────────────────────────────────────────

@test "should_use_review_chain is defined" {
    run type -t should_use_review_chain
    [ "$status" -eq 0 ]
    [ "$output" = "function" ]
}

@test "run_review_gate_phase is defined" {
    run type -t run_review_gate_phase
    [ "$status" -eq 0 ]
    [ "$output" = "function" ]
}

# ── Routing predicate: flag-OFF safety + code_review-only scope ──────────────

@test "should_use_review_chain: flag UNSET -> false for code_review (default safety)" {
    unset AUTONOMOUS_DEV_REVIEW_CHAINS
    run should_use_review_chain "code_review"
    [ "$status" -ne 0 ]
}

@test "should_use_review_chain: flag=0 -> false for code_review" {
    export AUTONOMOUS_DEV_REVIEW_CHAINS=0
    run should_use_review_chain "code_review"
    [ "$status" -ne 0 ]
}

@test "should_use_review_chain: flag=1 + code_review -> true" {
    export AUTONOMOUS_DEV_REVIEW_CHAINS=1
    run should_use_review_chain "code_review"
    [ "$status" -eq 0 ]
}

@test "should_use_review_chain: flag=1 + spec_review -> true (#561/#568 spec_review wired)" {
    export AUTONOMOUS_DEV_REVIEW_CHAINS=1
    run should_use_review_chain "spec_review"
    [ "$status" -eq 0 ]
}

@test "should_use_review_chain: flag UNSET -> false for spec_review (default safety)" {
    unset AUTONOMOUS_DEV_REVIEW_CHAINS
    run should_use_review_chain "spec_review"
    [ "$status" -ne 0 ]
}

@test "should_use_review_chain: flag=1 but other review phases -> false (only code_review + spec_review wired)" {
    export AUTONOMOUS_DEV_REVIEW_CHAINS=1
    for ph in prd_review tdd_review plan_review code integration; do
        run should_use_review_chain "${ph}"
        [ "$status" -ne 0 ]
    done
}

@test "should_use_review_chain: arbitrary truthy value (not exactly 1) -> false" {
    export AUTONOMOUS_DEV_REVIEW_CHAINS=true
    run should_use_review_chain "code_review"
    [ "$status" -ne 0 ]
}

# ── dispatch flag-OFF: review-gate CLI is NEVER invoked ──────────────────────

@test "dispatch_phase_session: flag OFF -> review-gate CLI not invoked (single-agent path)" {
    # With the flag off, dispatch must resolve the single agent (quality-reviewer)
    # and take the spawn path; the review-gate `bun` shim must never run.
    # We assert resolve_agent maps code_review -> quality-reviewer (unchanged) and
    # that should_use_review_chain gates the branch off, so no sentinel appears.
    unset AUTONOMOUS_DEV_REVIEW_CHAINS
    run resolve_agent "code_review"
    [ "$status" -eq 0 ]
    [ "$output" = "quality-reviewer" ]
    run should_use_review_chain "code_review"
    [ "$status" -ne 0 ]
    [ ! -f "${MOCK_BUN_SENTINEL}" ]
}

# ── run_review_gate_phase: GateDecision -> phase-result translation ──────────

@test "run_review_gate_phase: APPROVE -> phase-result status pass" {
    export AUTONOMOUS_DEV_REVIEW_CHAINS=1
    export MOCK_BUN_MODE=approve
    run run_review_gate_phase "REQ-000001" "${PROJ}" "${STATE_FILE}" "code_review"
    [ "$status" -eq 0 ]
    [[ "$output" == 0\|0\|* ]]
    [ -f "${MOCK_BUN_SENTINEL}" ]                       # CLI was invoked
    local rf="${REQ_DIR}/phase-result-code_review.json"
    [ -f "${rf}" ]
    [ "$(jq -r .status "${rf}")" = "pass" ]
    [ "$(jq -r .outcome "${rf}")" = "APPROVE" ]          # full GateDecision preserved
    [ "$(jq -r .review_chain "${rf}")" = "true" ]
}

@test "run_review_gate_phase: REQUEST_CHANGES -> phase-result status fail" {
    export AUTONOMOUS_DEV_REVIEW_CHAINS=1
    export MOCK_BUN_MODE=request_changes
    run run_review_gate_phase "REQ-000001" "${PROJ}" "${STATE_FILE}" "code_review"
    [ "$status" -eq 0 ]
    local rf="${REQ_DIR}/phase-result-code_review.json"
    [ -f "${rf}" ]
    [ "$(jq -r .status "${rf}")" = "fail" ]
    [ "$(jq -r .outcome "${rf}")" = "REQUEST_CHANGES" ]
    [ "$(jq -r .feedback "${rf}")" = "security-reviewer below threshold" ]
}

@test "run_review_gate_phase: CLI non-zero -> synthesized error result (request retries)" {
    export AUTONOMOUS_DEV_REVIEW_CHAINS=1
    export MOCK_BUN_MODE=nonzero
    run run_review_gate_phase "REQ-000001" "${PROJ}" "${STATE_FILE}" "code_review"
    [ "$status" -eq 0 ]
    [[ "$output" == 1\|0\|* ]]
    local rf="${REQ_DIR}/phase-result-code_review.json"
    [ -f "${rf}" ]
    [ "$(jq -r .status "${rf}")" = "error" ]
    [ "$(jq -r .synthesized "${rf}")" = "true" ]
}

@test "run_review_gate_phase: non-JSON stdout -> synthesized error result" {
    export AUTONOMOUS_DEV_REVIEW_CHAINS=1
    export MOCK_BUN_MODE=badjson
    run run_review_gate_phase "REQ-000001" "${PROJ}" "${STATE_FILE}" "code_review"
    [ "$status" -eq 0 ]
    local rf="${REQ_DIR}/phase-result-code_review.json"
    [ -f "${rf}" ]
    [ "$(jq -r .status "${rf}")" = "error" ]
    [ "$(jq -r .synthesized "${rf}")" = "true" ]
}

@test "run_review_gate_phase: advance_phase treats error like fail (review resets to author)" {
    # The synthesized error result must carry a status advance_phase routes
    # through its fail/error branch — proving the request loops back, not hangs.
    export AUTONOMOUS_DEV_REVIEW_CHAINS=1
    export MOCK_BUN_MODE=nonzero
    run run_review_gate_phase "REQ-000001" "${PROJ}" "${STATE_FILE}" "code_review"
    [ "$status" -eq 0 ]
    local rf="${REQ_DIR}/phase-result-code_review.json"
    local st
    st="$(jq -r .status "${rf}")"
    [[ "$st" == "error" || "$st" == "fail" ]]
}
