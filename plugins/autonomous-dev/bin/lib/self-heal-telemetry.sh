#!/usr/bin/env bash
###############################################################################
# self-heal-telemetry.sh — Phase-duration median collector
#
# REQ-000056 | TASK-015
#
# Records per-phase session durations and maintains a running median in
# ${AUTONOMOUS_DEV_STATE_DIR}/self-heal/phase-duration-medians.json.
#
# F6 (detect_suspicious_fast) reads from this file to determine the baseline.
# Baselines are keyed by phase ONLY (not request_type) per TDD OQ-3 / TC-044.
#
# File size is bounded to ≤64 KiB via a simple bounded ring-buffer approach:
# we maintain per-phase sorted sample arrays capped at MAX_SAMPLES_PER_PHASE.
# The median is recomputed on each update.
###############################################################################

: "${AUTONOMOUS_DEV_STATE_DIR:=${HOME}/.autonomous-dev}"
readonly _SELFHEAL_TELEMETRY_DIR="${AUTONOMOUS_DEV_STATE_DIR}/self-heal"
readonly _SELFHEAL_TELEMETRY_FILE="${_SELFHEAL_TELEMETRY_DIR}/phase-duration-medians.json"
readonly _SELFHEAL_TELEMETRY_SAMPLES_FILE="${_SELFHEAL_TELEMETRY_DIR}/phase-duration-samples.json"
# Max samples per phase to keep file size bounded
readonly _SELFHEAL_TELEMETRY_MAX_SAMPLES=50

# selfheal_record_phase_duration(phase, duration_seconds) -> 0
#   Records a single observed session duration for a phase and updates the
#   rolling median. Uses flock (or noclobber fallback) for concurrent safety.
selfheal_record_phase_duration() {
    local phase="${1:-}"
    local duration_seconds="${2:-}"

    [[ -n "${phase}" && -n "${duration_seconds}" ]] || return 0

    # Validate duration is a positive integer
    [[ "${duration_seconds}" =~ ^[0-9]+$ ]] || return 0
    [[ "${duration_seconds}" -gt 0 ]] || return 0

    mkdir -p "${_SELFHEAL_TELEMETRY_DIR}" 2>/dev/null || return 0

    if command -v flock >/dev/null 2>&1; then
        (
            flock -w 2 200 || return 0
            _selfheal_telemetry_update "${phase}" "${duration_seconds}"
        ) 200>"${_SELFHEAL_TELEMETRY_FILE}.lock"
    else
        (
            set -C
            until : > "${_SELFHEAL_TELEMETRY_FILE}.lock" 2>/dev/null; do sleep 0.05; done
            trap 'rm -f "${_SELFHEAL_TELEMETRY_FILE}.lock"' EXIT
            _selfheal_telemetry_update "${phase}" "${duration_seconds}"
        )
    fi
    return 0
}

# _selfheal_telemetry_update(phase, duration_seconds) -> 0 (internal)
#   Updates the samples file and recomputes the median for the given phase.
_selfheal_telemetry_update() {
    local phase="${1:-}"
    local duration="${2:-}"

    # Load or initialize samples file
    local samples_json="{}"
    if [[ -f "${_SELFHEAL_TELEMETRY_SAMPLES_FILE}" ]]; then
        samples_json=$(jq '.' "${_SELFHEAL_TELEMETRY_SAMPLES_FILE}" 2>/dev/null) || samples_json="{}"
    fi

    # Append new sample and cap at MAX_SAMPLES
    local new_samples
    new_samples=$(printf '%s' "${samples_json}" | jq \
        --arg p "${phase}" \
        --argjson d "${duration}" \
        --argjson max "${_SELFHEAL_TELEMETRY_MAX_SAMPLES}" \
        '.[$p] //= [] | .[$p] += [$d] |
         if (.[$p] | length) > $max then
             .[$p] = .[$p][(-$max):]
         else . end' 2>/dev/null) || return 0

    # Write samples file atomically
    local tmp="${_SELFHEAL_TELEMETRY_SAMPLES_FILE}.tmp.$$"
    printf '%s\n' "${new_samples}" > "${tmp}" && mv "${tmp}" "${_SELFHEAL_TELEMETRY_SAMPLES_FILE}" || {
        rm -f "${tmp}" 2>/dev/null || true
        return 0
    }

    # Recompute medians for all phases
    local medians_json
    medians_json=$(printf '%s' "${new_samples}" | jq \
        'to_entries | map({key: .key, value: (.value | sort | if length == 0 then 0 elif (length % 2) == 1 then .[length / 2 | floor] else (.[length/2 - 1] + .[length/2]) / 2 end)}) | from_entries' \
        2>/dev/null) || return 0

    # Write medians file atomically
    local medians_tmp="${_SELFHEAL_TELEMETRY_FILE}.tmp.$$"
    printf '%s\n' "${medians_json}" > "${medians_tmp}" && mv "${medians_tmp}" "${_SELFHEAL_TELEMETRY_FILE}" || {
        rm -f "${medians_tmp}" 2>/dev/null || true
        return 0
    }
    return 0
}
