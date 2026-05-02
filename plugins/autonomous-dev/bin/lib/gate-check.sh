#!/usr/bin/env bash
###############################################################################
# gate-check.sh - Additional-Gate Presence Check
#
# SPEC-018-2-03 Task 4
#
# Provides check_required_gates(state_file, phase) which echoes the name of
# the first missing required gate for the given outgoing phase, or empty
# string when no gates are required (or all are present). The supervisor
# uses this to keep a request paused on its current phase until the
# corresponding gate artifact appears at <state-dir>/gates/<gate-name>.json.
#
# Presence-only check: any non-empty file at the artifact path unblocks
# advancement. Real gate semantics (status=passed, content validation) are
# the responsibility of the gate evaluator that produced the artifact.
###############################################################################

# check_required_gates(state_file: string, phase: string) -> void
#   Stdout: name of the first missing gate, or empty string.
#   Exit 0 always (callers gate on stdout, not exit code).
#
#   The gate name is read from .type_config.additionalGates[phase]; if the
#   key is unset, no gates are required for this phase and the function is
#   a no-op.
check_required_gates() {
    local state_file="$1" phase="$2"
    [[ -f "${state_file}" ]] || return 0

    local state_dir
    state_dir=$(dirname "${state_file}")

    local gate
    gate=$(jq -r --arg p "${phase}" \
        '.type_config.additionalGates[$p] // empty' \
        "${state_file}" 2>/dev/null || true)

    if [[ -z "${gate}" || "${gate}" == "null" ]]; then
        return 0  # no gate required, empty stdout
    fi

    if [[ ! -f "${state_dir}/gates/${gate}.json" ]]; then
        printf '%s\n' "${gate}"
    fi
}

# update_status_reason_awaiting(state_file: string, gate_name: string) -> void
#   Idempotently writes status_reason="awaiting gate: <gate>" into state.json.
#   Used by the supervisor to surface the wait state to operators via the
#   daemon's status CLI without mutating phase or retry counters.
update_status_reason_awaiting() {
    local state_file="$1" gate_name="$2"
    [[ -f "${state_file}" ]] || return 0
    local tmp="${state_file}.tmp"
    jq --arg g "${gate_name}" \
        '.status_reason = ("awaiting gate: " + $g)' \
        "${state_file}" > "${tmp}" && mv "${tmp}" "${state_file}"
}
