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

# detect_default_branch(project: string) -> string
#   Detects the repo's default branch so the code-phase PR targets the right
#   base (issue #489). Repos whose default branch is not `main` (e.g. `master`)
#   previously got a broken `gh pr create --base main`. Resolution order:
#     1. gh repo view --json defaultBranchRef (authoritative; needs a remote)
#     2. git symbolic-ref refs/remotes/origin/HEAD (local mirror of the remote)
#     3. fall back to `main`.
#
# Arguments:
#   $1 -- project: Absolute path to the project/repository root.
#
# Stdout:
#   The default branch name (never empty; defaults to "main").
detect_default_branch() {
    local project="${1:-}"
    local branch=""

    if [[ -n "${project}" && -d "${project}" ]]; then
        # 1) Ask GitHub directly (most reliable when a remote exists).
        #    gh resolves the repo from its cwd, so run it inside the project.
        if command -v gh >/dev/null 2>&1; then
            branch=$( (cd "${project}" && gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null < /dev/null) || true)
        fi

        # 2) Fall back to the locally-tracked origin HEAD ref.
        if [[ -z "${branch}" ]] && command -v git >/dev/null 2>&1; then
            branch=$(git -C "${project}" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@' || true)
        fi
    fi

    # 3) Default.
    if [[ -z "${branch}" ]]; then
        branch="main"
    fi

    echo "${branch}"
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

        # Detect the repo's default branch so the PR targets the right base
        # instead of assuming 'main' (issue #489).
        local default_branch
        default_branch="$(detect_default_branch "${project}")"

        # Issue #501: if the daemon re-entered this request to address operator
        # PR review comments, current_phase_metadata.pr_comment_feedback holds
        # the new comments and pr_comment_url holds the existing PR. In that
        # case the branch + PR ALREADY EXIST: the agent must check out the same
        # branch, revise, and push (which updates the PR) — NOT open a new one.
        local pr_comment_feedback="" pr_comment_url=""
        if [[ -f "${state_file}" ]]; then
            pr_comment_feedback=$(jq -r '.current_phase_metadata.pr_comment_feedback // ""' "${state_file}" 2>/dev/null || echo "")
            pr_comment_url=$(jq -r '.current_phase_metadata.pr_comment_url // ""' "${state_file}" 2>/dev/null || echo "")
        fi

        local code_instructions
        if [[ -n "${pr_comment_feedback}" ]]; then
            # Revision pass driven by PR review comments.
            code_instructions="

## Address PR Review Comments (revision pass — issue #501)

The operator left review comments on the EXISTING pull request for this
request. Your job is to revise the code to address them and push the update.
**Do NOT open a new PR and do NOT force-push.**

Existing PR: ${pr_comment_url}

Operator review comments to address:
${pr_comment_feedback}

Steps:
1. Check out the EXISTING branch (do not create a new one):
   git checkout 'autonomous/${request_id}'
   (If it only exists on the remote: git fetch origin 'autonomous/${request_id}' && git checkout 'autonomous/${request_id}')

2. Make the revisions that address each comment above. Use Conventional
   Commits format (fix:, refactor:, etc.).

3. Push to the SAME branch to update the existing PR (a normal fast-forward
   push — never --force / --force-with-lease):
   git push origin 'autonomous/${request_id}'

4. Re-write phase-result-code.json. Keep the SAME github_pr artifact URL
   (${pr_comment_url}) in artifacts[] with kind: 'github_pr' so the daemon
   continues to track the same PR. In 'feedback', briefly note which comments
   you addressed.

If a comment is out of scope or you disagree, still write phase-result-code.json
and explain your reasoning in 'feedback' rather than silently ignoring it."
        else
            # First code pass: create the branch + PR as before.
            code_instructions="

## Branch and PR Instructions

1. Create a branch named 'autonomous/${request_id}' (single-quoted in any shell command):
   git checkout -b 'autonomous/${request_id}'

2. Make commits using Conventional Commits format (feat:, fix:, docs:, etc.).

3. When implementation is done, create a PR:
   gh pr create --base ${default_branch} --head 'autonomous/${request_id}' --title <conventional-title> --body <summary>

4. Write the resulting PR URL into phase-result-code.json artifacts[] with kind: 'github_pr'."
        fi

        base_prompt="${base_prompt}${code_instructions}"
    fi

    # #500 — operator artifact-comment feedback injection.
    #
    # When the operator leaves comments on this phase's rendered artifact in
    # the portal and clicks "revise", the portal writes a feedback artifact to
    #   ${project}/.autonomous-dev/requests/${request_id}/artifact-feedback/${phase}.json
    # AND a revise marker the daemon's consume_revise_markers() acts on by
    # resetting current_phase back to this (author) phase — the same loopback
    # the daemon uses when a *_review phase fails. On that re-run we inject the
    # operator's feedback here so the author addresses it (the review-gate
    # author re-run reads phase_history; the operator path is explicit).
    #
    # Read with jq when available (the daemon environment always has it); fall
    # back to skipping injection if jq is missing or the file is absent/corrupt
    # (fail open — never block a re-run because feedback couldn't be read).
    local feedback_file="${project}/.autonomous-dev/requests/${request_id}/artifact-feedback/${phase}.json"
    if [[ -f "${feedback_file}" ]] && command -v jq >/dev/null 2>&1; then
        local operator_feedback
        operator_feedback=$(jq -r '.feedback // empty' "${feedback_file}" 2>/dev/null || echo "")
        if [[ -n "${operator_feedback}" ]]; then
            base_prompt="${base_prompt}

═══════════════════════════════════════════════════════════════
**OPERATOR REVISION REQUEST — ADDRESS THESE COMMENTS**

A human operator reviewed your previous '${phase}' artifact and asked for
revisions. You MUST address every comment below in this revision, then
re-emit \`phase-result-${phase}.json\` as usual.

${operator_feedback}
═══════════════════════════════════════════════════════════════"
            if declare -F log_info >/dev/null 2>&1; then
                log_info "Injected operator artifact-comment feedback for ${request_id} phase ${phase}"
            fi
        fi
    fi

    echo "${base_prompt}"
}

# record_phase_metric(request_id, project, completed_phase, result_status) -> void
#   Best-effort metrics SELF-FEED: when a `<X>_review` phase completes, record an
#   InvocationMetric for the agent that PRODUCED phase `<X>` (resolve_agent), so
#   `agent improve`/`agent analyze` have real data to analyze. Writes to the
#   agent-factory data dir — the same agent-metrics.db those verbs read.
#
#   Derivation (the daemon's reviews emit pass/fail + a findings count, not a
#   numeric score): pass -> approved, score 4.6 - 0.3*findings (floor 3.0);
#   otherwise revision_requested, score 2.6 - 0.2*findings (floor 1.0). The work
#   phase's retry_count becomes review_iteration_count; domain is inferred coarsely
#   from the project's dominant language.
#
#   NEVER fails the caller — every path returns 0. Gated by env
#   AUTONOMOUS_DEV_DISABLE_METRICS_RECORDING and config
#   `agent_factory.metrics.record_from_pipeline` (default true).
record_phase_metric() {
    local request_id="$1" project="$2" completed_phase="$3" result_status="$4"

    # Only `<X>_review` phases carry a quality verdict on a producing agent.
    case "${completed_phase}" in *_review) ;; *) return 0 ;; esac

    [[ -n "${AUTONOMOUS_DEV_DISABLE_METRICS_RECORDING:-}" ]] && return 0
    local enabled="true"
    if [[ -n "${EFFECTIVE_CONFIG:-}" && -f "${EFFECTIVE_CONFIG}" ]]; then
        enabled=$(jq -r '.agent_factory.metrics.record_from_pipeline // true' "${EFFECTIVE_CONFIG}" 2>/dev/null || echo "true")
    fi
    [[ "${enabled}" == "false" ]] && return 0

    local work_phase="${completed_phase%_review}"
    local agent reviewer
    agent=$(resolve_agent "${work_phase}" 2>/dev/null) || return 0
    [[ -z "${agent}" ]] && return 0
    reviewer=$(resolve_agent "${completed_phase}" 2>/dev/null || echo "")

    local req_dir="${project}/.autonomous-dev/requests/${request_id}"
    local result_file="${req_dir}/phase-result-${completed_phase}.json"
    local state_file="${req_dir}/state.json"

    local findings=0 retries=0
    if [[ -f "${result_file}" ]]; then
        findings=$(jq -r '(.findings | if type=="array" then length elif type=="number" then . else 0 end)' "${result_file}" 2>/dev/null || echo 0)
    fi
    if [[ -f "${state_file}" ]]; then
        retries=$(jq -r --arg p "${work_phase}" '([.phase_history[]? | select(.state==$p) | .retry_count // 0] | max) // 0' "${state_file}" 2>/dev/null || echo 0)
    fi
    [[ "${findings}" =~ ^[0-9]+$ ]] || findings=0
    [[ "${retries}" =~ ^[0-9]+$ ]] || retries=0

    local outcome score
    if [[ "${result_status}" == "pass" ]]; then
        outcome="approved"
        score=$(awk -v f="${findings}" 'BEGIN{s=4.6-0.3*f; if(s<3.0)s=3.0; printf "%.2f", s}')
    else
        outcome="revision_requested"
        score=$(awk -v f="${findings}" 'BEGIN{s=2.6-0.2*f; if(s<1.0)s=1.0; printf "%.2f", s}')
    fi

    # Coarse domain inference from the project's dominant language.
    local domain="general"
    if [[ -d "${project}" ]]; then
        local npy nts
        npy=$(find "${project}" -maxdepth 3 -name '*.py' ! -path '*/.*' 2>/dev/null | head -40 | wc -l | tr -d ' ')
        nts=$(find "${project}" -maxdepth 3 -name '*.ts' ! -path '*/.*' 2>/dev/null | head -40 | wc -l | tr -d ' ')
        if (( npy > nts )); then domain="python"; elif (( nts > npy )); then domain="typescript"; fi
    fi

    # Resolve the node recorder; lazily build it from source if absent (the
    # committed bin/lib/record-metric.js is the primary path).
    local recorder="${PLUGIN_DIR}/bin/lib/record-metric.js"
    if [[ ! -f "${recorder}" && -f "${PLUGIN_DIR}/bin/record-metric.ts" ]] && command -v bun >/dev/null 2>&1; then
        bun build "${PLUGIN_DIR}/bin/record-metric.ts" --outfile="${recorder}" --target=node --external better-sqlite3 >/dev/null 2>&1 || true
    fi
    if [[ -f "${recorder}" ]] && command -v node >/dev/null 2>&1; then
        if node "${recorder}" --agent "${agent}" --request-id "${request_id}" --outcome "${outcome}" \
                --score "${score}" --reviewer "${reviewer}" --domain "${domain}" --retries "${retries}" \
                --agents-dir "${PLUGIN_DIR}/agents" >/dev/null 2>&1; then
            log_info "metrics: recorded ${agent} (${outcome}, score=${score}, domain=${domain}, retries=${retries}) from ${completed_phase}" 2>/dev/null || true
        else
            log_warn "metrics: recorder failed for ${agent} (best-effort, ignored)" 2>/dev/null || true
        fi
    fi
    return 0
}