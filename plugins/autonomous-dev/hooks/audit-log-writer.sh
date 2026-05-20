#!/usr/bin/env bash
###############################################################################
# audit-log-writer.sh — Claude SDK PreToolUse hook for the audit-log shim
#
# PLAN-042 Phase A (PRD-024 / TDD-041 §D-05, ADR-041-05).
#
# Reads a PreToolUse hook event from stdin (Claude SDK's hook contract:
# a JSON object with at least `tool_name` and `tool_input`) and, when the
# tool is `Bash`, appends one JSON line to `$AUDIT_LOG_PATH` recording the
# invocation.
#
# Environment (injected by the daemon in spawn-session.sh before claude
# is invoked):
#   AUDIT_LOG_PATH   Absolute path to ${req_dir}/command-audit.jsonl.
#                    The file is created (mode 0600) by the daemon BEFORE
#                    the agent starts; this hook only appends.
#   AUDIT_PHASE      The executor phase name (integration|deploy|test).
#                    Recorded in each row's `phase` field.
#
# Contract:
#   - Non-Bash tool events are ignored (exit 0, no write).
#   - If $AUDIT_LOG_PATH is unset or unwritable, the hook exits 0 silently.
#     We never block tool execution because of an audit-log failure —
#     observability must not break the pipeline.
#   - Output schema per TDD-041 §D-05:
#       {ts, phase, command, argv, cwd, exit_code, duration_ms, source}
#     `exit_code` and `duration_ms` are null in the PreToolUse record
#     (we don't have them yet — that's the trade-off for using PreToolUse;
#     a PostToolUse companion can fill them in a future iteration, but
#     Phase A's contract is "record that the command was attempted").
#   - `source` is `sdk_hook` for the SDK path, `debug_trap` for the
#     fallback bash DEBUG-trap path (separate code path; not in this file).
#
# Append safety: bash's `>>` on a single line is atomic for writes ≤ PIPE_BUF
# (4096 bytes on Linux/macOS). Each JSONL row is well under that. If a row
# ever exceeds PIPE_BUF, we'd need flock(1); not worth the complexity now.
###############################################################################

set -u  # tolerate missing AUDIT_LOG_PATH (we check explicitly)

# Fast path: if no audit log path is configured, do nothing.
log_path="${AUDIT_LOG_PATH:-}"
if [[ -z "${log_path}" ]]; then
    exit 0
fi

# Read the hook event from stdin. Use a small buffer; PreToolUse events
# are typically < 8KB. If stdin is empty (e.g. invoked manually for
# testing), exit cleanly.
event_json=""
if [[ ! -t 0 ]]; then
    event_json="$(cat)"
fi
if [[ -z "${event_json}" ]]; then
    exit 0
fi

# Extract tool_name. If jq is missing or the event isn't JSON, bail out
# silently — we never break the pipeline for an audit-log failure.
tool_name="$(printf '%s' "${event_json}" | jq -r '.tool_name // empty' 2>/dev/null || true)"
if [[ -z "${tool_name}" || "${tool_name}" != "Bash" ]]; then
    exit 0
fi

# Extract the Bash command string and (best-effort) the cwd. The Claude
# SDK's Bash tool input is `{command: "..."}`. Some versions also pass
# `description` and `run_in_background`; we only care about `command`.
command_str="$(printf '%s' "${event_json}" | jq -r '.tool_input.command // ""' 2>/dev/null || true)"
if [[ -z "${command_str}" ]]; then
    # Bash invocation with no command string is weird but not an error;
    # record an empty entry so the count still matches.
    command_str=""
fi

# Build argv as a JSON array. Splitting on whitespace would be wrong for
# anything with quoting; we record the raw command string AND a best-effort
# argv (just the first whitespace-delimited token, useful for the Phase B
# classifier).
first_token="$(printf '%s' "${command_str}" | awk '{print $1}')"

cwd="${PWD}"
ts="$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")"
phase="${AUDIT_PHASE:-unknown}"

# Compose the JSONL row. Use jq -c for compact single-line output and
# proper escaping. The `output_tail` field is included as null because
# PreToolUse fires before execution; PostToolUse would fill it in a
# future iteration (out of scope for Phase A — see file header).
row="$(jq -nc \
    --arg ts "${ts}" \
    --arg phase "${phase}" \
    --arg command "${command_str}" \
    --arg first_token "${first_token}" \
    --arg cwd "${cwd}" \
    '{
        ts: $ts,
        phase: $phase,
        command: $command,
        argv: [$first_token],
        cwd: $cwd,
        exit_code: null,
        duration_ms: null,
        output_tail: null,
        source: "sdk_hook"
    }' 2>/dev/null)"

if [[ -z "${row}" ]]; then
    exit 0
fi

# Append. Suppress errors — observability must not break the pipeline.
printf '%s\n' "${row}" >> "${log_path}" 2>/dev/null || true

exit 0
