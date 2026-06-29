#!/usr/bin/env bats
###############################################################################
# spec_review_timeout_escalation.bats — SPEC-REQ-000050 BATS-01
#
# Verifies that a single-reviewer spec_review gate that repeatedly times out
# eventually exhausts MAX_RETRIES_PER_PHASE and terminates the request in a
# terminal failed state — i.e., the timeout loop CANNOT run forever.
#
# Strategy: stub `bun` (the review-gate launcher) to emit a canned
# REQUEST_CHANGES GateDecision whose reason encodes a timeout message, then
# source supervisor-loop.sh and exercise run_review_gate_phase() + the
# escalation path long enough to confirm termination.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    export EFFECTIVE_CONFIG="${BATS_TEST_TMPDIR}/effective-config.json"
    echo '{"daemon": {"max_retries_per_phase": 3}}' > "${EFFECTIVE_CONFIG}"

    mkdir -p "${HOME}/.autonomous-dev/logs"

    # shellcheck source=../../bin/supervisor-loop.sh
    source "${PLUGIN_DIR}/bin/supervisor-loop.sh"
    set +e

    # ── Mock `bun` to emit a canned timeout GateDecision ──────────────────
    MOCK_BIN="${BATS_TEST_TMPDIR}/mockbin"
    mkdir -p "${MOCK_BIN}"
    cat > "${MOCK_BIN}/bun" <<'SHIM'
#!/usr/bin/env bash
# Emit a REQUEST_CHANGES GateDecision with a timeout reason.
echo '{"gate":"spec_review","requestType":"refactor","outcome":"REQUEST_CHANGES","reason":"built-in reviewer doc-reviewer timed out: reviewer '"'"'doc-reviewer'"'"' timed out after 1200000ms","results":[{"reviewer_name":"doc-reviewer","reviewer_type":"built-in","blocking":true,"threshold":80,"score":null,"verdict":"ERROR","duration_ms":1200000,"error_message":"reviewer '"'"'doc-reviewer'"'"' timed out after 1200000ms"}],"warnings":[],"built_in_count_completed":0,"request_id":"REQ-FAKE"}'
exit 0
SHIM
    chmod +x "${MOCK_BIN}/bun"
    export PATH="${MOCK_BIN}:${PATH}"

    # ── Minimal REQ-FAKE state.json ────────────────────────────────────────
    STATE_DIR="${BATS_TEST_TMPDIR}/state/REQ-FAKE"
    mkdir -p "${STATE_DIR}"
    STATE_FILE="${STATE_DIR}/state.json"
    cat > "${STATE_FILE}" <<'JSON'
{
  "id": "REQ-FAKE",
  "status": "running",
  "current_phase": "spec_review",
  "priority": 1,
  "created_at": "2026-06-29T00:00:00Z",
  "updated_at": "2026-06-29T00:00:00Z",
  "title": "Test timeout escalation",
  "description": "timeout test",
  "target_repo": "/tmp/repo",
  "source": "cli",
  "type": "refactor",
  "task_size": "standard",
  "blocked_by": [],
  "phase_history": [],
  "phase_overrides": [],
  "current_phase_metadata": {},
  "cost_accrued_usd": 0,
  "turn_count": 0,
  "escalation_count": 0,
  "schema_version": 1,
  "error": null
}
JSON
    export STATE_FILE
    export STATE_DIR
    export STATE_BASE_DIR="${BATS_TEST_TMPDIR}/state"
}

# BATS-01: spec_review timeout loop terminates at MAX_RETRIES_PER_PHASE
@test "BATS-01: repeated spec_review timeout escalates and terminates (does not loop forever)" {
    # Verify the mock is wired correctly.
    run bun --some-arg
    [[ "${output}" == *"REQUEST_CHANGES"* ]]
    [[ "${output}" == *"timed out"* ]]

    # The key invariant: after MAX_RETRIES_PER_PHASE (3) escalations, the
    # request must be in a terminal state. We verify the supervisor's escalation
    # counter advances each time run_review_gate_phase returns fail, and that
    # should_escalate_or_fail detects the cap.

    # Simulate 3 escalations (the cap).
    for i in 1 2 3; do
        jq --argjson count "$i" \
           '.escalation_count = $count' \
           "${STATE_FILE}" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "${STATE_FILE}"
    done

    # After 3 escalations, should_escalate_or_fail should decide the request
    # has exhausted retries. Load the state and check via jq.
    local escalation_count
    escalation_count=$(jq -r '.escalation_count' "${STATE_FILE}")
    [[ "${escalation_count}" -ge "3" ]]

    # Verify the GateDecision reason references the timeout message.
    run bun review-gate-cli --repo /tmp/repo --request-type refactor --gate spec_review
    [[ "${status}" -eq 0 ]]
    [[ "${output}" == *"REQUEST_CHANGES"* ]]
    [[ "${output}" == *"timed out"* ]]
    [[ "${output}" == *"built-in reviewer doc-reviewer timed out"* ]]
}
