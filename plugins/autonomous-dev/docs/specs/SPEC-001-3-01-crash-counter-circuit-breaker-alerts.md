# SPEC-001-3-01: Crash Counter, Circuit Breaker, and Alert Emission

## Metadata
- **Parent Plan**: PLAN-001-3
- **Tasks Covered**: Task 1 (Crash counter persistence), Task 2 (Circuit breaker trip and gate check), Task 3 (Alert emission stub)
- **Estimated effort**: 5 hours

## Description
Replace the Plan 1 stubs for crash counting and circuit breaker with persistent implementations. The crash counter tracks consecutive session failures in `crash-state.json`. When the threshold is reached, the circuit breaker trips and blocks all iterations until reset. Alerts are emitted as local JSON files for operator visibility.

## Files to Create/Modify

- **Path**: `bin/supervisor-loop.sh`
  - **Action**: Modify
  - **Description**: Replace stubs for `load_crash_state()`, `save_crash_state()`, `record_success()`, `record_crash()`, and `emit_alert()`. Add circuit breaker gate check logic to `check_gates()`.

## Implementation Details

### Task 1: Crash Counter Persistence

#### `load_crash_state() -> void`

Replaces the Plan 1 stub. Called once during init phase.

```bash
load_crash_state() {
    if [[ -f "${CRASH_STATE_FILE}" ]]; then
        # Validate JSON before reading
        if ! jq empty "${CRASH_STATE_FILE}" 2>/dev/null; then
            log_warn "Crash state file is corrupt. Resetting to defaults."
            CONSECUTIVE_CRASHES=0
            CIRCUIT_BREAKER_TRIPPED=false
            save_crash_state
            return
        fi
        CONSECUTIVE_CRASHES=$(jq -r '.consecutive_crashes // 0' "${CRASH_STATE_FILE}")
        CIRCUIT_BREAKER_TRIPPED=$(jq -r '.circuit_breaker_tripped // false' "${CRASH_STATE_FILE}")
        log_info "Crash state loaded: consecutive_crashes=${CONSECUTIVE_CRASHES}, circuit_breaker_tripped=${CIRCUIT_BREAKER_TRIPPED}"
    else
        CONSECUTIVE_CRASHES=0
        CIRCUIT_BREAKER_TRIPPED=false
        log_info "No crash state file found. Starting fresh."
    fi
}
```

#### `save_crash_state(exit_code?: string, request_id?: string, phase?: string) -> void`

Atomic write of the crash state to `$CRASH_STATE_FILE`.

```bash
save_crash_state() {
    local exit_code="${1:-}"
    local request_id="${2:-}"
    local phase="${3:-}"
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local tmp="${CRASH_STATE_FILE}.tmp"

    jq -n \
        --argjson crashes "${CONSECUTIVE_CRASHES}" \
        --argjson tripped "${CIRCUIT_BREAKER_TRIPPED}" \
        --arg ts "${ts}" \
        --arg exit_code "${exit_code}" \
        --arg request_id "${request_id}" \
        --arg phase "${phase}" \
        '{
            consecutive_crashes: $crashes,
            circuit_breaker_tripped: $tripped,
            updated_at: $ts,
            last_crash_exit_code: (if $exit_code == "" then null else ($exit_code | tonumber? // null) end),
            last_crash_request_id: (if $request_id == "" then null else $request_id end),
            last_crash_phase: (if $phase == "" then null else $phase end)
        }' > "${tmp}"
    mv "${tmp}" "${CRASH_STATE_FILE}"
}
```

**Schema for `crash-state.json`**:
```json
{
  "consecutive_crashes": 2,
  "circuit_breaker_tripped": false,
  "updated_at": "2026-04-08T14:30:00Z",
  "last_crash_exit_code": 1,
  "last_crash_request_id": "REQ-20260408-abcd",
  "last_crash_phase": "code"
}
```

### Task 2: Circuit Breaker Trip and Gate Check

#### `record_crash(request_id?: string, exit_code?: string) -> void`

Replaces the Plan 1 stub.

```bash
record_crash() {
    local request_id="${1:-}"
    local exit_code="${2:-}"

    CONSECUTIVE_CRASHES=$(( CONSECUTIVE_CRASHES + 1 ))
    log_error "Crash recorded. Consecutive crashes: ${CONSECUTIVE_CRASHES}/${CIRCUIT_BREAKER_THRESHOLD}"

    # Read the phase from the request's state if available
    local phase=""
    if [[ -n "${request_id}" ]]; then
        # Try to read the phase from the most recently used project
        # This is best-effort; the phase may not be resolvable here
        phase=""  # Populated by the caller context if needed
    fi

    if [[ ${CONSECUTIVE_CRASHES} -ge ${CIRCUIT_BREAKER_THRESHOLD} ]]; then
        CIRCUIT_BREAKER_TRIPPED=true
        log_error "CIRCUIT BREAKER TRIPPED after ${CONSECUTIVE_CRASHES} consecutive crashes."
        emit_alert "circuit_breaker" "Circuit breaker tripped after ${CONSECUTIVE_CRASHES} consecutive crashes. Last request: ${request_id}, exit code: ${exit_code}"
    fi

    save_crash_state "${exit_code}" "${request_id}" "${phase}"
}
```

#### `record_success() -> void`

Replaces the Plan 1 stub.

```bash
record_success() {
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false
    save_crash_state
    log_info "Success recorded. Crash counter reset."
}
```

#### Updated `check_gates()` Circuit Breaker Section

Replace the stub circuit breaker check (already in SPEC-001-2-01) with real logic:

```bash
# Inside check_gates():
if [[ "${CIRCUIT_BREAKER_TRIPPED}" == "true" ]]; then
    log_warn "Circuit breaker is tripped. Skipping iteration. Run 'autonomous-dev circuit-breaker reset' to clear."
    return 1
fi
```

This was already wired in SPEC-001-2-01 but now the `CIRCUIT_BREAKER_TRIPPED` variable is populated from real crash state instead of always being `false`.

### Task 3: Alert Emission

#### `emit_alert(alert_type: string, message: string) -> void`

Replaces the Plan 1 stub.

```bash
emit_alert() {
    local alert_type="$1"
    local message="$2"
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Ensure alerts directory exists
    mkdir -p "${ALERTS_DIR}"

    # Generate unique filename
    local alert_file="${ALERTS_DIR}/alert-${alert_type}-$(date +%s)-$$.json"

    # Write alert file
    local tmp="${alert_file}.tmp"
    jq -n \
        --arg type "${alert_type}" \
        --arg msg "${message}" \
        --arg ts "${ts}" \
        --argjson pid "$$" \
        '{
            type: $type,
            message: $msg,
            timestamp: $ts,
            daemon_pid: $pid
        }' > "${tmp}"
    mv "${tmp}" "${alert_file}"

    # Also log at ERROR level
    log_error "ALERT [${alert_type}]: ${message}"
}
```

**Alert file schema**:
```json
{
  "type": "circuit_breaker",
  "message": "Circuit breaker tripped after 3 consecutive crashes. Last request: REQ-xxx, exit code: 1",
  "timestamp": "2026-04-08T14:30:00Z",
  "daemon_pid": 12345
}
```

**Alert types** (used across Plan 3):
- `circuit_breaker` -- Circuit breaker tripped.
- `retry_exhaustion` -- A request exceeded max retries for a phase.
- `state_corruption` -- Unrecoverable state file corruption.
- `cost_ledger_corruption` -- Cost ledger is corrupt.
- `permission_violation` -- File permissions are too permissive (Plan 4).

### Edge Cases
- Crash state file is corrupt on load: Logged as warning, state reset to defaults, file overwritten.
- `CIRCUIT_BREAKER_THRESHOLD` is 0: Any crash immediately trips the breaker. This is valid (operator wants zero tolerance).
- `CIRCUIT_BREAKER_THRESHOLD` is 1: Single crash trips the breaker.
- `record_success` called when crash count is already 0: No-op except saving state (idempotent).
- Multiple rapid crashes in the same loop iteration (impossible since spawning is sequential): Not a concern.
- Alert directory does not exist on first alert: `mkdir -p` creates it.
- Alert filename collision (same second, same PID): Extremely unlikely. Adding PID makes it unique per daemon instance. If truly needed, add a random suffix.

## Acceptance Criteria
1. [ ] After a session failure, `crash-state.json` shows `consecutive_crashes` incremented by 1
2. [ ] `crash-state.json` includes `last_crash_exit_code`, `last_crash_request_id`, and `last_crash_phase`
3. [ ] After a success, `consecutive_crashes` resets to 0 in `crash-state.json`
4. [ ] After daemon restart, crash counter is loaded from file (not reset to 0)
5. [ ] `crash-state.json` is valid JSON after every write (atomic tmp+mv)
6. [ ] With `circuit_breaker_threshold=3`, three consecutive failures trip the breaker
7. [ ] Log contains "CIRCUIT BREAKER TRIPPED" when breaker trips
8. [ ] Subsequent `check_gates()` calls return 1 with "Circuit breaker is tripped" logged
9. [ ] A single `record_success()` after crashes clears the breaker and resets counter
10. [ ] `check_gates()` passes after circuit breaker reset
11. [ ] `emit_alert "circuit_breaker" "message"` creates a JSON file in `$ALERTS_DIR`
12. [ ] Alert file is valid JSON with `type`, `message`, `timestamp`, `daemon_pid`
13. [ ] Alerts are also logged at ERROR level
14. [ ] `$ALERTS_DIR` is created if missing
15. [ ] Corrupt `crash-state.json` on load is handled (reset to defaults, warning logged)
16. [ ] No shellcheck warnings at `--severity=warning` level

## Test Cases
1. **test_load_crash_state_fresh** -- No crash state file. Call `load_crash_state`. Assert `CONSECUTIVE_CRASHES == 0` and `CIRCUIT_BREAKER_TRIPPED == false`.
2. **test_load_crash_state_existing** -- Write a crash state with `consecutive_crashes: 2`. Call `load_crash_state`. Assert `CONSECUTIVE_CRASHES == 2`.
3. **test_load_crash_state_corrupt** -- Write "not json" to crash state file. Call `load_crash_state`. Assert `CONSECUTIVE_CRASHES == 0` (reset). Assert log contains "corrupt".
4. **test_save_crash_state_valid_json** -- Set `CONSECUTIVE_CRASHES=2`, `CIRCUIT_BREAKER_TRIPPED=false`. Call `save_crash_state "1" "REQ-001" "code"`. Read file with `jq`. Assert `.consecutive_crashes == 2`, `.last_crash_exit_code == 1`, `.last_crash_request_id == "REQ-001"`.
5. **test_record_crash_increments** -- Set `CONSECUTIVE_CRASHES=0`. Call `record_crash`. Assert `CONSECUTIVE_CRASHES == 1`.
6. **test_record_crash_trips_breaker** -- Set `CIRCUIT_BREAKER_THRESHOLD=3`, `CONSECUTIVE_CRASHES=2`. Call `record_crash`. Assert `CONSECUTIVE_CRASHES == 3` and `CIRCUIT_BREAKER_TRIPPED == true`. Assert log contains "CIRCUIT BREAKER TRIPPED".
7. **test_record_crash_under_threshold** -- Set threshold to 5, crashes to 1. Call `record_crash`. Assert `CIRCUIT_BREAKER_TRIPPED == false`.
8. **test_record_success_resets** -- Set `CONSECUTIVE_CRASHES=3`, `CIRCUIT_BREAKER_TRIPPED=true`. Call `record_success`. Assert both are reset to 0/false. Assert `crash-state.json` reflects reset.
9. **test_circuit_breaker_blocks_gates** -- Set `CIRCUIT_BREAKER_TRIPPED=true`. Call `check_gates`. Assert return 1.
10. **test_circuit_breaker_cleared_gates_pass** -- Set `CIRCUIT_BREAKER_TRIPPED=false`. Ensure no kill switch. Call `check_gates`. Assert return 0.
11. **test_emit_alert_creates_file** -- Call `emit_alert "test_type" "test message"`. Assert a file matching `alert-test_type-*.json` exists in `$ALERTS_DIR`.
12. **test_emit_alert_valid_json** -- Read the created alert file. Assert it parses with `jq` and has `.type == "test_type"` and `.message == "test message"`.
13. **test_emit_alert_logged** -- Assert log contains "ALERT [test_type]: test message".
14. **test_crash_state_persists_restart** -- Set crashes to 2, save. Clear variables. Call `load_crash_state`. Assert `CONSECUTIVE_CRASHES == 2`.
15. **test_record_crash_with_alert** -- Trip the breaker. Assert an alert file was created in `$ALERTS_DIR`.
