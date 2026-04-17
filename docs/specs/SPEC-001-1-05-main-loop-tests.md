# SPEC-001-1-05: Main Loop Shell and Unit Tests

## Metadata
- **Parent Plan**: PLAN-001-1
- **Tasks Covered**: Task 10 (Main loop shell), Task 11 (Unit tests)
- **Estimated effort**: 8 hours

## Description
Implement the `main()` function that orchestrates the init phase and enters the main loop with stub work-selection logic. Create comprehensive unit tests for all Plan 1 functions using the bats testing framework.

## Files to Create/Modify

- **Path**: `bin/supervisor-loop.sh`
  - **Action**: Modify
  - **Description**: Add the `main()` function with init sequence and while-true loop. Add stub functions for gate checks and request selection that Plan 2 will replace.

- **Path**: `tests/test_supervisor_core.bats`
  - **Action**: Create
  - **Description**: Bats test file covering all Plan 1 functions (tasks 2-10).

- **Path**: `tests/test_helpers.bash`
  - **Action**: Create
  - **Description**: Shared test helper functions for setting up temp directories, sourcing the script, and common assertions.

## Implementation Details

### Task 10: Main Loop Shell

#### `main(args: string[]) -> void`

The `main()` function is the entry point called at the bottom of the script: `main "$@"`.

- **Init Phase** (executed once):
  1. `parse_args "$@"`
  2. `mkdir -p "${DAEMON_HOME}" "${LOG_DIR}" "${ALERTS_DIR}"`
  3. `validate_dependencies`
  4. `acquire_lock`
  5. `load_config`
  6. `detect_stale_heartbeat`
  7. `load_crash_state` (stub: Plan 3 implements fully; for now, initialize `CONSECUTIVE_CRASHES=0`, `CIRCUIT_BREAKER_TRIPPED=false`)
  8. `log_info "Daemon starting (PID $$, once_mode=${ONCE_MODE})"`

- **Main Loop**:
  ```bash
  while true; do
      ITERATION_COUNT=$(( ITERATION_COUNT + 1 ))
      write_heartbeat

      # Check shutdown flag
      if [[ "${SHUTDOWN_REQUESTED}" == "true" ]]; then
          log_info "Shutdown requested. Exiting main loop."
          break
      fi

      # Gate checks (stub: always passes until Plan 2)
      if ! check_gates; then
          sleep "${POLL_INTERVAL}"
          [[ "${ONCE_MODE}" == "true" ]] && break
          continue
      fi

      # Select work (stub: returns empty until Plan 2)
      local selection
      selection=$(select_request)

      if [[ -z "${selection}" ]]; then
          idle_backoff_sleep
          [[ "${ONCE_MODE}" == "true" ]] && break
          continue
      fi

      # Work found -- stub: Plan 2 will add session spawning here
      idle_backoff_reset
      log_info "Work selected: ${selection} (session spawning not yet implemented)"

      # Rotate logs (stub: Plan 3 implements)
      # rotate_logs_if_needed

      [[ "${ONCE_MODE}" == "true" ]] && break
  done
  ```

- **Exit Phase**:
  ```bash
  log_info "Daemon exiting cleanly (iterations=${ITERATION_COUNT})"
  # EXIT trap handles release_lock
  ```

#### Stub Functions

These stubs will be replaced by subsequent plans:

```bash
# Stub: Plan 2 replaces with kill switch, cost cap, circuit breaker checks
check_gates() {
    return 0  # All gates pass
}

# Stub: Plan 2 replaces with actual request selection
select_request() {
    echo ""  # No work available
}

# Stub: Plan 3 replaces with actual crash state loading
load_crash_state() {
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false
}

# Stub: Plan 3 replaces with actual alert emission
emit_alert() {
    local alert_type="$1" message="$2"
    log_error "ALERT [${alert_type}]: ${message}"
}
```

#### Idle Backoff (included in main loop)

These functions should be defined at this point (since the loop uses them):

```bash
IDLE_BACKOFF_CURRENT=${POLL_INTERVAL}
IDLE_BACKOFF_BASE=${POLL_INTERVAL}

idle_backoff_sleep() {
    log_info "No actionable work. Sleeping ${IDLE_BACKOFF_CURRENT}s."
    sleep "${IDLE_BACKOFF_CURRENT}"
    IDLE_BACKOFF_CURRENT=$(( IDLE_BACKOFF_CURRENT * 2 ))
    if [[ ${IDLE_BACKOFF_CURRENT} -gt ${IDLE_BACKOFF_MAX} ]]; then
        IDLE_BACKOFF_CURRENT=${IDLE_BACKOFF_MAX}
    fi
}

idle_backoff_reset() {
    IDLE_BACKOFF_CURRENT=${IDLE_BACKOFF_BASE}
}
```

Note: In `--once` mode, the `idle_backoff_sleep` is called but then the loop breaks immediately after. The sleep duration in `--once` mode may be shortened for testing by overriding `POLL_INTERVAL` before running.

#### Directory Creation

`main()` must create:
- `~/.autonomous-dev/` (DAEMON_HOME)
- `~/.autonomous-dev/logs/` (LOG_DIR)
- `~/.autonomous-dev/alerts/` (ALERTS_DIR)

These are created with `mkdir -p` which is idempotent.

### Task 11: Unit Tests

#### Test Infrastructure

**`tests/test_helpers.bash`** provides:

```bash
# Source location
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${PLUGIN_DIR}/bin/supervisor-loop.sh"

# Create isolated test environment
setup_test_env() {
    export TEST_DAEMON_HOME=$(mktemp -d)
    export TEST_LOG_DIR="${TEST_DAEMON_HOME}/logs"
    export TEST_ALERTS_DIR="${TEST_DAEMON_HOME}/alerts"
    mkdir -p "${TEST_LOG_DIR}" "${TEST_ALERTS_DIR}"

    # Override constants for testing
    export DAEMON_HOME="${TEST_DAEMON_HOME}"
    export LOG_DIR="${TEST_LOG_DIR}"
    export LOG_FILE="${TEST_LOG_DIR}/daemon.log"
    export LOCK_FILE="${TEST_DAEMON_HOME}/daemon.lock"
    export HEARTBEAT_FILE="${TEST_DAEMON_HOME}/heartbeat.json"
    export CRASH_STATE_FILE="${TEST_DAEMON_HOME}/crash-state.json"
    export KILL_SWITCH_FILE="${TEST_DAEMON_HOME}/kill-switch.flag"
    export COST_LEDGER_FILE="${TEST_DAEMON_HOME}/cost-ledger.json"
    export ALERTS_DIR="${TEST_ALERTS_DIR}"
    export CONFIG_FILE="${TEST_DAEMON_HOME}/user-config.json"
    export DEFAULTS_FILE="${PLUGIN_DIR}/config/defaults.json"
    export EFFECTIVE_CONFIG=""

    # Reset state
    export ONCE_MODE=false
    export SHUTDOWN_REQUESTED=false
    export CURRENT_CHILD_PID=""
    export ITERATION_COUNT=0
    export POLL_INTERVAL=1  # Short for tests
    export HEARTBEAT_INTERVAL=30
    export IDLE_BACKOFF_MAX=4
}

# Cleanup test environment
teardown_test_env() {
    rm -rf "${TEST_DAEMON_HOME}"
}

# Source the script's functions without running main()
# This requires the script to only call main "$@" at the bottom
source_functions() {
    # Source the script but override main to be a no-op
    eval "$(sed 's/^main "\$@"//' "${SCRIPT}")"
}

# Assert a log file contains a message
assert_log_contains() {
    local pattern="$1"
    grep -q "${pattern}" "${LOG_FILE}"
}

# Assert a JSON file has a field with value
assert_json_field() {
    local file="$1" field="$2" expected="$3"
    local actual
    actual=$(jq -r "${field}" "${file}")
    [[ "${actual}" == "${expected}" ]]
}
```

**`tests/test_supervisor_core.bats`** structure:

```bash
#!/usr/bin/env bats

load test_helpers

setup() {
    setup_test_env
    source_functions
}

teardown() {
    teardown_test_env
}
```

#### Required Test Coverage

The bats file must include tests for each functional area. Minimum test list (each is a `@test` block):

**Argument Parsing (3 tests)**:
- `parse_args --once` sets ONCE_MODE
- `parse_args` with no args leaves ONCE_MODE false
- `parse_args --unknown` exits 1

**Logging (5 tests)**:
- `log_info` produces valid JSONL
- `log_warn` sets level to WARN
- `log_error` sets level to ERROR
- Log message with special characters is valid JSON
- Log includes correct PID and iteration count

**Dependency Validation (3 tests)**:
- All deps present: succeeds
- Missing dep: exits 1 with error listing missing command
- Claude version logged on success

**Lock File (5 tests)**:
- Fresh lock acquisition succeeds
- Stale lock detected and replaced
- Active lock causes exit 1
- Empty lock file treated as stale
- Release removes lock

**Heartbeat (4 tests)**:
- Write produces valid JSON
- Null active_request when no argument
- Active request set when argument provided
- Iteration count matches global state

**Stale Heartbeat Detection (4 tests)**:
- No heartbeat file: "Fresh start"
- Stale heartbeat: warning logged
- Recent heartbeat: "Normal startup"
- Unreadable heartbeat: treated as stale

**Signal Handling (3 tests)**:
- handle_shutdown sets SHUTDOWN_REQUESTED
- handle_shutdown does not kill child PID
- SIGTERM to running script causes clean exit

**Config Loading (5 tests)**:
- Defaults only (no user config)
- User config merge (single field override)
- Deep merge (nested field override)
- Invalid user JSON exits 1
- Missing defaults file exits 1

**Main Loop (3 tests)**:
- `--once` mode exits after one iteration
- Directories created on startup
- Heartbeat updated during loop

Total: ~35 tests minimum.

### Edge Cases for Tests
- Tests must be isolated: each test uses its own temp directory.
- Tests that start background processes must clean them up in teardown.
- Tests that modify PATH must restore it afterward.
- Tests must not depend on the real `~/.autonomous-dev/` directory.
- `source_functions` must handle the script's `set -euo pipefail` without failing (test environment may have unset variables).

## Acceptance Criteria
1. [ ] `supervisor-loop.sh --once` completes one full init phase, one loop iteration, and exits with code 0
2. [ ] Without `--once`, the script loops and sleeps (verified by heartbeat iteration count increasing over time)
3. [ ] `ITERATION_COUNT` increments by 1 each loop iteration
4. [ ] Heartbeat is written at the top of each loop iteration
5. [ ] With stub `select_request`, every iteration hits the "no work" path and calls `idle_backoff_sleep`
6. [ ] `--once` mode breaks after one iteration even in the "no work" path
7. [ ] `SHUTDOWN_REQUESTED=true` causes the loop to break on the next iteration check
8. [ ] All required directories (`~/.autonomous-dev/`, `logs/`, `alerts/`) are created on startup
9. [ ] `tests/test_helpers.bash` exists with `setup_test_env()`, `teardown_test_env()`, `source_functions()`, and assertion helpers
10. [ ] `tests/test_supervisor_core.bats` exists with at least 35 test cases
11. [ ] All tests pass when run with `bats tests/test_supervisor_core.bats`
12. [ ] Tests are isolated (each uses its own temp directory, no cross-test state leakage)
13. [ ] No shellcheck warnings at `--severity=warning` level in the main script
14. [ ] Stub functions (`check_gates`, `select_request`, `load_crash_state`, `emit_alert`) are present and return appropriate defaults

## Test Cases
1. **test_main_once_mode_exits** -- Run `supervisor-loop.sh --once` with test environment. Assert exit code 0. Assert `ITERATION_COUNT >= 1` in heartbeat. Assert lock file is removed.
2. **test_main_creates_directories** -- Remove `$DAEMON_HOME`. Run `main --once`. Assert `$DAEMON_HOME`, `$LOG_DIR`, `$ALERTS_DIR` all exist.
3. **test_main_heartbeat_updates** -- Run script in background (not --once). Sleep 3 seconds. Read heartbeat. Assert `iteration_count >= 1`. Send SIGTERM. Wait for exit.
4. **test_main_init_order** -- Run `--once`. Assert log entries appear in order: "Claude CLI version", "Lock acquired", "Config loaded", "Daemon starting".
5. **test_main_shutdown_check** -- Set `SHUTDOWN_REQUESTED=true` before entering loop. Assert loop body executes 0 times (immediate break).
6. **test_stub_check_gates_passes** -- Call `check_gates`. Assert return code 0.
7. **test_stub_select_request_empty** -- Call `select_request`. Assert output is empty string.
8. **test_idle_backoff_in_once_mode** -- Override `POLL_INTERVAL=1`. Run `main --once`. Assert log contains "No actionable work. Sleeping 1s".
