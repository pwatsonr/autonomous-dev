#!/usr/bin/env bash
# cli_list_stuck.sh -- `observability list-stuck` verb (REQ-000060 / issue #635)
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
# cli_list_stuck [--request REQ] [--since ISO] [--json]
#
# Enumerates every `<project>/.autonomous-dev/requests/*/session-stuck-*.json`.
# Sorts DESC by captured_at.
#
# Filters:
#   --request REQ     limit to a single request directory
#   --since ISO       drop rows whose captured_at < ISO
#
# Output modes:
#   default: table
#   --json:  single JSON array
#
# Exit codes:
#   0 = success (empty listing is not an error)
# ---------------------------------------------------------------------------
cli_list_stuck() {
    local filter_request=""
    local filter_since=""
    local json_mode=0

    # Parse args
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --request)
                filter_request="${2:-}"
                shift 2
                ;;
            --request=*)
                filter_request="${1#--request=}"
                shift
                ;;
            --since)
                filter_since="${2:-}"
                shift 2
                ;;
            --since=*)
                filter_since="${1#--since=}"
                shift
                ;;
            --json)
                json_mode=1
                shift
                ;;
            *)
                echo "cli_list_stuck: unknown argument: $1" >&2
                shift
                ;;
        esac
    done

    # Determine state dir: env override > CWD walk > HOME fallback.
    # AUTONOMOUS_DEV_REQUESTS_DIR lets tests (and operators) pin the path.
    local state_dir=""
    if [[ -n "${AUTONOMOUS_DEV_REQUESTS_DIR:-}" ]]; then
        state_dir="${AUTONOMOUS_DEV_REQUESTS_DIR}"
    else
        # Walk up from CWD to find .autonomous-dev
        local search_dir="$PWD"
        while [[ "$search_dir" != "/" ]]; do
            if [[ -d "${search_dir}/.autonomous-dev/requests" ]]; then
                state_dir="${search_dir}/.autonomous-dev/requests"
                break
            fi
            search_dir="$(dirname "$search_dir")"
        done

        # Fallback: use HOME/.autonomous-dev
        if [[ -z "$state_dir" ]]; then
            state_dir="${HOME}/.autonomous-dev/requests"
        fi
    fi

    # Collect all snapshot files
    local -a snap_files=()
    if [[ -n "$filter_request" ]]; then
        local req_dir="${state_dir}/${filter_request}"
        if [[ -d "$req_dir" ]]; then
            while IFS= read -r -d '' f; do
                snap_files+=("$f")
            done < <(find "$req_dir" -name 'session-stuck-*.json' -print0 2>/dev/null || true)
        fi
    else
        if [[ -d "$state_dir" ]]; then
            while IFS= read -r -d '' f; do
                snap_files+=("$f")
            done < <(find "$state_dir" -name 'session-stuck-*.json' -print0 2>/dev/null || true)
        fi
    fi

    if [[ "${#snap_files[@]}" -eq 0 ]]; then
        if [[ "$json_mode" == "1" ]]; then
            echo "[]"
        else
            echo "No stuck sessions found."
        fi
        return 0
    fi

    # Build array of parsed entries, sorted by captured_at DESC
    local -a entries=()
    for snap in "${snap_files[@]}"; do
        local entry
        entry="$(jq -c \
            --arg path "$snap" \
            '{
              path: $path,
              request_id: (.request_id // "unknown"),
              phase: (.phase // "unknown"),
              mode: (.mode // "unknown"),
              reason: (.reason // "unknown"),
              captured_at: (.captured_at // ""),
              recovery_hint: (.recovery_hint // null),
              schema_version: (.schema_version // 1)
            }' "$snap" 2>/dev/null)" || continue
        # Apply since filter
        if [[ -n "$filter_since" ]]; then
            local cap_at
            cap_at="$(echo "$entry" | jq -r '.captured_at' 2>/dev/null || echo "")"
            if [[ "$cap_at" < "$filter_since" ]]; then
                continue
            fi
        fi
        entries+=("$entry")
    done

    if [[ "${#entries[@]}" -eq 0 ]]; then
        if [[ "$json_mode" == "1" ]]; then
            echo "[]"
        else
            echo "No stuck sessions found."
        fi
        return 0
    fi

    # Sort by captured_at DESC using jq
    local all_json
    all_json="$(printf '%s\n' "${entries[@]}" | jq -sc 'sort_by(.captured_at) | reverse' 2>/dev/null \
        || printf '%s\n' "${entries[@]}" | jq -sc '.' 2>/dev/null \
        || echo "[]")"

    if [[ "$json_mode" == "1" ]]; then
        echo "$all_json"
        return 0
    fi

    # Table output
    printf '%-14s  %-12s  %-10s  %-22s  %-28s  %s\n' \
        "REQUEST_ID" "PHASE" "MODE" "REASON" "CAPTURED_AT" "RECOVERY_HINT"
    printf '%-14s  %-12s  %-10s  %-22s  %-28s  %s\n' \
        "--------------" "------------" "----------" "----------------------" "----------------------------" "--------------"

    echo "$all_json" | jq -r '.[] |
        [
          .request_id,
          .phase,
          .mode,
          .reason,
          .captured_at,
          (.recovery_hint // "" | .[0:40])
        ] | @tsv' 2>/dev/null \
    | while IFS=$'\t' read -r req_id phase mode reason captured_at hint; do
        printf '%-14s  %-12s  %-10s  %-22s  %-28s  %s\n' \
            "$req_id" "$phase" "$mode" "$reason" "$captured_at" "$hint"
    done

    return 0
}
