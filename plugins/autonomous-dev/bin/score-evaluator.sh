#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# score-evaluator.sh - Review-Phase Score Evaluator (flag plumbing)
#
# SPEC-018-2-01 Task 2 (initial flag plumbing)
# SPEC-019-4-02 Task 3 (reviewer-slot bridge: --gate flag + multi-reviewer
#                       minimum check via the TS HookRegistry)
#
# The supervisor invokes this script at every *_review phase. It accepts a
# --strict-mode flag (forwarded by the supervisor when the current phase is
# in type_config.enhancedPhases) and a state file path.
#
# When --gate <gate> and --min <n> are provided, the script also consults
# the TS HookRegistry via `node bin/lib/aggregate-cli.js` to count the
# reviewer slots registered for the gate. If the count is below --min, a
# `reviewer-minimum-fallback` notice is printed (the supervisor's caller
# wires this to the actual built-in fallback path; the bash evaluator no
# longer hard-codes a built-in-only path).
#
# Usage: score-evaluator.sh [--strict-mode] [--gate <gate>] [--min <n>] <state-file>
###############################################################################

STRICT_MODE=false
STATE_FILE=""
GATE=""
MIN_REVIEWERS=""

usage() {
    cat <<EOF
Usage: $(basename "$0") [--strict-mode] [--gate <gate>] [--min <n>] <state-file>

Options:
  --strict-mode    Apply tighter review thresholds (wired in a future plan).
  --gate <gate>    Review gate name (e.g. code-review). When set, the script
                   consults the TS HookRegistry via the aggregate-cli bridge
                   to count registered reviewers and emit a fallback notice
                   if fewer than --min are registered.
  --min <n>        Minimum reviewers required for --gate before the built-in
                   fallback is announced. Defaults to 2 when --gate is set.
  -h, --help       Show this help.
EOF
}

# parse_args(args...) -> void
#   Minimal positional parser. Recognises --strict-mode anywhere; the first
#   non-flag positional is treated as the state file path.
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --strict-mode)
                STRICT_MODE=true
                shift
                ;;
            --gate)
                if [[ $# -lt 2 ]]; then
                    echo "ERROR: --gate requires a value" >&2
                    exit 2
                fi
                GATE="$2"
                shift 2
                ;;
            --min)
                if [[ $# -lt 2 ]]; then
                    echo "ERROR: --min requires a value" >&2
                    exit 2
                fi
                MIN_REVIEWERS="$2"
                shift 2
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            --)
                shift
                if [[ $# -gt 0 ]]; then
                    STATE_FILE="$1"
                fi
                return 0
                ;;
            -*)
                echo "ERROR: Unknown flag: $1" >&2
                usage >&2
                exit 2
                ;;
            *)
                if [[ -z "${STATE_FILE}" ]]; then
                    STATE_FILE="$1"
                fi
                shift
                ;;
        esac
    done
}

main() {
    parse_args "$@"

    if [[ -z "${STATE_FILE}" ]]; then
        echo "ERROR: state file argument is required" >&2
        usage >&2
        exit 2
    fi

    if [[ ! -f "${STATE_FILE}" ]]; then
        echo "ERROR: state file not found: ${STATE_FILE}" >&2
        exit 2
    fi

    if ! jq empty "${STATE_FILE}" >/dev/null 2>&1; then
        echo "ERROR: state file is not valid JSON: ${STATE_FILE}" >&2
        exit 2
    fi

    # Flag plumbing only: real scoring rubric arrives in a future plan.
    # Emit a single-line log so operators can confirm the flag arrived.
    if [[ "${STRICT_MODE}" == "true" ]]; then
        printf 'score-evaluator: state=%s strict_mode=true\n' "${STATE_FILE}"
    else
        printf 'score-evaluator: state=%s strict_mode=false\n' "${STATE_FILE}"
    fi

    # SPEC-019-4-02: reviewer-slot bridge. When --gate is set, ask the TS
    # registry how many reviewers are registered for the gate; if fewer
    # than --min, announce that the built-in fallback should be used. The
    # bash evaluator no longer assumes built-in is the only path.
    if [[ -n "${GATE}" ]]; then
        local min="${MIN_REVIEWERS:-2}"
        local script_dir
        script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        local bridge="${script_dir}/lib/aggregate-cli.js"
        if [[ -f "${bridge}" ]] && command -v node >/dev/null 2>&1; then
            local count
            count="$(node "${bridge}" --count --gate "${GATE}" 2>/dev/null || echo "0")"
            if (( count < min )); then
                printf 'reviewer-minimum-fallback gate=%s registered=%s required=%s\n' \
                    "${GATE}" "${count}" "${min}" >&2
            fi
        else
            # Bridge not built; degrade gracefully — operator will see the
            # warning but the supervisor still proceeds with built-in only.
            printf 'reviewer-minimum-fallback gate=%s registered=0 required=%s (bridge not available)\n' \
                "${GATE}" "${min}" >&2
        fi
    fi

    exit 0
}

# Allow sourcing for unit tests without executing main.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
