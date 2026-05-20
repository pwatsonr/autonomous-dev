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

# Source shared phase helper functions
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=bin/lib/phase-helpers.sh
if [[ -f "${LIB_DIR}/phase-helpers.sh" ]]; then
    source "${LIB_DIR}/phase-helpers.sh"
fi

# write_synthesized_phase_result(path, status, error, exit_code, phase) -> void
#   Writes a synthesized phase-result.json when the agent didn't create one.
#   Used as fallback in spawn_session_typed() and by dispatch_phase_session()
#   timeout handling.
write_synthesized_phase_result() {
    local path="$1" status="$2" error_msg="$3" exit_code="${4:-0}" phase="${5:-}"
    local tmp="${path}.tmp.$$"
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Construct feedback message
    local feedback
    if [[ -n "$error_msg" ]]; then
        feedback="synthesized from exit code $exit_code ($error_msg)"
    else
        feedback="synthesized from exit code $exit_code"
    fi

    jq -n --arg s "$status" --arg e "$error_msg" --argjson rc "$exit_code" \
        --arg ts "$ts" --arg p "$phase" --arg f "$feedback" \
        '{
            status: $s,
            phase: $p,
            feedback: $f,
            error: $e,
            artifacts: [],
            synthesized: true,
            exit_code: $rc,
            completed_at: $ts
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
    line+=(--permission-mode bypassPermissions)
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
            if [[ "${token}" == *"You are an autonomous development agent"* || "${token}" == *"Read your request context from"* ]]; then
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
    # `${args[@]+"${args[@]}"}` is the bash-3.2-safe empty-array expansion;
    # under `set -u` plain `"${args[@]}"` errors with `args[@]: unbound
    # variable` on bash 3.2 (macOS system bash). The daemon invokes this
    # script via `bash spawn-session.sh` (unqualified), which on a daemon
    # PATH that lacks /opt/homebrew/bin resolves to /bin/bash@3.2, so this
    # path matters in production.
    # PORTAL-BUG-CATALOG-2026-05-16 followup: `--permission-mode bypassPermissions`
    # alone does NOT give the spawned session access to file-modifying tools in
    # --print mode. Without the explicit allowlist, every prd/tdd/plan/spec/code
    # phase produced text-only output, never wrote phase-result-<phase>.json
    # OR the requested artifact files, and the daemon fell back to its
    # "synthesized from exit code 0" fake-pass. Investigated 2026-05-17 with
    # session-1778990070.txt: claude itself reported "I don't have write
    # permissions or access to a file writing tool in this context." Result:
    # weeks of phase-walks that produced zero real artifacts at ~$0.20/phase.
    # The allowlist below is the union of tools the agent .md definitions in
    # plugins/autonomous-dev/agents/ declare; review phases get the read-only
    # subset.
    local tools_full="Read Write Edit Bash Glob Grep WebSearch WebFetch"
    # BUG-19 fix: review phases need Write so they can emit
    # `phase-result-<phase>.json` with their verdict. Without it, the agent
    # exits clean (exit 0) without writing the result file and the daemon
    # falls back to its synthesized "pass" — making every review a no-op.
    # The prompt already instructs reviewers to ONLY write the phase-result
    # file; this allowlist just unblocks that single artifact.
    local tools_review="Read Write Glob Grep"
    local agent_tools
    if [[ "${target_phase}" == *"_review" ]]; then
        agent_tools="${tools_review}"
    else
        agent_tools="${tools_full}"
    fi
    if [[ "${req_type}" == "infra" && "${target_phase}" != *"_review" ]]; then
        local gates="${ENHANCED_GATES_CSV:-${DEFAULT_ENHANCED_GATES}}"
        env "ENHANCED_GATES=${gates}" claude \
            --print --output-format json \
            --agent "${agent}" \
            --add-dir "${req_dir}" \
            --add-dir "${project}" \
            --permission-mode bypassPermissions \
            --allowedTools "${agent_tools}" \
            --max-budget-usd "${phase_budget}" \
            ${args[@]+"${args[@]}"} \
            "${phase_prompt}" || exit_code=$?
    else
        claude \
            --print --output-format json \
            --agent "${agent}" \
            --add-dir "${req_dir}" \
            --add-dir "${project}" \
            --permission-mode bypassPermissions \
            --allowedTools "${agent_tools}" \
            --max-budget-usd "${phase_budget}" \
            ${args[@]+"${args[@]}"} \
            "${phase_prompt}" || exit_code=$?
    fi

    # Synthesize phase-result.json if agent didn't write one.
    #
    # 2026-05-19 fix (REQ-000011 post-mortem): review phases that exit
    # cleanly without writing a phase-result envelope are NOT "pass" —
    # they're "the reviewer never produced a verdict". Old behavior
    # auto-passed them, which made the entire reviewer chain a no-op
    # and let bad PRs through with no actual review. New behavior:
    # missing-envelope on a `*_review` phase synthesizes FAIL with
    # `REVIEWER_DID_NOT_EMIT_VERDICT`. The daemon's phase-transition
    # logic treats that as a blocker, surfacing the gate to the
    # operator instead of silently advancing.
    #
    # Non-review phases keep the original semantics: clean exit +
    # missing envelope = pass (because the artifact-writing agents
    # often produce the artifact correctly but forget the bookkeeping;
    # we don't want to penalize them for that — the artifact is the
    # contract). Review phases ARE the bookkeeping; missing envelope
    # there means the contract was not met.
    local result_path="${req_dir}/phase-result-${target_phase}.json"
    if [[ ! -f "$result_path" ]]; then
        local status error_msg
        if [[ $exit_code -ne 0 ]]; then
            status="fail"
            error_msg="AGENT_EXITED_NONZERO"
        elif [[ "${target_phase}" == *"_review" ]]; then
            status="fail"
            error_msg="REVIEWER_DID_NOT_EMIT_VERDICT"
        else
            status="pass"
            error_msg=""
        fi
        write_synthesized_phase_result "$result_path" "$status" "$error_msg" "$exit_code" "$target_phase"
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
