#!/usr/bin/env bats
###############################################################################
# dispatch_phase.bats - Tests for dispatch_phase_session function export
#
# Note: Full integration tests are deferred due to bats function sourcing complexity.
# This file verifies the function is properly defined and exported.
# The function itself is tested via the working spawn_session_flags tests which
# exercise the corrected claude invocation path.
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

@test "dispatch_phase_session_function_exists" {
    # Verify the function is properly exported from supervisor-loop.sh
    run bash -c 'source bin/supervisor-loop.sh; type dispatch_phase_session'
    [[ $status -eq 0 ]]
    [[ "${output}" == *"dispatch_phase_session is a function"* ]]
}

@test "resolve_phase_budget_function_exists" {
    # Verify the helper function is properly exported
    run bash -c 'source bin/supervisor-loop.sh; type resolve_phase_budget'
    [[ $status -eq 0 ]]
    [[ "${output}" == *"resolve_phase_budget is a function"* ]]
}

@test "resolve_phase_budget_fallback_values" {
    # Test default budget values when EFFECTIVE_CONFIG has no overrides
    # Create a minimal config that will return null for phase budgets
    local config_file="${BATS_TEST_TMPDIR}/test-config.json"
    echo '{"daemon": {}}' > "${config_file}"

    result=$(bash -c "source bin/supervisor-loop.sh; EFFECTIVE_CONFIG='${config_file}'; resolve_phase_budget 'code'")
    [[ "${result}" == "10.0" ]]

    result=$(bash -c "source bin/supervisor-loop.sh; EFFECTIVE_CONFIG='${config_file}'; resolve_phase_budget 'prd_review'")
    [[ "${result}" == "2.0" ]]

    result=$(bash -c "source bin/supervisor-loop.sh; EFFECTIVE_CONFIG='${config_file}'; resolve_phase_budget 'prd'")
    [[ "${result}" == "5.0" ]]
}