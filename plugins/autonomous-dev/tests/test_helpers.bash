#!/usr/bin/env bash
###############################################################################
# test_helpers.bash - Shared test infrastructure for autonomous-dev tests
#
# Provides setup/teardown, environment isolation, and assertion helpers.
# Designed to be loaded by bats test files via `load test_helpers`.
###############################################################################

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
    export IDLE_BACKOFF_CURRENT=1
    export IDLE_BACKOFF_BASE=1
    export DAILY_COST_CAP=50.00
    export MONTHLY_COST_CAP=500.00
    export CIRCUIT_BREAKER_THRESHOLD=3
    export CONSECUTIVE_CRASHES=0
    export CIRCUIT_BREAKER_TRIPPED=false
}

# Cleanup test environment
teardown_test_env() {
    rm -rf "${TEST_DAEMON_HOME}"
}

# Source the script's functions without running main()
# The script uses a BASH_SOURCE guard so sourcing is safe.
source_functions() {
    source "${SCRIPT}"
}

# Assert a log file contains a message
assert_log_contains() {
    local pattern="$1"
    grep -q "${pattern}" "${LOG_FILE}"
}

# Assert a log file does NOT contain a message
assert_log_not_contains() {
    local pattern="$1"
    ! grep -q "${pattern}" "${LOG_FILE}"
}

# Assert a JSON file has a field with value
assert_json_field() {
    local file="$1" field="$2" expected="$3"
    local actual
    actual=$(jq -r "${field}" "${file}")
    [[ "${actual}" == "${expected}" ]]
}

###############################################################################
# Plan 3 Resilience Test Helpers
###############################################################################

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

# Create a request directory with state.json for testing
# Usage: create_request_fixture <repo_dir> <request_id> <status> <priority>
create_request_fixture() {
    local repo_dir="$1"
    local request_id="$2"
    local status="${3:-code}"
    local priority="${4:-1}"

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
                session_active: false,
                retry_count: 0,
                last_error: null,
                next_retry_after: null
            }
        }' > "${req_dir}/state.json"

    echo "${req_dir}"
}

# Create a request with session_active: true and a checkpoint
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

# Set up a mock effective config for tests that need select_request or recover_from_stale_heartbeat
setup_mock_config() {
    local repo_dir="${1:-}"
    EFFECTIVE_CONFIG="${TEST_DAEMON_HOME}/effective-config.json"
    if [[ -n "${repo_dir}" ]]; then
        jq -n --arg repo "${repo_dir}" \
            '{repositories: {allowlist: [$repo]}, daemon: {}}' \
            > "${EFFECTIVE_CONFIG}"
    else
        jq -n '{repositories: {allowlist: []}, daemon: {}}' \
            > "${EFFECTIVE_CONFIG}"
    fi
}

# Set up a mock claude command for testing
# Uses the full mock-claude.sh script that supports multiple behaviors
# via MOCK_CLAUDE_BEHAVIOR environment variable.
setup_mock_claude() {
    local mock_dir="${TEST_DAEMON_HOME}/mock-bin"
    mkdir -p "${mock_dir}"
    cp "${PLUGIN_DIR}/tests/mock-claude.sh" "${mock_dir}/claude"
    chmod +x "${mock_dir}/claude"
    export PATH="${mock_dir}:${PATH}"
    export MOCK_CLAUDE_LOG="${TEST_DAEMON_HOME}/mock-claude-invocations.log"
    # Default behavior: success with $1.50 cost
    export MOCK_CLAUDE_BEHAVIOR="${MOCK_CLAUDE_BEHAVIOR:-success}"
    export MOCK_CLAUDE_COST="${MOCK_CLAUDE_COST:-1.50}"
    export MOCK_CLAUDE_DELAY="${MOCK_CLAUDE_DELAY:-0}"
}
