#!/usr/bin/env bash
# test_gate_checks.sh -- Unit tests for SPEC-001-2-01
# Tests: check_gates() (kill switch, circuit breaker) and check_cost_caps()
#
# Requires: jq, bash 4+, awk
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source shared test harness
source "${SCRIPT_DIR}/../test_harness.sh"

###############################################################################
# Test Environment Setup
###############################################################################

# Override the setup function from test_harness.sh to include our environment
_base_setup() { setup; }

gate_setup() {
    _base_setup

    # Override paths to use temp directory
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
    EFFECTIVE_CONFIG=""

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
}

# Source the supervisor-loop.sh functions
# The BASH_SOURCE guard prevents main from executing when sourced.
source "${PROJECT_ROOT}/bin/supervisor-loop.sh"

# =============================================================================
# Test 1: test_kill_switch_engaged
# Create $KILL_SWITCH_FILE. Call check_gates. Assert return 1.
# Assert log contains "Kill switch is engaged".
# =============================================================================
test_kill_switch_engaged() {
    gate_setup
    touch "${KILL_SWITCH_FILE}"
    local rc=0
    check_gates || rc=$?
    assert_eq "1" "${rc}" "check_gates should return 1 when kill switch is engaged"
    assert_contains "$(cat "${LOG_FILE}")" "Kill switch is engaged"
}

# =============================================================================
# Test 2: test_kill_switch_not_engaged
# Ensure $KILL_SWITCH_FILE does not exist. Call check_gates. Assert return 0.
# =============================================================================
test_kill_switch_not_engaged() {
    gate_setup
    rm -f "${KILL_SWITCH_FILE}"
    CIRCUIT_BREAKER_TRIPPED=false
    local rc=0
    check_gates || rc=$?
    assert_eq "0" "${rc}" "check_gates should return 0 when kill switch is absent"
}

# =============================================================================
# Test 3: test_kill_switch_file_not_read
# Create $KILL_SWITCH_FILE with content. Make it unreadable (chmod 000).
# Gate still triggers on existence via -f.
# =============================================================================
test_kill_switch_file_not_read() {
    gate_setup
    echo "some reason" > "${KILL_SWITCH_FILE}"
    chmod 000 "${KILL_SWITCH_FILE}"
    local rc=0
    check_gates || rc=$?
    # Restore permissions for cleanup
    chmod 644 "${KILL_SWITCH_FILE}"
    assert_eq "1" "${rc}" "check_gates should return 1 for unreadable kill switch file"
    assert_contains "$(cat "${LOG_FILE}")" "Kill switch is engaged"
}

# =============================================================================
# Test 4: test_cost_cap_under_daily
# Create a ledger with today's spend at $49. Set DAILY_COST_CAP=50.
# Call check_cost_caps. Assert return 0.
# =============================================================================
test_cost_cap_under_daily() {
    gate_setup
    local today
    today=$(date -u +"%Y-%m-%d")
    DAILY_COST_CAP=50.00
    cat > "${COST_LEDGER_FILE}" <<EOF
{"daily":{"${today}":{"total_usd":49.00,"sessions":[]}}}
EOF
    local rc=0
    check_cost_caps || rc=$?
    assert_eq "0" "${rc}" "check_cost_caps should return 0 when daily spend is under cap"
}

# =============================================================================
# Test 5: test_cost_cap_over_daily
# Create a ledger with today's spend at $51. Set DAILY_COST_CAP=50.
# Call check_cost_caps. Assert return 1. Assert log contains "Daily cost cap reached".
# =============================================================================
test_cost_cap_over_daily() {
    gate_setup
    local today
    today=$(date -u +"%Y-%m-%d")
    DAILY_COST_CAP=50.00
    cat > "${COST_LEDGER_FILE}" <<EOF
{"daily":{"${today}":{"total_usd":51.00,"sessions":[]}}}
EOF
    local rc=0
    check_cost_caps || rc=$?
    assert_eq "1" "${rc}" "check_cost_caps should return 1 when daily spend exceeds cap"
    assert_contains "$(cat "${LOG_FILE}")" "Daily cost cap reached"
}

# =============================================================================
# Test 6: test_cost_cap_under_monthly
# Create a ledger with multiple days in the current month totaling $450.
# Set MONTHLY_COST_CAP=500. Call check_cost_caps. Assert return 0.
# =============================================================================
test_cost_cap_under_monthly() {
    gate_setup
    local month
    month=$(date -u +"%Y-%m")
    DAILY_COST_CAP=200.00
    MONTHLY_COST_CAP=500.00
    cat > "${COST_LEDGER_FILE}" <<EOF
{"daily":{"${month}-01":{"total_usd":150.00,"sessions":[]},"${month}-05":{"total_usd":150.00,"sessions":[]},"${month}-10":{"total_usd":150.00,"sessions":[]}}}
EOF
    local rc=0
    check_cost_caps || rc=$?
    assert_eq "0" "${rc}" "check_cost_caps should return 0 when monthly spend is under cap"
}

# =============================================================================
# Test 7: test_cost_cap_over_monthly
# Create a ledger totaling $510 this month. Set MONTHLY_COST_CAP=500.
# Call check_cost_caps. Assert return 1.
# =============================================================================
test_cost_cap_over_monthly() {
    gate_setup
    local month
    month=$(date -u +"%Y-%m")
    DAILY_COST_CAP=9999.00
    MONTHLY_COST_CAP=500.00
    cat > "${COST_LEDGER_FILE}" <<EOF
{"daily":{"${month}-01":{"total_usd":200.00,"sessions":[]},"${month}-05":{"total_usd":200.00,"sessions":[]},"${month}-10":{"total_usd":110.00,"sessions":[]}}}
EOF
    local rc=0
    check_cost_caps || rc=$?
    assert_eq "1" "${rc}" "check_cost_caps should return 1 when monthly spend exceeds cap"
    assert_contains "$(cat "${LOG_FILE}")" "Monthly cost cap reached"
}

# =============================================================================
# Test 8: test_cost_cap_no_ledger
# Ensure no ledger file exists. Call check_cost_caps. Assert return 0.
# =============================================================================
test_cost_cap_no_ledger() {
    gate_setup
    rm -f "${COST_LEDGER_FILE}"
    local rc=0
    check_cost_caps || rc=$?
    assert_eq "0" "${rc}" "check_cost_caps should return 0 when no ledger exists"
}

# =============================================================================
# Test 9: test_cost_cap_corrupt_ledger
# Write "not json" to the ledger file. Call check_cost_caps. Assert return 1.
# Assert log contains "corrupt".
# =============================================================================
test_cost_cap_corrupt_ledger() {
    gate_setup
    echo "not json" > "${COST_LEDGER_FILE}"
    local rc=0
    check_cost_caps || rc=$?
    assert_eq "1" "${rc}" "check_cost_caps should return 1 for corrupt ledger"
    assert_contains "$(cat "${LOG_FILE}")" "corrupt"
}

# =============================================================================
# Test 10: test_cost_cap_empty_ledger
# Write {} to the ledger file. Call check_cost_caps. Assert return 0.
# =============================================================================
test_cost_cap_empty_ledger() {
    gate_setup
    echo '{}' > "${COST_LEDGER_FILE}"
    local rc=0
    check_cost_caps || rc=$?
    assert_eq "0" "${rc}" "check_cost_caps should return 0 for empty ledger"
}

# =============================================================================
# Test 11: test_circuit_breaker_gate
# Set CIRCUIT_BREAKER_TRIPPED=true. Call check_gates. Assert return 1.
# Assert log contains "Circuit breaker is tripped".
# =============================================================================
test_circuit_breaker_gate() {
    gate_setup
    CIRCUIT_BREAKER_TRIPPED=true
    local rc=0
    check_gates || rc=$?
    assert_eq "1" "${rc}" "check_gates should return 1 when circuit breaker is tripped"
    assert_contains "$(cat "${LOG_FILE}")" "Circuit breaker is tripped"
}

###############################################################################
# Run Tests
###############################################################################

run_test "kill_switch_engaged" test_kill_switch_engaged
run_test "kill_switch_not_engaged" test_kill_switch_not_engaged
run_test "kill_switch_file_not_read" test_kill_switch_file_not_read
run_test "cost_cap_under_daily" test_cost_cap_under_daily
run_test "cost_cap_over_daily" test_cost_cap_over_daily
run_test "cost_cap_under_monthly" test_cost_cap_under_monthly
run_test "cost_cap_over_monthly" test_cost_cap_over_monthly
run_test "cost_cap_no_ledger" test_cost_cap_no_ledger
run_test "cost_cap_corrupt_ledger" test_cost_cap_corrupt_ledger
run_test "cost_cap_empty_ledger" test_cost_cap_empty_ledger
run_test "circuit_breaker_gate" test_circuit_breaker_gate

report
