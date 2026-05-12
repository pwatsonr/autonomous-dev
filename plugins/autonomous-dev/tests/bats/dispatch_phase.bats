#!/usr/bin/env bats
###############################################################################
# dispatch_phase.bats - Tests for dispatch_phase_session
#
# Covers TASK-009, TASK-026 (SPEC-039-2-03) acceptance criteria:
# - dispatch_phase_session calls spawn_session_typed
# - reads current_phase not .status for agent selection
# - unknown phase returns 3 no state change
# - invalid request_id returns 2
# - timeout synthesizes fail result
# - spawn failure returns propagated code
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"

    # Set required environment variables for supervisor-loop.sh
    export EFFECTIVE_CONFIG="${EFFECTIVE_CONFIG:-/dev/null}"
    export DAEMON_STATE_DIR="${BATS_TEST_TMPDIR}/daemon-state"
    export PORTAL_REQUEST_ACTIONS_DIR="${BATS_TEST_TMPDIR}/portal/request-actions"

    # Create required directories
    mkdir -p "${DAEMON_STATE_DIR}" "${PORTAL_REQUEST_ACTIONS_DIR}"

    # Source the supervisor-loop.sh
    # shellcheck source=../../bin/supervisor-loop.sh
    source "${PLUGIN_DIR}/bin/supervisor-loop.sh"

    # Setup test directory
    TEST_PROJECT="${BATS_TEST_TMPDIR}/test-project"
    REQ_DIR="${TEST_PROJECT}/.autonomous-dev/requests/REQ-123456"
    STATE_FILE="${REQ_DIR}/state.json"

    mkdir -p "${REQ_DIR}"

    # Create valid state.json
    cat > "${STATE_FILE}" << 'EOF'
{
  "id": "REQ-123456",
  "status": "running",
  "current_phase": "prd",
  "type": "feature",
  "expedited_reviews": false,
  "current_phase_metadata": {}
}
EOF

    # Mock claude command that succeeds quickly
    MOCK_CLAUDE="${BATS_TEST_TMPDIR}/claude"
    cat > "${MOCK_CLAUDE}" << 'EOF'
#!/bin/bash
echo '{"status": "success", "total_cost_usd": 1.23}'
exit 0
EOF
    chmod +x "${MOCK_CLAUDE}"

    # Put mock claude on PATH
    export PATH="${BATS_TEST_TMPDIR}:${PATH}"

    # Shorter timeout for tests
    export DISPATCH_TIMEOUT="2s"
}

@test "dispatch_uses_spawn_session_typed" {
    # Use CAPTURE_SPAWN_TO to verify spawn_session_typed is called
    CAPTURE_FILE="${BATS_TEST_TMPDIR}/capture.txt"
    export CAPTURE_SPAWN_TO="${CAPTURE_FILE}"

    # Call directly instead of using run to avoid scope issues
    local result
    result=$(dispatch_phase_session "REQ-123456" "${TEST_PROJECT}")
    local exit_code=$?

    echo "Dispatch result: $result"
    echo "Dispatch exit code: $exit_code"

    [[ $exit_code -eq 0 ]]
    [[ -f "${CAPTURE_FILE}" ]]
    # Verify the command includes correct agent
    grep -q "prd-author" "${CAPTURE_FILE}"
}

@test "reads_current_phase_not_status" {
    # Set state.json with status=running, current_phase=prd
    jq '.status = "running" | .current_phase = "prd"' "${STATE_FILE}" > "${STATE_FILE}.tmp"
    mv "${STATE_FILE}.tmp" "${STATE_FILE}"

    CAPTURE_FILE="${BATS_TEST_TMPDIR}/capture.txt"
    export CAPTURE_SPAWN_TO="${CAPTURE_FILE}"

    run dispatch_phase_session "REQ-123456" "${TEST_PROJECT}"

    [[ $status -eq 0 ]]
    # Should resolve prd -> prd-author, not status=running
    grep -q "prd-author" "${CAPTURE_FILE}"
}

@test "unknown_phase_returns_3_no_state_change" {
    # Set unknown phase
    jq '.current_phase = "garbage"' "${STATE_FILE}" > "${STATE_FILE}.tmp"
    mv "${STATE_FILE}.tmp" "${STATE_FILE}"

    # Capture original state
    original_state=$(cat "${STATE_FILE}")

    run dispatch_phase_session "REQ-123456" "${TEST_PROJECT}"

    [[ $status -eq 3 ]]
    # State should be unchanged
    current_state=$(cat "${STATE_FILE}")
    [[ "${current_state}" == "${original_state}" ]]
}

@test "invalid_request_id_returns_2" {
    run dispatch_phase_session "bogus-id" "${TEST_PROJECT}"

    [[ $status -eq 2 ]]
    # Should echo error format
    [[ "${output}" == "2|0|" ]]
}

@test "timeout_synthesizes_fail" {
    # Create a claude that sleeps longer than timeout
    SLOW_CLAUDE="${BATS_TEST_TMPDIR}/claude-slow"
    cat > "${SLOW_CLAUDE}" << 'EOF'
#!/bin/bash
sleep 10
EOF
    chmod +x "${SLOW_CLAUDE}"
    mv "${BATS_TEST_TMPDIR}/claude" "${BATS_TEST_TMPDIR}/claude-orig"
    mv "${SLOW_CLAUDE}" "${BATS_TEST_TMPDIR}/claude"

    # Unset CAPTURE_SPAWN_TO so it actually runs claude
    unset CAPTURE_SPAWN_TO

    run dispatch_phase_session "REQ-123456" "${TEST_PROJECT}"

    [[ $status -eq 124 ]]

    # Should synthesize fail result
    RESULT_FILE="${REQ_DIR}/phase-result-prd.json"
    [[ -f "${RESULT_FILE}" ]]

    status_value=$(jq -r '.status' "${RESULT_FILE}")
    [[ "${status_value}" == "fail" ]]

    error_value=$(jq -r '.error' "${RESULT_FILE}")
    [[ "${error_value}" == "WALL_CLOCK_TIMEOUT" ]]
}

@test "spawn_failure_returns_propagated_code" {
    # Create a claude that exits with code 42
    FAIL_CLAUDE="${BATS_TEST_TMPDIR}/claude-fail"
    cat > "${FAIL_CLAUDE}" << 'EOF'
#!/bin/bash
echo '{"error": "test failure"}'
exit 42
EOF
    chmod +x "${FAIL_CLAUDE}"
    mv "${BATS_TEST_TMPDIR}/claude" "${BATS_TEST_TMPDIR}/claude-orig"
    mv "${FAIL_CLAUDE}" "${BATS_TEST_TMPDIR}/claude"

    # Unset CAPTURE_SPAWN_TO so it actually runs claude
    unset CAPTURE_SPAWN_TO

    run dispatch_phase_session "REQ-123456" "${TEST_PROJECT}"

    [[ $status -eq 42 ]]
}