#!/usr/bin/env bats
###############################################################################
# test_gate_checks.bats - Tests for SPEC-001-2-01 gate checks
#
# Tests kill switch, cost cap, and circuit breaker gate checks.
###############################################################################

load test_helpers

setup() {
    setup_test_env
    source_functions
}

teardown() {
    teardown_test_env
}

###############################################################################
# Kill Switch Tests
###############################################################################

# Test 1: test_kill_switch_engaged
@test "check_gates returns 1 when kill switch file exists" {
    touch "${KILL_SWITCH_FILE}"
    run check_gates
    [ "$status" -eq 1 ]
    assert_log_contains "Kill switch is engaged"
}

# Test 2: test_kill_switch_not_engaged
@test "check_gates returns 0 when kill switch file does not exist" {
    rm -f "${KILL_SWITCH_FILE}"
    CIRCUIT_BREAKER_TRIPPED=false
    run check_gates
    [ "$status" -eq 0 ]
}

# Test 3: test_kill_switch_file_not_read
@test "kill switch triggers on file existence even when file is unreadable" {
    echo "some reason" > "${KILL_SWITCH_FILE}"
    chmod 000 "${KILL_SWITCH_FILE}"
    run check_gates
    [ "$status" -eq 1 ]
    assert_log_contains "Kill switch is engaged"
    # Restore permissions for cleanup
    chmod 644 "${KILL_SWITCH_FILE}"
}

###############################################################################
# Cost Cap Tests
###############################################################################

# Test 4: test_cost_cap_under_daily
@test "check_cost_caps returns 0 when daily spend is under cap" {
    local today
    today=$(date -u +"%Y-%m-%d")
    DAILY_COST_CAP=50.00
    cat > "${COST_LEDGER_FILE}" <<EOF
{
  "daily": {
    "${today}": {
      "total_usd": 49.00,
      "sessions": []
    }
  }
}
EOF
    run check_cost_caps
    [ "$status" -eq 0 ]
}

# Test 5: test_cost_cap_over_daily
@test "check_cost_caps returns 1 when daily spend exceeds cap" {
    local today
    today=$(date -u +"%Y-%m-%d")
    DAILY_COST_CAP=50.00
    cat > "${COST_LEDGER_FILE}" <<EOF
{
  "daily": {
    "${today}": {
      "total_usd": 51.00,
      "sessions": []
    }
  }
}
EOF
    run check_cost_caps
    [ "$status" -eq 1 ]
    assert_log_contains "Daily cost cap reached"
}

# Test 6: test_cost_cap_under_monthly
@test "check_cost_caps returns 0 when monthly spend is under cap" {
    local month
    month=$(date -u +"%Y-%m")
    DAILY_COST_CAP=200.00
    MONTHLY_COST_CAP=500.00
    cat > "${COST_LEDGER_FILE}" <<EOF
{
  "daily": {
    "${month}-01": {
      "total_usd": 150.00,
      "sessions": []
    },
    "${month}-05": {
      "total_usd": 150.00,
      "sessions": []
    },
    "${month}-10": {
      "total_usd": 150.00,
      "sessions": []
    }
  }
}
EOF
    run check_cost_caps
    [ "$status" -eq 0 ]
}

# Test 7: test_cost_cap_over_monthly
@test "check_cost_caps returns 1 when monthly spend exceeds cap" {
    local month
    month=$(date -u +"%Y-%m")
    DAILY_COST_CAP=200.00
    MONTHLY_COST_CAP=500.00
    cat > "${COST_LEDGER_FILE}" <<EOF
{
  "daily": {
    "${month}-01": {
      "total_usd": 200.00,
      "sessions": []
    },
    "${month}-05": {
      "total_usd": 200.00,
      "sessions": []
    },
    "${month}-10": {
      "total_usd": 110.00,
      "sessions": []
    }
  }
}
EOF
    run check_cost_caps
    [ "$status" -eq 1 ]
    assert_log_contains "Monthly cost cap reached"
}

# Test 8: test_cost_cap_no_ledger
@test "check_cost_caps returns 0 when no ledger file exists" {
    rm -f "${COST_LEDGER_FILE}"
    run check_cost_caps
    [ "$status" -eq 0 ]
}

# Test 9: test_cost_cap_corrupt_ledger
@test "check_cost_caps returns 1 when ledger is corrupt" {
    echo "not json" > "${COST_LEDGER_FILE}"
    run check_cost_caps
    [ "$status" -eq 1 ]
    assert_log_contains "corrupt"
}

# Test 10: test_cost_cap_empty_ledger
@test "check_cost_caps returns 0 when ledger is empty object" {
    echo '{}' > "${COST_LEDGER_FILE}"
    run check_cost_caps
    [ "$status" -eq 0 ]
}

###############################################################################
# Circuit Breaker Tests
###############################################################################

# Test 11: test_circuit_breaker_gate
@test "check_gates returns 1 when circuit breaker is tripped" {
    CIRCUIT_BREAKER_TRIPPED=true
    run check_gates
    [ "$status" -eq 1 ]
    assert_log_contains "Circuit breaker is tripped"
}

###############################################################################
# Gate Check Ordering Tests
###############################################################################

@test "check_gates checks kill switch before circuit breaker" {
    # Both kill switch and circuit breaker are engaged
    touch "${KILL_SWITCH_FILE}"
    CIRCUIT_BREAKER_TRIPPED=true
    run check_gates
    [ "$status" -eq 1 ]
    # Kill switch message should appear, not circuit breaker
    assert_log_contains "Kill switch is engaged"
    assert_log_not_contains "Circuit breaker is tripped"
}

@test "check_gates checks circuit breaker before cost caps" {
    # Circuit breaker tripped, and cost cap would also fail
    local today
    today=$(date -u +"%Y-%m-%d")
    CIRCUIT_BREAKER_TRIPPED=true
    DAILY_COST_CAP=50.00
    cat > "${COST_LEDGER_FILE}" <<EOF
{
  "daily": {
    "${today}": {
      "total_usd": 100.00,
      "sessions": []
    }
  }
}
EOF
    run check_gates
    [ "$status" -eq 1 ]
    assert_log_contains "Circuit breaker is tripped"
    assert_log_not_contains "Daily cost cap reached"
}

@test "check_cost_caps returns 0 when daily spend equals cap minus epsilon" {
    local today
    today=$(date -u +"%Y-%m-%d")
    DAILY_COST_CAP=50.00
    cat > "${COST_LEDGER_FILE}" <<EOF
{
  "daily": {
    "${today}": {
      "total_usd": 49.99,
      "sessions": []
    }
  }
}
EOF
    run check_cost_caps
    [ "$status" -eq 0 ]
}

@test "check_cost_caps returns 1 when daily spend equals cap exactly" {
    local today
    today=$(date -u +"%Y-%m-%d")
    DAILY_COST_CAP=50.00
    cat > "${COST_LEDGER_FILE}" <<EOF
{
  "daily": {
    "${today}": {
      "total_usd": 50.00,
      "sessions": []
    }
  }
}
EOF
    run check_cost_caps
    [ "$status" -eq 1 ]
    assert_log_contains "Daily cost cap reached"
}

@test "check_cost_caps ignores entries from previous months" {
    MONTHLY_COST_CAP=500.00
    DAILY_COST_CAP=9999.00
    cat > "${COST_LEDGER_FILE}" <<EOF
{
  "daily": {
    "2025-01-15": {
      "total_usd": 9999.00,
      "sessions": []
    }
  }
}
EOF
    run check_cost_caps
    [ "$status" -eq 0 ]
}
