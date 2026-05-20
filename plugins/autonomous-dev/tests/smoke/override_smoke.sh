#!/usr/bin/env bash
###############################################################################
# override_smoke.sh — PLAN-042 Phase D smoke test
#
# End-to-end smoke for the operator override path:
#
#   1. Set up a request directory under AUTONOMOUS_DEV_STATE_DIR with
#      an envelope the verifier would refuse (status=pass + bogus evidence).
#   2. Invoke the CLI's `override-verification` sub-command.
#   3. Assert the override file exists with the right shape.
#   4. Assert the request-action ledger row was appended.
#   5. Simulate the spawn-session.sh override-recognition predicate and
#      confirm it short-circuits (i.e. the envelope is NOT overwritten).
#
# Run via: bash plugins/autonomous-dev/tests/smoke/override_smoke.sh
#
# Exits 0 on pass, non-zero with diagnostic on fail.
###############################################################################

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="${PLUGIN_DIR}/bin/autonomous-dev.sh"

TMP="$(mktemp -d -t adv-override-smoke-XXXXXX)"
trap 'rm -rf "${TMP}"' EXIT

export AUTONOMOUS_DEV_STATE_DIR="${TMP}/state"
export HOME="${TMP}/home"
export USER="smoke-operator"
REQ_ID="REQ-100042"
REQ_DIR="${AUTONOMOUS_DEV_STATE_DIR}/requests/${REQ_ID}"
mkdir -p "${REQ_DIR}" "${HOME}/.autonomous-dev"

# Step 1 — envelope the verifier would refuse.
cat > "${REQ_DIR}/phase-result-test.json" <<'EOF'
{
  "status": "pass",
  "phase": "test",
  "feedback": "all good (claimed)",
  "evidence": [{"command": "unknown-tool", "exit_code": 0, "output_tail": "ok"}]
}
EOF
ENVELOPE_ORIG="$(cat "${REQ_DIR}/phase-result-test.json")"

# Step 2 — operator authorizes the override via CLI.
bash "${CLI}" override-verification "${REQ_ID}" --reason "smoke test override"

# Step 3 — override file exists + correct shape.
[[ -f "${REQ_DIR}/verification-override.json" ]] || {
    echo "FAIL: verification-override.json missing" >&2
    exit 1
}
[[ "$(jq -r '.request_id' "${REQ_DIR}/verification-override.json")" == "${REQ_ID}" ]] || {
    echo "FAIL: request_id mismatch" >&2
    exit 1
}
[[ "$(jq -r '.reason' "${REQ_DIR}/verification-override.json")" == "smoke test override" ]] || {
    echo "FAIL: reason mismatch" >&2
    exit 1
}
[[ "$(jq -r '.operator' "${REQ_DIR}/verification-override.json")" == "smoke-operator" ]] || {
    echo "FAIL: operator mismatch" >&2
    exit 1
}

# Step 4 — portal request-action audit row appended.
ACTION_FILE="${AUTONOMOUS_DEV_STATE_DIR}/request-actions/${REQ_ID}.json"
[[ -f "${ACTION_FILE}" ]] || {
    echo "FAIL: request-action ledger row missing" >&2
    exit 1
}
[[ "$(jq -r '.last_action' "${ACTION_FILE}")" == "verification_override" ]] || {
    echo "FAIL: last_action != verification_override" >&2
    exit 1
}
[[ "$(jq -r '.verification_override.enabled' "${ACTION_FILE}")" == "true" ]] || {
    echo "FAIL: verification_override.enabled != true" >&2
    exit 1
}

# Step 5 — spawn-session.sh's predicate short-circuits the envelope
# overwrite. Mirror the guard:
override_path="${REQ_DIR}/verification-override.json"
override_req=$(jq -r '.request_id // ""' "${override_path}")
[[ "${override_req}" == "${REQ_ID}" ]] || {
    echo "FAIL: override-recognition predicate failed" >&2
    exit 1
}

# Confirm envelope is untouched (the daemon would skip the overwrite).
ENVELOPE_AFTER="$(cat "${REQ_DIR}/phase-result-test.json")"
[[ "${ENVELOPE_ORIG}" == "${ENVELOPE_AFTER}" ]] || {
    echo "FAIL: envelope was modified — daemon should preserve under override" >&2
    exit 1
}

echo "OK: override smoke complete."
echo "  override file:  ${override_path}"
echo "  audit row:      ${ACTION_FILE}"
echo "  envelope:       preserved (status=$(jq -r '.status' "${REQ_DIR}/phase-result-test.json"))"
