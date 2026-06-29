#!/usr/bin/env bats
###############################################################################
# verifier_617_regression.bats — REQ-000052 TASK-012
#
# Regression guard for issue #617: a 208/208-passing build was marked
# VERIFICATION_FAILED / command_not_in_audit_log because the test command
# was not captured in the audit log even though it produced a result artifact.
#
# Tests R617-01..R617-04 per spec §4.2.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    VERIFIER="${PLUGIN_DIR}/lib/verification/verifier.sh"

    PROJ="$(mktemp -d -t adv-617-XXXXXX)"
    REQ_DIR="${PROJ}/.autonomous-dev/requests/REQ-617"
    mkdir -p "${REQ_DIR}/test-output"

    export VERIFICATION_REEXEC=0
    export VERIFICATION_ARTIFACT_FALLBACK=1
    unset VERIFICATION_MODE

    # Dispatched 30 minutes ago.
    _dispatched_at="$(date -u -v-30M +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
        || date -u -d '30 minutes ago' +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
        || date -u +"%Y-%m-%dT%H:%M:%SZ")"

    # Create state.json
    cat > "${REQ_DIR}/state.json" <<EOF
{ "id":"REQ-617", "status":"running", "current_phase":"integration",
  "current_phase_metadata": { "dispatched_at": "${_dispatched_at}" },
  "updated_at": "${_dispatched_at}" }
EOF

    # Create the executor-tail log (matches ET-1 pattern: "Tests: N passed").
    cat > "${REQ_DIR}/test-output/bun-test.log" <<'EOF'
> bun test

 bun test v1.1.0 (5f83e64)

 src/index.test.ts:
 ✓ it works (2ms)

Tests: 208 passed, 0 failed
Duration: 4.21s
EOF

    # Create phase-result-integration.json with the executor-tail artifact.
    cat > "${REQ_DIR}/phase-result-integration.json" <<EOF
{
  "phase": "integration",
  "status": "pass",
  "feedback": "all 208 tests passed",
  "evidence": [{
    "command": "bun test",
    "status": "pass",
    "exit_code": 0,
    "output_tail": "Tests: 208 passed, 0 failed"
  }],
  "artifacts": [{
    "kind": "executor-tail",
    "path": "${REQ_DIR}/test-output/bun-test.log",
    "title": "bun test output"
  }]
}
EOF

    # EMPTY audit log — the exact #617 scenario.
    : > "${REQ_DIR}/command-audit.jsonl"
    chmod 0600 "${REQ_DIR}/command-audit.jsonl"
}

teardown() {
    rm -rf "${PROJ}"
    unset VERIFICATION_REEXEC VERIFICATION_ARTIFACT_FALLBACK VERIFICATION_MODE
}

# ── R617-01: #617 happy path ──────────────────────────────────────────────────
@test "R617-01: 208-passing build with empty audit log is rescued by executor-tail" {
    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e

    [ "${rc}" -eq 0 ]
    local verdict
    verdict="$(jq -r '.verdict' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${verdict}" = "verified_by_artifact" ]
    local reason
    reason="$(jq -r '.reason' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [[ "${reason}" == "artifact_proof=executor_tail:"* ]]
}

# ── R617-02: Verdict string is exactly "verified_by_artifact" ────────────────
@test "R617-02: verdict string is exactly verified_by_artifact" {
    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    set -e

    local first_verdict
    first_verdict="$(jq -r '.verdict' "${REQ_DIR}/verification-report.jsonl" | head -1)"
    [ "${first_verdict}" = "verified_by_artifact" ]
}

# ── R617-03: Kill switch restores refusal ────────────────────────────────────
@test "R617-03: VERIFICATION_ARTIFACT_FALLBACK=0 restores refusal" {
    export VERIFICATION_ARTIFACT_FALLBACK=0

    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e

    [ "${rc}" -eq 2 ]
    local verdict
    verdict="$(jq -r '.verdict' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${verdict}" = "would_have_failed" ]
}

# ── R617-04: Missing artifact restores refusal ───────────────────────────────
@test "R617-04: missing artifact file restores refusal" {
    # Remove the executor-tail log and strip it from phase-result.
    rm -f "${REQ_DIR}/test-output/bun-test.log"
    cat > "${REQ_DIR}/phase-result-integration.json" <<'EOFJSON'
{
  "phase": "integration",
  "status": "pass",
  "feedback": "all 208 tests passed",
  "evidence": [{
    "command": "bun test",
    "status": "pass",
    "exit_code": 0,
    "output_tail": "Tests: 208 passed, 0 failed"
  }],
  "artifacts": []
}
EOFJSON

    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e

    [ "${rc}" -eq 2 ]
    local verdict
    verdict="$(jq -r '.verdict' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${verdict}" = "would_have_failed" ]
}
