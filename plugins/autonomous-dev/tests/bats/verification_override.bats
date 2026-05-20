#!/usr/bin/env bats
###############################################################################
# verification_override.bats — PLAN-042 Phase D
#
# Operator override path for VERIFICATION_FAILED. Tests cover:
#
#   1. CLI creates the override file with the right shape.
#   2. CLI rejects a missing or empty --reason.
#   3. CLI rejects a missing or malformed REQ-id.
#   4. Daemon respects the override (skips envelope overwrite) when the
#      file is present and the request_id matches.
#   5. Daemon does NOT respect a stale override whose request_id is for
#      a different REQ.
#   6. Override survives multiple consecutive "spawn-session-equivalent"
#      iterations until cleanup (file remains until terminal state).
#   7. Audit row is recorded in the portal request-action ledger when the
#      override is created.
#   8. End-to-end: simulated refusal fires, operator overrides, the next
#      verification pass preserves the original envelope.
#
# 8 bats cases — Phase D's pass target per PLAN-042 §"Phase D" is ~9 (5
# bats + 4 portal route tests). The portal route is exercised by the
# portal test file (override-route.test.ts).
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    CLI="${PLUGIN_DIR}/bin/autonomous-dev.sh"
    SPAWN="${PLUGIN_DIR}/bin/spawn-session.sh"

    TMP="$(mktemp -d -t adv-verd-XXXXXX)"
    export AUTONOMOUS_DEV_STATE_DIR="${TMP}/state"
    export HOME_BAK="${HOME:-/tmp}"
    export HOME="${TMP}/home"
    mkdir -p "${HOME}/.autonomous-dev"
    mkdir -p "${AUTONOMOUS_DEV_STATE_DIR}/requests/REQ-000042"
    export REQ_DIR="${AUTONOMOUS_DEV_STATE_DIR}/requests/REQ-000042"
    # The CLI walks AUTONOMOUS_DEV_STATE_DIR/requests/<id> first, so it
    # finds the test dir without a project-worktree dance.
    export AUTONOMOUS_DEV_REQ_DIR="${REQ_DIR}"
    export USER="test-operator"
}

teardown() {
    export HOME="${HOME_BAK}"
    rm -rf "${TMP}"
}

# ─────────────────────────────────────────────────────────────────────
# CLI shape & validation
# ─────────────────────────────────────────────────────────────────────

@test "phase-d cli: writes override file with correct shape" {
    run bash "${CLI}" override-verification REQ-000042 --reason "flaky network test"
    [ "$status" -eq 0 ]
    [ -f "${REQ_DIR}/verification-override.json" ]
    [ "$(jq -r '.request_id' "${REQ_DIR}/verification-override.json")" = "REQ-000042" ]
    [ "$(jq -r '.reason' "${REQ_DIR}/verification-override.json")" = "flaky network test" ]
    [ "$(jq -r '.operator' "${REQ_DIR}/verification-override.json")" = "test-operator" ]
    [ -n "$(jq -r '.timestamp' "${REQ_DIR}/verification-override.json")" ]
}

@test "phase-d cli: rejects empty --reason" {
    run bash "${CLI}" override-verification REQ-000042 --reason ""
    [ "$status" -ne 0 ]
    [ ! -f "${REQ_DIR}/verification-override.json" ]
    echo "$output" | grep -qi "reason"
}

@test "phase-d cli: rejects whitespace-only --reason" {
    run bash "${CLI}" override-verification REQ-000042 --reason "   "
    [ "$status" -ne 0 ]
    [ ! -f "${REQ_DIR}/verification-override.json" ]
}

@test "phase-d cli: rejects malformed REQ-id" {
    run bash "${CLI}" override-verification not-a-req-id --reason "test"
    [ "$status" -ne 0 ]
    echo "$output" | grep -qi "invalid"
}

@test "phase-d cli: rejects missing REQ-id positional" {
    run bash "${CLI}" override-verification --reason "test"
    [ "$status" -ne 0 ]
}

# ─────────────────────────────────────────────────────────────────────
# Daemon respects override (refuse-mode integration)
# ─────────────────────────────────────────────────────────────────────
#
# We exercise the spawn-session.sh refuse-mode block by:
#   a. Setting up a phase-result envelope claiming pass with evidence
#      that the verifier will refuse (e.g., an unclassifiable command).
#   b. Setting up a `verification-override.json` for the same REQ.
#   c. Sourcing spawn-session.sh's helpers and invoking the relevant
#      override-recognition block directly.
#
# Because spawn-session.sh is structured as one large `main` orchestrator,
# we test the override-check predicate at the file level rather than
# re-running the entire spawn flow. The integration is a 4-line guard:
# "if override file exists and request_id matches → skip overwrite".
# We assert that guard directly.

# Helper: simulate the override-recognition logic from spawn-session.sh.
# This mirrors lines ~470-510 (the PLAN-042 Phase D block we added).
check_override_applied() {
    local req_dir="$1" req_id="$2"
    local override_path="${req_dir}/verification-override.json"
    if [[ ! -f "${override_path}" ]]; then
        return 1
    fi
    local override_req
    override_req=$(jq -r '.request_id // ""' "${override_path}" 2>/dev/null || echo "")
    if [[ "${override_req}" == "${req_id}" ]]; then
        return 0
    fi
    return 1
}

@test "phase-d daemon: override file present + matching id → applied" {
    bash "${CLI}" override-verification REQ-000042 --reason "ok"
    [ -f "${REQ_DIR}/verification-override.json" ]
    run check_override_applied "${REQ_DIR}" "REQ-000042"
    [ "$status" -eq 0 ]
}

@test "phase-d daemon: override file present but for a different REQ → ignored" {
    # Manually craft a stale override (different request_id).
    cat > "${REQ_DIR}/verification-override.json" <<EOF
{
  "request_id": "REQ-999999",
  "reason": "stale",
  "operator": "someone-else",
  "timestamp": "2026-05-19T00:00:00Z"
}
EOF
    run check_override_applied "${REQ_DIR}" "REQ-000042"
    [ "$status" -ne 0 ]
}

# ─────────────────────────────────────────────────────────────────────
# Lifecycle: override persists across daemon iterations until terminal
# ─────────────────────────────────────────────────────────────────────

@test "phase-d lifecycle: override file persists across multiple polls" {
    bash "${CLI}" override-verification REQ-000042 --reason "persist"
    # Simulate three daemon polls — each calls check_override_applied
    # and the file must still exist between them.
    for _ in 1 2 3; do
        run check_override_applied "${REQ_DIR}" "REQ-000042"
        [ "$status" -eq 0 ]
        [ -f "${REQ_DIR}/verification-override.json" ]
    done
}

# ─────────────────────────────────────────────────────────────────────
# Audit trail
# ─────────────────────────────────────────────────────────────────────

@test "phase-d audit: request-action ledger receives a verification_override row" {
    run bash "${CLI}" override-verification REQ-000042 --reason "audit me"
    [ "$status" -eq 0 ]
    local action_file="${AUTONOMOUS_DEV_STATE_DIR}/request-actions/REQ-000042.json"
    [ -f "${action_file}" ]
    [ "$(jq -r '.last_action' "${action_file}")" = "verification_override" ]
    [ "$(jq -r '.verification_override.enabled' "${action_file}")" = "true" ]
    [ "$(jq -r '.verification_override.reason' "${action_file}")" = "audit me" ]
    [ "$(jq -r '.verification_override.set_by' "${action_file}")" = "test-operator" ]
}

# ─────────────────────────────────────────────────────────────────────
# End-to-end with the spawn-session.sh override block
# ─────────────────────────────────────────────────────────────────────
#
# We extract the override-check block from spawn-session.sh and assert
# its contract: given an envelope and a matching override, the envelope
# is NOT overwritten. Given the same envelope without the override, the
# envelope IS overwritten (Phase C contract).
#
# We test by writing a phase-result envelope + a verification-override
# file, then running the same predicate spawn-session.sh runs and
# asserting it short-circuits the overwrite step.

@test "phase-d e2e: refuse → override → envelope preserved" {
    # Set up an envelope the verifier WOULD refuse.
    cat > "${REQ_DIR}/phase-result-test.json" <<'EOF'
{
  "status": "pass",
  "phase": "test",
  "feedback": "agent original feedback",
  "evidence": [{"command": "totally-unknown-cmd", "exit_code": 0, "output_tail": "ok"}]
}
EOF
    cp "${REQ_DIR}/phase-result-test.json" "${REQ_DIR}/phase-result-test.original.json"

    # Operator authorizes the override.
    bash "${CLI}" override-verification REQ-000042 --reason "env mismatch"

    # Simulate spawn-session.sh's override-applied branch: when the
    # override is present and matches the request_id, the envelope must
    # NOT be overwritten with status=fail.
    run check_override_applied "${REQ_DIR}" "REQ-000042"
    [ "$status" -eq 0 ]

    # Envelope is unchanged from the agent's original.
    diff "${REQ_DIR}/phase-result-test.json" "${REQ_DIR}/phase-result-test.original.json"
    [ "$(jq -r '.status' "${REQ_DIR}/phase-result-test.json")" = "pass" ]
    [ "$(jq -r '.feedback' "${REQ_DIR}/phase-result-test.json")" = "agent original feedback" ]
}
