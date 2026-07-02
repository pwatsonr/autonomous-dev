#!/usr/bin/env bash
###############################################################################
# self-heal.sh — Self-Healing Pipeline: Dispatch Table + Detectors/Remediators
#
# REQ-000056 | TASK-001..TASK-014
#
# Implements the 9-mode failure-detection and auto-remediation dispatch table
# for the autonomous-dev supervisor loop. Sourced by supervisor-loop.sh at
# startup alongside lib/typed-limits.sh.
#
# CONCURRENCY MODEL (READ THIS):
#   The autonomous-dev supervisor loop is STRICTLY SINGLE-THREADED: it processes
#   one request × one phase × one dispatch at a time. selfheal_dispatch is
#   therefore invoked sequentially, and only one detect_*/remediate_* pair is
#   in flight in the bash process at any moment.
#
#   _selfheal_safe_call (§3.3) uses a brace group { ; } with || rc=$? capture
#   rather than a ( ) subshell precisely so the callee's assignment to
#   _SELFHEAL_LAST_EVIDENCE is visible to the dispatcher in the same shell.
#   Switching to a subshell would silently break evidence round-trip.
#
#   FUTURE-MISUSE WARNING: any change that introduces xargs -P, & backgrounding,
#   parallel "for ... &" over multiple requests, or any code path that forks the
#   supervisor into concurrent dispatchers in the SAME bash process will break
#   this invariant and MUST replace the global with a stdout-passed JSON string
#   from detector to dispatcher.
#
###############################################################################

# ---------------------------------------------------------------------------
# Environment defaults (assigned at module source — TC-002)
# ---------------------------------------------------------------------------
: "${AUTONOMOUS_DEV_SELF_HEAL:=1}"
: "${AUTONOMOUS_DEV_SELF_HEAL_MIN_PHASE_DURATION_SECONDS:=5}"
: "${AUTONOMOUS_DEV_SELF_HEAL_REVIEW_LOOP_THRESHOLD:=3}"
: "${AUTONOMOUS_DEV_SELF_HEAL_REVIEWER_TIMEOUT_THRESHOLD:=2}"
: "${AUTONOMOUS_DEV_SELF_HEAL_BUDGET_EXTENSION_FACTOR:=1.5}"
: "${AUTONOMOUS_DEV_SELF_HEAL_REVIEWER_TIMEOUT_MULTIPLIER:=2}"
: "${AUTONOMOUS_DEV_SELF_HEAL_DIAG_BUNDLE_MAX_BYTES:=1048576}"
: "${AUTONOMOUS_DEV_SELF_HEAL_SUSPICIOUS_FAST_RATIO:=10}"
: "${AUTONOMOUS_DEV_SELF_HEAL_VALIDATE_SCHEMA:=1}"
: "${AUTONOMOUS_DEV_SELF_HEAL_FILE_ISSUES:=0}"
: "${AUTONOMOUS_DEV_SELF_HEAL_ISSUE_REPO:=autonomous-dev}"

# ---------------------------------------------------------------------------
# Env allow-list for diagnostic bundle (§8.7 / TASK-005)
# ---------------------------------------------------------------------------
SELFHEAL_ENV_ALLOWLIST=(
    AUTONOMOUS_DEV_SELF_HEAL
    AUTONOMOUS_DEV_SELF_HEAL_MIN_PHASE_DURATION_SECONDS
    AUTONOMOUS_DEV_SELF_HEAL_REVIEW_LOOP_THRESHOLD
    AUTONOMOUS_DEV_SELF_HEAL_REVIEWER_TIMEOUT_THRESHOLD
    AUTONOMOUS_DEV_SELF_HEAL_BUDGET_EXTENSION_FACTOR
    AUTONOMOUS_DEV_SELF_HEAL_REVIEWER_TIMEOUT_MULTIPLIER
    AUTONOMOUS_DEV_SELF_HEAL_DIAG_BUNDLE_MAX_BYTES
    AUTONOMOUS_DEV_SELF_HEAL_SUSPICIOUS_FAST_RATIO
    AUTONOMOUS_DEV_SELF_HEAL_VALIDATE_SCHEMA
    AUTONOMOUS_DEV_SELF_HEAL_FILE_ISSUES
    AUTONOMOUS_DEV_SELF_HEAL_ISSUE_REPO
    AUTONOMOUS_DEV_STATE_DIR
    AUTONOMOUS_DEV_MAX_SOFT_TIMEOUT_REENTRIES
)

# ---------------------------------------------------------------------------
# Integration-point → ordered mode IDs (§3.4)
# ---------------------------------------------------------------------------
_SELFHEAL_DISPATCH_REVIEW_OUTCOME=(F1 F2 F4)
_SELFHEAL_DISPATCH_SESSION_OUTCOME=(F5 F6)
_SELFHEAL_DISPATCH_ADVANCE_PHASE=(F7 F8)
_SELFHEAL_DISPATCH_PHASE_TIMEOUT=(F3)
_SELFHEAL_DISPATCH_LEDGER_CHECK=(F9)

# Process-global evidence carrier (safe under single-threaded supervisor model)
_SELFHEAL_LAST_EVIDENCE='{}'

###############################################################################
# SECTION 1: Core dispatch infrastructure
###############################################################################

# selfheal_is_enabled() -> 0|1
#   Returns 0 if AUTONOMOUS_DEV_SELF_HEAL is set to the string "1", else 1.
selfheal_is_enabled() {
    [[ "${AUTONOMOUS_DEV_SELF_HEAL:-1}" == "1" ]]
}

# _selfheal_table_lookup(mode_id) -> 0|1
#   Pure lookup. Prints to stdout: "<detector>|<event_type>|<remediator>|<policy>"
#   Returns 1 (no output) for an unknown mode.
_selfheal_table_lookup() {
    local mode_id="${1:-}"
    case "${mode_id}" in
        F1) printf '%s\n' "detect_review_gate_loop|review_gate_loop_detected|remediate_fall_back_to_single_reviewer|R_FALL_BACK_TO_SINGLE_REVIEWER" ;;
        F2) printf '%s\n' "detect_reviewer_timeout_repeated|reviewer_timeout_repeated|remediate_escalate_reviewer_timeout|R_ESCALATE_REVIEWER_TIMEOUT" ;;
        F3) printf '%s\n' "detect_phase_timeout_with_progress|phase_timeout_with_progress|remediate_extend_phase_budget|R_EXTEND_PHASE_BUDGET" ;;
        F4) printf '%s\n' "detect_reviewer_error|reviewer_error_detected|remediate_retry_then_exclude|R_RETRY_ONCE_THEN_EXCLUDE_IF_NON_BLOCKING" ;;
        F5) printf '%s\n' "detect_suspicious_empty|suspicious_empty_result|remediate_requeue_author_phase_once|R_REQUEUE_AUTHOR_PHASE_ONCE" ;;
        F6) printf '%s\n' "detect_suspicious_fast|suspicious_fast_result|remediate_requeue_author_phase_once|R_REQUEUE_AUTHOR_PHASE_ONCE" ;;
        F7) printf '%s\n' "detect_verification_false_negative|verification_false_negative_detected|remediate_self_verify|R_SELF_VERIFY" ;;
        F8) printf '%s\n' "detect_novel_failure|novel_failure_detected|remediate_capture_and_pause|R_CAPTURE_AND_PAUSE" ;;
        F9) printf '%s\n' "detect_state_ledger_drift|state_ledger_drift_detected|remediate_reconcile_ledger|R_RECONCILE_LEDGER" ;;
        *) return 1 ;;
    esac
}

# _selfheal_safe_call(fn_name, [args...]) -> int
#   Invokes "$fn_name" "$@" inside a brace group with || rc-capture (NOT a
#   subshell) so that a set -e failure inside the callee does not unwind
#   the supervisor loop AND the callee can still write to _SELFHEAL_LAST_EVIDENCE.
_selfheal_safe_call() {
    local fn="$1"; shift
    local rc=0
    _SELFHEAL_LAST_EVIDENCE='{}'
    # Brace group (not subshell) so evidence assignment persists in caller's env.
    { "$fn" "$@"; rc=$?; } || rc=$?
    return "${rc}"
}

# selfheal_dispatch(integration_point, ctx_json) -> 0|1|2
#   Main dispatch function called from supervisor-loop.sh integration hooks.
selfheal_dispatch() {
    local integration_point="${1:-}"
    local ctx_json="${2:-{}}"

    # Kill-switch bypass
    if ! selfheal_is_enabled; then
        return 1
    fi

    # Map integration_point to ordered mode list
    local -a modes=()
    case "${integration_point}" in
        review_outcome) modes=("${_SELFHEAL_DISPATCH_REVIEW_OUTCOME[@]}")     ;;
        session_outcome) modes=("${_SELFHEAL_DISPATCH_SESSION_OUTCOME[@]}")   ;;
        advance_phase)  modes=("${_SELFHEAL_DISPATCH_ADVANCE_PHASE[@]}")      ;;
        phase_timeout)  modes=("${_SELFHEAL_DISPATCH_PHASE_TIMEOUT[@]}")      ;;
        ledger_check)   modes=("${_SELFHEAL_DISPATCH_LEDGER_CHECK[@]}")       ;;
        *)
            log_warn "selfheal_dispatch: unknown integration_point=${integration_point}" 2>/dev/null || true
            return 1
            ;;
    esac

    local any_succeeded=0
    local mode_id row detector event_type remediator policy
    local det_rc rem_rc

    for mode_id in "${modes[@]}"; do
        row=""
        if ! row=$(_selfheal_table_lookup "${mode_id}"); then
            continue
        fi

        detector="${row%%|*}"; row="${row#*|}"
        event_type="${row%%|*}"; row="${row#*|}"
        remediator="${row%%|*}"
        policy="${row##*|}"

        # Inject mode_id into ctx_json
        local ctx_with_mode
        ctx_with_mode=$(printf '%s' "${ctx_json}" | jq --arg m "${mode_id}" '. + {mode_id: $m}' 2>/dev/null) || ctx_with_mode="${ctx_json}"

        # Run detector
        det_rc=0
        _selfheal_safe_call "${detector}" "${ctx_with_mode}" || det_rc=$?

        if [[ "${det_rc}" -ge 2 ]]; then
            # Detector threw internal error — fall through to capture+pause
            local err_ctx
            err_ctx=$(printf '%s' "${ctx_with_mode}" | jq \
                --arg r "detector_threw" \
                --arg m "${mode_id}" \
                '. + {paused_reason: ("detector_threw:" + $m), mode_id: $m}' 2>/dev/null) || err_ctx="${ctx_with_mode}"
            remediate_capture_and_pause "${err_ctx}" || true
            return 2
        elif [[ "${det_rc}" -eq 1 ]]; then
            # Not detected — continue to next mode
            continue
        fi

        # Detected (det_rc=0) — merge evidence from global into ctx
        local ctx_with_evidence
        ctx_with_evidence=$(printf '%s' "${ctx_with_mode}" | jq \
            --argjson ev "${_SELFHEAL_LAST_EVIDENCE}" \
            '. + {evidence: $ev}' 2>/dev/null) || ctx_with_evidence="${ctx_with_mode}"

        # Emit detection event
        selfheal_emit_event "${event_type}" "${ctx_with_evidence}" "${policy}" || true

        # Run remediator
        rem_rc=0
        _selfheal_safe_call "${remediator}" "${ctx_with_evidence}" || rem_rc=$?

        if [[ "${rem_rc}" -ge 2 ]]; then
            local err_ctx2
            err_ctx2=$(printf '%s' "${ctx_with_evidence}" | jq \
                --arg r "remediator_threw:${mode_id}" \
                '. + {paused_reason: $r}' 2>/dev/null) || err_ctx2="${ctx_with_evidence}"
            remediate_capture_and_pause "${err_ctx2}" || true
            return 2
        elif [[ "${rem_rc}" -eq 0 ]]; then
            selfheal_emit_event "${policy}_succeeded" "${ctx_with_evidence}" || true
            any_succeeded=1
        else
            selfheal_emit_event "${policy}_declined" "${ctx_with_evidence}" || true
        fi
    done

    if [[ "${any_succeeded}" -eq 1 ]]; then
        return 0
    fi
    return 1
}

###############################################################################
# SECTION 2: Detectors (F1..F9)
###############################################################################

# detect_review_gate_loop(ctx_json) -> 0|1|2  [F1]
detect_review_gate_loop() {
    local ctx_json="${1:-{}}"

    local gate_decision state_file request_id phase
    gate_decision=$(printf '%s' "${ctx_json}" | jq -r '.gate_decision // empty' 2>/dev/null) || return 1
    state_file=$(printf '%s' "${ctx_json}" | jq -r '.state_file // empty' 2>/dev/null) || return 1
    request_id=$(printf '%s' "${ctx_json}" | jq -r '.request_id // empty' 2>/dev/null) || return 1
    phase=$(printf '%s' "${ctx_json}" | jq -r '.phase // empty' 2>/dev/null) || return 1

    [[ -n "${gate_decision}" && -n "${state_file}" && -f "${state_file}" ]] || return 1

    # Check outcome
    local outcome
    outcome=$(printf '%s' "${gate_decision}" | jq -r '.outcome // empty' 2>/dev/null) || return 1
    [[ "${outcome}" == "REQUEST_CHANGES" ]] || return 1

    # Get reviewer name
    local reviewer
    reviewer=$(printf '%s' "${gate_decision}" | jq -r '.results[0].reviewer_name // empty' 2>/dev/null) || return 1
    [[ -n "${reviewer}" ]] || return 1

    # Compute fingerprint of reason (first 256 bytes via sha256)
    local reason fingerprint
    reason=$(printf '%s' "${gate_decision}" | jq -r '.reason // .results[0].error_message // ""' 2>/dev/null) || reason=""
    fingerprint=$(printf '%s' "${reason}" | head -c 256 | shasum -a 256 | cut -d' ' -f1)

    # Read prior state
    local prior_json prior_count prior_fp
    prior_json=$(selfheal_state_get "${state_file}" "review_loop.${reviewer}" 2>/dev/null) || prior_json=""
    if [[ -n "${prior_json}" && "${prior_json}" != "null" ]]; then
        prior_count=$(printf '%s' "${prior_json}" | jq -r '.count // 0' 2>/dev/null) || prior_count=0
        prior_fp=$(printf '%s' "${prior_json}" | jq -r '.last_reason_fingerprint // ""' 2>/dev/null) || prior_fp=""
    else
        prior_count=0
        prior_fp=""
    fi

    local count
    if [[ "${prior_fp}" == "${fingerprint}" ]]; then
        count=$((prior_count + 1))
    else
        count=1
    fi

    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Persist updated state
    local new_state
    new_state=$(jq -n \
        --argjson c "${count}" \
        --arg fp "${fingerprint}" \
        --arg ts "${now}" \
        '{count: $c, last_reason_fingerprint: $fp, last_seen_at: $ts}')
    selfheal_state_set "${state_file}" "review_loop.${reviewer}" "${new_state}" || true

    if [[ "${count}" -ge "${AUTONOMOUS_DEV_SELF_HEAL_REVIEW_LOOP_THRESHOLD}" ]]; then
        _SELFHEAL_LAST_EVIDENCE=$(jq -n \
            --arg rev "${reviewer}" \
            --arg fp "${fingerprint}" \
            --argjson c "${count}" \
            --arg ts "${now}" \
            '{reviewer: $rev, fingerprint: $fp, count: $c, last_seen_at: $ts}')
        return 0
    fi
    return 1
}

# detect_reviewer_timeout_repeated(ctx_json) -> 0|1|2  [F2]
detect_reviewer_timeout_repeated() {
    local ctx_json="${1:-{}}"

    local gate_decision reviewer_name state_file
    gate_decision=$(printf '%s' "${ctx_json}" | jq -c '.gate_decision // empty' 2>/dev/null) || return 1
    reviewer_name=$(printf '%s' "${ctx_json}" | jq -r '.reviewer_name // empty' 2>/dev/null) || return 1
    state_file=$(printf '%s' "${ctx_json}" | jq -r '.state_file // empty' 2>/dev/null) || return 1

    [[ -n "${gate_decision}" && -n "${reviewer_name}" && -n "${state_file}" && -f "${state_file}" ]] || return 1

    local error_kind
    error_kind=$(printf '%s' "${gate_decision}" | \
        jq -r --arg rev "${reviewer_name}" \
        '.results[] | select(.reviewer_name==$rev) | .error_kind // empty' 2>/dev/null | head -1) || return 1
    [[ "${error_kind}" == "reviewer_timeout" ]] || return 1

    # Read and increment timeout count
    local cur_count
    cur_count=$(selfheal_state_get "${state_file}" "reviewer_timeouts.${reviewer_name}" 2>/dev/null) || cur_count="0"
    [[ -n "${cur_count}" && "${cur_count}" != "null" ]] || cur_count=0
    cur_count=$((cur_count + 1))
    selfheal_state_set "${state_file}" "reviewer_timeouts.${reviewer_name}" "${cur_count}" || true

    # Get current timeout
    local current_timeout
    current_timeout=$(selfheal_state_get "${state_file}" "reviewer_timeout_overrides.${reviewer_name}" 2>/dev/null) || current_timeout=""
    [[ -n "${current_timeout}" && "${current_timeout}" != "null" ]] || current_timeout="900"

    if [[ "${cur_count}" -ge "${AUTONOMOUS_DEV_SELF_HEAL_REVIEWER_TIMEOUT_THRESHOLD}" ]]; then
        _SELFHEAL_LAST_EVIDENCE=$(jq -n \
            --arg rev "${reviewer_name}" \
            --argjson tc "${cur_count}" \
            --argjson ct "${current_timeout}" \
            '{reviewer: $rev, timeout_count: $tc, current_timeout_seconds: $ct}')
        return 0
    fi
    return 1
}

# detect_phase_timeout_with_progress(ctx_json) -> 0|1|2  [F3]
detect_phase_timeout_with_progress() {
    local ctx_json="${1:-{}}"

    local pre_tree post_tree elapsed timeout_seconds
    pre_tree=$(printf '%s' "${ctx_json}" | jq -r '.pre_tree // empty' 2>/dev/null) || return 1
    post_tree=$(printf '%s' "${ctx_json}" | jq -r '.post_tree // empty' 2>/dev/null) || return 1
    elapsed=$(printf '%s' "${ctx_json}" | jq -r '.elapsed_seconds // empty' 2>/dev/null) || return 1
    timeout_seconds=$(printf '%s' "${ctx_json}" | jq -r '.timeout_seconds // empty' 2>/dev/null) || return 1

    [[ -n "${pre_tree}" && -n "${post_tree}" ]] || return 1

    # Call existing working_tree_advanced function
    if working_tree_advanced "${pre_tree}" "${post_tree}" 2>/dev/null; then
        _SELFHEAL_LAST_EVIDENCE=$(jq -n \
            --arg pre "${pre_tree}" \
            --arg post "${post_tree}" \
            --argjson el "${elapsed:-0}" \
            --argjson to "${timeout_seconds:-0}" \
            '{pre_tree: $pre, post_tree: $post, elapsed_seconds: $el, timeout_seconds: $to}')
        return 0
    fi
    return 1
}

# detect_reviewer_error(ctx_json) -> 0|1|2  [F4]
detect_reviewer_error() {
    local ctx_json="${1:-{}}"

    local result_file reviewer_name
    result_file=$(printf '%s' "${ctx_json}" | jq -r '.result_file // empty' 2>/dev/null) || return 1
    reviewer_name=$(printf '%s' "${ctx_json}" | jq -r '.reviewer_name // ""' 2>/dev/null) || reviewer_name=""

    [[ -n "${result_file}" && -f "${result_file}" ]] || return 1

    local status
    status=$(jq -r '.status // empty' "${result_file}" 2>/dev/null) || return 1
    [[ "${status}" == "error" ]] || return 1

    local reason
    reason=$(jq -r '.status_reason // ""' "${result_file}" 2>/dev/null) || reason=""

    case "${reason}" in
        REVIEW_GATE_CLI_NONZERO|REVIEW_GATE_BAD_JSON|REVIEW_GATE_RESULT_WRITE_FAILED) ;;
        *) return 1 ;;
    esac

    local exit_code stdout_head
    exit_code=$(jq '.exit_code // null' "${result_file}" 2>/dev/null) || exit_code="null"
    stdout_head=$(jq -r '.stdout // ""' "${result_file}" 2>/dev/null | head -c 1024) || stdout_head=""

    _SELFHEAL_LAST_EVIDENCE=$(jq -n \
        --arg rev "${reviewer_name}" \
        --arg sr "${reason}" \
        --argjson ec "${exit_code}" \
        --arg sh "${stdout_head}" \
        '{reviewer_name: (if $rev == "" then null else $rev end), status_reason: $sr, exit_code: $ec, stdout_head: $sh}')
    return 0
}

# detect_suspicious_empty(ctx_json) -> 0|1|2  [F5]
detect_suspicious_empty() {
    local ctx_json="${1:-{}}"

    local result_file session_log_path phase
    result_file=$(printf '%s' "${ctx_json}" | jq -r '.result_file // empty' 2>/dev/null) || return 1
    session_log_path=$(printf '%s' "${ctx_json}" | jq -r '.session_log_path // empty' 2>/dev/null) || return 1
    phase=$(printf '%s' "${ctx_json}" | jq -r '.phase // empty' 2>/dev/null) || return 1

    [[ -n "${result_file}" && -f "${result_file}" ]] || return 1

    # Only for author phases
    case "${phase}" in
        prd|tdd|plan|spec|code) ;;
        *) return 1 ;;
    esac

    local status artifact_count
    status=$(jq -r '.status // empty' "${result_file}" 2>/dev/null) || return 1
    [[ "${status}" == "pass" ]] || return 1

    artifact_count=$(jq '(.artifacts // []) | length' "${result_file}" 2>/dev/null) || return 1

    # Compute session duration (mtime difference)
    local session_duration
    if [[ -f "${session_log_path}" ]]; then
        local rf_mtime sl_mtime
        rf_mtime=$(stat -f '%m' "${result_file}" 2>/dev/null || stat -c '%Y' "${result_file}" 2>/dev/null) || return 1
        sl_mtime=$(stat -f '%m' "${session_log_path}" 2>/dev/null || stat -c '%Y' "${session_log_path}" 2>/dev/null) || return 1
        session_duration=$((rf_mtime - sl_mtime))
    else
        return 1
    fi

    local threshold="${AUTONOMOUS_DEV_SELF_HEAL_MIN_PHASE_DURATION_SECONDS}"
    if [[ "${artifact_count}" -eq 0 && "${session_duration}" -lt "${threshold}" ]]; then
        _SELFHEAL_LAST_EVIDENCE=$(jq -n \
            --arg ph "${phase}" \
            --argjson ac "${artifact_count}" \
            --argjson sd "${session_duration}" \
            --argjson th "${threshold}" \
            '{phase: $ph, artifact_count: $ac, session_duration_seconds: $sd, threshold: $th}')
        return 0
    fi
    return 1
}

# detect_suspicious_fast(ctx_json) -> 0|1|2  [F6]
#   NOTE: request_type is intentionally unused — baselines are keyed by phase only (TC-044).
detect_suspicious_fast() {
    local ctx_json="${1:-{}}"

    local result_file session_log_path phase
    result_file=$(printf '%s' "${ctx_json}" | jq -r '.result_file // empty' 2>/dev/null) || return 1
    session_log_path=$(printf '%s' "${ctx_json}" | jq -r '.session_log_path // empty' 2>/dev/null) || return 1
    phase=$(printf '%s' "${ctx_json}" | jq -r '.phase // empty' 2>/dev/null) || return 1

    [[ -n "${result_file}" && -f "${result_file}" && -f "${session_log_path}" ]] || return 1

    # Compute session duration
    local rf_mtime sl_mtime session_duration
    rf_mtime=$(stat -f '%m' "${result_file}" 2>/dev/null || stat -c '%Y' "${result_file}" 2>/dev/null) || return 1
    sl_mtime=$(stat -f '%m' "${session_log_path}" 2>/dev/null || stat -c '%Y' "${session_log_path}" 2>/dev/null) || return 1
    session_duration=$((rf_mtime - sl_mtime))

    # Read baseline — keyed by phase ONLY (request_type is intentionally unused per §7.6)
    local state_dir="${AUTONOMOUS_DEV_STATE_DIR:-${HOME}/.autonomous-dev}"
    local medians_file="${state_dir}/self-heal/phase-duration-medians.json"
    [[ -f "${medians_file}" ]] || return 1

    local baseline
    baseline=$(jq --arg p "${phase}" '.[$p] // empty' "${medians_file}" 2>/dev/null) || return 1
    # Reject non-number and nested objects (compound shape)
    if [[ -z "${baseline}" || "${baseline}" == "null" ]]; then
        return 1
    fi
    # If baseline is an object (compound/nested shape), treat as missing
    if printf '%s' "${baseline}" | jq -e 'type == "object"' >/dev/null 2>&1; then
        return 1
    fi

    local baseline_int
    baseline_int=$(printf '%s' "${baseline}" | jq -r '.' 2>/dev/null) || return 1
    [[ "${baseline_int}" -gt 0 ]] 2>/dev/null || return 1

    local threshold_int
    threshold_int="${AUTONOMOUS_DEV_SELF_HEAL_MIN_PHASE_DURATION_SECONDS}"
    local ratio="${AUTONOMOUS_DEV_SELF_HEAL_SUSPICIOUS_FAST_RATIO}"

    # Check: session_duration < (baseline / ratio) AND session_duration < threshold
    local cutoff
    cutoff=$(awk "BEGIN{printf \"%d\n\", ${baseline_int}/${ratio}}")

    if [[ "${session_duration}" -lt "${cutoff}" && "${session_duration}" -lt "${threshold_int}" ]]; then
        _SELFHEAL_LAST_EVIDENCE=$(jq -n \
            --arg ph "${phase}" \
            --argjson sd "${session_duration}" \
            --argjson bl "${baseline_int}" \
            --argjson rt "${ratio}" \
            '{phase: $ph, session_duration_seconds: $sd, baseline_seconds: $bl, ratio: $rt}')
        return 0
    fi
    return 1
}

# detect_verification_false_negative(ctx_json) -> 0|1|2  [F7]
detect_verification_false_negative() {
    # REQ-000058: avoid bash ${var:-{}} brace-parsing bug (trailing literal `}`
    # is appended when $1 is set, making ctx_json invalid JSON that causes jq
    # to exit non-zero).  Use explicit empty-check instead.
    local ctx_json="${1}"
    [[ -z "${ctx_json}" ]] && ctx_json="{}"

    local result_file project phase phase_started_at
    result_file=$(printf '%s' "${ctx_json}" | jq -r '.result_file // empty' 2>/dev/null) || return 1
    project=$(printf '%s' "${ctx_json}" | jq -r '.project // empty' 2>/dev/null) || return 1
    phase=$(printf '%s' "${ctx_json}" | jq -r '.phase // empty' 2>/dev/null) || return 1
    phase_started_at=$(printf '%s' "${ctx_json}" | jq -r '.phase_started_at // empty' 2>/dev/null) || return 1

    [[ -n "${result_file}" && -f "${result_file}" ]] || return 1

    local status
    status=$(jq -r '.status // empty' "${result_file}" 2>/dev/null) || return 1
    [[ "${status}" == "fail" ]] || return 1

    local reason
    reason=$(jq -r '.status_reason // ""' "${result_file}" 2>/dev/null) || reason=""

    local request_id
    request_id=$(printf '%s' "${ctx_json}" | jq -r '.request_id // empty' 2>/dev/null) || request_id=""

    # Locate test-result artifact
    local artifact_path=""
    local from_result
    from_result=$(jq -r '.test_results_path // .test_artifact // empty' "${result_file}" 2>/dev/null) || from_result=""
    if [[ -n "${from_result}" ]]; then
        artifact_path="${from_result}"
    else
        # Try to extract from reason string
        local extracted
        extracted=$(printf '%s' "${reason}" | grep -oE '[A-Za-z0-9_/.\-]+test-results\.json' | head -1) || extracted=""
        if [[ -n "${extracted}" ]]; then
            artifact_path="${extracted}"
        else
            artifact_path="${project}/.autonomous-dev/requests/${request_id}/test-results.json"
        fi
    fi

    local events_file="${project}/.autonomous-dev/requests/${request_id}/events.jsonl"

    if [[ ! -f "${artifact_path}" ]]; then
        # Emit skip event and return 1
        local skip_ctx
        skip_ctx=$(printf '%s' "${ctx_json}" | jq \
            --arg ap "${artifact_path}" \
            '. + {evidence: {artifact_path: $ap}}' 2>/dev/null) || skip_ctx="${ctx_json}"
        selfheal_emit_event "self_verify_skipped_missing_artifact" "${skip_ctx}" || true
        return 1
    fi

    # Check artifact mtime vs phase_started_at
    if [[ -n "${phase_started_at}" ]]; then
        local artifact_mtime phase_started_unix
        artifact_mtime=$(stat -f '%m' "${artifact_path}" 2>/dev/null || stat -c '%Y' "${artifact_path}" 2>/dev/null) || artifact_mtime=0
        # REQ-000058: -u flag forces UTC interpretation on macOS; GNU date
        # accepts the trailing Z natively.
        phase_started_unix=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${phase_started_at}" +%s 2>/dev/null \
            || date -d "${phase_started_at}" +%s 2>/dev/null) || phase_started_unix=0

        if [[ "${artifact_mtime}" -lt "${phase_started_unix}" ]]; then
            local stale_ctx
            stale_ctx=$(printf '%s' "${ctx_json}" | jq \
                --arg ap "${artifact_path}" \
                --argjson am "${artifact_mtime}" \
                '. + {evidence: {artifact_path: $ap, artifact_mtime_unix: $am}}' 2>/dev/null) || stale_ctx="${ctx_json}"
            selfheal_emit_event "self_verify_skipped_stale_artifact" "${stale_ctx}" || true
            return 1
        fi
    fi

    # Count failures
    local failed_count
    failed_count=$(jq '(.failures // .stats.failures // ([.tests[]? | select(.status=="failed")] | length)) // 0' \
        "${artifact_path}" 2>/dev/null) || failed_count=1

    if [[ "${failed_count}" -eq 0 ]]; then
        local artifact_mtime_str
        artifact_mtime_str=$(stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%SZ' "${artifact_path}" 2>/dev/null \
            || stat -c '%y' "${artifact_path}" 2>/dev/null | sed 's/ /T/' | cut -c1-19 | sed 's/$$/Z/') \
            || artifact_mtime_str=""
        _SELFHEAL_LAST_EVIDENCE=$(jq -n \
            --arg ap "${artifact_path}" \
            --arg am "${artifact_mtime_str}" \
            --argjson fc "${failed_count}" \
            --arg os "${status}" \
            --arg or "${reason}" \
            '{artifact_path: $ap, artifact_mtime: $am, failures: $fc, original_status: $os, original_status_reason: $or}')
        return 0
    fi
    return 1
}

# detect_novel_failure(ctx_json) -> 0|1|2  [F8]
detect_novel_failure() {
    local ctx_json="${1:-{}}"

    local result_file state_file
    result_file=$(printf '%s' "${ctx_json}" | jq -r '.result_file // empty' 2>/dev/null) || return 1
    state_file=$(printf '%s' "${ctx_json}" | jq -r '.state_file // empty' 2>/dev/null) || return 1

    local status=""
    if [[ -n "${result_file}" && -f "${result_file}" ]]; then
        status=$(jq -r '.status // ""' "${result_file}" 2>/dev/null) || status=""
    fi

    local state_parseable=false
    if [[ -n "${state_file}" && -f "${state_file}" ]]; then
        jq '.' "${state_file}" >/dev/null 2>&1 && state_parseable=true || state_parseable=false
    fi

    # If status is a known value AND state is parseable — NOT a novel failure
    case "${status}" in
        pass|fail|error|timeout)
            if [[ "${state_parseable}" == "true" ]]; then
                return 1
            fi
            ;;
    esac

    # Novel failure detected
    local missing_artifacts=()
    if [[ -z "${result_file}" || ! -f "${result_file}" ]]; then
        missing_artifacts+=("${result_file:-<unknown>}")
    fi

    local missing_json
    missing_json=$(printf '%s\n' "${missing_artifacts[@]}" | jq -R . | jq -s .)

    _SELFHEAL_LAST_EVIDENCE=$(jq -n \
        --arg os "${status}" \
        --argjson sp "${state_parseable}" \
        --argjson ma "${missing_json}" \
        '{observed_status: $os, state_parseable: $sp, missing_artifact_paths: $ma}')
    return 0
}

# detect_state_ledger_drift(ctx_json) -> 0|1|2  [F9]
detect_state_ledger_drift() {
    local ctx_json="${1:-{}}"

    local request_id state_file
    request_id=$(printf '%s' "${ctx_json}" | jq -r '.request_id // empty' 2>/dev/null) || return 1
    state_file=$(printf '%s' "${ctx_json}" | jq -r '.state_file // empty' 2>/dev/null) || return 1

    [[ -n "${request_id}" && -n "${state_file}" && -f "${state_file}" ]] || return 1

    local state_status
    state_status=$(jq -r '.status // ""' "${state_file}" 2>/dev/null) || return 1
    [[ -n "${state_status}" ]] || return 1

    # Check intake DB
    local intake_db="${INTAKE_DB:-${HOME}/.autonomous-dev/intake.db}"
    [[ -f "${intake_db}" ]] || return 1

    local db_status
    db_status=$(sqlite3 "${intake_db}" \
        "SELECT status FROM requests WHERE id='${request_id}'" 2>/dev/null) || return 1
    [[ -n "${db_status}" ]] || return 1

    if [[ "${state_status}" != "${db_status}" ]]; then
        _SELFHEAL_LAST_EVIDENCE=$(jq -n \
            --arg ss "${state_status}" \
            --arg ds "${db_status}" \
            '{state_status: $ss, db_status: $ds}')
        return 0
    fi
    return 1
}

###############################################################################
# SECTION 3: Remediators (R1..R9)
###############################################################################

# remediate_fall_back_to_single_reviewer(ctx_json) -> 0|1|2  [F1]
remediate_fall_back_to_single_reviewer() {
    local ctx_json="${1:-{}}"

    local state_file phase
    state_file=$(printf '%s' "${ctx_json}" | jq -r '.state_file // empty' 2>/dev/null) || return 2
    phase=$(printf '%s' "${ctx_json}" | jq -r '.phase // empty' 2>/dev/null) || return 2

    [[ -n "${state_file}" && -f "${state_file}" ]] || return 2

    # Idempotency check
    local already_disabled
    already_disabled=$(selfheal_state_get "${state_file}" "review_chain_disabled" 2>/dev/null) || already_disabled=""
    if [[ "${already_disabled}" == "true" ]]; then
        return 1
    fi

    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Atomically set all three fields using combined jq operation
    local tmp="${state_file}.tmp.$$"
    jq --arg ts "${now}" \
       --arg ph "${phase}" \
       '.current_phase_metadata //= {} |
        .current_phase_metadata.self_heal //= {} |
        .current_phase_metadata.self_heal.review_chain_disabled = true |
        .current_phase_metadata.self_heal.review_chain_disabled_at = $ts |
        .current_phase_metadata.self_heal.review_chain_disabled_for_phase = $ph' \
       "${state_file}" > "${tmp}" && mv "${tmp}" "${state_file}" || { rm -f "${tmp}" 2>/dev/null || true; return 2; }

    emit_alert "review_chain_disabled_for_request" \
        "Self-heal: review chain disabled for request due to repeated review-gate loop; falling back to single reviewer" \
        2>/dev/null || true

    return 0
}

# remediate_escalate_reviewer_timeout(ctx_json) -> 0|1|2  [F2]
remediate_escalate_reviewer_timeout() {
    local ctx_json="${1:-{}}"

    local state_file reviewer_name
    state_file=$(printf '%s' "${ctx_json}" | jq -r '.state_file // empty' 2>/dev/null) || return 2
    reviewer_name=$(printf '%s' "${ctx_json}" | jq -r '.reviewer_name // ""' 2>/dev/null) || reviewer_name=""

    # Get reviewer from evidence if not in ctx
    [[ -n "${reviewer_name}" ]] || reviewer_name=$(printf '%s' "${ctx_json}" | \
        jq -r '.evidence.reviewer // ""' 2>/dev/null) || reviewer_name=""

    [[ -n "${state_file}" && -f "${state_file}" && -n "${reviewer_name}" ]] || return 2

    # Check if already extended — fall through to F1 if so
    local already_extended
    already_extended=$(selfheal_state_get "${state_file}" "reviewer_timeout_extended.${reviewer_name}" 2>/dev/null) || already_extended=""
    if [[ "${already_extended}" == "true" ]]; then
        remediate_fall_back_to_single_reviewer "${ctx_json}"
        return $?
    fi

    # Compute new timeout
    local current_timeout
    current_timeout=$(selfheal_state_get "${state_file}" "reviewer_timeout_overrides.${reviewer_name}" 2>/dev/null) || current_timeout=""
    [[ -n "${current_timeout}" && "${current_timeout}" != "null" ]] || current_timeout="900"

    local new_timeout
    new_timeout=$(awk "BEGIN{printf \"%d\n\", ${current_timeout} * ${AUTONOMOUS_DEV_SELF_HEAL_REVIEWER_TIMEOUT_MULTIPLIER}}")

    # Persist
    selfheal_state_set "${state_file}" "reviewer_timeout_extended.${reviewer_name}" "true" || return 2
    selfheal_state_set "${state_file}" "reviewer_timeout_overrides.${reviewer_name}" "${new_timeout}" || return 2

    # Emit event
    local ev_ctx
    ev_ctx=$(printf '%s' "${ctx_json}" | jq \
        --arg rev "${reviewer_name}" \
        --argjson ct "${current_timeout}" \
        --argjson nt "${new_timeout}" \
        '. + {evidence: {reviewer: $rev, old_timeout: $ct, new_timeout: $nt}}' 2>/dev/null) || ev_ctx="${ctx_json}"
    selfheal_emit_event "reviewer_timeout_extended" "${ev_ctx}" || true

    return 0
}

# remediate_extend_phase_budget(ctx_json) -> 0|1|2  [F3]
remediate_extend_phase_budget() {
    local ctx_json="${1:-{}}"

    local state_file phase
    state_file=$(printf '%s' "${ctx_json}" | jq -r '.state_file // empty' 2>/dev/null) || return 2
    phase=$(printf '%s' "${ctx_json}" | jq -r '.phase // empty' 2>/dev/null) || return 2

    [[ -n "${state_file}" && -f "${state_file}" ]] || return 2

    # Idempotency: only extend once
    local budget_extended_at
    budget_extended_at=$(selfheal_state_get "${state_file}" "budget_extended_at" 2>/dev/null) || budget_extended_at=""
    if [[ -n "${budget_extended_at}" && "${budget_extended_at}" != "null" ]]; then
        return 1
    fi

    # Get current timeout
    local current
    # Source typed-limits.sh if needed to get resolve_phase_timeout
    current=$(resolve_phase_timeout "${state_file}" "${phase}" 2>/dev/null) || current=3600

    local factor="${AUTONOMOUS_DEV_SELF_HEAL_BUDGET_EXTENSION_FACTOR}"
    local new_timeout
    new_timeout=$(awk "BEGIN{printf \"%d\n\", ${current} * ${factor}}")

    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Persist self-heal fields
    selfheal_state_set "${state_file}" "budget_extended_at" "\"${now}\"" || return 2
    selfheal_state_set "${state_file}" "budget_extended_from" "${current}" || return 2
    selfheal_state_set "${state_file}" "budget_extended_to" "${new_timeout}" || return 2

    # Also update top-level phase_started_at (standard state-write pattern)
    local tmp="${state_file}.tmp.$$"
    jq --arg now "${now}" \
       '.phase_started_at = $now' \
       "${state_file}" > "${tmp}" && mv "${tmp}" "${state_file}" || { rm -f "${tmp}" 2>/dev/null || true; return 2; }

    # Emit event
    local ev_ctx
    ev_ctx=$(printf '%s' "${ctx_json}" | jq \
        --argjson fr "${current}" \
        --argjson to "${new_timeout}" \
        --argjson fc "${factor}" \
        --arg ea "${now}" \
        '. + {evidence: {from: $fr, to: $to, factor: $fc, extended_at: $ea}}' 2>/dev/null) || ev_ctx="${ctx_json}"
    selfheal_emit_event "phase_budget_extended" "${ev_ctx}" || true

    return 0
}

# remediate_retry_then_exclude(ctx_json) -> 0|1|2  [F4]
remediate_retry_then_exclude() {
    local ctx_json="${1:-{}}"

    local state_file reviewer_name project
    state_file=$(printf '%s' "${ctx_json}" | jq -r '.state_file // empty' 2>/dev/null) || return 2
    reviewer_name=$(printf '%s' "${ctx_json}" | jq -r '.reviewer_name // ""' 2>/dev/null) || reviewer_name=""
    [[ -n "${reviewer_name}" ]] || reviewer_name=$(printf '%s' "${ctx_json}" | \
        jq -r '.evidence.reviewer_name // ""' 2>/dev/null) || reviewer_name=""
    project=$(printf '%s' "${ctx_json}" | jq -r '.project // empty' 2>/dev/null) || project=""

    [[ -n "${state_file}" && -f "${state_file}" && -n "${reviewer_name}" ]] || return 2

    local cur_retry
    cur_retry=$(selfheal_state_get "${state_file}" "reviewer_retry.${reviewer_name}" 2>/dev/null) || cur_retry="0"
    [[ -n "${cur_retry}" && "${cur_retry}" != "null" ]] || cur_retry=0

    if [[ "${cur_retry}" -eq 0 ]]; then
        # First hit: schedule retry
        selfheal_state_set "${state_file}" "reviewer_retry.${reviewer_name}" "1" || return 2
        local ev_ctx
        ev_ctx=$(printf '%s' "${ctx_json}" | jq \
            --arg rev "${reviewer_name}" \
            '. + {evidence: {reviewer_name: $rev, action: "retry_scheduled"}}' 2>/dev/null) || ev_ctx="${ctx_json}"
        selfheal_emit_event "reviewer_retry_scheduled" "${ev_ctx}" || true
        return 0
    fi

    # Second hit: consult blocking field from chain config
    local request_type phase blocking="true"
    request_type=$(printf '%s' "${ctx_json}" | jq -r '.request_type // ""' 2>/dev/null) || request_type=""
    phase=$(printf '%s' "${ctx_json}" | jq -r '.phase // ""' 2>/dev/null) || phase=""

    # Derive gate name from phase (e.g. code_review -> code_review)
    local gate="${phase}"

    local chain_config_path
    if [[ -n "${project}" && -n "${request_type}" ]]; then
        chain_config_path="${project}/intake/reviewers/chains/${request_type}.json"
        if [[ -f "${chain_config_path}" ]]; then
            local found_blocking
            found_blocking=$(jq -r \
                --arg rt "${request_type}" \
                --arg g "${gate}" \
                --arg rev "${reviewer_name}" \
                '.request_types[$rt][$g][]? | select(.name==$rev) | .blocking | tostring' \
                "${chain_config_path}" 2>/dev/null | head -1) || found_blocking=""
            if [[ -n "${found_blocking}" && "${found_blocking}" != "null" ]]; then
                blocking="${found_blocking}"
            else
                # Field absent — treat as blocking=true and emit event
                local default_ctx
                default_ctx=$(printf '%s' "${ctx_json}" | jq \
                    --arg rev "${reviewer_name}" \
                    '. + {evidence: {reviewer_name: $rev, reason: "blocking_field_absent"}}' 2>/dev/null) || default_ctx="${ctx_json}"
                selfheal_emit_event "reviewer_blocking_default_assumed" "${default_ctx}" || true
                blocking="true"
            fi
        fi
    fi

    if [[ "${blocking}" == "true" ]]; then
        local block_ctx
        block_ctx=$(printf '%s' "${ctx_json}" | jq \
            --arg rev "${reviewer_name}" \
            '. + {evidence: {reviewer_name: $rev, reason: "blocking_reviewer_failed"}}' 2>/dev/null) || block_ctx="${ctx_json}"
        selfheal_emit_event "reviewer_failed_blocking" "${block_ctx}" || true
        return 1
    fi

    # Non-blocking: add to excluded_reviewers
    local excluded_json
    excluded_json=$(selfheal_state_get "${state_file}" "excluded_reviewers" 2>/dev/null) || excluded_json="[]"
    [[ -n "${excluded_json}" && "${excluded_json}" != "null" ]] || excluded_json="[]"

    local new_excluded
    new_excluded=$(printf '%s' "${excluded_json}" | jq --arg rev "${reviewer_name}" \
        '. + [$rev] | unique' 2>/dev/null) || new_excluded="[\"${reviewer_name}\"]"

    selfheal_state_set "${state_file}" "excluded_reviewers" "${new_excluded}" || return 2

    local excl_ctx
    excl_ctx=$(printf '%s' "${ctx_json}" | jq \
        --arg rev "${reviewer_name}" \
        '. + {evidence: {reviewer_name: $rev, reason: "reviewer_excluded_non_blocking"}}' 2>/dev/null) || excl_ctx="${ctx_json}"
    selfheal_emit_event "reviewer_excluded" "${excl_ctx}" || true
    return 0
}

# remediate_requeue_author_phase_once(ctx_json) -> 0|1|2  [F5/F6]
remediate_requeue_author_phase_once() {
    local ctx_json="${1:-{}}"

    local state_file result_file phase
    state_file=$(printf '%s' "${ctx_json}" | jq -r '.state_file // empty' 2>/dev/null) || return 2
    result_file=$(printf '%s' "${ctx_json}" | jq -r '.result_file // empty' 2>/dev/null) || return 2
    phase=$(printf '%s' "${ctx_json}" | jq -r '.phase // empty' 2>/dev/null) || return 2

    [[ -n "${state_file}" && -f "${state_file}" ]] || return 2

    # Idempotency: only requeue once per phase
    local already_requeued
    already_requeued=$(selfheal_state_get "${state_file}" "requeued.${phase}" 2>/dev/null) || already_requeued=""
    if [[ "${already_requeued}" == "true" ]]; then
        # Second attempt: capture and pause
        local pause_ctx
        pause_ctx=$(printf '%s' "${ctx_json}" | jq \
            '. + {paused_reason: "suspicious_previous_result: requeue exceeded"}' 2>/dev/null) || pause_ctx="${ctx_json}"
        remediate_capture_and_pause "${pause_ctx}"
        return $?
    fi

    # Determine requeue_reason from failure mode
    local mode_id
    mode_id=$(printf '%s' "${ctx_json}" | jq -r '.mode_id // "F5"' 2>/dev/null) || mode_id="F5"
    local requeue_reason="suspicious_empty"
    [[ "${mode_id}" == "F6" ]] && requeue_reason="suspicious_fast"

    # Back up result file
    if [[ -n "${result_file}" && -f "${result_file}" ]]; then
        local backup_ts
        backup_ts=$(date -u +%Y%m%dT%H%M%SZ)
        mv "${result_file}" "${result_file}.suspicious-${backup_ts}.bak" || true
    fi

    # Update state atomically
    local tmp="${state_file}.tmp.$$"
    jq --arg reason "${requeue_reason}" \
       --arg phase "${phase}" \
       '.status = "running" |
        .current_phase_metadata.dispatched_phase = null |
        .current_phase_metadata.self_heal //= {} |
        .current_phase_metadata.self_heal.suspicious_previous_result = true |
        .current_phase_metadata.self_heal.requeued[$phase] = true |
        .current_phase_metadata.self_heal.requeue_reason = ("suspicious_" + $reason)' \
       "${state_file}" > "${tmp}" && mv "${tmp}" "${state_file}" || { rm -f "${tmp}" 2>/dev/null || true; return 2; }

    local ev_ctx
    ev_ctx=$(printf '%s' "${ctx_json}" | jq \
        --arg ph "${phase}" \
        --arg reason "${requeue_reason}" \
        --arg bak "${result_file:-}.suspicious-*.bak" \
        '. + {evidence: {phase: $ph, reason: $reason, backed_up_to: $bak}}' 2>/dev/null) || ev_ctx="${ctx_json}"
    selfheal_emit_event "phase_requeued_suspicious" "${ev_ctx}" || true
    return 0
}

# remediate_self_verify(ctx_json) -> 0|1|2  [F7]
remediate_self_verify() {
    # REQ-000058: avoid bash ${var:-{}} brace-parsing bug.
    local ctx_json="${1}"
    [[ -z "${ctx_json}" ]] && ctx_json="{}"

    local result_file
    result_file=$(printf '%s' "${ctx_json}" | jq -r '.result_file // empty' 2>/dev/null) || return 2
    [[ -n "${result_file}" && -f "${result_file}" ]] || return 2

    # Idempotency
    local already_verified
    already_verified=$(jq -r '.self_verified // false' "${result_file}" 2>/dev/null) || already_verified="false"
    [[ "${already_verified}" == "true" ]] && return 1

    # Check evidence — should have 0 failures
    local failures
    failures=$(printf '%s' "${ctx_json}" | jq -r '.evidence.failures // 1' 2>/dev/null) || failures=1
    [[ "${failures}" -eq 0 ]] || return 1

    local prior_reason
    prior_reason=$(jq -r '.status_reason // ""' "${result_file}" 2>/dev/null) || prior_reason=""

    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Atomically rewrite result_file
    local tmp="${result_file}.tmp.$$"
    jq --arg ts "${now}" \
       --arg or "${prior_reason}" \
       '.status = "pass" |
        .self_verified = true |
        .original_status = "fail" |
        .original_status_reason = $or |
        .self_verified_at = $ts' \
       "${result_file}" > "${tmp}" && mv "${tmp}" "${result_file}" || { rm -f "${tmp}" 2>/dev/null || true; return 2; }

    local ev_ctx
    ev_ctx=$(printf '%s' "${ctx_json}" | jq \
        --arg ts "${now}" \
        '. + {evidence: (.evidence // {} | . + {corrected_at: $ts})}' 2>/dev/null) || ev_ctx="${ctx_json}"
    selfheal_emit_event "verification_false_negative_corrected" "${ev_ctx}" || true
    return 0
}

# remediate_capture_and_pause(ctx_json) -> 0|2  [F8 + universal fallback]
remediate_capture_and_pause() {
    local ctx_json="${1:-{}}"

    local request_id project phase state_file mode_id paused_reason
    request_id=$(printf '%s' "${ctx_json}" | jq -r '.request_id // "UNKNOWN"' 2>/dev/null) || request_id="UNKNOWN"
    project=$(printf '%s' "${ctx_json}" | jq -r '.project // ""' 2>/dev/null) || project=""
    phase=$(printf '%s' "${ctx_json}" | jq -r '.phase // "unknown"' 2>/dev/null) || phase="unknown"
    state_file=$(printf '%s' "${ctx_json}" | jq -r '.state_file // ""' 2>/dev/null) || state_file=""
    mode_id=$(printf '%s' "${ctx_json}" | jq -r '.mode_id // "F8"' 2>/dev/null) || mode_id="F8"
    paused_reason=$(printf '%s' "${ctx_json}" | jq -r '.paused_reason // ""' 2>/dev/null) || paused_reason=""
    [[ -n "${paused_reason}" ]] || paused_reason="novel_failure: ${mode_id}"

    local req_dir="${project}/.autonomous-dev/requests/${request_id}"
    local events_file="${req_dir}/events.jsonl"
    local session_log_path="${req_dir}/session-latest.txt"

    # Collect supervisor version
    local supervisor_version
    supervisor_version=$(git -C "${project:-$(pwd)}" rev-parse --short HEAD 2>/dev/null) || supervisor_version="unknown"

    # Read state JSON
    local state_json="null"
    if [[ -n "${state_file}" && -f "${state_file}" ]]; then
        state_json=$(jq '.' "${state_file}" 2>/dev/null) || state_json='"<parse_error>"'
    fi

    # Collect last 200 session log lines
    local session_log_lines=""
    if [[ -f "${session_log_path}" ]]; then
        session_log_lines=$(tail -n 200 "${session_log_path}" 2>/dev/null | jq -Rs . 2>/dev/null) || session_log_lines='""'
    else
        # Try to find most recent session log
        local latest_log
        latest_log=$(ls -t "${req_dir}/session-"*.txt 2>/dev/null | head -1) || latest_log=""
        if [[ -n "${latest_log}" ]]; then
            session_log_lines=$(tail -n 200 "${latest_log}" 2>/dev/null | jq -Rs . 2>/dev/null) || session_log_lines='""'
        else
            session_log_lines='""'
        fi
    fi

    # Collect last 50 events
    local last_50_events="[]"
    if [[ -f "${events_file}" ]]; then
        last_50_events=$(tail -n 50 "${events_file}" 2>/dev/null | while IFS= read -r line; do
            if printf '%s' "${line}" | jq '.' >/dev/null 2>&1; then
                printf '%s' "${line}"
            else
                jq -n --arg l "${line}" '$l'
            fi
        done | jq -s '.' 2>/dev/null) || last_50_events="[]"
    fi

    # Collect non-secret env vars (allow-list + denylist)
    local env_obj="{}"
    for var_name in "${SELFHEAL_ENV_ALLOWLIST[@]}"; do
        # Defense-in-depth: skip vars matching secret patterns
        if printf '%s' "${var_name}" | grep -qiE '(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)'; then
            continue
        fi
        local val="${!var_name:-}"
        if [[ -n "${val}" ]]; then
            env_obj=$(printf '%s' "${env_obj}" | jq \
                --arg k "${var_name}" \
                --arg v "${val}" \
                '. + {($k): $v}' 2>/dev/null) || true
        fi
    done

    # Compose initial bundle
    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local bundle_ts
    bundle_ts=$(date -u +%Y%m%dT%H%M%SZ)

    local bundle
    bundle=$(jq -n \
        --argjson schema_version 1 \
        --arg request_id "${request_id}" \
        --arg phase "${phase}" \
        --arg mode_id "${mode_id}" \
        --arg paused_reason "${paused_reason}" \
        --arg supervisor_version "${supervisor_version}" \
        --argjson state_json "${state_json}" \
        --argjson session_log "${session_log_lines}" \
        --argjson last_events "${last_50_events}" \
        --argjson non_secret_env "${env_obj}" \
        '{
            schema_version: $schema_version,
            request_id: $request_id,
            phase: $phase,
            detected_failure_mode: $mode_id,
            paused_reason_detail: $paused_reason,
            supervisor_version: $supervisor_version,
            state_json: $state_json,
            last_200_session_log_lines: $session_log,
            last_50_events: $last_events,
            non_secret_env: $non_secret_env,
            issue_filed_url: null
        }' 2>/dev/null) || { log_error "selfheal: failed to compose diagnostic bundle"; return 2; }

    # Enforce size cap: truncate session log first, then state_json if still over
    local max_bytes="${AUTONOMOUS_DEV_SELF_HEAL_DIAG_BUNDLE_MAX_BYTES}"
    local bundle_size
    bundle_size=$(printf '%s' "${bundle}" | wc -c | tr -d ' ') || bundle_size=0

    if [[ "${bundle_size}" -gt "${max_bytes}" ]]; then
        # Truncate session log
        bundle=$(printf '%s' "${bundle}" | jq \
            '. + {last_200_session_log_lines: "<truncated: bundle size exceeded cap>"}' 2>/dev/null) || true
        bundle_size=$(printf '%s' "${bundle}" | wc -c | tr -d ' ') || bundle_size=0
    fi

    if [[ "${bundle_size}" -gt "${max_bytes}" ]]; then
        # Truncate state_json
        bundle=$(printf '%s' "${bundle}" | jq \
            --arg sp "${state_file}" \
            ". + {state_json: (\"<truncated, full file at: \" + \$sp + \">\")}") || true
    fi

    # Optionally file an issue
    local issue_url="null"
    if [[ "${AUTONOMOUS_DEV_SELF_HEAL_FILE_ISSUES:-0}" == "1" ]]; then
        if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
            local summary_body="Self-heal captured novel failure: mode=${mode_id} phase=${phase} request=${request_id}\n\nReason: ${paused_reason}\n\nSee diagnostic bundle for full context."
            local filed_url
            filed_url=$(printf '%s' "${summary_body}" | gh issue create \
                --repo "${AUTONOMOUS_DEV_SELF_HEAL_ISSUE_REPO}" \
                --title "Novel failure: ${mode_id} in ${request_id}" \
                --body-file - 2>/dev/null) || filed_url=""
            [[ -n "${filed_url}" ]] && issue_url="\"${filed_url}\""
        fi
    fi

    # Update issue URL in bundle
    bundle=$(printf '%s' "${bundle}" | jq --argjson u "${issue_url}" \
        '. + {issue_filed_url: $u}' 2>/dev/null) || true

    # Write bundle atomically
    local bundle_path="${req_dir}/diagnostic-bundle-${bundle_ts}.json"
    local bundle_tmp="${bundle_path}.tmp.$$"
    if printf '%s\n' "${bundle}" > "${bundle_tmp}" && mv "${bundle_tmp}" "${bundle_path}"; then
        selfheal_emit_event "novel_failure_detected" "${ctx_json}" || true
        local bundle_ctx
        bundle_ctx=$(printf '%s' "${ctx_json}" | jq \
            --arg bp "${bundle_path}" \
            '. + {evidence: {bundle_path: $bp}}' 2>/dev/null) || bundle_ctx="${ctx_json}"
        selfheal_emit_event "diagnostic_bundle_written" "${bundle_ctx}" || true
    else
        rm -f "${bundle_tmp}" 2>/dev/null || true
        log_error "selfheal: failed to write diagnostic bundle for ${request_id}"
        # Invoke escalate_to_paused directly
        if [[ -n "${state_file}" && -f "${state_file}" ]]; then
            local tmp="${state_file}.tmp.$$"
            jq --arg pr "novel_failure_bundle_failed" \
               '.paused_reason = $pr' \
               "${state_file}" > "${tmp}" && mv "${tmp}" "${state_file}" || rm -f "${tmp}" 2>/dev/null || true
        fi
        local retry_count
        retry_count=$(jq -r '.escalation_count // 0' "${state_file}" 2>/dev/null) || retry_count=0
        escalate_to_paused "${request_id}" "${project}" "${phase}" "${retry_count}" || true
        return 2
    fi

    # Write paused_reason into state before calling escalate_to_paused
    if [[ -n "${state_file}" && -f "${state_file}" ]]; then
        local tmp="${state_file}.tmp.$$"
        jq --arg pr "${paused_reason}" \
           '.paused_reason = $pr' \
           "${state_file}" > "${tmp}" && mv "${tmp}" "${state_file}" || rm -f "${tmp}" 2>/dev/null || true
    fi

    local retry_count
    retry_count=$(jq -r '.escalation_count // 0' "${state_file:-/dev/null}" 2>/dev/null) || retry_count=0
    escalate_to_paused "${request_id}" "${project}" "${phase}" "${retry_count}" 2>/dev/null || true

    return 0
}

# remediate_reconcile_ledger(ctx_json) -> 0|2  [F9]
remediate_reconcile_ledger() {
    local ctx_json="${1:-{}}"

    local request_id state_file
    request_id=$(printf '%s' "${ctx_json}" | jq -r '.request_id // empty' 2>/dev/null) || return 2
    state_file=$(printf '%s' "${ctx_json}" | jq -r '.state_file // empty' 2>/dev/null) || return 2

    [[ -n "${request_id}" && -n "${state_file}" && -f "${state_file}" ]] || return 2

    local current_phase
    current_phase=$(jq -r '.current_phase // "unknown"' "${state_file}" 2>/dev/null) || current_phase="unknown"
    local state_status
    state_status=$(jq -r '.status // "unknown"' "${state_file}" 2>/dev/null) || state_status="unknown"

    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    sync_intake_db_row "${request_id}" "${current_phase}" "${state_status}" "${ts}" 2>/dev/null
    local rc=$?
    if [[ "${rc}" -ne 0 ]]; then
        return 2
    fi

    selfheal_state_set "${state_file}" "ledger_reconciled_at" "\"${ts}\"" || return 2

    local ev_ctx
    ev_ctx=$(printf '%s' "${ctx_json}" | jq \
        --arg ss "${state_status}" \
        --arg ds "${state_status}" \
        --arg ts "${ts}" \
        '. + {evidence: {state_status: $ss, db_status: $ds, reconciled_at: $ts}}' 2>/dev/null) || ev_ctx="${ctx_json}"
    selfheal_emit_event "ledger_reconciled" "${ev_ctx}" || true
    return 0
}
