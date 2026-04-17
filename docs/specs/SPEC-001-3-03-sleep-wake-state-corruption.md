# SPEC-001-3-03: Sleep/Wake Recovery, State Corruption, and Cost Ledger Corruption

## Metadata
- **Parent Plan**: PLAN-001-3
- **Tasks Covered**: Task 7 (Sleep/wake recovery), Task 8 (State file corruption recovery), Task 9 (Cost ledger corruption recovery)
- **Estimated effort**: 6 hours

## Description
Extend the Plan 1 stale heartbeat recovery stub to scan for interrupted sessions and restore them from checkpoints. Implement state file validation with checkpoint fallback. Implement cost ledger corruption detection that safely blocks all processing.

## Files to Create/Modify

- **Path**: `bin/supervisor-loop.sh`
  - **Action**: Modify
  - **Description**: Replace `recover_from_stale_heartbeat()` with full implementation. Add `validate_state_file()`, `restore_from_checkpoint()`, and enhance `check_cost_caps()` with corruption handling.

## Implementation Details

### Task 7: Sleep/Wake Recovery

#### Updated `recover_from_stale_heartbeat() -> void`

Replaces the Plan 1 stub. Called when stale heartbeat is detected on startup.

```bash
recover_from_stale_heartbeat() {
    # 1. Cleanup orphaned processes (from Plan 1)
    local stale_pid
    stale_pid=$(jq -r '.pid' "${HEARTBEAT_FILE}" 2>/dev/null || echo "")
    if [[ -n "${stale_pid}" && "${stale_pid}" != "$$" ]]; then
        if kill -0 "${stale_pid}" 2>/dev/null; then
            log_warn "Orphaned process ${stale_pid} still running. Sending SIGTERM."
            kill -TERM "${stale_pid}" 2>/dev/null || true
            sleep 2
            if kill -0 "${stale_pid}" 2>/dev/null; then
                kill -KILL "${stale_pid}" 2>/dev/null || true
            fi
            log_info "Orphaned process ${stale_pid} terminated."
        else
            log_info "No orphaned process found (PID ${stale_pid} not running)."
        fi
    fi

    # 2. Determine if this was a sleep event vs. a crash
    local staleness_seconds
    staleness_seconds=$(compute_heartbeat_staleness)
    local crash_state_updated_at=""
    if [[ -f "${CRASH_STATE_FILE}" ]]; then
        crash_state_updated_at=$(jq -r '.updated_at // ""' "${CRASH_STATE_FILE}" 2>/dev/null || echo "")
    fi

    local is_sleep_event=false
    if [[ ${staleness_seconds} -gt 600 ]]; then
        # Staleness > 10 minutes
        if [[ -z "${crash_state_updated_at}" ]]; then
            is_sleep_event=true
        else
            # Check if crash state was recently updated (within last 5 minutes before stale heartbeat)
            local crash_epoch
            crash_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${crash_state_updated_at}" +%s 2>/dev/null \
                          || date -u -d "${crash_state_updated_at}" +%s 2>/dev/null \
                          || echo "0")
            local heartbeat_epoch
            local heartbeat_ts
            heartbeat_ts=$(jq -r '.timestamp' "${HEARTBEAT_FILE}" 2>/dev/null || echo "")
            heartbeat_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${heartbeat_ts}" +%s 2>/dev/null \
                              || date -u -d "${heartbeat_ts}" +%s 2>/dev/null \
                              || echo "0")
            local gap=$(( heartbeat_epoch - crash_epoch ))
            if [[ ${gap} -gt 300 ]]; then
                # Crash state was NOT recently updated before the heartbeat went stale
                is_sleep_event=true
            fi
        fi
    fi

    if [[ "${is_sleep_event}" == "true" ]]; then
        log_info "Classifying stale heartbeat as sleep/wake event (NOT incrementing crash counter)."
    else
        log_info "Classifying stale heartbeat as potential crash event."
    fi

    # 3. Scan all active requests for session_active: true
    local repos
    repos=$(jq -r '.repositories.allowlist[]' "${EFFECTIVE_CONFIG}" 2>/dev/null || echo "")

    while IFS= read -r repo; do
        [[ -z "${repo}" ]] && continue
        local req_dir="${repo}/.autonomous-dev/requests"
        [[ -d "${req_dir}" ]] || continue

        for state_file in "${req_dir}"/*/state.json; do
            [[ -f "${state_file}" ]] || continue

            local session_active
            session_active=$(jq -r '.current_phase_metadata.session_active // false' "${state_file}" 2>/dev/null || echo "false")

            if [[ "${session_active}" == "true" ]]; then
                local req_id
                req_id=$(jq -r '.id' "${state_file}" 2>/dev/null || echo "unknown")
                log_warn "Found interrupted session for request ${req_id}. Restoring from checkpoint."

                local req_subdir
                req_subdir=$(dirname "${state_file}")
                restore_interrupted_session "${req_id}" "${req_subdir}" "${repo}"
            fi
        done
    done <<< "${repos}"

    log_info "Sleep/wake recovery complete."
}
```

#### Helper: `compute_heartbeat_staleness() -> int`

Returns staleness in seconds (for reuse).

```bash
compute_heartbeat_staleness() {
    local last_ts
    last_ts=$(jq -r '.timestamp' "${HEARTBEAT_FILE}" 2>/dev/null || echo "")
    if [[ -z "${last_ts}" ]]; then
        echo "999999"
        return
    fi

    local now_epoch last_epoch
    now_epoch=$(date -u +%s)
    last_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${last_ts}" +%s 2>/dev/null \
                 || date -u -d "${last_ts}" +%s 2>/dev/null \
                 || echo "0")
    echo $(( now_epoch - last_epoch ))
}
```

#### `restore_interrupted_session(request_id: string, req_dir: string, project: string) -> void`

```bash
restore_interrupted_session() {
    local request_id="$1"
    local req_dir="$2"
    local project="$3"
    local state_file="${req_dir}/state.json"
    local checkpoint_file="${req_dir}/checkpoint.json"
    local events_file="${req_dir}/events.jsonl"

    # Restore from checkpoint if available
    if [[ -f "${checkpoint_file}" ]]; then
        if jq empty "${checkpoint_file}" 2>/dev/null; then
            cp "${checkpoint_file}" "${state_file}"
            log_info "Restored state.json from checkpoint for ${request_id}"
        else
            log_warn "Checkpoint is also corrupt for ${request_id}. Keeping current state."
        fi
    else
        log_warn "No checkpoint found for ${request_id}. Clearing session_active flag only."
    fi

    # Clear session_active flag
    local tmp="${state_file}.tmp"
    jq '.current_phase_metadata.session_active = false' "${state_file}" > "${tmp}" 2>/dev/null
    mv "${tmp}" "${state_file}"

    # Append recovery event
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local event
    event=$(jq -n \
        --arg ts "${ts}" \
        --arg req "${request_id}" \
        '{
            timestamp: $ts,
            type: "session_interrupted",
            request_id: $req,
            details: {
                recovery_action: "restored_from_checkpoint"
            }
        }')
    echo "${event}" >> "${events_file}"
}
```

### Task 8: State File Corruption Recovery

#### `validate_state_file(state_file: string) -> int`

Called before any operation that reads a state.json file (selection, spawn, update).

```bash
validate_state_file() {
    local state_file="$1"

    # Fast path: file exists and is valid JSON
    if [[ -f "${state_file}" ]] && jq empty "${state_file}" 2>/dev/null; then
        return 0
    fi

    # File does not exist
    if [[ ! -f "${state_file}" ]]; then
        log_error "State file missing: ${state_file}"
        return 1
    fi

    # File exists but is invalid JSON
    log_warn "State file corrupt: ${state_file}. Attempting checkpoint recovery."

    local req_dir
    req_dir=$(dirname "${state_file}")
    local checkpoint_file="${req_dir}/checkpoint.json"

    if [[ -f "${checkpoint_file}" ]] && jq empty "${checkpoint_file}" 2>/dev/null; then
        cp "${checkpoint_file}" "${state_file}"
        log_info "Restored state.json from checkpoint: ${state_file}"
        return 0
    fi

    # Both corrupt or checkpoint missing
    local request_id
    request_id=$(basename "${req_dir}")
    log_error "Unrecoverable state corruption for ${request_id}. Both state.json and checkpoint.json are invalid."

    # Attempt to transition to failed (write a minimal valid state)
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    jq -n \
        --arg id "${request_id}" \
        --arg ts "${ts}" \
        '{
            id: $id,
            status: "failed",
            updated_at: $ts,
            current_phase_metadata: {
                failure_reason: "state_corruption",
                failed_at: $ts
            }
        }' > "${state_file}"

    emit_alert "state_corruption" "Unrecoverable state corruption for request ${request_id}"

    return 1
}
```

#### Integration Points

Add `validate_state_file` calls in:
1. `select_request()`: Before parsing each state.json.
2. `spawn_session()`: Before reading the state.
3. `update_request_state()`: Before updating the state.

Example integration in `select_request()`:
```bash
for state_file in "${req_dir}"/*/state.json; do
    [[ -f "${state_file}" ]] || continue
    validate_state_file "${state_file}" || continue  # Skip corrupt files
    ...
done
```

### Task 9: Cost Ledger Corruption Recovery

#### Enhanced `check_cost_caps()` (modifies SPEC-001-2-01)

The cost cap check already handles corrupt ledger by returning 1 (SPEC-001-2-01). This spec adds:

1. An alert emission on corruption detection.
2. A recovery instruction in the log.

```bash
# Inside check_cost_caps, where corrupt ledger is detected:
if ! jq empty "${COST_LEDGER_FILE}" 2>/dev/null; then
    log_error "Cost ledger is corrupt. Refusing to process work."
    log_error "Recovery: Run 'autonomous-dev config init --reset-ledger' to reinitialize."
    emit_alert "cost_ledger_corruption" "Cost ledger at ${COST_LEDGER_FILE} is corrupt. Daemon will not process work until repaired."
    return 1
fi
```

#### Enhanced `update_cost_ledger()` (modifies SPEC-001-2-04)

Similarly, if the ledger is corrupt when attempting to update:

```bash
# Inside update_cost_ledger:
local ledger
ledger=$(read_cost_ledger)
if [[ -z "${ledger}" ]]; then
    log_error "Cannot update cost ledger (corrupt or unreadable)"
    log_error "Recovery: Run 'autonomous-dev config init --reset-ledger' to reinitialize."
    emit_alert "cost_ledger_corruption" "Cost ledger is corrupt. Cannot record session cost."
    return 1
fi
```

### Edge Cases
- **Sleep event with no active sessions**: Recovery scans repos, finds no interrupted sessions. Logs "recovery complete" and proceeds.
- **Sleep event with active session but no checkpoint**: Keeps the current state.json (may contain partial session work). Clears `session_active` flag. Logs warning.
- **Crash state has no `updated_at` field**: `crash_state_updated_at` is empty, treated as no recent crash activity (classified as sleep).
- **All repos empty during recovery scan**: Recovery completes quickly with no action.
- **validate_state_file called on a file that another process is atomically writing**: The `mv` pattern means the file is either the old complete version or the new complete version. `jq empty` succeeds on both.
- **Checkpoint is valid but stale (from many sessions ago)**: Still better than corrupt state. The session may re-do work, but state is consistent.
- **State corruption creates a `failed` state file for an unknown request ID**: The request ID is inferred from the directory name. If the directory name doesn't match the original request ID, the failed state will have a mismatched ID. This is acceptable as a best-effort recovery.

## Acceptance Criteria
1. [ ] After sleep event simulation (backdated heartbeat by 30 minutes, `session_active: true`), daemon restores from checkpoint
2. [ ] After recovery, `session_active` is set to `false`
3. [ ] After recovery, `events.jsonl` has a `session_interrupted` event
4. [ ] Crash counter is NOT incremented for sleep events (staleness > 10 min with no recent crash state update)
5. [ ] Crash counter IS incremented for non-sleep stale heartbeats (staleness < 10 min or recent crash state update)
6. [ ] Recovered request is selectable on the next iteration
7. [ ] Orphaned processes from the prior instance are killed
8. [ ] With corrupt `state.json` and valid `checkpoint.json`, state is restored. Log contains "Restored state.json from checkpoint"
9. [ ] With both `state.json` and `checkpoint.json` corrupt, request transitions to `failed` with reason `state_corruption`. Alert is emitted
10. [ ] With valid `state.json`, no recovery runs (fast path, no extra overhead)
11. [ ] `validate_state_file` is called before selection, spawn, and update operations
12. [ ] With corrupt `cost-ledger.json`, gate check fails, no sessions spawned. Log contains recovery instruction
13. [ ] Alert is emitted on cost ledger corruption
14. [ ] With valid or missing ledger, normal operation continues
15. [ ] No shellcheck warnings at `--severity=warning` level

## Test Cases
1. **test_sleep_recovery_restores_checkpoint** -- Create a request with `session_active: true` and a valid checkpoint. Backdate heartbeat by 30 minutes. Call `recover_from_stale_heartbeat`. Assert state.json is restored from checkpoint. Assert `session_active == false`.
2. **test_sleep_recovery_event_logged** -- After recovery, read `events.jsonl`. Assert last entry has `type: "session_interrupted"`.
3. **test_sleep_recovery_no_crash_increment** -- Set `CONSECUTIVE_CRASHES=0`. Simulate sleep recovery. Assert `CONSECUTIVE_CRASHES` is still 0.
4. **test_sleep_recovery_no_active_sessions** -- Create requests with `session_active: false`. Backdate heartbeat. Call recovery. Assert no state files were modified.
5. **test_sleep_recovery_no_checkpoint** -- Create a request with `session_active: true` but no checkpoint file. Call recovery. Assert `session_active` is cleared. Assert log contains "No checkpoint found".
6. **test_sleep_vs_crash_classification_sleep** -- Backdate heartbeat by 30 minutes. No recent crash state update. Assert classified as sleep.
7. **test_sleep_vs_crash_classification_crash** -- Backdate heartbeat by 2 minutes. Assert classified as potential crash.
8. **test_validate_state_valid** -- Create a valid state.json. Call `validate_state_file`. Assert return 0.
9. **test_validate_state_corrupt_with_checkpoint** -- Write invalid JSON to state.json. Create a valid checkpoint.json. Call `validate_state_file`. Assert return 0. Assert state.json is now valid (restored from checkpoint).
10. **test_validate_state_both_corrupt** -- Write invalid JSON to both state.json and checkpoint.json. Call `validate_state_file`. Assert return 1. Assert state.json now has `status: "failed"`. Assert alert file created.
11. **test_validate_state_missing** -- Remove state.json. Call `validate_state_file`. Assert return 1.
12. **test_cost_ledger_corrupt_blocks** -- Write "not json" to cost ledger. Call `check_cost_caps`. Assert return 1. Assert log contains "Recovery: Run".
13. **test_cost_ledger_corrupt_alert** -- Write "not json" to cost ledger. Call `check_cost_caps`. Assert alert file created with type `cost_ledger_corruption`.
14. **test_cost_ledger_update_corrupt** -- Write "not json" to cost ledger. Call `update_cost_ledger "5.00"`. Assert return 1. Assert alert emitted.
