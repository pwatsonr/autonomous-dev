#!/usr/bin/env bash
# cli_show_stuck.sh -- `observability show-stuck` verb (REQ-000060 / issue #635)
# Part of TDD: docs/tdd/REQ-000060-req-000060.md §9
#
# Dependencies: jq (1.6+)
# Sources: session_transcript.sh

set -uo pipefail
# NOTE: `-e` is deliberately NOT set at file scope.

# Source shared helpers if not already loaded
if ! declare -F atomic_write_json >/dev/null 2>&1; then
    _OBS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    # shellcheck source=session_transcript.sh
    source "${_OBS_DIR}/session_transcript.sh"
fi

# ---------------------------------------------------------------------------
# cli_show_stuck <path-or-request-id>
#
# Argument: either an absolute path to a snapshot file, OR a REQ-ID
# (matched against .autonomous-dev/requests/<REQ>/, most recent
# session-stuck-*.json wins).
#
# Output: pretty-printed JSON (via `jq .`), with a trailing section:
#     ---
#     RECOVERY HINT: <recovery_hint>
#     ---
#
# Exit codes:
#   0 = printed successfully
#   1 = snapshot not found; message to stderr: "snapshot not found: <path>"
# ---------------------------------------------------------------------------
cli_show_stuck() {
    local arg="${1:-}"

    if [[ -z "$arg" ]]; then
        echo "cli_show_stuck: requires a path or REQ-ID argument" >&2
        return 1
    fi

    local snap_path=""

    # Check if it's an absolute/relative path to an existing file
    if [[ -f "$arg" ]]; then
        snap_path="$arg"
    else
        # Try to find by REQ-ID
        # Determine state dir: env override > CWD walk > HOME fallback.
        local state_dir=""
        if [[ -n "${AUTONOMOUS_DEV_REQUESTS_DIR:-}" ]]; then
            state_dir="${AUTONOMOUS_DEV_REQUESTS_DIR}"
        else
            local search_dir="$PWD"
            while [[ "$search_dir" != "/" ]]; do
                if [[ -d "${search_dir}/.autonomous-dev/requests" ]]; then
                    state_dir="${search_dir}/.autonomous-dev/requests"
                    break
                fi
                search_dir="$(dirname "$search_dir")"
            done
            if [[ -z "$state_dir" ]]; then
                state_dir="${HOME}/.autonomous-dev/requests"
            fi
        fi

        local req_dir="${state_dir}/${arg}"
        if [[ ! -d "$req_dir" ]]; then
            echo "snapshot not found: ${arg}" >&2
            return 1
        fi

        # Find most recent session-stuck-*.json (sort by filename desc)
        local newest
        newest="$(find "$req_dir" -name 'session-stuck-*.json' 2>/dev/null \
            | sort -r | head -1)"
        if [[ -z "$newest" ]]; then
            echo "snapshot not found: ${arg}" >&2
            return 1
        fi
        snap_path="$newest"
    fi

    if [[ ! -f "$snap_path" ]]; then
        echo "snapshot not found: ${arg}" >&2
        return 1
    fi

    # Pretty print
    jq '.' "$snap_path" 2>/dev/null || {
        echo "snapshot not found: ${arg}" >&2
        return 1
    }

    # Print recovery hint section
    local hint
    hint="$(jq -r '.recovery_hint // "(none)"' "$snap_path" 2>/dev/null || echo "(none)")"
    echo "---"
    echo "RECOVERY HINT: ${hint}"
    echo "---"

    return 0
}
