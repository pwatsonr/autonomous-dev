# SPEC-001-3-02: Error Backoff, Retry Exhaustion, and Turn Budget Detection

## Metadata
- **Parent Plan**: PLAN-001-3
- **Tasks Covered**: Task 4 (Per-request error backoff), Task 5 (Retry exhaustion escalation), Task 6 (Turn budget exhaustion detection)
- **Estimated effort**: 6.5 hours

## Description
Implement exponential per-request error backoff that prevents rapid-fire retries of failing requests. Implement retry exhaustion that escalates a request to `paused` status when max retries are exceeded. Implement turn budget exhaustion detection that treats max-turns-reached as a soft failure distinct from hard crashes.

## Files to Create/Modify

- **Path**: `bin/supervisor-loop.sh`
  - **Action**: Modify
  - **Description**: Add `compute_next_retry_after()`, `check_retry_exhaustion()`, and `detect_turn_exhaustion()` functions. Modify `update_request_state()` to integrate backoff and exhaustion logic.

- **Path**: `config/defaults.json`
  - **Action**: Modify
  - **Description**: Ensure `daemon.error_backoff_base_seconds`, `daemon.error_backoff_max_seconds`, and `daemon.max_retries_per_phase` exist (should already be present from SPEC-001-1-04).

## Implementation Details

### Task 4: Per-Request Error Backoff

#### `compute_next_retry_after(retry_count: int) -> string`

Computes the ISO-8601 UTC timestamp at which the request becomes retryable.

- **Parameters**: `retry_count` -- current retry count (1-based, after the increment).
- **Returns**: ISO-8601 timestamp string.
- **Formula**: `delay = min(ERROR_BACKOFF_BASE * 2^(retry_count - 1), ERROR_BACKOFF_MAX)`

```bash
compute_next_retry_after() {
    local retry_count="$1"
    local exponent=$(( retry_count - 1 ))

    # Compute 2^exponent using bit shift
    local multiplier=1
    local i
    for (( i=0; i<exponent; i++ )); do
        multiplier=$(( multiplier * 2 ))
    done

    local delay=$(( ERROR_BACKOFF_BASE * multiplier ))
    if [[ ${delay} -gt ${ERROR_BACKOFF_MAX} ]]; then
        delay=${ERROR_BACKOFF_MAX}
    fi

    # Compute future timestamp
    local future_epoch
    future_epoch=$(( $(date -u +%s) + delay ))

    # Convert epoch to ISO-8601 UTC
    # macOS: date -u -j -f "%s" "${future_epoch}" +"%Y-%m-%dT%H:%M:%SZ"
    # Linux: date -u -d "@${future_epoch}" +"%Y-%m-%dT%H:%M:%SZ"
    local timestamp
    timestamp=$(date -u -j -f "%s" "${future_epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
                || date -u -d "@${future_epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
                || echo "")

    echo "${timestamp}"
}
```

**Backoff schedule** (with defaults `ERROR_BACKOFF_BASE=30`, `ERROR_BACKOFF_MAX=900`):

| Retry Count | Delay (seconds) | Capped? |
|------------|----------------|---------|
| 1 | 30 | No |
| 2 | 60 | No |
| 3 | 120 | No |
| 4 | 240 | No |
| 5 | 480 | No |
| 6 | 900 | Yes (cap) |
| 7+ | 900 | Yes (cap) |

#### Integration with `update_request_state()`

In the error path of `update_request_state()`, after incrementing `retry_count`, compute and write `next_retry_after`:

```bash
# Inside update_request_state, error path, after jq update:
local new_retry_count
new_retry_count=$(jq -r '.current_phase_metadata.retry_count' "${state_file}")
local next_retry
next_retry=$(compute_next_retry_after "${new_retry_count}")

if [[ -n "${next_retry}" ]]; then
    local tmp="${state_file}.tmp"
    jq --arg nra "${next_retry}" \
        '.current_phase_metadata.next_retry_after = $nra' "${state_file}" > "${tmp}"
    mv "${tmp}" "${state_file}"
    log_info "Request ${request_id} backoff until ${next_retry} (retry ${new_retry_count})"
fi
```

#### Integration with `select_request()`

The backoff filtering in `select_request()` was already specified in SPEC-001-2-02 (checks `next_retry_after` and skips if in the future). No additional changes needed here.

### Task 5: Retry Exhaustion Escalation

#### `check_retry_exhaustion(request_id: string, project: string) -> int`

Called after updating state on error. Returns 0 if retries remain, 1 if exhausted.

```bash
check_retry_exhaustion() {
    local request_id="$1"
    local project="$2"
    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"

    local retry_count status
    retry_count=$(jq -r '.current_phase_metadata.retry_count // 0' "${state_file}")
    status=$(jq -r '.status' "${state_file}")

    # Check per-phase max retries from config, with default
    local max_retries
    max_retries=$(jq -r ".daemon.max_retries_by_phase.\"${status}\" // .daemon.max_retries_per_phase // 3" "${EFFECTIVE_CONFIG}" 2>/dev/null)
    if [[ "${max_retries}" == "null" || -z "${max_retries}" ]]; then
        max_retries="${MAX_RETRIES_PER_PHASE}"
    fi

    if [[ ${retry_count} -ge ${max_retries} ]]; then
        log_warn "Request ${request_id} exhausted retries for phase '${status}' (${retry_count}/${max_retries})"
        escalate_to_paused "${request_id}" "${project}" "${status}" "${retry_count}"
        return 1
    fi

    return 0
}
```

#### `escalate_to_paused(request_id: string, project: string, phase: string, retry_count: int) -> void`

```bash
escalate_to_paused() {
    local request_id="$1"
    local project="$2"
    local phase="$3"
    local retry_count="$4"
    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"
    local events_file="${project}/.autonomous-dev/requests/${request_id}/events.jsonl"

    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Transition to paused
    local tmp="${state_file}.tmp"
    jq --arg ts "${ts}" \
        --arg reason "Retry exhaustion in phase ${phase}" \
        '
        .status = "paused" |
        .current_phase_metadata.paused_reason = $reason |
        .current_phase_metadata.paused_at = $ts |
        .updated_at = $ts
        ' "${state_file}" > "${tmp}"
    mv "${tmp}" "${state_file}"

    # Append escalation event
    local event
    event=$(jq -n \
        --arg ts "${ts}" \
        --arg req "${request_id}" \
        --arg phase "${phase}" \
        --argjson retries "${retry_count}" \
        '{
            timestamp: $ts,
            type: "retry_exhaustion",
            request_id: $req,
            details: {
                phase: $phase,
                retry_count: $retries,
                escalated_to: "paused"
            }
        }')
    echo "${event}" >> "${events_file}"

    # Emit alert
    emit_alert "retry_exhaustion" "Request ${request_id} paused after ${retry_count} retries in phase '${phase}'"

    log_error "Request ${request_id} escalated to PAUSED (retry exhaustion in ${phase})"
}
```

#### Integration with Main Loop

In the error path of the main loop body, after `update_request_state`:

```bash
# After update_request_state for error:
check_retry_exhaustion "${request_id}" "${project}"
```

### Task 6: Turn Budget Exhaustion Detection

#### `detect_turn_exhaustion(exit_code: int, output_file: string) -> int`

Returns 0 if turn exhaustion detected, 1 otherwise.

```bash
detect_turn_exhaustion() {
    local exit_code="$1"
    local output_file="$2"

    # Check exit code 2 (conventional for max-turns-reached)
    if [[ ${exit_code} -eq 2 ]]; then
        return 0
    fi

    # Check output for max_turns_reached indicator
    if [[ -f "${output_file}" ]]; then
        local reason
        reason=$(jq -r '.reason // .result.reason // ""' "${output_file}" 2>/dev/null || echo "")
        if [[ "${reason}" == "max_turns_reached" ]]; then
            return 0
        fi
    fi

    return 1
}
```

#### Integration with Main Loop

After session exit, before the success/error branching:

```bash
# After spawn_session returns:
if [[ ${exit_code} -ne 0 ]] && detect_turn_exhaustion "${exit_code}" "${output_file}"; then
    # Turn exhaustion: treat as soft failure
    log_warn "Turn budget exhausted for ${request_id}. Consider increasing max_turns for phase '${status}'."
    log_warn "Hint: Set daemon.max_turns_by_phase.${status} in ~/.claude/autonomous-dev.json"

    # Still counts as an error for retry purposes, but does NOT trip the circuit breaker
    update_request_state "${request_id}" "${project}" "error" "${session_cost}" "${exit_code}"
    check_retry_exhaustion "${request_id}" "${project}"
    # Do NOT call record_crash -- turn exhaustion is not a crash
    update_cost_ledger "${session_cost}" "${request_id}"
elif [[ ${exit_code} -eq 0 ]]; then
    record_success
    update_request_state "${request_id}" "${project}" "success" "${session_cost}"
    update_cost_ledger "${session_cost}" "${request_id}"
else
    record_crash "${request_id}" "${exit_code}"
    update_request_state "${request_id}" "${project}" "error" "${session_cost}" "${exit_code}"
    check_retry_exhaustion "${request_id}" "${project}"
    update_cost_ledger "${session_cost}" "${request_id}"
fi
```

Key distinction:
- **Turn exhaustion** (exit code 2 or `max_turns_reached`): Retry count increments, but crash counter does NOT increment. The circuit breaker is not affected.
- **Hard failure** (any other non-zero exit): Both retry count and crash counter increment. Circuit breaker may trip.

### Edge Cases
- `ERROR_BACKOFF_BASE` is 0: All delays are 0, effectively no backoff. Valid but unusual.
- `retry_count` is very large (e.g., 100): `2^99` overflows bash integers. However, `MAX_RETRIES_PER_PHASE` (default 3) means this should never happen. Guard with the cap: if `exponent > 30`, use `delay = ERROR_BACKOFF_MAX` directly.
- `compute_next_retry_after` returns empty string (date parsing failed): The `next_retry_after` field is not written. The request remains retryable immediately (fail-open).
- Request transitions to `paused` but is the only request: No more work is found, daemon idle-sleeps. This is correct.
- Turn exhaustion on the first attempt: Retry count goes to 1 but circuit breaker is untouched. The request will be retried after backoff.
- Session output is missing or empty when checking for turn exhaustion: `jq` returns empty, function returns 1 (not turn exhaustion). Falls through to hard failure path.

## Acceptance Criteria
1. [ ] First failure sets `next_retry_after` approximately 30s in the future (base default)
2. [ ] Second failure sets `next_retry_after` approximately 60s in the future
3. [ ] Third failure sets approximately 120s
4. [ ] Backoff caps at `ERROR_BACKOFF_MAX` (900s default)
5. [ ] During backoff, `select_request()` skips the request
6. [ ] After backoff expires, the request is selectable again
7. [ ] Config values for `error_backoff_base_seconds` and `error_backoff_max_seconds` are respected
8. [ ] After max retries (default 3) for a phase, request transitions to `paused` status
9. [ ] Alert is emitted on retry exhaustion with request ID and phase
10. [ ] `events.jsonl` contains a `retry_exhaustion` event on escalation
11. [ ] No further sessions are spawned for a paused request
12. [ ] Exit code 2 is detected as turn exhaustion
13. [ ] Session output with `"reason": "max_turns_reached"` is detected as turn exhaustion
14. [ ] Turn exhaustion increments retry counter but does NOT increment crash counter
15. [ ] Turn exhaustion does NOT trip the circuit breaker
16. [ ] Log contains a recommendation to increase the turn budget for the affected phase
17. [ ] The request remains actionable after turn exhaustion (after backoff)
18. [ ] No shellcheck warnings at `--severity=warning` level

## Test Cases
1. **test_compute_backoff_first_retry** -- Set `ERROR_BACKOFF_BASE=30`, `ERROR_BACKOFF_MAX=900`. Call `compute_next_retry_after 1`. Assert the returned timestamp is approximately now + 30s (within 2s tolerance).
2. **test_compute_backoff_second_retry** -- Call `compute_next_retry_after 2`. Assert approximately now + 60s.
3. **test_compute_backoff_third_retry** -- Call `compute_next_retry_after 3`. Assert approximately now + 120s.
4. **test_compute_backoff_cap** -- Set `ERROR_BACKOFF_MAX=100`. Call `compute_next_retry_after 10`. Assert delay does not exceed 100s.
5. **test_backoff_written_to_state** -- Trigger an error update. Read state.json. Assert `.current_phase_metadata.next_retry_after` is a valid ISO-8601 timestamp in the future.
6. **test_backoff_request_skipped** -- Set `next_retry_after` 5 minutes in the future on a request. Call `select_request`. Assert the request is not selected.
7. **test_backoff_request_selectable_after_expiry** -- Set `next_retry_after` to 1 second in the past. Call `select_request`. Assert the request IS selected.
8. **test_retry_exhaustion_pauses** -- Create a request with `retry_count: 2` and `MAX_RETRIES_PER_PHASE=3`. Trigger one more error. Assert state.json has `status: "paused"`.
9. **test_retry_exhaustion_event** -- After exhaustion, read `events.jsonl`. Assert last entry has `type: "retry_exhaustion"`.
10. **test_retry_exhaustion_alert** -- After exhaustion, assert an alert file exists in `$ALERTS_DIR` with `type: "retry_exhaustion"`.
11. **test_paused_request_not_selected** -- Set request status to `paused`. Call `select_request`. Assert not selected.
12. **test_turn_exhaustion_exit_code_2** -- Call `detect_turn_exhaustion 2 "/nonexistent"`. Assert return 0 (detected).
13. **test_turn_exhaustion_output_field** -- Create an output file with `{"reason": "max_turns_reached"}`. Call `detect_turn_exhaustion 1 "${output_file}"`. Assert return 0.
14. **test_turn_exhaustion_not_detected** -- Call `detect_turn_exhaustion 1 "/nonexistent"`. Assert return 1 (not detected).
15. **test_turn_exhaustion_no_crash_count** -- Set `CONSECUTIVE_CRASHES=0`. Simulate a turn exhaustion flow. Assert `CONSECUTIVE_CRASHES` is still 0 (not incremented).
16. **test_turn_exhaustion_retry_increments** -- Simulate turn exhaustion. Assert `retry_count` in state.json is incremented.
17. **test_turn_exhaustion_log_recommendation** -- Simulate turn exhaustion. Assert log contains "Consider increasing max_turns".
