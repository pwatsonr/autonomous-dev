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
        # Detect review phases to give them stronger envelope-mandatory
        # framing. Review phases that don't write phase-result-<phase>.json
        # are now treated as FAIL by the daemon (REQ-000011 post-mortem),
        # so the prompt must make that obligation impossible to miss.
        local is_review_phase=false
        case "${phase}" in
            *_review) is_review_phase=true ;;
        esac
        # Detect executor phases that historically confabulate "all tests
        # pass / Docker built / deployment complete" without actually
        # running anything (REQ-000011 post-mortem). The daemon now
        # auto-fails their envelopes if status=pass but no `evidence`
        # array is present.
        local is_executor_phase=false
        case "${phase}" in
            integration|deploy|test) is_executor_phase=true ;;
        esac

        base_prompt="You are an autonomous development agent working on request ${request_id}.

Your current phase is: ${phase}

Read the request state file at: ${state_file}
Read the project context at: ${project}

Perform the work required for the '${phase}' phase as described in the state file."

        # Reviewer-specific contract — placed early so it's load-bearing,
        # not buried under the analysis instructions. Repeated again at
        # the end for redundancy.
        if [[ "${is_review_phase}" == "true" ]]; then
            base_prompt="${base_prompt}

═══════════════════════════════════════════════════════════════
**MANDATORY OUTPUT CONTRACT FOR REVIEWERS — READ FIRST**

You are a *_review phase. The daemon treats a clean exit WITHOUT a
written phase-result-${phase}.json envelope as **FAIL** with code
\`REVIEWER_DID_NOT_EMIT_VERDICT\`. Your analysis without the envelope
is wasted work.

Before you finish, write to \`${req_dir}/phase-result-${phase}.json\`:

  {
    \"status\": \"pass\" | \"fail\",
    \"phase\": \"${phase}\",
    \"feedback\": \"<verdict + any blocking findings, ≤500 chars>\",
    \"findings\": [
      { \"severity\": \"blocking|warn|info\", \"file\": \"<path>\",
        \"line\": <number>, \"message\": \"<one sentence>\" }
    ]
  }

  - \"pass\" = no blocking findings; pipeline advances.
  - \"fail\" = at least one blocking finding; pipeline gates for the
    operator. Use this honestly. False-pass is worse than verbose-fail.

Even if your review found ZERO issues, you STILL must write the
envelope with status: pass and a brief feedback message. The envelope
is the contract; the analysis is just how you arrive at the verdict.
═══════════════════════════════════════════════════════════════
"
        fi

        # Executor-specific contract — same hoisting + forcing language
        # as reviewers, addressing the confabulation pattern observed in
        # REQ-000011 (integration agent claimed \"100% pass\" without
        # running tests; deploy agent claimed Docker built without
        # writing any Dockerfile).
        if [[ "${is_executor_phase}" == "true" ]]; then
            base_prompt="${base_prompt}

═══════════════════════════════════════════════════════════════
**MANDATORY EVIDENCE-OF-WORK CONTRACT FOR EXECUTORS — READ FIRST**

You are an executor phase (${phase}). The daemon now **auto-fails**
any envelope where status=\"pass\" but the \`evidence\` array is empty
or missing — code \`EXECUTOR_CLAIMED_PASS_WITHOUT_EVIDENCE\`.

If you claim tests pass, you MUST run them and capture the output.
If you claim a Docker image built, you MUST run docker build and
capture the output. No exceptions. Summary claims like \"all tests
passing\" without command output are now blocked.

Required envelope shape (note the \`evidence\` array):

  {
    \"status\": \"pass\" | \"fail\",
    \"phase\": \"${phase}\",
    \"feedback\": \"<short summary, ≤500 chars>\",
    \"evidence\": [
      {
        \"command\": \"<exact command you ran>\",
        \"exit_code\": <0 = success, nonzero = failure>,
        \"output_tail\": \"<last 20 lines of stdout/stderr, verbatim>\"
      }
    ],
    \"artifacts\": [
      { \"kind\": \"<test-output|dockerfile|deploy-script>\",
        \"path\": \"<file path>\", \"title\": \"<one-liner>\" }
    ]
  }

Rules:
  - If you claim a command produced exit_code 0, the \`output_tail\`
    must contain the actual tool's success markers (e.g. \"X pass / 0 fail\"
    for bun test). DO NOT paraphrase. Paste the tail verbatim.
  - If even one of your verification commands fails, set status=\"fail\"
    and report HONESTLY. False-pass is worse than verbose-fail.
  - You can include MULTIPLE evidence entries (one per command).
  - Empty \`evidence\` array + status=\"pass\" = auto-failed by the daemon.
═══════════════════════════════════════════════════════════════
"
        fi

        # Add artifact location instructions for authoring phases
        case "${phase}" in
            prd)
                local artifact_slug="${request_id}-$(echo "${request_id}" | sed 's/REQ-[0-9]*-//' | tr '[:upper:]' '[:lower:]' | sed 's/_/-/g')"
                base_prompt="${base_prompt}

Write the PRD document to \`${project}/docs/prd/${artifact_slug}.md\` (mkdir -p the dir). List that path in \`phase-result-${phase}.json.artifacts[]\` with \`kind: '${phase}'\`."
                ;;
            tdd)
                local artifact_slug="${request_id}-$(echo "${request_id}" | sed 's/REQ-[0-9]*-//' | tr '[:upper:]' '[:lower:]' | sed 's/_/-/g')"
                base_prompt="${base_prompt}

Write the TDD document to \`${project}/docs/tdd/${artifact_slug}.md\` (mkdir -p the dir). List that path in \`phase-result-${phase}.json.artifacts[]\` with \`kind: '${phase}'\`."
                ;;
            plan)
                local artifact_slug="${request_id}-$(echo "${request_id}" | sed 's/REQ-[0-9]*-//' | tr '[:upper:]' '[:lower:]' | sed 's/_/-/g')"
                base_prompt="${base_prompt}

Write the Plan document to \`${project}/docs/plans/${artifact_slug}.md\` (mkdir -p the dir). List that path in \`phase-result-${phase}.json.artifacts[]\` with \`kind: '${phase}'\`."
                ;;
            spec)
                local artifact_slug="${request_id}-$(echo "${request_id}" | sed 's/REQ-[0-9]*-//' | tr '[:upper:]' '[:lower:]' | sed 's/_/-/g')"
                base_prompt="${base_prompt}

Write the Spec document to \`${project}/docs/specs/${artifact_slug}.md\` (mkdir -p the dir). List that path in \`phase-result-${phase}.json.artifacts[]\` with \`kind: '${phase}'\`."
                ;;
        esac

        base_prompt="${base_prompt}

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