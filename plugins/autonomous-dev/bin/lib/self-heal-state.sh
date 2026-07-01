#!/usr/bin/env bash
###############################################################################
# self-heal-state.sh — Atomic state.json self-heal writers
#
# REQ-000056 | TASK-003
#
# Provides selfheal_state_set and selfheal_state_get for reading/writing the
# .current_phase_metadata.self_heal.* subtree of state.json atomically.
# Uses tmp-file + mv atomicity pattern (TC-006).
###############################################################################

# selfheal_state_set(state_file, dot_path, json_value) -> 0|2
#
#   dot_path:   period-separated path RELATIVE to .current_phase_metadata.self_heal
#               e.g. "review_loop.X.count" sets
#               .current_phase_metadata.self_heal.review_loop["X"].count
#   json_value: a valid JSON literal passed through `jq --argjson v`
#
#   Returns 0 on success, 2 on any failure. Leaves state.json byte-identical
#   for all keys outside .current_phase_metadata.self_heal.
selfheal_state_set() {
    local state_file="${1:-}"
    local dot_path="${2:-}"
    local json_value="${3:-null}"

    # Validate inputs
    if [[ ! -f "${state_file}" ]]; then
        return 2
    fi

    # Validate json_value is parseable JSON
    if ! printf '%s' "${json_value}" | jq '.' >/dev/null 2>&1; then
        return 2
    fi

    local tmp="${state_file}.tmp.$$"
    if jq --arg p "${dot_path}" --argjson v "${json_value}" \
       '.current_phase_metadata //= {}
        | .current_phase_metadata.self_heal //= {}
        | .current_phase_metadata.self_heal |=
            ( . as $cur | $cur | setpath(($p|split(".")); $v) )' \
       "${state_file}" > "${tmp}" 2>/dev/null; then
        mv "${tmp}" "${state_file}"
        return 0
    else
        rm -f "${tmp}" 2>/dev/null || true
        return 2
    fi
}

# selfheal_state_get(state_file, dot_path) -> 0
#   Prints the JSON value at .current_phase_metadata.self_heal.<dot_path> to
#   stdout (raw). Prints empty string if path does not exist. Always returns 0.
selfheal_state_get() {
    local state_file="${1:-}"
    local dot_path="${2:-}"

    if [[ ! -f "${state_file}" ]]; then
        printf ''
        return 0
    fi

    local result
    result=$(jq --arg p "${dot_path}" \
        '.current_phase_metadata.self_heal // {} | getpath($p | split("."))' \
        "${state_file}" 2>/dev/null) || result=""

    if [[ -z "${result}" || "${result}" == "null" ]]; then
        printf ''
    else
        printf '%s' "${result}"
    fi
    return 0
}
