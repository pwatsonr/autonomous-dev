#!/usr/bin/env bash
###############################################################################
# typed-limits.sh - Type-Aware Limit Resolution Helpers
#
# SPEC-018-2-02
#
# Provides resolve_phase_timeout and resolve_max_retries, which look up
# per-request overrides from .type_config in state.json and fall back to the
# global daemon config (~/.claude/autonomous-dev.json) and finally to
# hard-coded defaults. Sourced by supervisor-loop.sh.
#
# Cross-reference: per-type values originate from PHASE_OVERRIDE_MATRIX in
# plugins/autonomous-dev/intake/types/phase-override.ts. The TS side stamps
# .type_config when a request enters the pipeline; this bash side consumes
# it. Drift between TS matrix and the keys read here will surface as a
# fallback to the global default — operators see the "type=feature" tag in
# escalation messages even on a non-feature request, which is the
# intended-cheap signal that the matrix loader needs investigation.
###############################################################################

# Hard-coded defaults used only when both per-type override and the global
# config are absent. Match the values in the existing supervisor-loop.sh.
_TYPED_LIMITS_DEFAULT_TIMEOUT=14400  # seconds = 4 hours
_TYPED_LIMITS_DEFAULT_RETRIES=3

# resolve_phase_timeout(state_file: string, phase: string) -> int
#   Returns the timeout in seconds for the given phase on the given state.
#   Lookup order:
#     1. .type_config.phaseTimeouts[phase] in state.json (v1.1)
#     2. .phase_timeout_seconds in $AUTONOMOUS_DEV_CONFIG (global default)
#     3. hard-coded 14400
#
#   Uses jq's `// empty` (rather than `// <default>`) so a deliberate zero
#   value is preserved — the matrix never sets zero, so this is paranoia,
#   but cheap.
resolve_phase_timeout() {
    local state_file="$1" phase="$2"
    local override
    override=$(jq -r --arg p "${phase}" \
        '.type_config.phaseTimeouts[$p] // empty' \
        "${state_file}" 2>/dev/null || true)
    if [[ -n "${override}" && "${override}" != "null" ]]; then
        printf '%s\n' "${override}"
        return 0
    fi

    local config_path="${AUTONOMOUS_DEV_CONFIG:-${HOME}/.claude/autonomous-dev.json}"
    if [[ -f "${config_path}" ]]; then
        local global
        global=$(jq -r '.phase_timeout_seconds // empty' "${config_path}" 2>/dev/null || true)
        if [[ -n "${global}" && "${global}" != "null" ]]; then
            printf '%s\n' "${global}"
            return 0
        fi
    fi

    printf '%s\n' "${_TYPED_LIMITS_DEFAULT_TIMEOUT}"
}

# resolve_max_retries(state_file: string) -> int
#   Returns the maxRetries budget for this state.
#   Lookup order:
#     1. .type_config.maxRetries in state.json (v1.1)
#     2. .max_retries in $AUTONOMOUS_DEV_CONFIG (global default)
#     3. hard-coded 3
resolve_max_retries() {
    local state_file="$1"
    local override
    override=$(jq -r '.type_config.maxRetries // empty' \
        "${state_file}" 2>/dev/null || true)
    if [[ -n "${override}" && "${override}" != "null" ]]; then
        printf '%s\n' "${override}"
        return 0
    fi

    local config_path="${AUTONOMOUS_DEV_CONFIG:-${HOME}/.claude/autonomous-dev.json}"
    if [[ -f "${config_path}" ]]; then
        local global
        global=$(jq -r '.max_retries // empty' "${config_path}" 2>/dev/null || true)
        if [[ -n "${global}" && "${global}" != "null" ]]; then
            printf '%s\n' "${global}"
            return 0
        fi
    fi

    printf '%s\n' "${_TYPED_LIMITS_DEFAULT_RETRIES}"
}

# resolve_request_type(state_file: string) -> string
#   Returns the request type (.type) or "feature" when absent. Used to
#   enrich escalation messages.
resolve_request_type() {
    local state_file="$1"
    jq -r '.type // "feature"' "${state_file}" 2>/dev/null || echo "feature"
}
