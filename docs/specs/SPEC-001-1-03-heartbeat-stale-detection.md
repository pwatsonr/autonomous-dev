# SPEC-001-1-03: Heartbeat Writing and Stale Heartbeat Detection

## Metadata
- **Parent Plan**: PLAN-001-1
- **Tasks Covered**: Task 6 (Heartbeat writing), Task 7 (Stale heartbeat detection)
- **Estimated effort**: 3.5 hours

## Description
Implement atomic heartbeat file writing that records the daemon's liveness state, and stale heartbeat detection on startup that identifies prior crashes or sleep/wake events with orphaned process cleanup.

## Files to Create/Modify

- **Path**: `bin/supervisor-loop.sh`
  - **Action**: Modify
  - **Description**: Add `write_heartbeat()`, `detect_stale_heartbeat()`, and `recover_from_stale_heartbeat()` functions.

## Implementation Details

### Task 6: Heartbeat Writing

#### `write_heartbeat(active_request_id?: string) -> void`

- **Parameters**:
  - `active_request_id` (optional, default: not provided). When not provided, the `active_request_id` field in the JSON is set to `null`.
- **Output file**: `$HEARTBEAT_FILE` (`~/.autonomous-dev/heartbeat.json`)
- **JSON schema**:
  ```json
  {
    "timestamp": "2026-04-08T14:30:00Z",
    "pid": 12345,
    "iteration_count": 42,
    "active_request_id": "REQ-20260408-abcd" | null
  }
  ```
- **Algorithm**:
  1. Generate ISO-8601 UTC timestamp: `local ts; ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")`.
  2. Determine the active_request value:
     ```bash
     local active_request="${1:-null}"
     ```
  3. Write to a temporary file using `jq -n`:
     ```bash
     local tmp="${HEARTBEAT_FILE}.tmp"
     jq -n \
         --arg ts "${ts}" \
         --argjson pid "$$" \
         --argjson iter "${ITERATION_COUNT}" \
         --arg req "${active_request}" \
         '{
             timestamp: $ts,
             pid: $pid,
             iteration_count: $iter,
             active_request_id: (if $req == "null" then null else $req end)
         }' > "${tmp}"
     ```
  4. Atomic move: `mv "${tmp}" "${HEARTBEAT_FILE}"`.

- **Atomicity guarantee**: The `tmp` + `mv` pattern ensures that `heartbeat.json` is always a complete, valid JSON file. `mv` on the same filesystem is atomic on both macOS (APFS) and Linux (ext4/XFS). The `.tmp` file is in the same directory as the target to guarantee same-filesystem operation.

### Task 7: Stale Heartbeat Detection

#### `detect_stale_heartbeat() -> void`

Called once during the init phase (before the main loop starts).

- **Algorithm**:
  1. If `$HEARTBEAT_FILE` does not exist:
     - `log_info "No heartbeat file found. Fresh start."`
     - Return (nothing to recover).
  2. Read the timestamp from the heartbeat:
     ```bash
     local last_ts
     last_ts=$(jq -r '.timestamp' "${HEARTBEAT_FILE}" 2>/dev/null || echo "")
     ```
  3. If `last_ts` is empty or null:
     - `log_warn "Heartbeat file unreadable. Treating as stale."`
     - Call `recover_from_stale_heartbeat`.
     - Return.
  4. Compute staleness in seconds:
     ```bash
     local now_epoch last_epoch staleness_seconds
     now_epoch=$(date -u +%s)
     # macOS date: -j -u -f format
     # GNU date: -u -d string
     last_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${last_ts}" +%s 2>/dev/null \
                  || date -u -d "${last_ts}" +%s 2>/dev/null \
                  || echo "0")
     staleness_seconds=$(( now_epoch - last_epoch ))
     ```
  5. Compute the threshold: `local threshold=$(( HEARTBEAT_INTERVAL * 2 ))`.
  6. If `staleness_seconds > threshold`:
     - `log_warn "Stale heartbeat detected (${staleness_seconds}s old, threshold ${threshold}s). Prior crash or sleep event."`
     - Call `recover_from_stale_heartbeat`.
  7. Otherwise:
     - `log_info "Recent heartbeat found (${staleness_seconds}s old). Normal startup."`

#### `recover_from_stale_heartbeat() -> void`

This is a **partial implementation** in Plan 1. Full recovery logic (scanning active requests, restoring from checkpoints) is deferred to Plan 3 (SPEC-001-3-03). This stub handles orphaned process cleanup only.

- **Algorithm**:
  1. Read the PID from the stale heartbeat:
     ```bash
     local stale_pid
     stale_pid=$(jq -r '.pid' "${HEARTBEAT_FILE}" 2>/dev/null || echo "")
     ```
  2. If `stale_pid` is non-empty and the process is still running (`kill -0 "${stale_pid}" 2>/dev/null`):
     - `log_warn "Orphaned process ${stale_pid} still running. Sending SIGTERM."`
     - `kill -TERM "${stale_pid}" 2>/dev/null || true`
     - `sleep 2`
     - If still running: `kill -KILL "${stale_pid}" 2>/dev/null || true`
     - `log_info "Orphaned process ${stale_pid} terminated."`
  3. If stale_pid is empty or process is not running:
     - `log_info "No orphaned process found."`
  4. Log: `log_info "Sleep/wake recovery complete."` (placeholder; Plan 3 will extend this).

### Cross-Platform Timestamp Parsing

The `date` command differs between macOS and GNU/Linux:

| Platform | Parse command |
|----------|--------------|
| macOS (BSD) | `date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$ts" +%s` |
| Linux (GNU) | `date -u -d "$ts" +%s` |

The implementation uses a fallback chain: try macOS format first, then GNU format, then fall back to `0` (which will make the staleness very large, safely triggering recovery).

### Edge Cases
- Heartbeat file exists but contains invalid JSON: `jq -r '.timestamp'` returns empty string, triggering the "unreadable" path.
- Heartbeat PID matches the current process PID (e.g., PID was reused by the OS): The `kill -0` check on the same PID would succeed but we should NOT kill ourselves. Add a guard: `if [[ "${stale_pid}" != "$$" ]]` before attempting kill.
- Heartbeat interval is 0 (misconfigured): Threshold becomes 0, making any non-zero staleness trigger recovery. This is safe (over-cautious, not harmful).
- System clock went backwards (NTP adjustment): `staleness_seconds` could be negative. Treat negative staleness as 0 (fresh).

## Acceptance Criteria
1. [ ] `write_heartbeat()` creates `heartbeat.json` containing valid JSON
2. [ ] Heartbeat contains `timestamp` (ISO-8601 UTC), `pid` (number), `iteration_count` (number), `active_request_id` (string or null)
3. [ ] `write_heartbeat` with no argument sets `active_request_id` to JSON `null`
4. [ ] `write_heartbeat "REQ-123"` sets `active_request_id` to `"REQ-123"`
5. [ ] Heartbeat write is atomic (no partial files observed under concurrent reads)
6. [ ] `detect_stale_heartbeat()` with no heartbeat file logs "Fresh start" and returns
7. [ ] `detect_stale_heartbeat()` with a heartbeat older than 2x `HEARTBEAT_INTERVAL` logs stale warning
8. [ ] `detect_stale_heartbeat()` with a recent heartbeat logs "Normal startup"
9. [ ] `recover_from_stale_heartbeat()` sends SIGTERM to orphaned PID from the heartbeat (if running)
10. [ ] `recover_from_stale_heartbeat()` does not kill the current process if PID matches `$$`
11. [ ] `recover_from_stale_heartbeat()` escalates to SIGKILL after 2 seconds if process survives SIGTERM
12. [ ] Timestamp parsing works on both macOS and Linux (fallback chain)
13. [ ] No shellcheck warnings at `--severity=warning` level

## Test Cases
1. **test_write_heartbeat_valid_json** -- Call `write_heartbeat`. Read `heartbeat.json` with `jq .`. Assert exit code 0 (valid JSON). Assert `.pid` equals `$$`. Assert `.iteration_count` equals `$ITERATION_COUNT`.
2. **test_write_heartbeat_null_request** -- Call `write_heartbeat` with no arguments. Assert `.active_request_id` is `null` (not the string "null").
3. **test_write_heartbeat_with_request** -- Call `write_heartbeat "REQ-test-001"`. Assert `.active_request_id == "REQ-test-001"`.
4. **test_write_heartbeat_atomic** -- Start a background reader that reads the heartbeat file in a loop (100 iterations). Concurrently call `write_heartbeat` 100 times. Assert every read either gets valid JSON or file-not-found (never a partial write).
5. **test_detect_stale_no_file** -- Ensure no heartbeat file exists. Call `detect_stale_heartbeat`. Assert log contains "Fresh start".
6. **test_detect_stale_old_heartbeat** -- Write a heartbeat with a timestamp 120 seconds in the past (with `HEARTBEAT_INTERVAL=30`, threshold is 60). Call `detect_stale_heartbeat`. Assert log contains "Stale heartbeat detected".
7. **test_detect_stale_recent_heartbeat** -- Write a heartbeat with a timestamp 10 seconds in the past. Call `detect_stale_heartbeat`. Assert log contains "Normal startup".
8. **test_detect_stale_unreadable_heartbeat** -- Write invalid JSON to heartbeat file. Call `detect_stale_heartbeat`. Assert log contains "unreadable".
9. **test_recover_orphaned_process** -- Start a `sleep 300` background process. Write a heartbeat with that PID. Call `recover_from_stale_heartbeat`. Assert the sleep process is no longer running.
10. **test_recover_no_orphan** -- Write a heartbeat with PID 99999999 (not running). Call `recover_from_stale_heartbeat`. Assert log contains "No orphaned process found".
11. **test_recover_self_pid_guard** -- Write a heartbeat with PID `$$`. Call `recover_from_stale_heartbeat`. Assert the current process is NOT killed (test completes successfully).
