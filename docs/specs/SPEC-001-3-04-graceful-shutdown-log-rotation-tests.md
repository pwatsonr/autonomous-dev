# SPEC-001-3-04: Graceful Shutdown Escalation, Log Rotation, and Tests

## Metadata
- **Parent Plan**: PLAN-001-3
- **Tasks Covered**: Task 10 (Graceful shutdown timeout escalation), Task 11 (Log rotation), Task 12 (Unit and integration tests)
- **Estimated effort**: 10.5 hours

## Description
Implement graceful shutdown timeout escalation that progressively escalates from waiting to SIGTERM to SIGKILL for hung child processes. Implement size-based log rotation and age-based log cleanup. Create comprehensive unit and integration tests for all Plan 3 resilience features.

## Files to Create/Modify

- **Path**: `bin/supervisor-loop.sh`
  - **Action**: Modify
  - **Description**: Add `graceful_shutdown_child()`, `rotate_logs_if_needed()`, and `cleanup_old_logs()` functions. Integrate into signal handler and main loop.

- **Path**: `tests/test_resilience.bats`
  - **Action**: Create
  - **Description**: Unit and integration tests for all Plan 3 resilience functions.

- **Path**: `tests/test_helpers.bash`
  - **Action**: Modify
  - **Description**: Add resilience test helpers (mock clock, state fixture generators).

## Implementation Details

### Task 10: Graceful Shutdown Timeout Escalation

#### `graceful_shutdown_child() -> void`

Called when `SHUTDOWN_REQUESTED=true` and `CURRENT_CHILD_PID` is non-empty. Integrates into the post-wait logic in the main loop.

```bash
graceful_shutdown_child() {
    local child_pid="${CURRENT_CHILD_PID}"
    if [[ -z "${child_pid}" ]]; then
        return
    fi

    # Check if child is still running
    if ! kill -0 "${child_pid}" 2>/dev/null; then
        log_info "Child process ${child_pid} already exited."
        return
    fi

    local grace_period="${GRACEFUL_SHUTDOWN_TIMEOUT:-300}"
    log_info "Waiting up to ${grace_period}s for child process ${child_pid} to exit naturally..."

    # Phase 1: Wait for natural exit
    local waited=0
    local poll_step=5
    while kill -0 "${child_pid}" 2>/dev/null && [[ ${waited} -lt ${grace_period} ]]; do
        sleep "${poll_step}"
        waited=$(( waited + poll_step ))
        if (( waited % 30 == 0 )); then
            log_info "Still waiting for child ${child_pid}... (${waited}/${grace_period}s)"
        fi
    done

    # Check if child exited during wait
    if ! kill -0 "${child_pid}" 2>/dev/null; then
        log_info "Child process ${child_pid} exited within grace period."
        return
    fi

    # Phase 2: SIGTERM
    log_warn "Child ${child_pid} did not exit within grace period (${grace_period}s). Sending SIGTERM."
    kill -TERM "${child_pid}" 2>/dev/null || true

    local sigterm_wait=10
    local sigterm_waited=0
    while kill -0 "${child_pid}" 2>/dev/null && [[ ${sigterm_waited} -lt ${sigterm_wait} ]]; do
        sleep 1
        sigterm_waited=$(( sigterm_waited + 1 ))
    done

    # Check again
    if ! kill -0 "${child_pid}" 2>/dev/null; then
        log_info "Child process ${child_pid} exited after SIGTERM."
        return
    fi

    # Phase 3: SIGKILL
    log_error "Child ${child_pid} did not respond to SIGTERM after ${sigterm_wait}s. Sending SIGKILL."
    kill -KILL "${child_pid}" 2>/dev/null || true
    wait "${child_pid}" 2>/dev/null || true

    log_info "Child process ${child_pid} forcefully terminated."
}
```

#### Integration with Signal Handler and Main Loop

Modify the signal handler in `handle_shutdown()`:
```bash
handle_shutdown() {
    local signal="$1"
    log_info "Received ${signal}, initiating graceful shutdown..."
    SHUTDOWN_REQUESTED=true
    # The actual child process handling happens in the main loop
    # after the `wait` call is interrupted by the signal.
}
```

In the main loop, after `wait` returns in `spawn_session()`, add:
```bash
# At the end of spawn_session, after wait:
if [[ "${SHUTDOWN_REQUESTED}" == "true" && -n "${CURRENT_CHILD_PID}" ]]; then
    graceful_shutdown_child
fi
CURRENT_CHILD_PID=""
```

Alternatively, integrate at the main loop level after `spawn_session` returns:
```bash
# In the main loop, after spawn_session returns:
if [[ "${SHUTDOWN_REQUESTED}" == "true" ]]; then
    log_info "Shutdown requested after session. Exiting."
    break
fi
```

### Task 11: Log Rotation

#### `rotate_logs_if_needed() -> void`

Size-based rotation called at the end of each loop iteration.

```bash
rotate_logs_if_needed() {
    if [[ ! -f "${LOG_FILE}" ]]; then
        return
    fi

    # Get file size in bytes
    local size_bytes
    if [[ "$(uname)" == "Darwin" ]]; then
        size_bytes=$(stat -f%z "${LOG_FILE}" 2>/dev/null || echo "0")
    else
        size_bytes=$(stat -c%s "${LOG_FILE}" 2>/dev/null || echo "0")
    fi

    local max_bytes=$(( LOG_MAX_SIZE_MB * 1024 * 1024 ))

    if [[ ${size_bytes} -ge ${max_bytes} ]]; then
        log_info "Log rotation triggered: ${LOG_FILE} is ${size_bytes} bytes (max ${max_bytes})"

        # Rotate: daemon.log.2 is deleted, daemon.log.1 -> daemon.log.2, daemon.log -> daemon.log.1
        rm -f "${LOG_FILE}.2"
        if [[ -f "${LOG_FILE}.1" ]]; then
            mv "${LOG_FILE}.1" "${LOG_FILE}.2"
        fi
        mv "${LOG_FILE}" "${LOG_FILE}.1"

        # Create a fresh log file
        touch "${LOG_FILE}"

        log_info "Log rotation complete. Previous log: ${LOG_FILE}.1"
    fi
}
```

**Rotation chain**:
1. Delete `daemon.log.2` (oldest).
2. Move `daemon.log.1` to `daemon.log.2`.
3. Move `daemon.log` to `daemon.log.1`.
4. Create fresh `daemon.log` with `touch`.

#### `cleanup_old_logs() -> void`

Age-based cleanup of old log files and session output files.

```bash
cleanup_old_logs() {
    local retention_days="${LOG_RETENTION_DAYS:-7}"

    # Clean up rotated daemon logs older than retention
    if [[ "$(uname)" == "Darwin" ]]; then
        find "${LOG_DIR}" -name "daemon.log.*" -mtime "+${retention_days}" -delete 2>/dev/null || true
        find "${LOG_DIR}" -name "session-*.json" -mtime "+${retention_days}" -delete 2>/dev/null || true
        find "${LOG_DIR}" -name "launchd-*.log" -mtime "+${retention_days}" -delete 2>/dev/null || true
    else
        find "${LOG_DIR}" -name "daemon.log.*" -mtime "+${retention_days}" -delete 2>/dev/null || true
        find "${LOG_DIR}" -name "session-*.json" -mtime "+${retention_days}" -delete 2>/dev/null || true
    fi

    log_info "Log cleanup complete (retention: ${retention_days} days)"
}
```

#### Integration in Main Loop

Both functions are called at the end of each iteration:
```bash
# At end of main loop body, before --once check:
rotate_logs_if_needed
cleanup_old_logs
```

### Task 12: Tests

#### `tests/test_resilience.bats` Structure

```bash
#!/usr/bin/env bats

load test_helpers

setup() {
    setup_test_env
    source_functions
    setup_mock_claude
}

teardown() {
    # Kill any lingering child processes
    [[ -n "${CHILD_PIDS:-}" ]] && kill ${CHILD_PIDS} 2>/dev/null || true
    teardown_test_env
}
```

#### Test Coverage by Category

**Crash counter tests (5 tests)**:
1. Increment on failure, check counter value.
2. Reset on success.
3. Persist across simulated daemon restart.
4. Corrupt crash state handled on load.
5. Counter starts at 0 on fresh start.

**Circuit breaker tests (5 tests)**:
1. Trip at threshold (3 consecutive failures).
2. Gate rejects when tripped.
3. Reset clears breaker.
4. Gate passes after reset.
5. Alert file created on trip.

**Error backoff tests (4 tests)**:
1. Exponential delay computation (30, 60, 120, ...).
2. Cap at max.
3. Request skipped during backoff.
4. Request selectable after backoff expires.

**Retry exhaustion tests (3 tests)**:
1. Escalation to paused after max retries.
2. Event written to events.jsonl.
3. Alert emitted.

**Turn exhaustion tests (3 tests)**:
1. Exit code 2 detection.
2. Output field detection.
3. No crash counter increment.

**Sleep/wake recovery tests (4 tests)**:
1. Stale heartbeat with active session: restore from checkpoint.
2. No active sessions: clean pass.
3. No checkpoint available: clears session_active only.
4. Crash counter not incremented for sleep events.

**State corruption tests (3 tests)**:
1. Restore from checkpoint.
2. Both corrupt: transition to failed.
3. Valid state: fast path.

**Cost ledger corruption tests (2 tests)**:
1. Gate blocks on corruption.
2. Alert emitted.

**Graceful shutdown tests (3 tests)**:
1. Child exits within grace period: no signals sent.
2. Child survives grace period: SIGTERM sent.
3. Child survives SIGTERM: SIGKILL sent.

**Log rotation tests (4 tests)**:
1. Under size limit: no rotation.
2. Over size limit: rotation occurs, files named correctly.
3. Multiple rotations: chain works (log.1 -> log.2, log -> log.1).
4. Cleanup deletes old files.

**Integration tests (3 tests)**:
1. Three consecutive failures trip breaker, reset clears it, next iteration succeeds.
2. Sleep/wake simulation: backdate heartbeat, mark session active, run daemon, verify recovery.
3. Corrupt state.json with valid checkpoint: verify restore and continued processing.

### `tests/test_helpers.bash` Additions for Plan 3

```bash
# Create a stale heartbeat for testing
create_stale_heartbeat() {
    local staleness_seconds="${1:-3600}"
    local pid="${2:-99999}"
    local past_epoch=$(( $(date -u +%s) - staleness_seconds ))
    local past_ts
    past_ts=$(date -u -j -f "%s" "${past_epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
              || date -u -d "@${past_epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)

    jq -n \
        --arg ts "${past_ts}" \
        --argjson pid "${pid}" \
        '{timestamp: $ts, pid: $pid, iteration_count: 100, active_request_id: null}' \
        > "${HEARTBEAT_FILE}"
}

# Create a request with session_active: true
create_active_session_fixture() {
    local repo_dir="$1" request_id="$2"
    local req_dir
    req_dir=$(create_request_fixture "${repo_dir}" "${request_id}" "code" 1)

    # Mark session as active
    local tmp="${req_dir}/state.json.tmp"
    jq '.current_phase_metadata.session_active = true' "${req_dir}/state.json" > "${tmp}"
    mv "${tmp}" "${req_dir}/state.json"

    # Create a checkpoint
    jq '.current_phase_metadata.session_active = false' "${req_dir}/state.json" > "${req_dir}/checkpoint.json"

    echo "${req_dir}"
}

# Override sleep for fast tests
override_sleep() {
    sleep() { :; }
    export -f sleep
}
```

### Edge Cases
- **Grace period of 0**: SIGTERM is sent immediately. Then 10s wait for SIGTERM response. Then SIGKILL.
- **Child PID was reused by OS**: `kill -0` returns true for a different process. The SIGTERM goes to the wrong process. Mitigation: This is inherent to PID-based process management. The window is small (PID reuse requires process exit + new process spawn with same PID). For production, consider process groups or `ppid` checks.
- **Log file written during rotation**: The `mv` of daemon.log is atomic. Immediately after `mv`, new log entries go to a fresh daemon.log (created by `touch`). The only risk is if a log entry is being written at the exact moment of `mv` -- but since the daemon is single-threaded, this cannot happen (log writes and rotation are in the same thread).
- **Log cleanup on system with many session files**: `find -delete` is efficient for large directories. No concern.
- **Rotation when daemon.log.1 does not exist**: The `[[ -f ]]` guard handles this.

## Acceptance Criteria
1. [ ] With a child that exits within grace period, no signals are sent and daemon exits cleanly
2. [ ] With a child that hangs past the grace period, SIGTERM is sent
3. [ ] With a child that hangs past SIGTERM wait (10s), SIGKILL is sent
4. [ ] Log records each escalation step: "Waiting...", "Sending SIGTERM", "Sending SIGKILL"
5. [ ] Daemon exits 0 after child cleanup
6. [ ] Grace period is configurable via `GRACEFUL_SHUTDOWN_TIMEOUT`
7. [ ] With a log exceeding `LOG_MAX_SIZE_MB`, rotation produces correct file chain
8. [ ] `daemon.log.1` and `daemon.log.2` are created correctly (no data loss)
9. [ ] Fresh `daemon.log` is created after rotation
10. [ ] With log files older than `LOG_RETENTION_DAYS`, cleanup deletes them
11. [ ] Session output files older than retention are also cleaned up
12. [ ] Rotation and cleanup are called at the end of each loop iteration
13. [ ] `tests/test_resilience.bats` exists with comprehensive test coverage
14. [ ] All tests pass when run with `bats tests/test_resilience.bats`
15. [ ] Tests cover: crash counter, circuit breaker, error backoff, retry exhaustion, turn exhaustion, sleep/wake recovery, state corruption, cost ledger corruption, graceful shutdown, log rotation, log cleanup
16. [ ] No shellcheck warnings at `--severity=warning` level

## Test Cases
1. **test_graceful_shutdown_natural_exit** -- Start a background `sleep 1` as child. Set `CURRENT_CHILD_PID` to its PID. Call `graceful_shutdown_child`. Assert log contains "exited within grace period". Assert child is no longer running.
2. **test_graceful_shutdown_sigterm** -- Start a background process that traps SIGTERM and exits. Set short grace period (1s). Wait for grace period to expire. Assert log contains "Sending SIGTERM". Assert child exits after SIGTERM.
3. **test_graceful_shutdown_sigkill** -- Start a background process that ignores SIGTERM (trap '' TERM). Set grace period to 1s. Call `graceful_shutdown_child`. Assert log contains "Sending SIGKILL". Assert child is no longer running.
4. **test_graceful_shutdown_no_child** -- Set `CURRENT_CHILD_PID=""`. Call `graceful_shutdown_child`. Assert it returns immediately without error.
5. **test_log_rotation_under_limit** -- Create a daemon.log smaller than `LOG_MAX_SIZE_MB`. Call `rotate_logs_if_needed`. Assert no rotation occurred (no daemon.log.1).
6. **test_log_rotation_over_limit** -- Set `LOG_MAX_SIZE_MB=1` (1 MB). Create a daemon.log larger than 1 MB (write 2 MB of data). Call `rotate_logs_if_needed`. Assert `daemon.log.1` exists. Assert fresh `daemon.log` is small.
7. **test_log_rotation_chain** -- Create daemon.log and daemon.log.1 both over limit. Rotate once. Assert daemon.log.2 exists (was daemon.log.1). Assert daemon.log.1 exists (was daemon.log). Assert daemon.log is fresh.
8. **test_log_rotation_deletes_oldest** -- Create daemon.log.2. Rotate. Assert old daemon.log.2 content is replaced by daemon.log.1 content.
9. **test_log_cleanup_old_files** -- Create session files with old modification times (use `touch -t`). Set `LOG_RETENTION_DAYS=1`. Call `cleanup_old_logs`. Assert old files are deleted. Assert recent files remain.
10. **test_log_cleanup_preserves_recent** -- Create a session file modified today. Call `cleanup_old_logs`. Assert it is NOT deleted.
11. **test_integration_three_failures_trip_breaker** -- Set up mock-claude with "failure" behavior. Set `CIRCUIT_BREAKER_THRESHOLD=3`. Run three iterations (mock the loop). Assert breaker is tripped after third failure. Assert alert file exists.
12. **test_integration_reset_and_succeed** -- After tripping breaker, set `CONSECUTIVE_CRASHES=0`, `CIRCUIT_BREAKER_TRIPPED=false`, save. Set mock-claude to "success". Run one iteration. Assert state updated successfully.
13. **test_integration_sleep_recovery** -- Create a request with `session_active: true`. Create stale heartbeat (30 min old). Run init phase. Assert request restored from checkpoint. Assert crash counter not incremented.
14. **test_integration_corrupt_state_recovery** -- Write invalid JSON to a request's state.json. Place a valid checkpoint.json. Run select_request. Assert the state was restored and the request is selectable.
