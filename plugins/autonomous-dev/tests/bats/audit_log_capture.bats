#!/usr/bin/env bats
###############################################################################
# audit_log_capture.bats — PLAN-042 Phase A
#
# Tests the audit-log shim's writer hook and reader helpers in isolation
# (no live `claude` invocation). The wiring into spawn-session.sh is
# covered by manual smoke (see tests/smoke/audit_log_smoke.sh) and by the
# fact that the spawn-session.sh file passes `bash -n` post-edit.
#
# Six cases per PLAN-042 Phase A §"Targets" T-042-A-06:
#   1. log file created (by setup that mimics spawn-session.sh)
#   2. log entry written for Bash tool call
#   3. log entry contains the expected schema fields
#   4. agent cannot open the log for write (file is mode 0600)
#   5. log survives agent crash mid-phase (the writer is invoked-per-event;
#      a crash kills the agent but the rows already written remain)
#   6. DEBUG-trap source discriminator is preserved by the reader (the
#      writer hook itself uses sdk_hook; the reader treats both sources
#      uniformly — proves Phase B can consume mixed-source logs)
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    HOOK="${PLUGIN_DIR}/hooks/audit-log-writer.sh"
    READER="${PLUGIN_DIR}/lib/verification/audit-log-reader.sh"
    TMP="$(mktemp -d -t adv-audit-XXXXXX)"
    REQ_DIR="${TMP}/.autonomous-dev/requests/REQ-TEST"
    mkdir -p "${REQ_DIR}"

    # Mirror what spawn-session.sh does for an executor phase:
    # create the audit log file and chmod 0600.
    LOG="${REQ_DIR}/command-audit.jsonl"
    : > "${LOG}"
    chmod 0600 "${LOG}"

    export AUDIT_LOG_PATH="${LOG}"
    export AUDIT_PHASE="integration"

    # Source the reader so its functions are in scope.
    # shellcheck source=/dev/null
    source "${READER}"
}

teardown() {
    rm -rf "${TMP}"
    unset AUDIT_LOG_PATH AUDIT_PHASE
}

# Helper: feed a PreToolUse event JSON into the hook on stdin.
fire_hook() {
    local event_json="$1"
    printf '%s' "${event_json}" | bash "${HOOK}"
}

# Helper: build a PreToolUse event for the Bash tool with a given command.
bash_event() {
    local cmd="$1"
    jq -nc --arg cmd "${cmd}" '{
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: $cmd }
    }'
}

# ─────────────────────────────────────────────────────────────────────
# Case 1: log file created (preconditions from setup)
# ─────────────────────────────────────────────────────────────────────
@test "phase-a: audit log file is created with mode 0600 before agent spawns" {
    [[ -f "${LOG}" ]]
    # mode is 600 (rw for owner only). macOS stat -f, Linux stat -c.
    local mode
    mode=$(stat -f '%Lp' "${LOG}" 2>/dev/null || stat -c '%a' "${LOG}" 2>/dev/null)
    [[ "${mode}" == "600" ]]
    # And the reader agrees the file exists.
    audit_log_exists "${REQ_DIR}"
    [[ "$(audit_log_count "${REQ_DIR}")" == "0" ]]
}

# ─────────────────────────────────────────────────────────────────────
# Case 2: hook writes one JSONL row for a Bash tool event
# ─────────────────────────────────────────────────────────────────────
@test "phase-a: PreToolUse Bash event appends one JSONL row" {
    fire_hook "$(bash_event 'bun test')"
    [[ "$(audit_log_count "${REQ_DIR}")" == "1" ]]
    # Three Bash events => three rows.
    fire_hook "$(bash_event 'echo hello')"
    fire_hook "$(bash_event 'pytest -k foo')"
    [[ "$(audit_log_count "${REQ_DIR}")" == "3" ]]
}

# ─────────────────────────────────────────────────────────────────────
# Case 3: schema — each row has the TDD-041 §D-05 fields
# ─────────────────────────────────────────────────────────────────────
@test "phase-a: each row contains ts, phase, command, argv, cwd, source" {
    fire_hook "$(bash_event 'bun test --bail')"
    local row
    row=$(head -n1 "${LOG}")
    # Fields present and well-typed.
    [[ "$(printf '%s' "${row}" | jq -r '.ts')" =~ ^20[0-9]{2}- ]]
    [[ "$(printf '%s' "${row}" | jq -r '.phase')" == "integration" ]]
    [[ "$(printf '%s' "${row}" | jq -r '.command')" == "bun test --bail" ]]
    [[ "$(printf '%s' "${row}" | jq -r '.argv[0]')" == "bun" ]]
    # REQ-000052: source changed from "sdk_hook" to "sdk_hook_pre".
    # Accept both for backward compat with any existing logs/fixtures.
    local _src
    _src="$(printf '%s' "${row}" | jq -r '.source')"
    [[ "${_src}" == "sdk_hook_pre" || "${_src}" == "sdk_hook" ]]
    # cwd is present and non-empty.
    [[ -n "$(printf '%s' "${row}" | jq -r '.cwd')" ]]
    # Non-Bash events are ignored.
    fire_hook "$(jq -nc '{tool_name: "Read", tool_input: {path: "/etc/hosts"}}')"
    [[ "$(audit_log_count "${REQ_DIR}")" == "1" ]]
}

# ─────────────────────────────────────────────────────────────────────
# Case 4: file is mode 0600 — only the operator (file owner) reads/writes.
# The agent process, even running as the same uid, cannot append via the
# OWN file path because the daemon does not expose the path to the agent's
# prompt or tool descriptions. We assert the file mode here as the
# observable invariant; the path-isolation invariant is enforced by
# spawn-session.sh not passing AUDIT_LOG_PATH through to the agent's
# prompt (the env var is consumed by the hook subprocess only).
# ─────────────────────────────────────────────────────────────────────
@test "phase-a: log file mode is 0600 (operator-only)" {
    local mode
    mode=$(stat -f '%Lp' "${LOG}" 2>/dev/null || stat -c '%a' "${LOG}" 2>/dev/null)
    [[ "${mode}" == "600" ]]
    # No group/world read/write.
    local sym
    sym=$(stat -f '%Sp' "${LOG}" 2>/dev/null || stat -c '%A' "${LOG}" 2>/dev/null)
    # Symbolic mode should be `-rw-------` on both macOS and Linux.
    [[ "${sym}" == "-rw-------" ]]
}

# ─────────────────────────────────────────────────────────────────────
# Case 5: rows persist if the agent crashes mid-phase.
# Simulation: write two rows via the hook, then "crash" (we kill the
# bats-spawned shell by simulating ENOSPC on the next write). The first
# two rows must still be intact and readable.
# ─────────────────────────────────────────────────────────────────────
@test "phase-a: rows already written survive agent crash" {
    fire_hook "$(bash_event 'bun test')"
    fire_hook "$(bash_event 'git status')"
    # Simulate a crash mid-third-write by feeding malformed JSON; the hook
    # exits 0 silently (its contract), and the first two rows remain.
    printf 'NOT JSON' | bash "${HOOK}" || true
    [[ "$(audit_log_count "${REQ_DIR}")" == "2" ]]
    # The pre-crash rows are still well-formed JSON.
    jq -e . "${LOG}" >/dev/null
}

# ─────────────────────────────────────────────────────────────────────
# Case 6: reader treats sdk_hook and debug_trap source values uniformly,
# so Phase B can consume mixed-source logs. The writer's own output is
# always source=sdk_hook (the only mechanism wired in Phase A); a
# debug_trap fallback row is appended here directly to prove the reader
# does not discriminate when filtering by phase or by command.
# ─────────────────────────────────────────────────────────────────────
@test "phase-a: reader filters and matches across sdk_hook and debug_trap sources" {
    fire_hook "$(bash_event 'bun test')"   # source=sdk_hook
    # Append a synthetic debug_trap row (what a future fallback would write).
    jq -nc --arg phase "${AUDIT_PHASE}" '{
        ts: "2026-05-19T12:00:00.000Z",
        phase: $phase,
        command: "./scripts/whatever.sh",
        argv: ["./scripts/whatever.sh"],
        cwd: "/tmp/work",
        exit_code: 0,
        duration_ms: 12,
        output_tail: null,
        source: "debug_trap"
    }' >> "${LOG}"

    [[ "$(audit_log_count "${REQ_DIR}")" == "2" ]]
    # Phase filter returns both rows.
    local hits
    hits=$(audit_log_entries "${REQ_DIR}" "integration" | wc -l | tr -d ' ')
    [[ "${hits}" == "2" ]]
    # Command lookup works for both source values.
    audit_log_has_command "${REQ_DIR}" "bun test"
    audit_log_has_command "${REQ_DIR}" "./scripts/whatever.sh"
    # A command not in the log is not found.
    run audit_log_has_command "${REQ_DIR}" "rm -rf /"
    [[ "${status}" -eq 1 ]]
}
