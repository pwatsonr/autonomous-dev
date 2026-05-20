#!/usr/bin/env bash
###############################################################################
# audit-log-reader.sh — read interface for ${req_dir}/command-audit.jsonl.
#
# PLAN-042 Phase A — task T-042-A-05.
#
# Phase A produces the audit log via plugins/autonomous-dev/hooks/audit-log-
# writer.sh. Phase B will consume it via the helpers below. Phase A itself
# uses these helpers only for the bats tests and the smoke script; the
# daemon's enforcement chain does not call them in Phase A (per PLAN-042
# "no behavior change").
#
# Public functions:
#
#   audit_log_path(req_dir) -> stdout
#     Echoes ${req_dir}/command-audit.jsonl. Exists primarily as the single
#     source of truth for the filename so spawn-session.sh, the hook, and
#     Phase B all agree.
#
#   audit_log_exists(req_dir) -> 0 | 1
#     Returns 0 if the audit log file exists (even if empty), 1 otherwise.
#
#   audit_log_count(req_dir) -> stdout
#     Echoes the number of JSONL rows in the file. Echoes 0 if missing.
#
#   audit_log_entries(req_dir, [phase]) -> stdout
#     Streams the JSONL rows. If `phase` is supplied, filters to rows whose
#     `.phase` matches. Output is the raw JSONL (one object per line),
#     suitable for piping into jq.
#
#   audit_log_has_command(req_dir, command, [exit_code]) -> 0 | 1
#     Returns 0 if at least one row's `.command` field exact-matches the
#     given command string. If exit_code is supplied AND not "any", also
#     requires `.exit_code` to match (note: Phase A's PreToolUse-only hook
#     leaves exit_code null, so the exit_code check is forward-compat for
#     Phase B's PostToolUse companion).
#
# Source-only (no main): callers `source` this file and invoke the
# functions directly. No global state.
###############################################################################

audit_log_path() {
    local req_dir="$1"
    printf '%s/command-audit.jsonl' "${req_dir}"
}

audit_log_exists() {
    local req_dir="$1"
    local path
    path="$(audit_log_path "${req_dir}")"
    [[ -f "${path}" ]]
}

audit_log_count() {
    local req_dir="$1"
    local path
    path="$(audit_log_path "${req_dir}")"
    if [[ ! -f "${path}" ]]; then
        printf '0\n'
        return 0
    fi
    # Count non-empty lines. wc -l counts newlines; if the last row has no
    # trailing newline (writer crash mid-write) we'd under-count by one,
    # but our writer always emits `\n`. awk handles both empty files and
    # trailing-newline-missing cases cleanly without needing the
    # error-suppression dance grep -c requires.
    local n
    n=$(awk 'NF>0 { c++ } END { printf "%d", c+0 }' "${path}" 2>/dev/null)
    printf '%s\n' "${n:-0}"
}

audit_log_entries() {
    local req_dir="$1"
    local phase="${2:-}"
    local path
    path="$(audit_log_path "${req_dir}")"
    if [[ ! -f "${path}" ]]; then
        return 0
    fi
    if [[ -z "${phase}" ]]; then
        cat "${path}"
    else
        # Filter rows by phase via jq. -c keeps single-line output.
        jq -c --arg p "${phase}" 'select(.phase == $p)' "${path}" 2>/dev/null || true
    fi
}

audit_log_has_command() {
    local req_dir="$1"
    local needle="$2"
    local want_exit="${3:-any}"
    local path
    path="$(audit_log_path "${req_dir}")"
    if [[ ! -f "${path}" ]]; then
        return 1
    fi
    local hit
    if [[ "${want_exit}" == "any" ]]; then
        hit=$(jq -r --arg c "${needle}" \
            'select(.command == $c) | .command' "${path}" 2>/dev/null | head -n1)
    else
        hit=$(jq -r --arg c "${needle}" --argjson e "${want_exit}" \
            'select(.command == $c and .exit_code == $e) | .command' \
            "${path}" 2>/dev/null | head -n1)
    fi
    [[ -n "${hit}" ]]
}
