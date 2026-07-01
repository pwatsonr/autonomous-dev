#!/usr/bin/env bash
###############################################################################
# self-heal-events.sh — Schema-validated event emit + summary
#
# REQ-000056 | TASK-004
#
# Provides selfheal_emit_event and selfheal_emit_summary.
#
# flock(1) is not available by default on macOS. This module detects its
# availability and falls back to a set -C (noclobber) lockfile pattern when
# flock is absent.
###############################################################################

# selfheal_emit_event(event_type, ctx_json, [policy]) -> 0
#
#   Composes a canonical event envelope, optionally validates it against the
#   schema at docs/schemas/events/<event_type>.schema.json (if ajv is installed
#   and AUTONOMOUS_DEV_SELF_HEAL_VALIDATE_SCHEMA=1), and appends it to the
#   request's events.jsonl file under flock (or noclobber fallback).
#
#   Always returns 0 even on schema-validation failure (schema violation logs a
#   warning but the event is still appended — FR-DETECT-05 / ADR-4).
selfheal_emit_event() {
    local event_type="${1:-}"
    local ctx_json="${2:-{}}"
    local policy="${3:-}"

    [[ -n "${event_type}" ]] || return 0

    # Resolve events_file from ctx
    local events_file
    events_file=$(printf '%s' "${ctx_json}" | jq -r '.events_file // empty' 2>/dev/null) || events_file=""

    # Fallback: derive from request_id + project
    if [[ -z "${events_file}" ]]; then
        local request_id project
        request_id=$(printf '%s' "${ctx_json}" | jq -r '.request_id // empty' 2>/dev/null) || request_id=""
        project=$(printf '%s' "${ctx_json}" | jq -r '.project // empty' 2>/dev/null) || project=""
        if [[ -n "${request_id}" && -n "${project}" ]]; then
            events_file="${project}/.autonomous-dev/requests/${request_id}/events.jsonl"
        fi
    fi

    [[ -n "${events_file}" ]] || return 0

    # Compose event envelope
    local ts request_id phase failure_mode evidence
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    request_id=$(printf '%s' "${ctx_json}" | jq -r '.request_id // ""' 2>/dev/null) || request_id=""
    phase=$(printf '%s' "${ctx_json}" | jq -r '.phase // ""' 2>/dev/null) || phase=""
    failure_mode=$(printf '%s' "${ctx_json}" | jq -r '.mode_id // "null"' 2>/dev/null) || failure_mode="null"
    evidence=$(printf '%s' "${ctx_json}" | jq -c '.evidence // {}' 2>/dev/null) || evidence="{}"

    local remediation_planned
    if [[ -n "${policy}" ]]; then
        remediation_planned="\"${policy}\""
    else
        remediation_planned="null"
    fi

    # Handle failure_mode null vs string
    local failure_mode_json
    if [[ "${failure_mode}" == "null" || -z "${failure_mode}" ]]; then
        failure_mode_json="null"
    else
        failure_mode_json="\"${failure_mode}\""
    fi

    local event_line
    event_line=$(jq -n \
        --argjson sv 1 \
        --arg ts "${ts}" \
        --arg type "${event_type}" \
        --arg req "${request_id}" \
        --arg phase "${phase}" \
        --argjson fm "${failure_mode_json}" \
        --argjson ev "${evidence}" \
        --argjson rp "${remediation_planned}" \
        '{
            schema_version: $sv,
            timestamp: $ts,
            type: $type,
            request_id: $req,
            phase: $phase,
            failure_mode: $fm,
            evidence: $ev,
            remediation_planned: $rp
        }' 2>/dev/null) || return 0

    # Optional schema validation
    if [[ "${AUTONOMOUS_DEV_SELF_HEAL_VALIDATE_SCHEMA:-1}" == "1" ]]; then
        _selfheal_validate_schema "${event_type}" "${event_line}" || true
    fi

    # Ensure events_file directory exists
    local events_dir
    events_dir=$(dirname "${events_file}")
    mkdir -p "${events_dir}" 2>/dev/null || true

    # Append with flock (or noclobber fallback)
    _selfheal_append_event_line "${events_file}" "${event_line}"
    return 0
}

# _selfheal_validate_schema(event_type, event_line) -> 0 (always)
#   Validates the event against its schema. Logs a warning on failure.
_selfheal_validate_schema() {
    local event_type="${1:-}"
    local event_line="${2:-}"

    # Find schema path relative to plugin dir
    local plugin_dir
    plugin_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
    local schema_file="${plugin_dir}/../../docs/schemas/events/${event_type}.schema.json"

    if [[ ! -f "${schema_file}" ]]; then
        return 0  # No schema to validate against
    fi

    if ! command -v ajv >/dev/null 2>&1; then
        # One-time warning at first absence (suppressed on subsequent calls)
        log_warn "selfheal: ajv not found; skipping schema validation for ${event_type}" 2>/dev/null || true
        return 0
    fi

    local tmp_event
    tmp_event=$(mktemp) || return 0
    printf '%s\n' "${event_line}" > "${tmp_event}"

    if ! ajv validate -s "${schema_file}" -d "${tmp_event}" >/dev/null 2>&1; then
        log_warn "schema_violation event=${event_type} reason=ajv_validation_failed" 2>/dev/null || true
    fi

    rm -f "${tmp_event}" 2>/dev/null || true
    return 0
}

# _selfheal_append_event_line(events_file, line) -> 0
#   Appends a JSON line to events_file using flock if available, else noclobber.
_selfheal_append_event_line() {
    local events_file="${1:-}"
    local line="${2:-}"

    [[ -n "${events_file}" && -n "${line}" ]] || return 0

    if command -v flock >/dev/null 2>&1; then
        (
            flock -w 1 200 || true
            printf '%s\n' "${line}" >> "${events_file}"
        ) 200>"${events_file}.lock"
    else
        # macOS fallback: set -C (noclobber) lock-file pattern
        (
            set -C
            until : > "${events_file}.lock" 2>/dev/null; do sleep 0.05; done
            trap 'rm -f "${events_file}.lock"' EXIT
            printf '%s\n' "${line}" >> "${events_file}"
        )
    fi
    return 0
}

# selfheal_emit_summary(request_id, project, [terminal_status]) -> 0
#
#   Reads all events from events.jsonl and counts detections and remediation
#   outcomes. Appends ONE self_heal_summary event.
selfheal_emit_summary() {
    local request_id="${1:-}"
    local project="${2:-}"
    local terminal_status="${3:-}"

    [[ -n "${request_id}" && -n "${project}" ]] || return 0

    local events_file="${project}/.autonomous-dev/requests/${request_id}/events.jsonl"
    [[ -f "${events_file}" ]] || return 0

    # Detection event types (F1..F9)
    local -a detection_types=(
        review_gate_loop_detected
        reviewer_timeout_repeated
        phase_timeout_with_progress
        reviewer_error_detected
        suspicious_empty_result
        suspicious_fast_result
        verification_false_negative_detected
        novel_failure_detected
        state_ledger_drift_detected
    )

    # Build detection counts
    local detections_json="{}"
    local mode_num=1
    for dt in "${detection_types[@]}"; do
        local cnt
        cnt=$(grep -c "\"type\":\"${dt}\"" "${events_file}" 2>/dev/null) || cnt=0
        detections_json=$(printf '%s' "${detections_json}" | jq \
            --arg k "F${mode_num}" \
            --argjson v "${cnt}" \
            '. + {($k): $v}' 2>/dev/null) || true
        mode_num=$((mode_num + 1))
    done

    # Build remediation succeeded/declined counts
    local policies=(
        R_FALL_BACK_TO_SINGLE_REVIEWER
        R_ESCALATE_REVIEWER_TIMEOUT
        R_EXTEND_PHASE_BUDGET
        R_RETRY_ONCE_THEN_EXCLUDE_IF_NON_BLOCKING
        R_REQUEUE_AUTHOR_PHASE_ONCE
        R_SELF_VERIFY
        R_CAPTURE_AND_PAUSE
        R_RECONCILE_LEDGER
    )

    local remediations_succeeded_json="{}"
    local remediations_declined_json="{}"
    for policy in "${policies[@]}"; do
        local sc dc
        sc=$(grep -c "\"type\":\"${policy}_succeeded\"" "${events_file}" 2>/dev/null) || sc=0
        dc=$(grep -c "\"type\":\"${policy}_declined\"" "${events_file}" 2>/dev/null) || dc=0
        remediations_succeeded_json=$(printf '%s' "${remediations_succeeded_json}" | jq \
            --arg k "${policy}" \
            --argjson v "${sc}" \
            '. + {($k): $v}' 2>/dev/null) || true
        remediations_declined_json=$(printf '%s' "${remediations_declined_json}" | jq \
            --arg k "${policy}" \
            --argjson v "${dc}" \
            '. + {($k): $v}' 2>/dev/null) || true
    done

    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    local terminal_json
    if [[ -n "${terminal_status}" ]]; then
        terminal_json="\"${terminal_status}\""
    else
        terminal_json="null"
    fi

    local summary_event
    summary_event=$(jq -n \
        --argjson sv 1 \
        --arg ts "${ts}" \
        --arg type "self_heal_summary" \
        --arg req "${request_id}" \
        --argjson det "${detections_json}" \
        --argjson rs "${remediations_succeeded_json}" \
        --argjson rd "${remediations_declined_json}" \
        --argjson term "${terminal_json}" \
        '{
            schema_version: $sv,
            timestamp: $ts,
            type: $type,
            request_id: $req,
            phase: "terminal",
            failure_mode: null,
            evidence: {
                detections: $det,
                remediations_succeeded: $rs,
                remediations_declined: $rd,
                terminal_status: $term
            },
            remediation_planned: null
        }' 2>/dev/null) || return 0

    _selfheal_append_event_line "${events_file}" "${summary_event}"
    return 0
}
