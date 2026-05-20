#!/usr/bin/env bash
###############################################################################
# verifier_smoke.sh — PLAN-042 Phase B smoke test
#
# Simulates a 3-command executor envelope + matching Phase A audit log,
# then runs the Phase B verifier (LOG MODE) and asserts the resulting
# verification-report.jsonl has the expected shape and content.
#
# Real re-execution is disabled (VERIFICATION_REEXEC=0) — the smoke proves
# the wiring + classification + audit-log presence checks without invoking
# arbitrary commands on the operator's box. The bats suite covers the
# re-exec path via stubs.
#
# Run via:  bash plugins/autonomous-dev/tests/smoke/verifier_smoke.sh
#
# Exits 0 on pass, non-zero with diagnostic on fail.
###############################################################################

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERIFIER="${PLUGIN_DIR}/lib/verification/verifier.sh"

TMP="$(mktemp -d -t adv-verifier-smoke-XXXXXX)"
trap 'rm -rf "${TMP}"' EXIT
REQ_DIR="${TMP}/.autonomous-dev/requests/REQ-SMOKE"
mkdir -p "${REQ_DIR}/worktree"

# Step 1 — write a 3-command pass-claiming envelope.
jq -n '{
    status: "pass",
    phase: "integration",
    feedback: "all good",
    evidence: [
        {"command":"bun test","exit_code":0,"output_tail":"1559 pass / 0 fail"},
        {"command":"git push origin main","exit_code":0,"output_tail":"To github.com\nupdated"},
        {"command":"some-bespoke-tool","exit_code":0,"output_tail":"ok"}
    ]
}' > "${REQ_DIR}/phase-result-integration.json"

# Step 2 — write a matching audit log (one row per command).
LOG="${REQ_DIR}/command-audit.jsonl"
: > "${LOG}"
for cmd in "bun test" "git push origin main" "some-bespoke-tool"; do
    first_token="$(printf '%s' "${cmd}" | awk '{print $1}')"
    jq -nc --arg phase "integration" --arg cmd "${cmd}" --arg ft "${first_token}" '{
        ts: "2026-05-19T12:00:00Z", phase: $phase, command: $cmd,
        argv: [$ft], cwd: "/tmp/wt", exit_code: null,
        duration_ms: null, output_tail: null, source: "sdk_hook"
    }' >> "${LOG}"
done
chmod 0600 "${LOG}"

# Step 3 — run the verifier in log mode, capturing stderr for the summary.
export VERIFICATION_REEXEC=0
# shellcheck source=/dev/null
source "${VERIFIER}"
err="${TMP}/verifier.err"
verify_envelope "${REQ_DIR}" "integration" "log" 2>"${err}"

REPORT="${REQ_DIR}/verification-report.jsonl"

# Assertion 1 — report exists.
if [[ ! -f "${REPORT}" ]]; then
    echo "FAIL: verification-report.jsonl was not created" >&2
    exit 1
fi

# Assertion 2 — three rows, one per evidence entry.
rows=$(wc -l < "${REPORT}" | tr -d ' ')
if [[ "${rows}" != "3" ]]; then
    echo "FAIL: expected 3 rows, got ${rows}" >&2
    cat "${REPORT}" >&2
    exit 1
fi

# Assertion 3 — classification per row matches expectations.
expect_class() {
    local idx="$1" want="$2"
    local got
    got=$(awk -v i="${idx}" 'NR == (i+1) {print; exit}' "${REPORT}" | jq -r .classification)
    if [[ "${got}" != "${want}" ]]; then
        echo "FAIL: row ${idx} classification expected '${want}', got '${got}'" >&2
        exit 1
    fi
}
expect_class 0 idempotent      # bun test
expect_class 1 non_idempotent  # git push ...
expect_class 2 unclassifiable  # some-bespoke-tool

# Assertion 4 — first row's presence check is pass.
p0=$(awk 'NR==1{print; exit}' "${REPORT}" | jq -r .checks.presence)
if [[ "${p0}" != "pass" ]]; then
    echo "FAIL: row 0 presence expected pass, got ${p0}" >&2
    exit 1
fi

# Assertion 5 — report file mode is 0600.
mode=$(stat -f '%Lp' "${REPORT}" 2>/dev/null || stat -c '%a' "${REPORT}" 2>/dev/null)
if [[ "${mode}" != "600" ]]; then
    echo "FAIL: expected mode 600 on report, got ${mode}" >&2
    exit 1
fi

# Assertion 6 — calibration summary on stderr.
if ! grep -q "verification_summary: phase=integration" "${err}"; then
    echo "FAIL: missing calibration summary on stderr" >&2
    cat "${err}" >&2
    exit 1
fi

# Assertion 7 — phase-result envelope is UNCHANGED (log mode).
status=$(jq -r .status "${REQ_DIR}/phase-result-integration.json")
if [[ "${status}" != "pass" ]]; then
    echo "FAIL: envelope status changed in log mode (was 'pass', now '${status}')" >&2
    exit 1
fi

echo "PASS: verifier smoke (3 rows, classifications correct, mode 0600, summary emitted, envelope unchanged)"
