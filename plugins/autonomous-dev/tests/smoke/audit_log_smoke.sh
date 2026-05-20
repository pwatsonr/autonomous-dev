#!/usr/bin/env bash
###############################################################################
# audit_log_smoke.sh — PLAN-042 Phase A smoke test
#
# Simulates the daemon-spawned agent loop's audit-log invariants without a
# live `claude` call:
#
#   1. Daemon creates ${req_dir}/command-audit.jsonl with mode 0600.
#   2. The Claude SDK fires PreToolUse events for three Bash invocations
#      (we simulate by piping synthetic event JSON into audit-log-writer.sh
#      three times — exactly what the SDK does in production).
#   3. Verify the log has 3 rows with the expected schema.
#
# Run via:  bash plugins/autonomous-dev/tests/smoke/audit_log_smoke.sh
#
# Exits 0 on pass, non-zero with diagnostic on fail.
###############################################################################

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="${PLUGIN_DIR}/hooks/audit-log-writer.sh"
READER="${PLUGIN_DIR}/lib/verification/audit-log-reader.sh"

TMP="$(mktemp -d -t adv-audit-smoke-XXXXXX)"
trap 'rm -rf "${TMP}"' EXIT
REQ_DIR="${TMP}/.autonomous-dev/requests/REQ-SMOKE"
mkdir -p "${REQ_DIR}"

LOG="${REQ_DIR}/command-audit.jsonl"

# Step 1 — daemon creates the file and locks it down.
: > "${LOG}"
chmod 0600 "${LOG}"

export AUDIT_LOG_PATH="${LOG}"
export AUDIT_PHASE="integration"

# Step 2 — fire three synthetic PreToolUse events for `echo hello`.
for i in 1 2 3; do
    jq -nc --arg cmd "echo hello run-${i}" '{
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: $cmd }
    }' | bash "${HOOK}"
done

# Step 3 — verify.
# shellcheck source=/dev/null
source "${READER}"

count="$(audit_log_count "${REQ_DIR}")"
if [[ "${count}" != "3" ]]; then
    echo "FAIL: expected 3 rows, got ${count}" >&2
    cat "${LOG}" >&2
    exit 1
fi

# Each row well-formed and matches the expected echo command.
for i in 1 2 3; do
    if ! audit_log_has_command "${REQ_DIR}" "echo hello run-${i}"; then
        echo "FAIL: row ${i} missing or wrong command" >&2
        cat "${LOG}" >&2
        exit 1
    fi
done

# Schema spot-check on first row.
first="$(head -n1 "${LOG}")"
for field in ts phase command argv cwd source; do
    if [[ "$(printf '%s' "${first}" | jq -r ".${field} // \"\"")" == "" ]]; then
        echo "FAIL: first row missing field ${field}" >&2
        echo "${first}" >&2
        exit 1
    fi
done

if [[ "$(printf '%s' "${first}" | jq -r '.source')" != "sdk_hook" ]]; then
    echo "FAIL: source != sdk_hook on first row" >&2
    exit 1
fi

# Mode-0600 invariant still holds after writes.
mode="$(stat -f '%Lp' "${LOG}" 2>/dev/null || stat -c '%a' "${LOG}" 2>/dev/null)"
if [[ "${mode}" != "600" ]]; then
    echo "FAIL: expected mode 600, got ${mode}" >&2
    exit 1
fi

echo "PASS: audit log smoke (3 rows, mode 0600, sdk_hook source)"
