#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# spawn-session.sh - Type-Aware Session Spawning Helper
#
# SPEC-018-2-03 Task 5
#
# Assembles and (optionally) executes the `claude` CLI invocation with
# per-type flags injected based on the request's .type and .expedited_reviews
# fields and the target phase. Three injection rules:
#
#   1. type=bug AND target_phase=tdd     -> append --bug-context-path <state>
#   2. type=infra AND target_phase != *_review
#                                        -> prefix env ENHANCED_GATES=<csv>
#   3. expedited_reviews=true AND target_phase ends with _review
#                                        -> append --expedited
#
# When CAPTURE_SPAWN_TO is set, the assembled command line is written to
# that file (one logical command per line, with paths normalized to the
# ${STATE_DIR} placeholder) and `claude` is NOT invoked. This is the seam
# the bats snapshot tests in test_spawn_session_flags.bats hook into.
#
# Usage:
#   spawn-session.sh <state-file> <target-phase> <agent>
#
# Environment:
#   CAPTURE_SPAWN_TO   Optional path; when set, write the assembled command
#                      line here instead of executing claude.
#   ENHANCED_GATES_CSV Override the default infra gate list. Default:
#                      "security_review,cost_analysis,rollback_plan"
#                      (alphabetically sorted for deterministic snapshots).
###############################################################################

DEFAULT_ENHANCED_GATES="security_review,cost_analysis,rollback_plan"

# assemble_spawn_command(state_file, target_phase, agent) -> void
#   Writes the assembled command (one line, space-separated) to stdout.
#   Pure: does not invoke claude. Used by spawn_session and by the bats
#   snapshot tests.
#
#   Path normalization: when CAPTURE_SPAWN_TO is set, the absolute state
#   directory is replaced with the literal "${STATE_DIR}" so committed
#   snapshots are stable across hosts.
assemble_spawn_command() {
    local state_file="$1" target_phase="$2" agent="$3"

    local req_type expedited
    req_type=$(jq -r '.type // "feature"' "${state_file}" 2>/dev/null || echo "feature")
    expedited=$(jq -r '.expedited_reviews // false' "${state_file}" 2>/dev/null || echo "false")

    local -a args=()
    local -a env_prefix=()

    # Rule 1: bug + tdd -> --bug-context-path
    if [[ "${req_type}" == "bug" && "${target_phase}" == "tdd" ]]; then
        args+=(--bug-context-path "${state_file}")
    fi

    # Rule 3: expedited + *_review -> --expedited
    if [[ "${expedited}" == "true" && "${target_phase}" == *"_review" ]]; then
        args+=(--expedited)
    fi

    # Rule 2: infra + non-review -> env ENHANCED_GATES=...
    if [[ "${req_type}" == "infra" && "${target_phase}" != *"_review" ]]; then
        local gates="${ENHANCED_GATES_CSV:-${DEFAULT_ENHANCED_GATES}}"
        env_prefix=(env "ENHANCED_GATES=${gates}")
    fi

    # Build the line. Order: env-prefix, then `claude --agent <agent>`,
    # then per-type flags, then --state <state>.
    local -a line=()
    if [[ ${#env_prefix[@]} -gt 0 ]]; then
        line+=("${env_prefix[@]}")
    fi
    line+=(claude --agent "${agent}")
    if [[ ${#args[@]} -gt 0 ]]; then
        line+=("${args[@]}")
    fi
    line+=(--state "${state_file}")

    # When capturing, normalize the absolute state directory to ${STATE_DIR}
    # for snapshot stability.
    local out=""
    local first=1
    local token
    for token in "${line[@]}"; do
        if [[ -n "${CAPTURE_SPAWN_TO:-}" ]]; then
            local state_dir
            state_dir=$(dirname "${state_file}")
            # Replace ONLY the directory prefix, leaving the basename intact.
            token="${token//${state_dir}/\$\{STATE_DIR\}}"
        fi
        if [[ ${first} -eq 1 ]]; then
            out="${token}"
            first=0
        else
            out="${out} ${token}"
        fi
    done

    printf '%s\n' "${out}"
}

# spawn_session_typed(state_file, target_phase, agent) -> int
#   Public entry. When CAPTURE_SPAWN_TO is set, appends the assembled
#   command to that file and returns 0 (test mode). Otherwise execs claude
#   via the assembled prefix and arguments.
spawn_session_typed() {
    local state_file="$1" target_phase="$2" agent="$3"

    local cmd_line
    cmd_line=$(assemble_spawn_command "${state_file}" "${target_phase}" "${agent}")

    if [[ -n "${CAPTURE_SPAWN_TO:-}" ]]; then
        printf '%s\n' "${cmd_line}" >> "${CAPTURE_SPAWN_TO}"
        return 0
    fi

    # Re-derive the actual (non-normalized) command and exec it. We rebuild
    # rather than parsing the captured string to avoid round-tripping
    # whitespace-sensitive arguments through a string split.
    local req_type expedited
    req_type=$(jq -r '.type // "feature"' "${state_file}" 2>/dev/null || echo "feature")
    expedited=$(jq -r '.expedited_reviews // false' "${state_file}" 2>/dev/null || echo "false")

    local -a args=()
    if [[ "${req_type}" == "bug" && "${target_phase}" == "tdd" ]]; then
        args+=(--bug-context-path "${state_file}")
    fi
    if [[ "${expedited}" == "true" && "${target_phase}" == *"_review" ]]; then
        args+=(--expedited)
    fi

    if [[ "${req_type}" == "infra" && "${target_phase}" != *"_review" ]]; then
        local gates="${ENHANCED_GATES_CSV:-${DEFAULT_ENHANCED_GATES}}"
        env "ENHANCED_GATES=${gates}" claude --agent "${agent}" "${args[@]}" --state "${state_file}"
    else
        claude --agent "${agent}" "${args[@]}" --state "${state_file}"
    fi
}

main() {
    if [[ $# -lt 3 ]]; then
        echo "Usage: $(basename "$0") <state-file> <target-phase> <agent>" >&2
        exit 2
    fi
    spawn_session_typed "$@"
}

# Allow sourcing for unit tests without executing main.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
