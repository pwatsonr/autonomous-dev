#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# score-evaluator.sh - Review-Phase Score Evaluator (flag plumbing)
#
# SPEC-018-2-01 Task 2
#
# The supervisor invokes this script at every *_review phase. It accepts a
# --strict-mode flag (forwarded by the supervisor when the current phase is
# in type_config.enhancedPhases) and a state file path. The strict-mode
# rubric itself is OUT of scope for this spec — only flag plumbing — but the
# script must accept the flag and exit 0 on a valid state file so the
# supervisor pipeline does not break.
#
# Future plans (e.g., PRD-004 reviewer-config) add the actual differential
# scoring behaviour. This file is the seam.
#
# Usage: score-evaluator.sh [--strict-mode] <state-file>
###############################################################################

STRICT_MODE=false
STATE_FILE=""

usage() {
    cat <<EOF
Usage: $(basename "$0") [--strict-mode] <state-file>

Options:
  --strict-mode   Apply tighter review thresholds (wired in a future plan).
  -h, --help      Show this help.
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

    exit 0
}

# Allow sourcing for unit tests without executing main.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
