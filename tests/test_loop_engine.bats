#!/usr/bin/env bats
###############################################################################
# test_loop_engine.bats - Tests for SPEC-001-2-05
#
# Covers:
#   - Idle backoff (exponential, cap, reset)
#   - Main loop wiring (full iteration integration tests)
#   - Mock-claude validation
#
# Requires: jq, bats
###############################################################################

load test_helpers

setup() {
    setup_test_env
    source_functions
}

teardown() {
    # Clean up any background processes
    if [[ -n "${CURRENT_CHILD_PID:-}" ]] && kill -0 "${CURRENT_CHILD_PID}" 2>/dev/null; then
        kill "${CURRENT_CHILD_PID}" 2>/dev/null || true
    fi
    teardown_test_env
}

###############################################################################
# Unit Tests: Idle Backoff
###############################################################################

# Test 1: test_idle_backoff_first_sleep
# Set POLL_INTERVAL=2, IDLE_BACKOFF_CURRENT=2. Override sleep to record
# its argument. Call idle_backoff_sleep. Assert recorded sleep is "2".
@test "idle_backoff_sleep: first idle sleep uses base poll interval" {
    POLL_INTERVAL=2
    IDLE_BACKOFF_CURRENT=2
    IDLE_BACKOFF_MAX=900

    # Override sleep to record argument instead of actually sleeping
    local sleep_log="${TEST_DAEMON_HOME}/sleep-args.log"
    sleep() { echo "$1" >> "${sleep_log}"; }
    export -f sleep

    # Override wait to no-op (idle_backoff_sleep backgrounds sleep and waits)
    wait() { :; }

    idle_backoff_sleep

    # Assert the sleep duration recorded
    local recorded
    recorded=$(head -1 "${sleep_log}")
    [ "${recorded}" = "2" ]

    # Verify the log message contains the duration
    assert_log_contains "No actionable work. Sleeping 2s."
}

# Test 2: test_idle_backoff_doubling
# Set IDLE_BACKOFF_CURRENT=2. Call idle_backoff_sleep (override sleep to
# no-op). Assert IDLE_BACKOFF_CURRENT == 4. Call again. Assert == 8.
@test "idle_backoff_sleep: doubles on consecutive calls (2 -> 4 -> 8)" {
    IDLE_BACKOFF_CURRENT=2
    IDLE_BACKOFF_MAX=900

    # No-op sleep and wait
    sleep() { :; }
    export -f sleep
    wait() { :; }

    idle_backoff_sleep
    [ "${IDLE_BACKOFF_CURRENT}" -eq 4 ]

    idle_backoff_sleep
    [ "${IDLE_BACKOFF_CURRENT}" -eq 8 ]
}

# Test 3: test_idle_backoff_cap
# Set IDLE_BACKOFF_CURRENT=512, IDLE_BACKOFF_MAX=900. Call idle_backoff_sleep.
# Assert IDLE_BACKOFF_CURRENT == 900 (capped, not 1024).
@test "idle_backoff_sleep: caps at IDLE_BACKOFF_MAX (512 -> 900, not 1024)" {
    IDLE_BACKOFF_CURRENT=512
    IDLE_BACKOFF_MAX=900

    # No-op sleep and wait
    sleep() { :; }
    export -f sleep
    wait() { :; }

    idle_backoff_sleep
    [ "${IDLE_BACKOFF_CURRENT}" -eq 900 ]
}

# Test 4: test_idle_backoff_reset
# Set IDLE_BACKOFF_CURRENT=120, IDLE_BACKOFF_BASE=30. Call idle_backoff_reset.
# Assert IDLE_BACKOFF_CURRENT == 30.
@test "idle_backoff_reset: resets to base after work found" {
    IDLE_BACKOFF_CURRENT=120
    IDLE_BACKOFF_BASE=30

    idle_backoff_reset
    [ "${IDLE_BACKOFF_CURRENT}" -eq 30 ]
}

###############################################################################
# Mock-Claude Direct Tests
###############################################################################

# Test 12: test_mock_claude_success
# Run mock-claude.sh directly with MOCK_CLAUDE_BEHAVIOR=success.
# Assert exit code 0 and output is valid JSON with cost_usd.
@test "mock-claude: success behavior returns exit 0 with valid JSON" {
    local mock_script="${PLUGIN_DIR}/tests/mock-claude.sh"
    export MOCK_CLAUDE_BEHAVIOR=success
    export MOCK_CLAUDE_COST="2.50"
    export MOCK_CLAUDE_LOG="${TEST_DAEMON_HOME}/mock-invocations.log"

    run "${mock_script}" --print --output-format json
    [ "$status" -eq 0 ]

    # Validate JSON output
    echo "${output}" | jq empty
    local cost
    cost=$(echo "${output}" | jq -r '.cost_usd')
    [ "${cost}" = "2.5" ]

    local result
    result=$(echo "${output}" | jq -r '.result')
    [ "${result}" = "success" ]
}

# Test 13: test_mock_claude_failure
# Run with MOCK_CLAUDE_BEHAVIOR=failure. Assert exit code 1.
@test "mock-claude: failure behavior returns exit 1" {
    local mock_script="${PLUGIN_DIR}/tests/mock-claude.sh"
    export MOCK_CLAUDE_BEHAVIOR=failure
    export MOCK_CLAUDE_LOG="${TEST_DAEMON_HOME}/mock-invocations.log"

    run "${mock_script}" --print
    [ "$status" -eq 1 ]

    # Output should still be JSON
    echo "${output}" | jq empty
    local result
    result=$(echo "${output}" | jq -r '.result')
    [ "${result}" = "error" ]
}

# Test 14: test_mock_claude_turns_exhausted
# Run with MOCK_CLAUDE_BEHAVIOR=turns_exhausted. Assert exit code 2.
@test "mock-claude: turns_exhausted behavior returns exit 2 with max_turns_reached" {
    local mock_script="${PLUGIN_DIR}/tests/mock-claude.sh"
    export MOCK_CLAUDE_BEHAVIOR=turns_exhausted
    export MOCK_CLAUDE_COST="5.00"
    export MOCK_CLAUDE_LOG="${TEST_DAEMON_HOME}/mock-invocations.log"

    run "${mock_script}" --print
    [ "$status" -eq 2 ]

    # Validate JSON output
    echo "${output}" | jq empty
    local reason
    reason=$(echo "${output}" | jq -r '.reason')
    [ "${reason}" = "max_turns_reached" ]
}

###############################################################################
# Integration Tests: Full Loop Iteration
###############################################################################

# Test 5: test_integration_success_flow
# Set up: create repo fixture, add request with status "intake", set up
# mock-claude with "success" behavior. Run supervisor-loop.sh --once.
# Assert: state.json has retry_count == 0, last_error == null.
# Assert: events.jsonl has session_complete entry.
# Assert: cost ledger has today's entry.
@test "integration: mock success -> state updated, cost tracked, crash counter reset" {
    # Create a mock repo with a request
    local repo_dir="${TEST_DAEMON_HOME}/repos/my-project"
    mkdir -p "${repo_dir}"
    local req_dir
    req_dir=$(create_request_fixture "${repo_dir}" "REQ-001" "intake" 1)

    # Set up mock config pointing to this repo
    setup_mock_config "${repo_dir}"

    # Set up mock claude for success
    setup_mock_claude
    export MOCK_CLAUDE_BEHAVIOR=success
    export MOCK_CLAUDE_COST="3.75"

    # Initialize cost ledger
    initialize_cost_ledger

    # Set variables for fast test execution
    POLL_INTERVAL=1
    IDLE_BACKOFF_CURRENT=1
    IDLE_BACKOFF_BASE=1
    ONCE_MODE=true
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false
    ERROR_BACKOFF_BASE=1
    ERROR_BACKOFF_MAX=2
    MAX_RETRIES_PER_PHASE=3

    # Run the main loop (--once mode for single iteration)
    main_loop

    # Assert state.json updated
    local state_file="${req_dir}/state.json"
    [ -f "${state_file}" ]

    local retry_count
    retry_count=$(jq -r '.current_phase_metadata.retry_count' "${state_file}")
    [ "${retry_count}" = "0" ]

    local last_error
    last_error=$(jq -r '.current_phase_metadata.last_error' "${state_file}")
    [ "${last_error}" = "null" ]

    local session_active
    session_active=$(jq -r '.current_phase_metadata.session_active' "${state_file}")
    [ "${session_active}" = "false" ]

    # Assert events.jsonl has session_complete entry
    local events_file="${req_dir}/events.jsonl"
    [ -f "${events_file}" ]
    grep -q '"session_complete"' "${events_file}"

    # Assert cost ledger has today's entry
    local today
    today=$(date -u +"%Y-%m-%d")
    [ -f "${COST_LEDGER_FILE}" ]
    local daily_total
    daily_total=$(jq -r ".daily[\"${today}\"].total_usd" "${COST_LEDGER_FILE}")
    [ "${daily_total}" = "3.75" ]

    # Assert crash counter was reset
    [ "${CONSECUTIVE_CRASHES}" -eq 0 ]
}

# Test 6: test_integration_failure_flow
# Same setup but mock-claude with "failure" behavior. Run --once.
# Assert: state.json has retry_count == 1, last_error contains exit code.
# Assert: events.jsonl has session_error entry.
@test "integration: mock failure -> retry count incremented, crash counter incremented" {
    # Create a mock repo with a request
    local repo_dir="${TEST_DAEMON_HOME}/repos/my-project"
    mkdir -p "${repo_dir}"
    local req_dir
    req_dir=$(create_request_fixture "${repo_dir}" "REQ-002" "code" 1)

    # Set up mock config pointing to this repo
    setup_mock_config "${repo_dir}"

    # Set up mock claude for failure
    setup_mock_claude
    export MOCK_CLAUDE_BEHAVIOR=failure
    export MOCK_CLAUDE_COST="0.50"

    # Initialize cost ledger
    initialize_cost_ledger

    # Set variables
    POLL_INTERVAL=1
    IDLE_BACKOFF_CURRENT=1
    IDLE_BACKOFF_BASE=1
    ONCE_MODE=true
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false
    ERROR_BACKOFF_BASE=1
    ERROR_BACKOFF_MAX=2
    MAX_RETRIES_PER_PHASE=3

    # Run the main loop
    main_loop

    # Assert state.json updated with error details
    local state_file="${req_dir}/state.json"
    [ -f "${state_file}" ]

    local retry_count
    retry_count=$(jq -r '.current_phase_metadata.retry_count' "${state_file}")
    [ "${retry_count}" = "1" ]

    local last_error
    last_error=$(jq -r '.current_phase_metadata.last_error' "${state_file}")
    [[ "${last_error}" == *"exit"* ]] || [[ "${last_error}" == *"code"* ]]

    # Assert events.jsonl has session_error entry
    local events_file="${req_dir}/events.jsonl"
    [ -f "${events_file}" ]
    grep -q '"session_error"' "${events_file}"

    # Assert crash counter incremented
    [ "${CONSECUTIVE_CRASHES}" -eq 1 ]

    # Assert crash state was persisted
    [ -f "${CRASH_STATE_FILE}" ]
    local persisted_crashes
    persisted_crashes=$(jq -r '.consecutive_crashes' "${CRASH_STATE_FILE}")
    [ "${persisted_crashes}" = "1" ]
}

# Test 7: test_integration_no_work
# Set up: empty allowlist (or no requests). Run --once.
# Assert: log contains "No actionable work". Assert: no session output files.
@test "integration: no requests -> idle backoff sleep logged" {
    # Set up mock config with no repos (empty allowlist)
    setup_mock_config ""

    # Initialize cost ledger
    initialize_cost_ledger

    # Set variables
    POLL_INTERVAL=1
    IDLE_BACKOFF_CURRENT=1
    IDLE_BACKOFF_BASE=1
    ONCE_MODE=true
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false

    # Override sleep to no-op for fast test
    sleep() { :; }
    export -f sleep

    # Run the main loop
    main_loop

    # Assert log contains idle backoff message
    assert_log_contains "No actionable work"

    # Assert no session output files created
    local session_files
    session_files=$(find "${LOG_DIR}" -name "session-*.json" 2>/dev/null | wc -l)
    [ "${session_files}" -eq 0 ]
}

# Test 8: test_integration_kill_switch
# Create kill switch file. Create a request. Run --once.
# Assert: log contains "Kill switch is engaged". Assert: no session spawned.
@test "integration: kill switch -> no session spawned" {
    # Create a mock repo with a request
    local repo_dir="${TEST_DAEMON_HOME}/repos/my-project"
    mkdir -p "${repo_dir}"
    create_request_fixture "${repo_dir}" "REQ-003" "code" 1

    # Set up mock config pointing to this repo
    setup_mock_config "${repo_dir}"

    # Set up mock claude (should NOT be called)
    setup_mock_claude

    # Initialize cost ledger
    initialize_cost_ledger

    # Create the kill switch
    touch "${KILL_SWITCH_FILE}"

    # Set variables
    POLL_INTERVAL=1
    IDLE_BACKOFF_CURRENT=1
    IDLE_BACKOFF_BASE=1
    ONCE_MODE=true
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false

    # Override sleep to no-op
    sleep() { :; }
    export -f sleep

    # Run the main loop
    main_loop

    # Assert kill switch logged
    assert_log_contains "Kill switch is engaged"

    # Assert no session output files created
    local session_files
    session_files=$(find "${LOG_DIR}" -name "session-*.json" 2>/dev/null | wc -l)
    [ "${session_files}" -eq 0 ]

    # Assert mock-claude was never called (no invocation log)
    [ ! -f "${MOCK_CLAUDE_LOG}" ]
}

# Test 9: test_integration_mock_claude_args
# Run integration with mock-claude. Read MOCK_CLAUDE_LOG.
# Assert the invocation includes --print, --output-format json, --max-turns,
# --prompt, --project-directory.
@test "integration: mock claude invoked with correct CLI arguments" {
    # Create a mock repo with a request
    local repo_dir="${TEST_DAEMON_HOME}/repos/my-project"
    mkdir -p "${repo_dir}"
    create_request_fixture "${repo_dir}" "REQ-004" "code" 1

    # Set up mock config
    setup_mock_config "${repo_dir}"

    # Set up mock claude
    setup_mock_claude
    export MOCK_CLAUDE_BEHAVIOR=success
    export MOCK_CLAUDE_COST="1.00"

    # Initialize cost ledger
    initialize_cost_ledger

    # Set variables
    POLL_INTERVAL=1
    IDLE_BACKOFF_CURRENT=1
    IDLE_BACKOFF_BASE=1
    ONCE_MODE=true
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false
    ERROR_BACKOFF_BASE=1
    ERROR_BACKOFF_MAX=2
    MAX_RETRIES_PER_PHASE=3

    # Run the main loop
    main_loop

    # Assert MOCK_CLAUDE_LOG exists and was populated
    [ -f "${MOCK_CLAUDE_LOG}" ]

    # Read the invocation arguments
    local invocation
    invocation=$(cat "${MOCK_CLAUDE_LOG}")

    # Assert all expected arguments are present
    [[ "${invocation}" == *"--print"* ]]
    [[ "${invocation}" == *"--output-format"* ]]
    [[ "${invocation}" == *"json"* ]]
    [[ "${invocation}" == *"--max-turns"* ]]
    [[ "${invocation}" == *"--prompt"* ]]
    [[ "${invocation}" == *"--project-directory"* ]]
}

# Test 10: test_integration_cost_tracking
# Set mock-claude cost to "3.75". Run --once. Assert cost ledger today's
# total is 3.75.
@test "integration: cost tracking records session cost in ledger" {
    # Create a mock repo with a request
    local repo_dir="${TEST_DAEMON_HOME}/repos/my-project"
    mkdir -p "${repo_dir}"
    create_request_fixture "${repo_dir}" "REQ-005" "intake" 1

    # Set up mock config
    setup_mock_config "${repo_dir}"

    # Set up mock claude with specific cost
    setup_mock_claude
    export MOCK_CLAUDE_BEHAVIOR=success
    export MOCK_CLAUDE_COST="3.75"

    # Initialize cost ledger
    initialize_cost_ledger

    # Set variables
    POLL_INTERVAL=1
    IDLE_BACKOFF_CURRENT=1
    IDLE_BACKOFF_BASE=1
    ONCE_MODE=true
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false
    ERROR_BACKOFF_BASE=1
    ERROR_BACKOFF_MAX=2
    MAX_RETRIES_PER_PHASE=3

    # Run the main loop
    main_loop

    # Assert cost ledger has today's entry with correct cost
    local today
    today=$(date -u +"%Y-%m-%d")
    [ -f "${COST_LEDGER_FILE}" ]

    local daily_total
    daily_total=$(jq -r ".daily[\"${today}\"].total_usd" "${COST_LEDGER_FILE}")
    [ "${daily_total}" = "3.75" ]

    # Assert the session entry exists
    local session_count
    session_count=$(jq -r ".daily[\"${today}\"].sessions | length" "${COST_LEDGER_FILE}")
    [ "${session_count}" -eq 1 ]

    local session_req
    session_req=$(jq -r ".daily[\"${today}\"].sessions[0].request_id" "${COST_LEDGER_FILE}")
    [ "${session_req}" = "REQ-005" ]
}

# Test 11: test_integration_once_mode_single_iteration
# Run --once. Assert heartbeat shows iteration_count == 1.
@test "integration: --once mode runs exactly one iteration" {
    # Create a mock repo with a request
    local repo_dir="${TEST_DAEMON_HOME}/repos/my-project"
    mkdir -p "${repo_dir}"
    create_request_fixture "${repo_dir}" "REQ-006" "intake" 1

    # Set up mock config
    setup_mock_config "${repo_dir}"

    # Set up mock claude
    setup_mock_claude
    export MOCK_CLAUDE_BEHAVIOR=success
    export MOCK_CLAUDE_COST="1.00"

    # Initialize cost ledger
    initialize_cost_ledger

    # Reset iteration count
    ITERATION_COUNT=0

    # Set variables
    POLL_INTERVAL=1
    IDLE_BACKOFF_CURRENT=1
    IDLE_BACKOFF_BASE=1
    ONCE_MODE=true
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false
    ERROR_BACKOFF_BASE=1
    ERROR_BACKOFF_MAX=2
    MAX_RETRIES_PER_PHASE=3

    # Run the main loop
    main_loop

    # Assert exactly one iteration was performed
    [ "${ITERATION_COUNT}" -eq 1 ]

    # Assert heartbeat file was written with iteration_count == 1
    [ -f "${HEARTBEAT_FILE}" ]
    local hb_iter
    hb_iter=$(jq -r '.iteration_count' "${HEARTBEAT_FILE}")
    [ "${hb_iter}" = "1" ]
}
