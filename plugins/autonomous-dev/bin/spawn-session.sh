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

# Simple phase budget resolution (mirrors supervisor-loop.sh)
resolve_phase_budget() {
    local phase="${1:-}"
    case "${phase}" in
        intake)                                                       echo "1.0"  ;;
        prd|tdd|plan|spec)                                            echo "5.0"  ;;
        prd_review|tdd_review|plan_review|spec_review|security_review) echo "2.0"  ;;
        code_review)                                                  echo "2.0"  ;;
        code)                                                         echo "10.0" ;;
        deploy)                                                       echo "5.0"  ;;
        *)                                                            echo "5.0"  ;;
    esac
}

# Simple phase prompt resolution (basic fallback)
# NOTE: Duplication with supervisor-loop.sh::resolve_phase_prompt is intentional-for-now
resolve_phase_prompt() {
    local phase="${1:-}"
    local request_id="${2:-}"
    local project="${3:-}"
    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"

    echo "Read your request context from ${state_file}, then perform the ${phase} phase. Write your phase result to phase-result-${phase}.json as JSON."
}

# write_synthesized_phase_result(path, status, error, exit_code) -> void
#   Writes a synthesized phase-result.json when the agent didn't create one.
#   Used as fallback in spawn_session_typed() and by dispatch_phase_session()
#   timeout handling.
write_synthesized_phase_result() {
    local path="$1" status="$2" error_msg="$3" exit_code="${4:-0}"
    local tmp="${path}.tmp.$$"
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    jq -n --arg s "$status" --arg e "$error_msg" --argjson rc "$exit_code" \
        --arg ts "$ts" \
        '{
            status: $s,
            error: $e,
            exit_code: $rc,
            synthesized: true,
            synthesized_at: $ts,
            artifacts: []
        }' > "$tmp"
    mv "$tmp" "$path"
}

# assemble_spawn_command(state_file, target_phase, agent) -> void
#   Writes the assembled command (one line, space-separated) to stdout.
#   Uses corrected claude flags: --print, --add-dir, --max-budget-usd.
#   Pure: does not invoke claude. Used by spawn_session and by the bats
#   snapshot tests.
#
#   Path normalization: when CAPTURE_SPAWN_TO is set, absolute paths are
#   replaced with placeholders for stable snapshots.
assemble_spawn_command() {
    local state_file="$1" target_phase="$2" agent="$3"

    local req_type expedited
    req_type=$(jq -r '.type // "feature"' "${state_file}" 2>/dev/null || echo "feature")
    expedited=$(jq -r '.expedited_reviews // false' "${state_file}" 2>/dev/null || echo "false")

    # Derive request_id and project from state_file path
    local req_dir req_id project
    req_dir=$(dirname "${state_file}")
    req_id=$(basename "${req_dir}")
    project=$(dirname "$(dirname "$(dirname "${req_dir}")")")

    # Resolve phase budget and build phase prompt
    local phase_budget phase_prompt
    phase_budget=$(resolve_phase_budget "${target_phase}")
    phase_prompt=$(resolve_phase_prompt "${target_phase}" "${req_id}" "${project}")

    local -a args=()
    local -a env_prefix=()

    # Rule 2: infra + non-review -> env ENHANCED_GATES=...
    if [[ "${req_type}" == "infra" && "${target_phase}" != *"_review" ]]; then
        local gates="${ENHANCED_GATES_CSV:-${DEFAULT_ENHANCED_GATES}}"
        env_prefix=(env "ENHANCED_GATES=${gates}")
    fi

    # Rule 3: expedited + *_review -> --append-system-prompt
    if [[ "${expedited}" == "true" && "${target_phase}" == *"_review" ]]; then
        args+=(--append-system-prompt "Expedited review: prioritize blocking issues; skip nitpicks.")
    fi

    # Build the corrected claude command
    local -a line=()
    if [[ ${#env_prefix[@]} -gt 0 ]]; then
        line+=("${env_prefix[@]}")
    fi
    line+=(claude --print --output-format json)
    line+=(--agent "${agent}")
    line+=(--add-dir "${req_dir}")
    line+=(--add-dir "${project}")
    line+=(--permission-mode acceptEdits)
    line+=(--max-budget-usd "${phase_budget}")
    if [[ ${#args[@]} -gt 0 ]]; then
        line+=("${args[@]}")
    fi
    line+=("${phase_prompt}")

    # When capturing, normalize paths to placeholders for snapshot stability
    local out=""
    local first=1
    local token
    for token in "${line[@]}"; do
        if [[ -n "${CAPTURE_SPAWN_TO:-}" ]]; then
            local state_dir
            state_dir=$(dirname "${state_file}")
            local project_dir
            project_dir=$(dirname "$(dirname "$(dirname "${state_dir}")")")

            # Replace directory paths with placeholders
            token="${token//${state_dir}/\$\{STATE_DIR\}}"
            token="${token//${project_dir}/\$\{PROJECT_DIR\}}"

            # Replace the prompt text with a placeholder for readability
            # Check if this token contains the prompt (it may be modified by path replacement)
            if [[ "${token}" == *"Read your request context from"* ]]; then
                token="\${PHASE_PROMPT}"
            fi
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

# spawn_session_typed(state_file, target_phase, agent, [prompt_override]) -> int
#   Public entry. When CAPTURE_SPAWN_TO is set, appends the assembled
#   command to that file and returns 0 (test mode). Otherwise execs claude
#   via the corrected flags.
spawn_session_typed() {
    local state_file="$1" target_phase="$2" agent="$3"
    local prompt_override="${4:-}"

    local cmd_line
    cmd_line=$(assemble_spawn_command "${state_file}" "${target_phase}" "${agent}")

    if [[ -n "${CAPTURE_SPAWN_TO:-}" ]]; then
        printf '%s\n' "${cmd_line}" >> "${CAPTURE_SPAWN_TO}"
        return 0
    fi

    # Re-derive the actual (non-normalized) command and exec it
    local req_type expedited
    req_type=$(jq -r '.type // "feature"' "${state_file}" 2>/dev/null || echo "feature")
    expedited=$(jq -r '.expedited_reviews // false' "${state_file}" 2>/dev/null || echo "false")

    # Derive paths and budget
    local req_dir req_id project
    req_dir=$(dirname "${state_file}")
    req_id=$(basename "${req_dir}")
    project=$(dirname "$(dirname "$(dirname "${req_dir}")")")

    local phase_budget phase_prompt
    phase_budget=$(resolve_phase_budget "${target_phase}")
    # Use prompt_override if provided, otherwise use local resolution
    if [[ -n "${prompt_override}" ]]; then
        phase_prompt="${prompt_override}"
    else
        phase_prompt=$(resolve_phase_prompt "${target_phase}" "${req_id}" "${project}")
    fi

    local -a args=()

    # Rule 3: expedited + *_review -> --append-system-prompt
    if [[ "${expedited}" == "true" && "${target_phase}" == *"_review" ]]; then
        args+=(--append-system-prompt "Expedited review: prioritize blocking issues; skip nitpicks.")
    fi

    # Execute corrected claude command
    local exit_code=0
    if [[ "${req_type}" == "infra" && "${target_phase}" != *"_review" ]]; then
        local gates="${ENHANCED_GATES_CSV:-${DEFAULT_ENHANCED_GATES}}"
        env "ENHANCED_GATES=${gates}" claude \
            --print --output-format json \
            --agent "${agent}" \
            --add-dir "${req_dir}" \
            --add-dir "${project}" \
            --permission-mode acceptEdits \
            --max-budget-usd "${phase_budget}" \
            "${args[@]}" \
            "${phase_prompt}" || exit_code=$?
    else
        claude \
            --print --output-format json \
            --agent "${agent}" \
            --add-dir "${req_dir}" \
            --add-dir "${project}" \
            --permission-mode acceptEdits \
            --max-budget-usd "${phase_budget}" \
            "${args[@]}" \
            "${phase_prompt}" || exit_code=$?
    fi

    # Synthesize phase-result.json if agent didn't write one
    local result_path="${req_dir}/phase-result-${target_phase}.json"
    if [[ ! -f "$result_path" ]]; then
        local status error_msg
        if [[ $exit_code -eq 0 ]]; then
            status="pass"
            error_msg=""
        else
            status="fail"
            error_msg="AGENT_EXITED_NONZERO"
        fi
        write_synthesized_phase_result "$result_path" "$status" "$error_msg" "$exit_code"
    fi

    return $exit_code
}

main() {
    if [[ $# -lt 3 ]]; then
        echo "Usage: $(basename "$0") <state-file> <target-phase> <agent> [prompt]" >&2
        exit 2
    fi
    spawn_session_typed "$@"
}

# Allow sourcing for unit tests without executing main.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
