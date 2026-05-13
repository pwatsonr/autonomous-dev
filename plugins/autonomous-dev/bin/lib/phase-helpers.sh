#!/usr/bin/env bash

###############################################################################
# phase-helpers.sh - Shared phase prompt and budget resolution functions
#
# Extracted from supervisor-loop.sh and spawn-session.sh per FR-020-10b
# to eliminate duplication. The canonical implementations live here.
###############################################################################

# resolve_phase_budget(phase: string) -> string
#   Determines the budget (USD) for a given phase. Checks the effective config
#   for a phase-specific override first; falls back to built-in defaults.
#
#   Note: This function expects EFFECTIVE_CONFIG to be set in the environment
#   (as it is in supervisor-loop.sh). If not set, falls back to defaults only.
#
# Arguments:
#   $1 -- phase: The current phase name (e.g., "code", "intake").
#
# Stdout:
#   Budget amount as string (e.g., "10.0").
resolve_phase_budget() {
    local phase="${1:-}"

    local budget
    if [[ -n "${EFFECTIVE_CONFIG:-}" && -f "${EFFECTIVE_CONFIG}" ]]; then
        budget=$(jq -r ".daemon.max_budget_usd_by_phase.\"${phase}\" // null" "${EFFECTIVE_CONFIG}" 2>/dev/null || echo "null")
    else
        budget="null"
    fi

    if [[ "${budget}" == "null" || -z "${budget}" ]]; then
        case "${phase}" in
            intake)                                                       budget="1.0"  ;;
            prd|tdd|plan|spec)                                            budget="5.0"  ;;
            prd_review|tdd_review|plan_review|spec_review|security_review) budget="2.0"  ;;
            code_review)                                                  budget="2.0"  ;;
            code)                                                         budget="10.0" ;;
            integration)                                                  budget="5.0"  ;;
            deploy)                                                       budget="5.0"  ;;
            monitor)                                                      budget="2.0"  ;;
            *)                                                            budget="5.0"  ;;
        esac
    fi

    echo "${budget}"
}

# resolve_phase_prompt(phase: string, request_id: string, project: string) -> string
#   Looks up the phase-specific prompt template and performs variable
#   substitution. Falls back to a generic prompt when no template exists.
#   For code phase, appends branch/commit/PR instructions.
#
# Arguments:
#   $1 -- phase:      Current phase (e.g., "intake", "code", "prd_review").
#   $2 -- request_id: The request ID (e.g., "REQ-20260408-abcd").
#   $3 -- project:    Absolute path to the project/repository root.
#
# Stdout:
#   The resolved prompt string.
resolve_phase_prompt() {
    local phase="${1:-}"
    local request_id="${2:-}"
    local project="${3:-}"

    # Determine plugin directory relative to this lib file
    local plugin_dir
    plugin_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

    local prompt_file="${plugin_dir}/phase-prompts/${phase}.md"
    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"

    local base_prompt=""
    if [[ -f "${prompt_file}" ]]; then
        local prompt_template
        prompt_template=$(cat "${prompt_file}")

        base_prompt="${prompt_template}"
        base_prompt="${base_prompt//\{\{REQUEST_ID\}\}/${request_id}}"
        base_prompt="${base_prompt//\{\{PROJECT\}\}/${project}}"
        base_prompt="${base_prompt//\{\{STATE_FILE\}\}/${state_file}}"
        base_prompt="${base_prompt//\{\{PHASE\}\}/${phase}}"
    else
        local req_dir="${project}/.autonomous-dev/requests/${request_id}"
        base_prompt="You are an autonomous development agent working on request ${request_id}.

Your current phase is: ${phase}

Read the request state file at: ${state_file}
Read the project context at: ${project}

Perform the work required for the '${phase}' phase as described in the state file.

When you finish, write \`${req_dir}/phase-result-${phase}.json\` = \`{ \"status\": \"pass\" | \"fail\", \"phase\": \"${phase}\", \"feedback\": \"<short summary; for a review, the verdict + any blocking findings>\", \"artifacts\": [ { \"kind\": \"...\", \"path\": \"...\", \"title\": \"...\" } ] }\`.

**Do NOT modify \`current_phase\` or \`status\` in \`${state_file}\` — the daemon owns all phase transitions.** You MAY append an entry to \`phase_history[]\` and set \`current_phase_metadata.${phase}_completed_at\`, but never change \`current_phase\`. If you hit an error you can't resolve, still write \`phase-result-${phase}.json\` with \`\"status\": \"fail\"\` and the error in \`\"feedback\"\`."

        # Use log_info if available (from supervisor-loop.sh context)
        if declare -F log_info >/dev/null 2>&1; then
            log_info "No prompt file for phase '${phase}'. Using fallback prompt."
        fi
    fi

    # Add code-phase specific instructions
    if [[ "${phase}" == "code" ]]; then
        # Validate request_id first (if validate_request_id function is available)
        if declare -F validate_request_id >/dev/null 2>&1; then
            if ! validate_request_id "${request_id}"; then
                if declare -F log_error >/dev/null 2>&1; then
                    log_error "Invalid request_id for code phase: ${request_id}"
                fi
                echo "ERROR: Invalid request_id format"
                return 1
            fi
        fi

        local code_instructions="

## Branch and PR Instructions

1. Create a branch named 'autonomous/${request_id}' (single-quoted in any shell command):
   git checkout -b 'autonomous/${request_id}'

2. Make commits using Conventional Commits format (feat:, fix:, docs:, etc.).

3. When implementation is done, create a PR:
   gh pr create --base main --head 'autonomous/${request_id}' --title <conventional-title> --body <summary>

4. Write the resulting PR URL into phase-result-code.json artifacts[] with kind: 'github_pr'."

        base_prompt="${base_prompt}${code_instructions}"
    fi

    echo "${base_prompt}"
}