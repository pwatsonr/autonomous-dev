# SPEC-001-2-05: Idle Backoff, Main Loop Wiring, and Tests

## Metadata
- **Parent Plan**: PLAN-001-2
- **Tasks Covered**: Task 9 (Idle backoff), Task 10 (Wire everything into main loop), Task 11 (Unit and integration tests)
- **Estimated effort**: 9 hours

## Description
Implement exponential idle backoff with cap and reset. Replace Plan 1's stub loop body with the full operational sequence: gate checks, request selection, session spawning, state update, and cost ledger update. Create unit and integration tests for all Plan 2 functions using mock-claude.

## Files to Create/Modify

- **Path**: `bin/supervisor-loop.sh`
  - **Action**: Modify
  - **Description**: Finalize `idle_backoff_sleep()`, `idle_backoff_reset()`. Replace the stub main loop body with the full operational wiring.

- **Path**: `tests/test_loop_engine.bats`
  - **Action**: Create
  - **Description**: Unit and integration tests for all Plan 2 functions.

- **Path**: `tests/mock-claude.sh`
  - **Action**: Create
  - **Description**: Mock Claude CLI script that simulates success, failure, and turns-exhausted behaviors.

- **Path**: `tests/test_helpers.bash`
  - **Action**: Modify
  - **Description**: Add shared fixtures for request state files and mock-claude setup.

## Implementation Details

### Task 9: Idle Backoff

#### Variables (set after config load)

```bash
IDLE_BACKOFF_CURRENT=${POLL_INTERVAL}  # Initialized after load_config
IDLE_BACKOFF_BASE=${POLL_INTERVAL}
# IDLE_BACKOFF_MAX is loaded from config (default 900)
```

#### `idle_backoff_sleep() -> void`

```bash
idle_backoff_sleep() {
    log_info "No actionable work. Sleeping ${IDLE_BACKOFF_CURRENT}s."
    sleep "${IDLE_BACKOFF_CURRENT}"

    # Exponential increase: double, capped at max
    IDLE_BACKOFF_CURRENT=$(( IDLE_BACKOFF_CURRENT * 2 ))
    if [[ ${IDLE_BACKOFF_CURRENT} -gt ${IDLE_BACKOFF_MAX} ]]; then
        IDLE_BACKOFF_CURRENT=${IDLE_BACKOFF_MAX}
    fi
}
```

- First idle: sleep `POLL_INTERVAL` (default 30s).
- Second idle: sleep 60s.
- Third idle: sleep 120s.
- Continues doubling until `IDLE_BACKOFF_MAX` (default 900s / 15 minutes).
- Duration is logged each time.

#### `idle_backoff_reset() -> void`

```bash
idle_backoff_reset() {
    IDLE_BACKOFF_CURRENT=${IDLE_BACKOFF_BASE}
}
```

Called when work is found. Resets to base interval.

### Task 10: Main Loop Wiring

Replace the Plan 1 stub loop body in `main()`:

```bash
main() {
    parse_args "$@"
    mkdir -p "${DAEMON_HOME}" "${LOG_DIR}" "${ALERTS_DIR}"

    validate_dependencies
    acquire_lock
    load_config
    detect_stale_heartbeat
    load_crash_state
    initialize_cost_ledger

    log_info "Daemon starting (PID $$, once_mode=${ONCE_MODE})"

    while true; do
        ITERATION_COUNT=$(( ITERATION_COUNT + 1 ))
        write_heartbeat

        # Check shutdown flag
        if [[ "${SHUTDOWN_REQUESTED}" == "true" ]]; then
            log_info "Shutdown requested. Exiting main loop."
            break
        fi

        # Gate checks (kill switch, circuit breaker, cost cap)
        if ! check_gates; then
            sleep "${POLL_INTERVAL}"
            [[ "${ONCE_MODE}" == "true" ]] && break
            continue
        fi

        # Select work
        local selection
        selection=$(select_request)

        if [[ -z "${selection}" ]]; then
            idle_backoff_sleep
            [[ "${ONCE_MODE}" == "true" ]] && break
            continue
        fi

        # Work found
        idle_backoff_reset

        local request_id project
        IFS='|' read -r request_id project <<< "${selection}"

        log_info "Processing request: ${request_id} from ${project}"

        # Spawn session and capture results
        local result exit_code session_cost output_file
        result=$(spawn_session "${request_id}" "${project}")
        IFS='|' read -r exit_code session_cost output_file <<< "${result}"

        # Update state based on exit code
        if [[ ${exit_code} -eq 0 ]]; then
            record_success
            update_request_state "${request_id}" "${project}" "success" "${session_cost}"
        else
            record_crash "${request_id}" "${exit_code}"
            update_request_state "${request_id}" "${project}" "error" "${session_cost}" "${exit_code}"
        fi

        # Update cost ledger
        update_cost_ledger "${session_cost}" "${request_id}"

        # Rotate logs if needed (stub until Plan 3)
        # rotate_logs_if_needed

        # --once mode: exit after single iteration
        [[ "${ONCE_MODE}" == "true" ]] && break
    done

    log_info "Daemon exiting cleanly (iterations=${ITERATION_COUNT})"
    # EXIT trap handles release_lock
}

main "$@"
```

#### Key Integration Points

- `record_success()` and `record_crash()` are stubs from Plan 1 (implemented in Plan 3).
- `rotate_logs_if_needed()` is commented out (implemented in Plan 3).
- `initialize_cost_ledger()` is called in the init phase.
- The `while true` loop body follows the sequence: heartbeat -> shutdown check -> gates -> select -> (no work? backoff) -> (work? spawn -> update state -> update cost).
- `--once` mode breaks after one full iteration regardless of outcome.

### Task 11: Tests

#### `tests/mock-claude.sh`

A mock script that simulates Claude CLI behavior. Controlled via environment variables.

```bash
#!/usr/bin/env bash
# Mock claude CLI for testing
# Behavior controlled by MOCK_CLAUDE_BEHAVIOR environment variable:
#   "success" (default): exit 0, write JSON output with cost
#   "failure": exit 1, write error output
#   "turns_exhausted": exit 2, write JSON with max_turns_reached
#   "hang": sleep indefinitely (for timeout tests)
#   "slow": sleep MOCK_CLAUDE_DELAY seconds then exit 0

set -euo pipefail

BEHAVIOR="${MOCK_CLAUDE_BEHAVIOR:-success}"
COST="${MOCK_CLAUDE_COST:-1.50}"
DELAY="${MOCK_CLAUDE_DELAY:-0}"

# Log invocation for test assertions
echo "$@" >> "${MOCK_CLAUDE_LOG:-/tmp/mock-claude-invocations.log}"

case "${BEHAVIOR}" in
    success)
        sleep "${DELAY}"
        jq -n --arg cost "${COST}" '{
            result: "success",
            cost_usd: ($cost | tonumber),
            turns_used: 5,
            reason: "completed"
        }'
        exit 0
        ;;
    failure)
        sleep "${DELAY}"
        echo '{"result": "error", "error": "Something went wrong"}'
        exit 1
        ;;
    turns_exhausted)
        sleep "${DELAY}"
        jq -n --arg cost "${COST}" '{
            result: "max_turns",
            cost_usd: ($cost | tonumber),
            turns_used: 200,
            reason: "max_turns_reached"
        }'
        exit 2
        ;;
    hang)
        sleep 86400
        ;;
    slow)
        sleep "${DELAY}"
        jq -n --arg cost "${COST}" '{
            result: "success",
            cost_usd: ($cost | tonumber),
            turns_used: 10,
            reason: "completed"
        }'
        exit 0
        ;;
esac
```

The mock must be placed in PATH before the real `claude` during tests.

#### `tests/test_helpers.bash` Additions

```bash
# Create a mock request state.json fixture
create_request_fixture() {
    local repo_dir="$1" request_id="$2" status="${3:-intake}" priority="${4:-1}"
    local req_dir="${repo_dir}/.autonomous-dev/requests/${request_id}"
    mkdir -p "${req_dir}"

    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    jq -n \
        --arg id "${request_id}" \
        --arg status "${status}" \
        --argjson priority "${priority}" \
        --arg ts "${ts}" \
        '{
            id: $id,
            status: $status,
            priority: $priority,
            created_at: $ts,
            updated_at: $ts,
            blocked_by: [],
            cost_accrued_usd: 0,
            current_phase_metadata: {
                retry_count: 0,
                session_active: false,
                last_error: null
            }
        }' > "${req_dir}/state.json"

    echo "${req_dir}"
}

# Set up mock-claude in PATH
setup_mock_claude() {
    local mock_dir="${TEST_DAEMON_HOME}/mock-bin"
    mkdir -p "${mock_dir}"
    cp "${PLUGIN_DIR}/tests/mock-claude.sh" "${mock_dir}/claude"
    chmod +x "${mock_dir}/claude"
    export PATH="${mock_dir}:${PATH}"
    export MOCK_CLAUDE_LOG="${TEST_DAEMON_HOME}/mock-claude-invocations.log"
}
```

#### Test Coverage

**Unit tests for idle backoff (3 tests)**:
1. First idle sleep uses base poll interval.
2. Doubling behavior: base -> 2x -> 4x.
3. Cap at `IDLE_BACKOFF_MAX`.
4. Reset after work found.

**Unit tests for gate checks (covered in SPEC-001-2-01, referenced here)**

**Unit tests for request selection (covered in SPEC-001-2-02)**

**Unit tests for max-turns (covered in SPEC-001-2-02)**

**Integration tests (full iteration)**:
1. Full iteration with mock success: request exists, mock claude succeeds, state updated, cost tracked.
2. Full iteration with mock failure: mock claude exits 1, retry count incremented.
3. Idle backoff when no requests: no work, sleep logged with backoff.
4. Kill switch blocks iteration: flag present, no session spawned.

### Edge Cases
- Idle backoff overflow: With very large `POLL_INTERVAL`, doubling could overflow bash integer arithmetic. `bash` uses 64-bit signed integers, so overflow at ~9.2 exabytes of seconds is not a practical concern. The cap at `IDLE_BACKOFF_MAX` prevents this anyway.
- `--once` mode with work: Spawns one session, updates state, and breaks. Does not loop for a second iteration.
- `--once` mode without work: Hits idle backoff, then breaks.
- `--once` mode with gate failure: Sleeps `POLL_INTERVAL`, then breaks.
- Session cost is empty string: `update_cost_ledger` should handle gracefully (treat as 0).

## Acceptance Criteria
1. [ ] First idle sleep is `POLL_INTERVAL` (30s default)
2. [ ] Second consecutive idle sleep is double (60s)
3. [ ] Third consecutive idle sleep is double again (120s)
4. [ ] Idle sleep is capped at `IDLE_BACKOFF_MAX` (900s default)
5. [ ] After finding work, next idle sleep resets to `POLL_INTERVAL`
6. [ ] Sleep duration is logged at INFO level
7. [ ] Main loop body: gates -> select -> (no work? idle) -> (work? spawn, update, cost)
8. [ ] With a valid request in an allowlisted repo, the daemon selects it, spawns a session, captures result, and updates state
9. [ ] With no requests, the daemon idle-sleeps with backoff
10. [ ] With `--once`, exactly one iteration runs (with or without work) and the script exits
11. [ ] With kill switch engaged, iterations skip work and sleep
12. [ ] `mock-claude.sh` exists and supports `success`, `failure`, `turns_exhausted`, `hang`, and `slow` behaviors
13. [ ] Integration test: mock success -> state updated, cost tracked, crash counter reset
14. [ ] Integration test: mock failure -> retry count incremented, crash counter incremented
15. [ ] Integration test: no requests -> idle backoff sleep logged
16. [ ] All tests pass (`bats tests/test_loop_engine.bats`)
17. [ ] No shellcheck warnings at `--severity=warning` level

## Test Cases
1. **test_idle_backoff_first_sleep** -- Set `POLL_INTERVAL=2`, `IDLE_BACKOFF_CURRENT=2`. Override `sleep` to record its argument. Call `idle_backoff_sleep`. Assert recorded sleep is "2".
2. **test_idle_backoff_doubling** -- Set `IDLE_BACKOFF_CURRENT=2`. Call `idle_backoff_sleep` (override sleep to no-op). Assert `IDLE_BACKOFF_CURRENT == 4`. Call again. Assert `IDLE_BACKOFF_CURRENT == 8`.
3. **test_idle_backoff_cap** -- Set `IDLE_BACKOFF_CURRENT=512`, `IDLE_BACKOFF_MAX=900`. Call `idle_backoff_sleep`. Assert `IDLE_BACKOFF_CURRENT == 900` (capped, not 1024).
4. **test_idle_backoff_reset** -- Set `IDLE_BACKOFF_CURRENT=120`, `IDLE_BACKOFF_BASE=30`. Call `idle_backoff_reset`. Assert `IDLE_BACKOFF_CURRENT == 30`.
5. **test_integration_success_flow** -- Set up: create repo fixture, add request with status "intake", set up mock-claude with "success" behavior. Run `supervisor-loop.sh --once`. Assert: state.json has `retry_count == 0`, `last_error == null`. Assert: events.jsonl has `session_complete` entry. Assert: cost ledger has today's entry.
6. **test_integration_failure_flow** -- Same setup but mock-claude with "failure" behavior. Run `--once`. Assert: state.json has `retry_count == 1`, `last_error` contains exit code. Assert: events.jsonl has `session_error` entry.
7. **test_integration_no_work** -- Set up: empty allowlist (or no requests). Run `--once`. Assert: log contains "No actionable work". Assert: no session output files created.
8. **test_integration_kill_switch** -- Create kill switch file. Create a request. Run `--once`. Assert: log contains "Kill switch is engaged". Assert: no session spawned (no session output files).
9. **test_integration_mock_claude_args** -- Run integration with mock-claude. Read `MOCK_CLAUDE_LOG`. Assert the invocation includes `--print`, `--output-format json`, `--max-turns`, `--prompt`, `--project-directory`.
10. **test_integration_cost_tracking** -- Set mock-claude cost to "3.75". Run `--once`. Assert cost ledger today's total is 3.75.
11. **test_integration_once_mode_single_iteration** -- Run `--once`. Assert heartbeat shows `iteration_count == 1`.
12. **test_mock_claude_success** -- Run `mock-claude.sh` directly with `MOCK_CLAUDE_BEHAVIOR=success`. Assert exit code 0 and output is valid JSON with `cost_usd`.
13. **test_mock_claude_failure** -- Run with `MOCK_CLAUDE_BEHAVIOR=failure`. Assert exit code 1.
14. **test_mock_claude_turns_exhausted** -- Run with `MOCK_CLAUDE_BEHAVIOR=turns_exhausted`. Assert exit code 2.
