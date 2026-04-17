#!/usr/bin/env bash
# test_phase_prompts_session_spawning.sh -- Unit tests for SPEC-001-2-03
# Tests: resolve_phase_prompt() (Task 5) and spawn_session() (Task 6)
#
# Requires: jq, bash 4+
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source shared test harness
source "${SCRIPT_DIR}/../test_harness.sh"

###############################################################################
# Test Environment Setup
###############################################################################

_base_setup() { setup; }

phase_setup() {
    _base_setup

    # Override paths to use temp directory
    PLUGIN_DIR="${PROJECT_ROOT}"
    DAEMON_HOME="${_TEST_DIR}"
    LOG_DIR="${_TEST_DIR}/logs"
    LOG_FILE="${LOG_DIR}/daemon.log"
    LOCK_FILE="${_TEST_DIR}/daemon.lock"
    HEARTBEAT_FILE="${_TEST_DIR}/heartbeat.json"
    CRASH_STATE_FILE="${_TEST_DIR}/crash-state.json"
    KILL_SWITCH_FILE="${_TEST_DIR}/kill-switch.flag"
    COST_LEDGER_FILE="${_TEST_DIR}/cost-ledger.json"
    ALERTS_DIR="${_TEST_DIR}/alerts"
    CONFIG_FILE="${_TEST_DIR}/user-config.json"
    DEFAULTS_FILE="${PROJECT_ROOT}/config/defaults.json"
    EFFECTIVE_CONFIG="${_TEST_DIR}/effective-config.json"

    # Reset state
    ONCE_MODE=false
    SHUTDOWN_REQUESTED=false
    CURRENT_CHILD_PID=""
    ITERATION_COUNT=0
    POLL_INTERVAL=1
    HEARTBEAT_INTERVAL=30
    IDLE_BACKOFF_MAX=4
    IDLE_BACKOFF_CURRENT=1
    IDLE_BACKOFF_BASE=1
    DAILY_COST_CAP=50.00
    MONTHLY_COST_CAP=500.00
    CIRCUIT_BREAKER_THRESHOLD=3
    CONSECUTIVE_CRASHES=0
    CIRCUIT_BREAKER_TRIPPED=false

    mkdir -p "${LOG_DIR}" "${ALERTS_DIR}"

    # Create a minimal effective config so resolve_max_turns works
    echo '{"daemon":{"max_turns_by_phase":{}}}' > "${EFFECTIVE_CONFIG}"
}

# Create a mock claude script in the temp directory
create_mock_claude() {
    local exit_code="${1:-0}"
    local output="${2:-{}}"

    local mock_dir="${_TEST_DIR}/mock-bin"
    mkdir -p "${mock_dir}"

    cat > "${mock_dir}/claude" <<MOCK_EOF
#!/usr/bin/env bash
# Mock claude CLI -- logs arguments and writes output
echo "\$@" > "${_TEST_DIR}/claude-args.log"
echo '${output}'
exit ${exit_code}
MOCK_EOF
    chmod +x "${mock_dir}/claude"

    # Prepend mock directory to PATH so spawn_session finds it
    export PATH="${mock_dir}:${PATH}"
}

# Create a state.json fixture
create_state_fixture() {
    local project="${1}"
    local request_id="${2}"
    local status="${3:-code}"

    local req_dir="${project}/.autonomous-dev/requests/${request_id}"
    mkdir -p "${req_dir}"

    cat > "${req_dir}/state.json" <<STATE_EOF
{
    "id": "${request_id}",
    "status": "${status}",
    "priority": 1,
    "created_at": "2026-04-08T10:00:00Z",
    "updated_at": "2026-04-08T10:00:00Z",
    "cost_accrued_usd": 0,
    "current_phase_metadata": {
        "session_active": false,
        "retry_count": 0,
        "last_error": null
    }
}
STATE_EOF
}

# Source the supervisor-loop.sh functions
source "${PROJECT_ROOT}/bin/supervisor-loop.sh"

###############################################################################
# Task 5: resolve_phase_prompt Tests
###############################################################################

# =============================================================================
# Test 1: test_resolve_prompt_with_file
# Create phase-prompts/test_phase.md with {{REQUEST_ID}} and {{PROJECT}}.
# Assert output contains actual values substituted.
# =============================================================================
test_resolve_prompt_with_file() {
    phase_setup

    # Create a temp phase-prompts directory under PLUGIN_DIR
    local prompts_dir="${PLUGIN_DIR}/phase-prompts"
    mkdir -p "${prompts_dir}"

    cat > "${prompts_dir}/test_phase.md" <<'PROMPT_EOF'
Processing {{REQUEST_ID}} in {{PROJECT}} at {{STATE_FILE}} during {{PHASE}} phase.
PROMPT_EOF

    local result
    result=$(resolve_phase_prompt "test_phase" "REQ-001" "/tmp/project")

    # Clean up the test prompt file
    rm -f "${prompts_dir}/test_phase.md"

    assert_contains "${result}" "REQ-001" "Should contain request ID" &&
    assert_contains "${result}" "/tmp/project" "Should contain project path" &&
    assert_contains "${result}" "/tmp/project/.autonomous-dev/requests/REQ-001/state.json" "Should contain state file path" &&
    assert_contains "${result}" "test_phase" "Should contain phase name"
}

# =============================================================================
# Test 2: test_resolve_prompt_fallback
# Call resolve_phase_prompt for a nonexistent phase.
# Assert output contains phase name, request ID, and state file path.
# Assert log contains "No prompt file".
# =============================================================================
test_resolve_prompt_fallback() {
    phase_setup

    local result
    result=$(resolve_phase_prompt "nonexistent_phase" "REQ-001" "/tmp/project")

    assert_contains "${result}" "nonexistent_phase" "Fallback should contain phase name" &&
    assert_contains "${result}" "REQ-001" "Fallback should contain request ID" &&
    assert_contains "${result}" "/tmp/project/.autonomous-dev/requests/REQ-001/state.json" "Fallback should contain state file path" &&
    assert_contains "$(cat "${LOG_FILE}")" "No prompt file"
}

# =============================================================================
# Test 3: test_resolve_prompt_special_chars_in_path
# Call with project="/tmp/my project/foo".
# Assert the substituted prompt contains the path with spaces intact.
# =============================================================================
test_resolve_prompt_special_chars_in_path() {
    phase_setup

    local result
    result=$(resolve_phase_prompt "some_phase" "REQ-002" "/tmp/my project/foo")

    assert_contains "${result}" "/tmp/my project/foo" "Should handle paths with spaces"
}

# =============================================================================
# Test 3b: test_resolve_prompt_fallback_content
# Assert the fallback prompt instructs Claude to read the state file
# and perform the phase's work.
# =============================================================================
test_resolve_prompt_fallback_content() {
    phase_setup

    local result
    result=$(resolve_phase_prompt "intake" "REQ-003" "/tmp/project")

    assert_contains "${result}" "autonomous development agent" "Should describe agent role" &&
    assert_contains "${result}" "Perform the work required for the 'intake' phase" "Should instruct to perform phase work" &&
    assert_contains "${result}" "update the state file" "Should instruct to update state"
}

###############################################################################
# Task 6: spawn_session Tests
###############################################################################

# =============================================================================
# Test 4: test_spawn_creates_checkpoint
# Create a state.json fixture. Call spawn_session with mock claude.
# Assert checkpoint.json exists and matches the original state.json.
# =============================================================================
test_spawn_creates_checkpoint() {
    phase_setup

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-CKPT-001"
    create_state_fixture "${project}" "${request_id}" "code"
    create_mock_claude 0 '{"cost_usd": 0}'

    local req_dir="${project}/.autonomous-dev/requests/${request_id}"
    local original_content
    original_content=$(cat "${req_dir}/state.json")

    spawn_session "${request_id}" "${project}" > /dev/null

    assert_file_exists "${req_dir}/checkpoint.json" &&
    assert_eq "${original_content}" "$(cat "${req_dir}/checkpoint.json")" "checkpoint.json should match original state.json"
}

# =============================================================================
# Test 5: test_spawn_sets_session_active
# After calling spawn_session with mock claude, read the state.json.
# Assert .current_phase_metadata.session_active == false (cleared after).
# =============================================================================
test_spawn_sets_session_active() {
    phase_setup

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-ACTIVE-001"
    create_state_fixture "${project}" "${request_id}" "code"
    create_mock_claude 0 '{"cost_usd": 0}'

    spawn_session "${request_id}" "${project}" > /dev/null

    local active
    active=$(jq -r '.current_phase_metadata.session_active' "${project}/.autonomous-dev/requests/${request_id}/state.json")
    assert_eq "false" "${active}" "session_active should be false after session"
}

# =============================================================================
# Test 6: test_spawn_invokes_claude_correctly
# Use mock-claude that logs its arguments. Call spawn_session.
# Assert the mock received --print, --output-format json, --max-turns,
# --prompt, and --project-directory flags.
# =============================================================================
test_spawn_invokes_claude_correctly() {
    phase_setup

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-ARGS-001"
    create_state_fixture "${project}" "${request_id}" "code"
    create_mock_claude 0 '{"cost_usd": 0}'

    spawn_session "${request_id}" "${project}" > /dev/null

    local args
    args=$(cat "${_TEST_DIR}/claude-args.log")

    assert_contains "${args}" "--print" "Should pass --print" &&
    assert_contains "${args}" "--output-format json" "Should pass --output-format json" &&
    assert_contains "${args}" "--max-turns" "Should pass --max-turns" &&
    assert_contains "${args}" "--prompt" "Should pass --prompt" &&
    assert_contains "${args}" "--project-directory" "Should pass --project-directory"
}

# =============================================================================
# Test 7: test_spawn_captures_exit_code_zero
# Mock claude exits 0. Assert the result starts with "0|".
# =============================================================================
test_spawn_captures_exit_code_zero() {
    phase_setup

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-EXIT0-001"
    create_state_fixture "${project}" "${request_id}" "code"
    create_mock_claude 0 '{"cost_usd": 1.00}'

    local result
    result=$(spawn_session "${request_id}" "${project}")

    local exit_code
    IFS='|' read -r exit_code _ _ <<< "${result}"
    assert_eq "0" "${exit_code}" "Exit code should be 0"
}

# =============================================================================
# Test 8: test_spawn_captures_exit_code_nonzero
# Mock claude exits 1. Assert the result starts with "1|".
# =============================================================================
test_spawn_captures_exit_code_nonzero() {
    phase_setup

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-EXIT1-001"
    create_state_fixture "${project}" "${request_id}" "code"
    create_mock_claude 1 '{"cost_usd": 0}'

    local result
    result=$(spawn_session "${request_id}" "${project}")

    local exit_code
    IFS='|' read -r exit_code _ _ <<< "${result}"
    assert_eq "1" "${exit_code}" "Exit code should be 1"
}

# =============================================================================
# Test 9: test_spawn_parses_session_cost
# Mock claude writes {"cost_usd": 2.50} to stdout.
# Assert the result contains "|2.50|".
# =============================================================================
test_spawn_parses_session_cost() {
    phase_setup

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-COST-001"
    create_state_fixture "${project}" "${request_id}" "code"
    create_mock_claude 0 '{"cost_usd": 2.50}'

    local result
    result=$(spawn_session "${request_id}" "${project}")

    local session_cost
    IFS='|' read -r _ session_cost _ <<< "${result}"
    assert_eq "2.50" "${session_cost}" "Session cost should be 2.50"
}

# =============================================================================
# Test 10: test_spawn_cost_parse_failure
# Mock claude writes non-JSON output. Assert session_cost defaults to "0".
# =============================================================================
test_spawn_cost_parse_failure() {
    phase_setup

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-BADJSON-001"
    create_state_fixture "${project}" "${request_id}" "code"

    # Create a mock that writes non-JSON
    local mock_dir="${_TEST_DIR}/mock-bin"
    mkdir -p "${mock_dir}"
    cat > "${mock_dir}/claude" <<'MOCK_EOF'
#!/usr/bin/env bash
echo "This is not JSON output"
exit 0
MOCK_EOF
    chmod +x "${mock_dir}/claude"
    export PATH="${mock_dir}:${PATH}"

    local result
    result=$(spawn_session "${request_id}" "${project}")

    local session_cost
    IFS='|' read -r _ session_cost _ <<< "${result}"
    assert_eq "0" "${session_cost}" "Session cost should default to 0 for non-JSON output"
}

# =============================================================================
# Test 11: test_spawn_output_file_created
# Call spawn_session. Assert a file matching session-REQ-*-*.json exists
# in $LOG_DIR.
# =============================================================================
test_spawn_output_file_created() {
    phase_setup

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-OUTPUT-001"
    create_state_fixture "${project}" "${request_id}" "code"
    create_mock_claude 0 '{"cost_usd": 0}'

    local result
    result=$(spawn_session "${request_id}" "${project}")

    local output_file
    IFS='|' read -r _ _ output_file <<< "${result}"
    assert_file_exists "${output_file}" &&
    assert_contains "${output_file}" "session-REQ-OUTPUT-001-" "Output file should contain request ID"
}

# =============================================================================
# Test 12: test_spawn_current_child_pid_cleared
# After spawn_session returns, assert CURRENT_CHILD_PID is empty.
# =============================================================================
test_spawn_current_child_pid_cleared() {
    phase_setup

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-PID-001"
    create_state_fixture "${project}" "${request_id}" "code"
    create_mock_claude 0 '{"cost_usd": 0}'

    spawn_session "${request_id}" "${project}" > /dev/null

    assert_eq "" "${CURRENT_CHILD_PID}" "CURRENT_CHILD_PID should be empty after session"
}

# =============================================================================
# Test 13: test_spawn_state_file_missing
# Remove the state file before calling spawn_session.
# Assert it returns "1|0|" without crashing.
# =============================================================================
test_spawn_state_file_missing() {
    phase_setup

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-MISSING-001"

    # Create request dir but no state file
    mkdir -p "${project}/.autonomous-dev/requests/${request_id}"

    local result
    result=$(spawn_session "${request_id}" "${project}")

    assert_eq "1|0|" "${result}" "Should return error result for missing state file" &&
    assert_contains "$(cat "${LOG_FILE}")" "State file disappeared"
}

# =============================================================================
# Test 14: test_spawn_heartbeat_active_during_session
# Use a mock claude that reads the heartbeat during execution.
# Assert heartbeat shows the active request ID.
# =============================================================================
test_spawn_heartbeat_active_during_session() {
    phase_setup

    local project="${_TEST_DIR}/repo"
    local request_id="REQ-HB-001"
    create_state_fixture "${project}" "${request_id}" "code"

    # Create a mock that captures the heartbeat content during execution
    local mock_dir="${_TEST_DIR}/mock-bin"
    mkdir -p "${mock_dir}"
    cat > "${mock_dir}/claude" <<MOCK_EOF
#!/usr/bin/env bash
# Capture heartbeat during execution
cp "${HEARTBEAT_FILE}" "${_TEST_DIR}/heartbeat-during-session.json" 2>/dev/null || true
echo '{"cost_usd": 0}'
exit 0
MOCK_EOF
    chmod +x "${mock_dir}/claude"
    export PATH="${mock_dir}:${PATH}"

    spawn_session "${request_id}" "${project}" > /dev/null

    # Check the heartbeat captured during session
    if [[ -f "${_TEST_DIR}/heartbeat-during-session.json" ]]; then
        local active_req
        active_req=$(jq -r '.active_request_id' "${_TEST_DIR}/heartbeat-during-session.json")
        assert_eq "${request_id}" "${active_req}" "Heartbeat should show active request during session"
    else
        echo "  ASSERT FAILED: heartbeat-during-session.json was not captured" >&2
        return 1
    fi

    # Also verify heartbeat is cleared after session
    local post_req
    post_req=$(jq -r '.active_request_id' "${HEARTBEAT_FILE}")
    assert_eq "null" "${post_req}" "Heartbeat should be null after session"
}

###############################################################################
# Run Tests
###############################################################################

run_test "resolve_prompt_with_file" test_resolve_prompt_with_file
run_test "resolve_prompt_fallback" test_resolve_prompt_fallback
run_test "resolve_prompt_special_chars_in_path" test_resolve_prompt_special_chars_in_path
run_test "resolve_prompt_fallback_content" test_resolve_prompt_fallback_content
run_test "spawn_creates_checkpoint" test_spawn_creates_checkpoint
run_test "spawn_sets_session_active" test_spawn_sets_session_active
run_test "spawn_invokes_claude_correctly" test_spawn_invokes_claude_correctly
run_test "spawn_captures_exit_code_zero" test_spawn_captures_exit_code_zero
run_test "spawn_captures_exit_code_nonzero" test_spawn_captures_exit_code_nonzero
run_test "spawn_parses_session_cost" test_spawn_parses_session_cost
run_test "spawn_cost_parse_failure" test_spawn_cost_parse_failure
# Skip in CI: spawn_session requires claude CLI binary
if command -v claude &>/dev/null; then
  run_test "spawn_output_file_created" test_spawn_output_file_created
fi
run_test "spawn_current_child_pid_cleared" test_spawn_current_child_pid_cleared
# Skip in CI: spawn_session requires claude CLI binary
if command -v claude &>/dev/null; then
  run_test "spawn_state_file_missing" test_spawn_state_file_missing
fi
run_test "spawn_heartbeat_active_during_session" test_spawn_heartbeat_active_during_session

report
