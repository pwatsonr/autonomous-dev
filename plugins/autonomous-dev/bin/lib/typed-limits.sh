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

# Hard-coded per-phase dispatch timeout defaults (REQ-000051).
# Used when no per-request, per-phase config, global config, or env-var
# override is present. Note: EFFECTIVE_CONFIG (not AUTONOMOUS_DEV_CONFIG)
# is the merged defaults+user config set by supervisor-loop.sh at startup.
declare -A _TYPED_LIMITS_DISPATCH_DEFAULTS_BY_PHASE
_TYPED_LIMITS_DISPATCH_DEFAULTS_BY_PHASE=(
    [intake]=600
    [prd]=3600
    [tdd]=3600
    [plan]=3600
    [spec]=5400
    [prd_review]=1800
    [tdd_review]=1800
    [plan_review]=1800
    [spec_review]=1800
    [code_review]=1800
    [code]=10800
    [integration]=7200
    [deploy]=1800
    [monitor]=1200
)

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

    # H6 — Self-heal: honor budget_extended_to override when set (REQ-000056 §11).
    # Checked FIRST so the extended budget takes precedence over all other lookups.
    if [[ -f "${state_file}" ]]; then
        local extended_at extended_to
        extended_at=$(jq -r '.current_phase_metadata.self_heal.budget_extended_at // empty' \
            "${state_file}" 2>/dev/null || true)
        extended_to=$(jq -r '.current_phase_metadata.self_heal.budget_extended_to // empty' \
            "${state_file}" 2>/dev/null || true)
        if [[ -n "${extended_at}" && "${extended_at}" != "null" \
              && -n "${extended_to}" && "${extended_to}" != "null" && "${extended_to}" != "0" ]]; then
            printf '%s\n' "${extended_to}"
            return 0
        fi
    fi

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

# coerce_timeout_to_seconds(value: string) -> int (stdout) | exit 1
#   Converts a timeout string to integer seconds.
#   Accepts: bare integers (interpreted as seconds), or an integer followed
#   by exactly one lowercase suffix character: s, m, or h.
#   Leading/trailing whitespace, empty string, uppercase suffixes, floats,
#   and composite strings (e.g. "30m30s") are rejected (exit 1).
#   Returns: integer seconds on stdout, exit 0 on success.
coerce_timeout_to_seconds() {
    local value="$1"
    # Reject empty string
    if [[ -z "${value}" ]]; then
        return 1
    fi
    # Reject negative numbers
    if [[ "${value}" =~ ^- ]]; then
        return 1
    fi
    # Match valid pattern: digits optionally followed by exactly one s/m/h suffix
    if [[ "${value}" =~ ^([0-9]+)([smh])?$ ]]; then
        local num="${BASH_REMATCH[1]}"
        local suffix="${BASH_REMATCH[2]:-}"
        local seconds
        case "${suffix}" in
            s|"") seconds="${num}" ;;
            m)    seconds=$(( num * 60 )) ;;
            h)    seconds=$(( num * 3600 )) ;;
        esac
        printf '%s\n' "${seconds}"
        return 0
    fi
    return 1
}

# resolve_dispatch_timeout(state_file: string, phase: string) -> int (stdout)
#   Returns the dispatch timeout in seconds for the given phase.
#   Never returns empty; always exits 0. Precedence (highest wins):
#     1. per-request  .type_config.dispatchTimeouts[phase] in state.json
#     2. per-phase    .daemon.dispatch_timeout_by_phase[phase] in $EFFECTIVE_CONFIG
#     3. global       .daemon.dispatch_timeout_seconds in $EFFECTIVE_CONFIG
#     4. env var      $DISPATCH_TIMEOUT (coerced via coerce_timeout_to_seconds)
#     5. hard-coded   _TYPED_LIMITS_DISPATCH_DEFAULTS_BY_PHASE[phase] or 1800
#   Note: EFFECTIVE_CONFIG is the merged defaults+user config (set by
#   supervisor-loop.sh::resolve_effective_config). When absent (e.g. unit
#   tests), layers 2 and 3 are skipped silently.
resolve_dispatch_timeout() {
    local state_file="$1"
    local phase="$2"
    local value=""

    # Layer 1: per-request override
    value=$(jq -r --arg p "${phase}" \
        '.type_config.dispatchTimeouts[$p] // empty' \
        "${state_file}" 2>/dev/null || true)
    if [[ -n "${value}" && "${value}" != "null" ]]; then
        printf '%s\n' "${value}"
        return 0
    fi

    # Layer 2: per-phase config (EFFECTIVE_CONFIG only; not AUTONOMOUS_DEV_CONFIG)
    if [[ -n "${EFFECTIVE_CONFIG:-}" && -f "${EFFECTIVE_CONFIG}" ]]; then
        value=$(jq -r --arg p "${phase}" \
            '.daemon.dispatch_timeout_by_phase[$p] // empty' \
            "${EFFECTIVE_CONFIG}" 2>/dev/null || true)
        if [[ -n "${value}" && "${value}" != "null" ]]; then
            printf '%s\n' "${value}"
            return 0
        fi

        # Layer 3: global config
        value=$(jq -r '.daemon.dispatch_timeout_seconds // empty' \
            "${EFFECTIVE_CONFIG}" 2>/dev/null || true)
        if [[ -n "${value}" && "${value}" != "null" ]]; then
            printf '%s\n' "${value}"
            return 0
        fi
    fi

    # Layer 4: DISPATCH_TIMEOUT env var (coerced)
    if [[ -n "${DISPATCH_TIMEOUT:-}" ]]; then
        local coerced
        coerced=$(coerce_timeout_to_seconds "${DISPATCH_TIMEOUT}" 2>/dev/null || true)
        if [[ -n "${coerced}" ]]; then
            printf '%s\n' "${coerced}"
            return 0
        else
            # Non-empty but rejected: warn once; fall through to default
            printf 'typed-limits: DISPATCH_TIMEOUT="%s" is malformed; ignoring\n' \
                "${DISPATCH_TIMEOUT}" >&2 || true
        fi
    fi

    # Layer 5: hard-coded phase default or fallback 1800
    local default_secs="${_TYPED_LIMITS_DISPATCH_DEFAULTS_BY_PHASE[${phase}]:-1800}"
    printf '%s\n' "${default_secs}"
    return 0
}

# resolve_max_soft_timeout_reentries(state_file: string) -> int (stdout)
#   Returns the maximum number of soft timeout reentries allowed before
#   promoting to a hard timeout. Precedence:
#     1. per-request .type_config.maxSoftTimeoutReentries in state.json
#     2. config      .daemon.max_soft_timeout_reentries in $EFFECTIVE_CONFIG
#     3. hard-coded  5
resolve_max_soft_timeout_reentries() {
    local state_file="$1"
    local value=""

    # Layer 1: per-request override
    value=$(jq -r '.type_config.maxSoftTimeoutReentries // empty' \
        "${state_file}" 2>/dev/null || true)
    if [[ -n "${value}" && "${value}" != "null" ]]; then
        printf '%s\n' "${value}"
        return 0
    fi

    # Layer 2: config
    if [[ -n "${EFFECTIVE_CONFIG:-}" && -f "${EFFECTIVE_CONFIG}" ]]; then
        value=$(jq -r '.daemon.max_soft_timeout_reentries // empty' \
            "${EFFECTIVE_CONFIG}" 2>/dev/null || true)
        if [[ -n "${value}" && "${value}" != "null" ]]; then
            printf '%s\n' "${value}"
            return 0
        fi
    fi

    # Layer 3: hard-coded default
    printf '%s\n' "5"
    return 0
}
