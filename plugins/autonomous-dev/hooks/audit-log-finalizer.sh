#!/usr/bin/env bash
###############################################################################
# audit-log-finalizer.sh — Claude SDK PostToolUse hook for the audit-log shim
#
# REQ-000052 / Issue #617.
#
# Reads a PostToolUse hook event from stdin and:
#   (a) If a matching PreToolUse row exists (by tool_use_id), merges the
#       exit_code / duration_ms / output_tail into that row via atomic rewrite.
#   (b) Otherwise, appends a fresh row with source="sdk_hook_post".
#
# Environment:
#   AUDIT_LOG_PATH   Absolute path to ${req_dir}/command-audit.jsonl.
#   AUDIT_PHASE      The executor phase name (integration|deploy|test).
#
# Contract: exits 0 in ALL cases. Never blocks tool execution.
###############################################################################

set -u

# Fast path: if no audit log path is configured, do nothing.
log_path="${AUDIT_LOG_PATH:-}"
if [[ -z "${log_path}" ]]; then
    exit 0
fi

# Read the hook event from stdin.
event_json=""
if [[ ! -t 0 ]]; then
    event_json="$(cat)"
fi
if [[ -z "${event_json}" ]]; then
    exit 0
fi

# Extract tool_name. Bail on non-Bash events.
tool_name="$(printf '%s' "${event_json}" | jq -r '.tool_name // empty' 2>/dev/null || true)"
if [[ -z "${tool_name}" || "${tool_name}" != "Bash" ]]; then
    exit 0
fi

# If AUDIT_LOG_PATH is unwritable, bail out.
if [[ ! -w "${log_path}" && ! -w "$(dirname "${log_path}")" ]]; then
    exit 0
fi

# Extract fields from the PostToolUse event.
tool_use_id="$(printf '%s' "${event_json}" | jq -r '.tool_use_id // empty' 2>/dev/null || true)"
command_str="$(printf '%s' "${event_json}" | jq -r '.tool_input.command // ""' 2>/dev/null || true)"

# Extract exit_code: prefer .tool_response.exit_code, fall back to is_error.
exit_code_raw="$(printf '%s' "${event_json}" | jq -r '.tool_response.exit_code // empty' 2>/dev/null || true)"
if [[ -z "${exit_code_raw}" ]]; then
    is_error="$(printf '%s' "${event_json}" | jq -r '.tool_response.is_error // empty' 2>/dev/null || true)"
    if [[ "${is_error}" == "true" ]]; then
        exit_code_raw="1"
    elif [[ "${is_error}" == "false" ]]; then
        exit_code_raw="0"
    fi
fi
# Normalise to JSON number or null.
if [[ -n "${exit_code_raw}" && "${exit_code_raw}" =~ ^[0-9]+$ ]]; then
    exit_code_or_null="${exit_code_raw}"
else
    exit_code_or_null="null"
fi

duration_ms_raw="$(printf '%s' "${event_json}" | jq -r '.tool_response.duration_ms // empty' 2>/dev/null || true)"
if [[ -n "${duration_ms_raw}" && "${duration_ms_raw}" =~ ^[0-9]+$ ]]; then
    duration_ms_or_null="${duration_ms_raw}"
else
    duration_ms_or_null="null"
fi

stdout_str="$(printf '%s' "${event_json}" | jq -r '.tool_response.stdout // ""' 2>/dev/null || true)"
stderr_str="$(printf '%s' "${event_json}" | jq -r '.tool_response.stderr // ""' 2>/dev/null || true)"
output_tail="$(printf '%s\n%s' "${stdout_str}" "${stderr_str}" | tail -n 50)"

first_token="$(printf '%s' "${command_str}" | awk '{print $1}')"
ts="$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")"
phase="${AUDIT_PHASE:-unknown}"

# ── Try flock when available ──
_lock_fd=9
_lock_path="${log_path}.lock"

_do_merge() {
    local tmp="${log_path}.tmp.$$"
    chmod 0600 "${tmp}" 2>/dev/null || true
    jq -c \
        --arg id "${tool_use_id}" \
        --argjson ec "${exit_code_or_null}" \
        --argjson dur "${duration_ms_or_null}" \
        --arg tail "${output_tail}" \
        'if .tool_use_id == $id then
            .exit_code = $ec
            | .duration_ms = $dur
            | .output_tail = $tail
            | .source = (.source + "+sdk_hook_post")
         else . end' \
        "${log_path}" > "${tmp}" 2>/dev/null \
    && mv "${tmp}" "${log_path}" 2>/dev/null \
    || rm -f "${tmp}" 2>/dev/null
}

_do_append() {
    local row
    row="$(jq -nc \
        --arg ts "${ts}" \
        --arg phase "${phase}" \
        --arg command "${command_str}" \
        --arg first_token "${first_token}" \
        --arg cwd "${PWD}" \
        --argjson ec "${exit_code_or_null}" \
        --argjson dur "${duration_ms_or_null}" \
        --arg tail "${output_tail}" \
        --arg uid "${tool_use_id}" \
        '{
            ts: $ts,
            phase: $phase,
            command: $command,
            argv: [$first_token],
            cwd: $cwd,
            exit_code: $ec,
            duration_ms: $dur,
            output_tail: $tail,
            source: "sdk_hook_post"
        } + (if $uid == "" then {} else {tool_use_id: $uid} end)' 2>/dev/null)"
    [[ -z "${row}" ]] && return 0
    printf '%s\n' "${row}" >> "${log_path}" 2>/dev/null || true
}

# ── Decide: merge or append ──
_should_merge=0
if [[ -n "${tool_use_id}" && -f "${log_path}" ]]; then
    if grep -q "\"tool_use_id\":\"${tool_use_id}\"" "${log_path}" 2>/dev/null; then
        _should_merge=1
    fi
fi

if command -v flock >/dev/null 2>&1; then
    (
        flock -w 1 9 || true
        if [[ "${_should_merge}" -eq 1 ]]; then
            _do_merge
        else
            _do_append
        fi
    ) 9>> "${_lock_path}" 2>/dev/null || true
else
    if [[ "${_should_merge}" -eq 1 ]]; then
        _do_merge
    else
        _do_append
    fi
fi

exit 0
