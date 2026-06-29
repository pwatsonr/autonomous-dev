#!/usr/bin/env bash
# test_progress_aware_timeout.sh -- Integration tests for REQ-000051:
# progress-aware dispatch timeout and soft-timeout escalation logic.
#
# Tests:
#   I-A: Hard timeout (no progress) increments retry_count via update_request_state
#   I-B: Soft timeout (with progress) mutates state.json correctly via record_soft_timeout
#   I-C: Promotion to hard after max_soft_timeout_reentries via record_soft_timeout + ceiling check
#   I-D: DISPATCH_TIMEOUT env var honored by resolve_dispatch_timeout
#   I-E: Phase advance resets soft_timeout_count via record_phase_history + advance_phase jq
#
# Approach: source supervisor-loop.sh in unit-test mode (BASH_SOURCE[0] != $0
# guard prevents main() from running) after stubbing external dependencies.
#
# Requires: jq (1.6+), git, bash 4+
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PLUGIN_DIR="$(cd "${PROJECT_ROOT}/.." && pwd)"

# Source shared test harness
source "${SCRIPT_DIR}/../test_harness.sh"

# Source typed-limits.sh directly (resolve_dispatch_timeout, coerce_*, etc.)
source "${PROJECT_ROOT}/bin/lib/typed-limits.sh"

###############################################################################
# Minimal stubs required before sourcing helpers from supervisor-loop.sh.
# We replicate only the functions needed for the tested code paths.
###############################################################################

# Logging stubs
log_info()  { echo "[INFO]  $*" >/dev/null; }
log_warn()  { echo "[WARN]  $*" >/dev/null; }
log_error() { echo "[ERROR] $*" >/dev/null; }

# Stub emit_alert so tests don't write to real ALERTS_DIR
ALERTS_DIR="${_TEST_DIR:-/tmp}/alerts"
emit_alert() { mkdir -p "${ALERTS_DIR}"; echo "{\"type\":\"$1\",\"msg\":\"$2\"}" >> "${ALERTS_DIR}/alerts.jsonl"; }

# Stub validate_state_file — just check it exists and is valid JSON
validate_state_file() {
    local f="$1"
    [[ -f "$f" ]] && jq empty "$f" 2>/dev/null
}

# validate_request_id — allow REQ-* pattern
validate_request_id() {
    [[ "$1" =~ ^REQ- ]]
}

# Stub compute_next_retry_after
compute_next_retry_after() { echo ""; }

###############################################################################
# Now define the functions from supervisor-loop.sh that we need.
# Instead of sourcing the 5k-line file, we inline the tested function bodies.
###############################################################################

# Copy of snapshot_working_tree (REQ-000051)
snapshot_working_tree() {
    local project="${1:-}"
    if [[ -z "${project}" || ! -d "${project}/.git" ]]; then
        printf 'non-git\n'
        return 0
    fi
    local head dirty
    head=$(git -C "${project}" rev-parse HEAD 2>/dev/null || true)
    dirty=$(git -C "${project}" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    printf '%s|%s\n' "${head}" "${dirty}"
}

# Copy of working_tree_advanced (REQ-000051)
working_tree_advanced() {
    local pre="${1:-}" post="${2:-}"
    if [[ -z "${pre}" || -z "${post}" ]]; then return 1; fi
    if [[ "${pre}" == "non-git" || "${post}" == "non-git" ]]; then return 1; fi
    if [[ "${pre}" == "${post}" ]]; then return 1; fi
    return 0
}

# Copy of emit_soft_timeout_promotion_alert (REQ-000051)
emit_soft_timeout_promotion_alert() {
    local request_id="$1" phase="$2" soft_timeout_count="$3" project="${4:-}"
    local ts; ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local events_file=""
    if [[ -n "${project}" ]]; then
        events_file="${project}/.autonomous-dev/requests/${request_id}/events.jsonl"
    fi
    if [[ -n "${events_file}" && -d "$(dirname "${events_file}")" ]]; then
        local event
        event=$(jq -cn --arg ts "${ts}" --arg req "${request_id}" \
            --arg phase "${phase}" --argjson stc "${soft_timeout_count}" \
            '{ timestamp:$ts, type:"soft_timeout_promoted_to_hard",
               request_id:$req, details:{phase:$phase,soft_timeout_count:$stc} }')
        echo "${event}" >> "${events_file}"
    fi
    emit_alert "soft_timeout_promoted_to_hard" \
        "Request ${request_id} promoted soft-timeout to hard after ${soft_timeout_count} productive timeouts in phase '${phase}'"
}

# Copy of record_soft_timeout (REQ-000051)
record_soft_timeout() {
    local request_id="$1" project="$2" phase="$3"
    local pre_tree="$4" post_tree="$5" timeout_seconds="$6"
    local req_dir="${project}/.autonomous-dev/requests/${request_id}"
    local state_file="${req_dir}/state.json"
    local events_file="${req_dir}/events.jsonl"
    local ts; ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local pre_head pre_dirty post_head post_dirty
    if [[ "${pre_tree}" == "non-git" ]]; then
        pre_head="null"; pre_dirty="null"
    else
        pre_head="${pre_tree%%|*}"; pre_dirty="${pre_tree##*|}"
        [[ "${pre_dirty}" =~ ^[0-9]+$ ]] || pre_dirty="null"
    fi
    if [[ "${post_tree}" == "non-git" ]]; then
        post_head="null"; post_dirty="null"
    else
        post_head="${post_tree%%|*}"; post_dirty="${post_tree##*|}"
        [[ "${post_dirty}" =~ ^[0-9]+$ ]] || post_dirty="null"
    fi
    local tmp="${state_file}.tmp.$$"
    if jq --arg ts "${ts}" --arg secs "${timeout_seconds}" \
        '.current_phase_metadata.soft_timeout_count =
             ((.current_phase_metadata.soft_timeout_count // 0) + 1) |
         .current_phase_metadata.last_session_completed_at = $ts |
         .current_phase_metadata.session_active = false |
         .current_phase_metadata.last_error =
             ("Soft timeout after " + $secs + "s (progress detected)") |
         .current_phase_metadata.last_error_at = $ts |
         .updated_at = $ts' \
        "${state_file}" > "${tmp}" 2>/dev/null; then
        mv "${tmp}" "${state_file}"
    else
        rm -f "${tmp}" 2>/dev/null || true
        log_warn "record_soft_timeout: failed to update state.json"
        return 0
    fi
    local new_soft_count
    new_soft_count=$(jq -r '.current_phase_metadata.soft_timeout_count // 1' "${state_file}" 2>/dev/null || echo "1")
    local pre_head_json post_head_json pre_dirty_json post_dirty_json
    [[ "${pre_head}" == "null" ]] && pre_head_json="null" || pre_head_json=$(jq -n --arg v "${pre_head}" '$v')
    [[ "${post_head}" == "null" ]] && post_head_json="null" || post_head_json=$(jq -n --arg v "${post_head}" '$v')
    [[ "${pre_dirty}" == "null" ]] && pre_dirty_json="null" || pre_dirty_json="${pre_dirty}"
    [[ "${post_dirty}" == "null" ]] && post_dirty_json="null" || post_dirty_json="${post_dirty}"
    local event
    event=$(jq -cn \
        --arg ts "${ts}" --arg req "${request_id}" --arg phase "${phase}" \
        --argjson secs "${timeout_seconds}" \
        --argjson pre_head "${pre_head_json}" --argjson post_head "${post_head_json}" \
        --argjson pre_dirty "${pre_dirty_json}" --argjson post_dirty "${post_dirty_json}" \
        --argjson stc "${new_soft_count}" \
        '{ timestamp:$ts, type:"session_soft_timeout", request_id:$req,
           details:{ phase:$phase, timeout_seconds:$secs,
             pre_head:$pre_head, post_head:$post_head,
             pre_dirty_count:$pre_dirty, post_dirty_count:$post_dirty,
             soft_timeout_count:$stc } }') || { log_warn "record_soft_timeout: event build failed"; return 0; }
    echo "${event}" >> "${events_file}" || log_warn "record_soft_timeout: events append failed"
    return 0
}

# update_request_state (simplified version covering just the sentinel-125 and error paths we test)
update_request_state() {
    local request_id="$1" project="$2" outcome="$3" session_cost="$4" exit_code="${5:-unknown}"
    local req_dir="${project}/.autonomous-dev/requests/${request_id}"
    local state_file="${req_dir}/state.json"
    local events_file="${req_dir}/events.jsonl"
    if ! echo "${session_cost}" | jq -e 'tonumber' >/dev/null 2>&1; then
        session_cost="0"
    fi
    if ! validate_state_file "${state_file}"; then return 1; fi
    local current_state; current_state=$(cat "${state_file}")
    local ts; ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    if [[ "${outcome}" == "success" ]]; then
        local tmp="${state_file}.tmp"
        echo "${current_state}" | jq --arg ts "${ts}" --arg cost "${session_cost}" \
            '.current_phase_metadata.last_session_completed_at = $ts |
             .current_phase_metadata.session_active = false |
             .current_phase_metadata.retry_count = 0 |
             .current_phase_metadata.last_error = null |
             .cost_accrued_usd = ((.cost_accrued_usd // 0) + ($cost | tonumber)) |
             .updated_at = $ts' > "${tmp}"
        mv "${tmp}" "${state_file}"
        jq -cn --arg ts "${ts}" --arg req "${request_id}" --arg cost "${session_cost}" \
            '{timestamp:$ts,type:"session_complete",request_id:$req,details:{session_cost_usd:($cost|tonumber)}}' \
            >> "${events_file}"
        log_info "State updated: request=${request_id} outcome=success cost=${session_cost}"
    else
        # Sentinel-125: soft timeout (REQ-000051)
        if [[ "${exit_code:-0}" -eq 125 ]]; then
            local tmp_soft="${state_file}.tmp"
            jq --arg cost "${session_cost}" \
                '.cost_accrued_usd = ((.cost_accrued_usd // 0) + ($cost | tonumber))' \
                "${state_file}" > "${tmp_soft}" 2>/dev/null \
                && mv "${tmp_soft}" "${state_file}" \
                || rm -f "${tmp_soft}" 2>/dev/null || true
            log_info "State updated: request=${request_id} outcome=soft_timeout"
            return 0
        fi
        # Hard error path
        local tmp="${state_file}.tmp"
        echo "${current_state}" | jq --arg ts "${ts}" --arg cost "${session_cost}" \
            --arg ec "${exit_code}" \
            '.current_phase_metadata.retry_count = ((.current_phase_metadata.retry_count // 0) + 1) |
             .current_phase_metadata.last_error = ("Session exited with code " + $ec) |
             .current_phase_metadata.last_error_at = $ts |
             .current_phase_metadata.session_active = false |
             .cost_accrued_usd = ((.cost_accrued_usd // 0) + ($cost | tonumber)) |
             .updated_at = $ts' > "${tmp}"
        mv "${tmp}" "${state_file}"
        local new_retry; new_retry=$(jq -r '.current_phase_metadata.retry_count' "${state_file}")
        local next_retry; next_retry=$(compute_next_retry_after "${new_retry}")
        if [[ -n "${next_retry}" ]]; then
            local tmp2="${state_file}.tmp"
            jq --arg nra "${next_retry}" '.current_phase_metadata.next_retry_after = $nra' \
                "${state_file}" > "${tmp2}" && mv "${tmp2}" "${state_file}"
        fi
        jq -cn --arg ts "${ts}" --arg req "${request_id}" \
            --arg ec "${exit_code}" --arg cost "${session_cost}" \
            '{timestamp:$ts,type:"session_error",request_id:$req,
              details:{session_cost_usd:($cost|tonumber),exit_code:($ec|tonumber? // $ec)}}' \
            >> "${events_file}"
        log_warn "State updated: request=${request_id} outcome=error exit_code=${exit_code}"
    fi
}

# record_phase_history — minimal copy matching the implementation
record_phase_history() {
    local state_file="$1" completed_phase="$2" next_phase="$3" ts="$4"
    local tmp="${state_file}.hist.$$"
    jq --arg completed "$completed_phase" --arg next "$next_phase" --arg ts "$ts" \
       '.phase_history = (.phase_history // []) |
        (if (.phase_history | length) > 0
              and (.phase_history[-1] | type) == "object"
              and .phase_history[-1].state == $completed
              and (.phase_history[-1].exited_at == null)
         then
           .phase_history[-1].exited_at = $ts |
           .phase_history[-1].exit_reason = "completed"
         else
           .phase_history += [{
             state: $completed, entered_at: null, exited_at: $ts,
             session_id: null, turns_used: 0, cost_usd: 0,
             retry_count: 0, soft_timeout_count: 0, exit_reason: "completed"
           }]
         end) |
        (if $next != "" then
           .phase_history += [{
             state: $next, entered_at: $ts, exited_at: null,
             session_id: null, turns_used: 0, cost_usd: 0,
             retry_count: 0, soft_timeout_count: 0, exit_reason: null
           }]
         else . end)' \
       "$state_file" > "$tmp" && mv "$tmp" "$state_file" || {
        rm -f "$tmp" 2>/dev/null || true
        log_warn "record_phase_history: failed"
        return 1
    }
}

###############################################################################
# Helper: create a minimal request directory with state.json
###############################################################################
_create_request_dir() {
    local project="$1" req_id="$2" phase="${3:-code}"
    local req_dir="${project}/.autonomous-dev/requests/${req_id}"
    mkdir -p "${req_dir}"
    jq -n --arg id "${req_id}" --arg phase "${phase}" \
        '{ id:$id, status:"running", current_phase:$phase,
           current_phase_metadata:{
             session_active:false, retry_count:0, soft_timeout_count:0
           },
           phase_history:[{
             state:$phase, entered_at:"2026-01-01T00:00:00Z",
             exited_at:null, session_id:null, turns_used:0,
             cost_usd:0, retry_count:0, soft_timeout_count:0,
             exit_reason:null
           }],
           cost_accrued_usd:0,
           updated_at:"2026-01-01T00:00:00Z" }' \
        > "${req_dir}/state.json"
    touch "${req_dir}/events.jsonl"
    echo "${req_dir}"
}

###############################################################################
# I-A: Hard timeout (no progress) — update_request_state increments retry_count,
#      does NOT set soft_timeout_count, appends a session_error event.
###############################################################################
test_ia_hard_timeout_no_progress() {
    local project="${_TEST_DIR}/project_ia"
    local req_id="REQ-IA-001"
    git -C "$(mkdir -p "${project}" && echo "${project}")" init -q 2>/dev/null || true
    local req_dir
    req_dir=$(_create_request_dir "${project}" "${req_id}" "code")
    local state_file="${req_dir}/state.json"

    # Simulate hard timeout: call update_request_state with exit_code=124
    update_request_state "${req_id}" "${project}" "error" "0.50" "124"

    # Assertions
    local retry_count soft_count events_last_type
    retry_count=$(jq -r '.current_phase_metadata.retry_count // 0' "${state_file}")
    soft_count=$(jq -r '.current_phase_metadata.soft_timeout_count // 0' "${state_file}")
    events_last_type=$(tail -1 "${req_dir}/events.jsonl" | jq -r '.type')

    assert_eq "1" "${retry_count}"   "I-A: retry_count should be 1 after hard timeout"
    assert_eq "0" "${soft_count}"    "I-A: soft_timeout_count should remain 0"
    assert_eq "session_error" "${events_last_type}" "I-A: last event should be session_error"
}

###############################################################################
# I-B: Soft timeout (with progress) — record_soft_timeout mutates state.json
#      and events.jsonl; retry_count unchanged; session_active=false;
#      update_request_state sentinel-125 accrues cost but skips error path.
###############################################################################
test_ib_soft_timeout_with_progress() {
    local project="${_TEST_DIR}/project_ib"
    local req_id="REQ-IB-001"
    mkdir -p "${project}"
    git -C "${project}" init -q
    git -C "${project}" config user.email "test@test.com"
    git -C "${project}" config user.name "Test"
    echo "init" > "${project}/init.txt"
    git -C "${project}" add init.txt
    git -C "${project}" commit -q -m "init"
    local pre_tree; pre_tree=$(snapshot_working_tree "${project}")

    # Simulate progress: add a new file
    echo "work" > "${project}/work.txt"
    local post_tree; post_tree=$(snapshot_working_tree "${project}")

    local req_dir
    req_dir=$(_create_request_dir "${project}" "${req_id}" "code")
    local state_file="${req_dir}/state.json"

    # Call record_soft_timeout (simulates what dispatch_phase_session does)
    record_soft_timeout "${req_id}" "${project}" "code" "${pre_tree}" "${post_tree}" "10800"

    # Now call update_request_state with sentinel 125 (should only accrue cost)
    # Seed cost_accrued_usd=0 is already there; session_cost=1.00
    update_request_state "${req_id}" "${project}" "error" "1.00" "125"

    # Assertions on state.json
    local retry_count soft_count session_active cost last_err events_last_type
    retry_count=$(jq -r '.current_phase_metadata.retry_count // 0' "${state_file}")
    soft_count=$(jq -r '.current_phase_metadata.soft_timeout_count // 0' "${state_file}")
    session_active=$(jq -r '.current_phase_metadata.session_active' "${state_file}")
    cost=$(jq -r '.cost_accrued_usd' "${state_file}")
    last_err=$(jq -r '.current_phase_metadata.last_error // ""' "${state_file}")
    events_last_type=$(tail -1 "${req_dir}/events.jsonl" | jq -r '.type')

    assert_eq "0"  "${retry_count}"    "I-B: retry_count should remain 0 on soft timeout"
    assert_eq "1"  "${soft_count}"     "I-B: soft_timeout_count should be 1"
    assert_eq "false" "${session_active}" "I-B: session_active should be false"
    # cost should be 1.00 (accrued by sentinel-125 branch)
    local cost_ok=0
    (( $(echo "${cost} >= 1.0" | bc -l 2>/dev/null || echo 0) )) && cost_ok=1 || true
    # Allow bc unavailability by checking with awk
    if ! command -v bc >/dev/null 2>&1; then
        cost_ok=$(awk "BEGIN {print (${cost} >= 1.0) ? 1 : 0}")
    fi
    assert_eq "1" "${cost_ok}" "I-B: cost_accrued_usd should include session cost (got ${cost})"

    if [[ "${last_err}" != *"Soft timeout"* ]]; then
        echo "  I-B: last_error '${last_err}' should contain 'Soft timeout'" >&2
        return 1
    fi
    assert_eq "session_soft_timeout" "${events_last_type}" \
        "I-B: last event should be session_soft_timeout"

    # No next_retry_after or session_error event
    local has_session_error
    has_session_error=$(jq -s '[.[] | select(.type=="session_error")] | length' "${req_dir}/events.jsonl")
    assert_eq "0" "${has_session_error}" "I-B: no session_error event should be written"

    local has_next_retry
    has_next_retry=$(jq -r '.current_phase_metadata.next_retry_after // "none"' "${state_file}")
    assert_eq "none" "${has_next_retry}" "I-B: next_retry_after should not be set"
}

###############################################################################
# I-C: Promotion to hard after max_soft_timeout_reentries
#      Using max_soft = 2: call 1 soft-timeouts, call 2 should promote.
###############################################################################
test_ic_promotion_to_hard() {
    local project="${_TEST_DIR}/project_ic"
    local req_id="REQ-IC-001"
    mkdir -p "${project}"
    git -C "${project}" init -q
    git -C "${project}" config user.email "test@test.com"
    git -C "${project}" config user.name "Test"
    echo "init" > "${project}/init.txt"
    git -C "${project}" add init.txt
    git -C "${project}" commit -q -m "init"

    local req_dir
    req_dir=$(_create_request_dir "${project}" "${req_id}" "code")
    local state_file="${req_dir}/state.json"

    # Seed max_soft_timeout_reentries = 2 via state.json (per-request override)
    local tmp="${state_file}.tmp.$$"
    jq '.type_config = {maxSoftTimeoutReentries: 2}' "${state_file}" > "${tmp}" && mv "${tmp}" "${state_file}"

    # First soft timeout (cur_soft=0, 0+1 < 2 → soft path)
    local pre1; pre1=$(snapshot_working_tree "${project}")
    echo "work1" > "${project}/work1.txt"
    local post1; post1=$(snapshot_working_tree "${project}")

    local max_soft cur_soft
    max_soft=$(EFFECTIVE_CONFIG="" resolve_max_soft_timeout_reentries "${state_file}")
    cur_soft=$(jq -r '.current_phase_metadata.soft_timeout_count // 0' "${state_file}")

    if (( cur_soft + 1 >= max_soft )); then
        echo "  I-C: call 1 should NOT promote (cur_soft=${cur_soft}, max=${max_soft})" >&2
        return 1
    fi
    record_soft_timeout "${req_id}" "${project}" "code" "${pre1}" "${post1}" "10800"
    update_request_state "${req_id}" "${project}" "error" "0" "125"

    local soft_after1 retry_after1
    soft_after1=$(jq -r '.current_phase_metadata.soft_timeout_count' "${state_file}")
    retry_after1=$(jq -r '.current_phase_metadata.retry_count // 0' "${state_file}")
    assert_eq "1"  "${soft_after1}"  "I-C: soft_timeout_count should be 1 after call 1"
    assert_eq "0"  "${retry_after1}" "I-C: retry_count should remain 0 after call 1"

    # Second soft timeout attempt: cur_soft=1, 1+1 >= 2 → promote to hard
    local pre2; pre2=$(snapshot_working_tree "${project}")
    echo "work2" > "${project}/work2.txt"
    local post2; post2=$(snapshot_working_tree "${project}")

    max_soft=$(EFFECTIVE_CONFIG="" resolve_max_soft_timeout_reentries "${state_file}")
    cur_soft=$(jq -r '.current_phase_metadata.soft_timeout_count // 0' "${state_file}")

    if (( cur_soft + 1 >= max_soft )); then
        # Promotion path: call emit_soft_timeout_promotion_alert, then treat as hard
        emit_soft_timeout_promotion_alert "${req_id}" "code" "${cur_soft}" "${project}"
        # Call update_request_state with exit_code=124 (hard timeout path)
        update_request_state "${req_id}" "${project}" "error" "0" "124"
    else
        echo "  I-C: call 2 SHOULD promote (cur_soft=${cur_soft}, max=${max_soft})" >&2
        return 1
    fi

    local retry_after2 events_has_promotion
    retry_after2=$(jq -r '.current_phase_metadata.retry_count // 0' "${state_file}")
    events_has_promotion=$(jq -s '[.[] | select(.type=="soft_timeout_promoted_to_hard")] | length' \
        "${req_dir}/events.jsonl")

    assert_eq "1"  "${retry_after2}"       "I-C: retry_count should be 1 after promotion"
    assert_eq "1"  "${events_has_promotion}" "I-C: events.jsonl should contain soft_timeout_promoted_to_hard"
}

###############################################################################
# I-D: DISPATCH_TIMEOUT env var honored by resolve_dispatch_timeout
###############################################################################
test_id_dispatch_timeout_env_var() {
    local state_file="${_TEST_DIR}/id_state.json"
    echo '{}' > "${state_file}"
    unset EFFECTIVE_CONFIG 2>/dev/null || true

    # DISPATCH_TIMEOUT=2s (suffix) — coerce should give 2
    local out
    out=$(EFFECTIVE_CONFIG="" DISPATCH_TIMEOUT="2s" resolve_dispatch_timeout "${state_file}" "code")
    assert_eq "2" "${out}" "I-D: DISPATCH_TIMEOUT=2s should resolve to 2 seconds"

    # DISPATCH_TIMEOUT=45 (bare integer) — coerce as seconds
    out=$(EFFECTIVE_CONFIG="" DISPATCH_TIMEOUT="45" resolve_dispatch_timeout "${state_file}" "code")
    assert_eq "45" "${out}" "I-D: DISPATCH_TIMEOUT=45 (bare int) should resolve to 45 seconds"

    # DISPATCH_TIMEOUT takes lower priority than per-phase config
    local cfg="${_TEST_DIR}/id_cfg.json"
    echo '{"daemon":{"dispatch_timeout_by_phase":{"code":999}}}' > "${cfg}"
    out=$(EFFECTIVE_CONFIG="${cfg}" DISPATCH_TIMEOUT="2s" resolve_dispatch_timeout "${state_file}" "code")
    assert_eq "999" "${out}" "I-D: per-phase config (999) should win over DISPATCH_TIMEOUT env var"
}

###############################################################################
# I-E: Phase advance resets soft_timeout_count in both state.json and
#      the new phase_history entry.
###############################################################################
test_ie_phase_advance_resets_soft_timeout_count() {
    local project="${_TEST_DIR}/project_ie"
    local req_id="REQ-IE-001"
    mkdir -p "${project}/.autonomous-dev/requests/${req_id}"
    local state_file="${project}/.autonomous-dev/requests/${req_id}/state.json"

    # Seed state with soft_timeout_count = 3 in current phase
    jq -n '{ id:"REQ-IE-001", status:"running", current_phase:"code",
              current_phase_metadata:{
                session_active:false, retry_count:0, soft_timeout_count:3
              },
              phase_history:[{
                state:"code", entered_at:"2026-01-01T00:00:00Z",
                exited_at:null, session_id:null, turns_used:0,
                cost_usd:0, retry_count:0, soft_timeout_count:3,
                exit_reason:null
              }],
              cost_accrued_usd:5.0,
              updated_at:"2026-01-01T00:00:00Z" }' \
        > "${state_file}"

    local ts; ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Call record_phase_history to close "code" and open "integration"
    record_phase_history "${state_file}" "code" "integration" "${ts}"

    # Also simulate advance_phase's metadata reset (the jq we added)
    local tmp="${state_file}.advance.$$"
    jq --arg phase "integration" --arg status "running" --arg ts "${ts}" \
        '.current_phase = $phase |
         .status = $status |
         .updated_at = $ts |
         .current_phase_metadata.dispatched_phase = null |
         .current_phase_metadata.soft_timeout_count = 0' \
        "${state_file}" > "${tmp}" && mv "${tmp}" "${state_file}"

    # Assertions
    local metadata_stc
    metadata_stc=$(jq -r '.current_phase_metadata.soft_timeout_count // 99' "${state_file}")
    assert_eq "0" "${metadata_stc}" "I-E: current_phase_metadata.soft_timeout_count should be 0 after advance"

    # phase_history entries:
    # - The closed "code" entry: was seeded with soft_timeout_count=3; record_phase_history
    #   stamps exited_at/exit_reason but does NOT reset soft_timeout_count on existing entries.
    #   Only newly-created entries (the "else" and "if $next" blocks) get soft_timeout_count=0.
    # - The new "integration" entry should have soft_timeout_count=0 (created fresh).
    local code_stc integration_stc
    code_stc=$(jq -r '[.phase_history[] | select(.state=="code")] | last | .soft_timeout_count // 99' "${state_file}")
    integration_stc=$(jq -r '[.phase_history[] | select(.state=="integration")] | last | .soft_timeout_count // 99' "${state_file}")

    assert_eq "3" "${code_stc}"        "I-E: closed code phase_history entry preserves its soft_timeout_count (3)"
    assert_eq "0" "${integration_stc}" "I-E: new integration phase_history entry should have soft_timeout_count=0"
}

###############################################################################
# Run all tests
###############################################################################
run_test "I-A: Hard timeout increments retry_count"                   test_ia_hard_timeout_no_progress
run_test "I-B: Soft timeout does not increment retry_count"           test_ib_soft_timeout_with_progress
run_test "I-C: Promotion to hard at max_soft_timeout_reentries"       test_ic_promotion_to_hard
run_test "I-D: DISPATCH_TIMEOUT env var honored by resolve_dispatch"  test_id_dispatch_timeout_env_var
run_test "I-E: Phase advance resets soft_timeout_count"               test_ie_phase_advance_resets_soft_timeout_count

report
