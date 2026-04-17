#!/usr/bin/env bash
# test_cost_governor.sh -- Unit tests for budget check and enforcement
# Part of SPEC-010-2-04: Unit Tests for Cost Extraction, Ledger, and Budget Enforcement
#
# Tests: check_budgets(), post_session_check(), emit_cost_escalation()
#        in lib/cost_governor.sh
# Test count: 12
#
# Requires: jq (1.6+), bc, bash 4+
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source shared test harness
source "${SCRIPT_DIR}/../test_harness.sh"

# Source the ledger first (cost_governor.sh depends on it)
source "${PROJECT_ROOT}/lib/cost_ledger.sh"
# Source the module under test
source "${PROJECT_ROOT}/lib/cost_governor.sh"

# =============================================================================
# Mock config used across tests
# =============================================================================
MOCK_CONFIG='{"governance":{"daily_cost_cap_usd":100,"monthly_cost_cap_usd":2000,"per_request_cost_cap_usd":50},"repositories":{"allowlist":[]}}'

# =============================================================================
# Helper: Set up isolated ledger and seed with specific totals by writing
# ledger entries with the given daily/monthly/cumulative values.
# =============================================================================
setup_governor() {
  export COST_LEDGER_PATH="${_TEST_DIR}/cost-ledger.jsonl"
}

# Helper: Write a ledger line with a specific timestamp
write_ledger_line() {
  local timestamp="$1" request_id="$2" repo="$3" phase="$4" session_id="$5"
  local cost_usd="$6" turns="$7" cumulative="$8" daily="$9" monthly="${10}"

  jq -nc \
    --arg ts "$timestamp" \
    --arg rid "$request_id" \
    --arg repo "$repo" \
    --arg phase "$phase" \
    --arg sid "$session_id" \
    --argjson cost "$cost_usd" \
    --argjson turns "$turns" \
    --argjson cum "$cumulative" \
    --argjson daily "$daily" \
    --argjson monthly "$monthly" \
    '{
      timestamp: $ts,
      request_id: $rid,
      repository: $repo,
      phase: $phase,
      session_id: $sid,
      cost_usd: $cost,
      turns_used: $turns,
      cumulative_request_cost_usd: $cum,
      daily_total_usd: $daily,
      monthly_total_usd: $monthly
    }' >> "$COST_LEDGER_PATH"
}

# Helper: Seed ledger with a today-dated entry having specific totals
seed_today_entry() {
  local request_id="$1" daily="$2" monthly="$3" cumulative="$4"
  local today_ts
  today_ts="$(date -u +"%Y-%m-%d")T12:00:00Z"
  write_ledger_line "$today_ts" "$request_id" "/tmp/repo" "prd" "sess_seed" \
    1.00 10 "$cumulative" "$daily" "$monthly"
}

# =============================================================================
# Test 1: all_below_caps -- daily=50, monthly=500, request=25.
#   check_budgets returns 0 (pass).
# =============================================================================
test_all_below_caps() {
  setup_governor
  seed_today_entry "REQ-TEST-001" 50 500 25

  local budget_status exit_code=0
  budget_status=$(check_budgets "REQ-TEST-001" "$MOCK_CONFIG") || exit_code=$?

  assert_eq "0" "$exit_code"

  local status
  status=$(echo "$budget_status" | jq -r '.status')
  assert_eq "pass" "$status"
}

# =============================================================================
# Test 2: per_request_exceeded -- request=55. Returns 1,
#   blocked_by=per_request, scope=request.
# =============================================================================
test_per_request_exceeded() {
  setup_governor
  seed_today_entry "REQ-TEST-002" 50 500 55

  local budget_status exit_code=0
  budget_status=$(check_budgets "REQ-TEST-002" "$MOCK_CONFIG") || exit_code=$?

  assert_eq "1" "$exit_code"

  local blocked_by scope
  blocked_by=$(echo "$budget_status" | jq -r '.blocked_by')
  scope=$(echo "$budget_status" | jq -r '.scope')
  assert_eq "per_request" "$blocked_by"
  assert_eq "request" "$scope"
}

# =============================================================================
# Test 3: daily_exceeded -- daily=105. Returns 1,
#   blocked_by=daily, scope=all.
# =============================================================================
test_daily_exceeded() {
  setup_governor
  seed_today_entry "REQ-TEST-003" 105 500 25

  local budget_status exit_code=0
  budget_status=$(check_budgets "REQ-TEST-003" "$MOCK_CONFIG") || exit_code=$?

  assert_eq "1" "$exit_code"

  local blocked_by scope
  blocked_by=$(echo "$budget_status" | jq -r '.blocked_by')
  scope=$(echo "$budget_status" | jq -r '.scope')
  assert_eq "daily" "$blocked_by"
  assert_eq "all" "$scope"
}

# =============================================================================
# Test 4: monthly_exceeded -- monthly=2100. Returns 1,
#   blocked_by=monthly, scope=all.
# =============================================================================
test_monthly_exceeded() {
  setup_governor
  seed_today_entry "REQ-TEST-004" 50 2100 25

  local budget_status exit_code=0
  budget_status=$(check_budgets "REQ-TEST-004" "$MOCK_CONFIG") || exit_code=$?

  assert_eq "1" "$exit_code"

  local blocked_by scope
  blocked_by=$(echo "$budget_status" | jq -r '.blocked_by')
  scope=$(echo "$budget_status" | jq -r '.scope')
  assert_eq "monthly" "$blocked_by"
  assert_eq "all" "$scope"
}

# =============================================================================
# Test 5: daily_at_exactly_cap -- daily=100.00. Returns 1 (>= is exceeded).
# =============================================================================
test_daily_at_exactly_cap() {
  setup_governor
  seed_today_entry "REQ-TEST-005" 100.00 500 25

  local budget_status exit_code=0
  budget_status=$(check_budgets "REQ-TEST-005" "$MOCK_CONFIG") || exit_code=$?

  assert_eq "1" "$exit_code"

  local blocked_by
  blocked_by=$(echo "$budget_status" | jq -r '.blocked_by')
  assert_eq "daily" "$blocked_by"
}

# =============================================================================
# Test 6: monthly_takes_precedence -- Both daily and monthly exceeded.
#   blocked_by=monthly (monthly is checked first as most severe).
# =============================================================================
test_monthly_takes_precedence() {
  setup_governor
  seed_today_entry "REQ-TEST-006" 105 2100 25

  local budget_status exit_code=0
  budget_status=$(check_budgets "REQ-TEST-006" "$MOCK_CONFIG") || exit_code=$?

  assert_eq "1" "$exit_code"

  local blocked_by
  blocked_by=$(echo "$budget_status" | jq -r '.blocked_by')
  assert_eq "monthly" "$blocked_by"
}

# =============================================================================
# Test 7: post_session_per_request_pause -- Simulate per-request cap hit.
#   Verify only that request is paused (scope=request).
# =============================================================================
test_post_session_per_request_pause() {
  setup_governor

  # Create a request state file structure for the request
  local repo_dir="${_TEST_DIR}/repo"
  local request_id="REQ-TEST-007"
  local state_dir="${repo_dir}/.autonomous-dev/requests/${request_id}"
  mkdir -p "$state_dir"

  # Write a state file with active status
  jq -nc \
    --arg id "$request_id" \
    '{id: $id, status: "in_progress", current_phase_metadata: {}}' \
    > "${state_dir}/state.json"

  # Config with this repo in allowlist
  local config
  config=$(echo "$MOCK_CONFIG" | jq --arg repo "$repo_dir" '.repositories.allowlist = [$repo]')

  # Seed ledger with per-request exceeded
  seed_today_entry "$request_id" 50 500 55

  # Run post_session_check
  post_session_check "$request_id" "$config" 2>/dev/null

  # Verify the request is paused
  local status
  status=$(jq -r '.status' "${state_dir}/state.json")
  assert_eq "paused" "$status"
}

# =============================================================================
# Test 8: post_session_daily_pause -- Simulate daily cap hit.
#   Verify all active requests are paused.
# =============================================================================
test_post_session_daily_pause() {
  setup_governor

  local repo_dir="${_TEST_DIR}/repo"

  # Create two active requests
  local req1="REQ-TEST-008A"
  local req2="REQ-TEST-008B"
  local state_dir1="${repo_dir}/.autonomous-dev/requests/${req1}"
  local state_dir2="${repo_dir}/.autonomous-dev/requests/${req2}"
  mkdir -p "$state_dir1" "$state_dir2"

  jq -nc --arg id "$req1" '{id: $id, status: "in_progress", current_phase_metadata: {}}' > "${state_dir1}/state.json"
  jq -nc --arg id "$req2" '{id: $id, status: "in_progress", current_phase_metadata: {}}' > "${state_dir2}/state.json"

  local config
  config=$(echo "$MOCK_CONFIG" | jq --arg repo "$repo_dir" '.repositories.allowlist = [$repo]')

  # Seed ledger with daily exceeded
  seed_today_entry "$req1" 105 500 25

  post_session_check "$req1" "$config" 2>/dev/null

  # Both requests should be paused
  local status1 status2
  status1=$(jq -r '.status' "${state_dir1}/state.json")
  status2=$(jq -r '.status' "${state_dir2}/state.json")

  assert_eq "paused" "$status1"
  assert_eq "paused" "$status2"
}

# =============================================================================
# Test 9: escalation_payload_daily -- Verify payload has correct cap_type,
#   values, recommendation.
# =============================================================================
test_escalation_payload_daily() {
  setup_governor
  seed_today_entry "REQ-TEST-009" 105 500 25

  local budget_status
  budget_status=$(check_budgets "REQ-TEST-009" "$MOCK_CONFIG" 2>/dev/null) || true

  # Capture escalation payload by mocking emit_escalation
  local captured_payload=""
  emit_escalation() {
    captured_payload="$1"
  }
  export -f emit_escalation 2>/dev/null || true

  # Since we can't easily override the function inside the sourced module,
  # test by calling emit_cost_escalation directly and capturing its alert file
  local alerts_dir="${_TEST_DIR}/alerts"
  export HOME="$_TEST_DIR"
  mkdir -p "${_TEST_DIR}/.autonomous-dev/alerts"

  emit_cost_escalation "$budget_status" "REQ-TEST-009" "$MOCK_CONFIG" 2>/dev/null

  # Find the alert file written to alerts dir
  local alert_file
  alert_file=$(ls "${_TEST_DIR}/.autonomous-dev/alerts"/alert-cost_cap_exceeded-* 2>/dev/null | head -1)

  if [[ -z "$alert_file" ]]; then
    echo "  ASSERT FAILED: No alert file found" >&2
    return 1
  fi

  local payload
  payload=$(cat "$alert_file")

  local cap_type urgency cap_value recommendation
  cap_type=$(echo "$payload" | jq -r '.cap_type')
  urgency=$(echo "$payload" | jq -r '.urgency')
  cap_value=$(echo "$payload" | jq -r '.cap_value_usd')
  recommendation=$(echo "$payload" | jq -r '.recommendation')

  assert_eq "daily" "$cap_type"
  assert_eq "immediate" "$urgency"
  assert_eq "100" "$cap_value"
  assert_contains "$recommendation" "daily cap"
}

# =============================================================================
# Test 10: escalation_payload_per_request -- Verify affected_requests has
#   only one entry.
# =============================================================================
test_escalation_payload_per_request() {
  setup_governor
  seed_today_entry "REQ-TEST-010" 50 500 55

  local budget_status
  budget_status=$(check_budgets "REQ-TEST-010" "$MOCK_CONFIG" 2>/dev/null) || true

  export HOME="$_TEST_DIR"
  mkdir -p "${_TEST_DIR}/.autonomous-dev/alerts"

  emit_cost_escalation "$budget_status" "REQ-TEST-010" "$MOCK_CONFIG" 2>/dev/null

  local alert_file
  alert_file=$(ls "${_TEST_DIR}/.autonomous-dev/alerts"/alert-cost_cap_exceeded-* 2>/dev/null | head -1)

  if [[ -z "$alert_file" ]]; then
    echo "  ASSERT FAILED: No alert file found" >&2
    return 1
  fi

  local payload
  payload=$(cat "$alert_file")

  local cap_type affected_count affected_id
  cap_type=$(echo "$payload" | jq -r '.cap_type')
  affected_count=$(echo "$payload" | jq '.affected_requests | length')
  affected_id=$(echo "$payload" | jq -r '.affected_requests[0]')

  assert_eq "per_request" "$cap_type"
  assert_eq "1" "$affected_count"
  assert_eq "REQ-TEST-010" "$affected_id"
}

# =============================================================================
# Test 11: escalation_payload_monthly -- Verify recommendation mentions
#   "next month".
# =============================================================================
test_escalation_payload_monthly() {
  setup_governor
  seed_today_entry "REQ-TEST-011" 50 2100 25

  local budget_status
  budget_status=$(check_budgets "REQ-TEST-011" "$MOCK_CONFIG" 2>/dev/null) || true

  export HOME="$_TEST_DIR"
  mkdir -p "${_TEST_DIR}/.autonomous-dev/alerts"

  emit_cost_escalation "$budget_status" "REQ-TEST-011" "$MOCK_CONFIG" 2>/dev/null

  local alert_file
  alert_file=$(ls "${_TEST_DIR}/.autonomous-dev/alerts"/alert-cost_cap_exceeded-* 2>/dev/null | head -1)

  if [[ -z "$alert_file" ]]; then
    echo "  ASSERT FAILED: No alert file found" >&2
    return 1
  fi

  local payload
  payload=$(cat "$alert_file")

  local cap_type recommendation
  cap_type=$(echo "$payload" | jq -r '.cap_type')
  recommendation=$(echo "$payload" | jq -r '.recommendation')

  assert_eq "monthly" "$cap_type"
  assert_contains "$recommendation" "next month"
}

# =============================================================================
# Test 12: budget_check_reads_config -- Change config cap. Verify check uses
#   new cap value.
# =============================================================================
test_budget_check_reads_config() {
  setup_governor

  # Seed with daily=80, which is below the default cap of 100
  seed_today_entry "REQ-TEST-012" 80 500 25

  # With default config (cap=100), this should pass
  local exit_code=0
  check_budgets "REQ-TEST-012" "$MOCK_CONFIG" >/dev/null 2>/dev/null || exit_code=$?
  assert_eq "0" "$exit_code"

  # Now change config to lower the daily cap to 75
  local strict_config
  strict_config=$(echo "$MOCK_CONFIG" | jq '.governance.daily_cost_cap_usd = 75')

  local exit_code2=0
  local budget_status
  budget_status=$(check_budgets "REQ-TEST-012" "$strict_config" 2>/dev/null) || exit_code2=$?
  assert_eq "1" "$exit_code2"

  local blocked_by
  blocked_by=$(echo "$budget_status" | jq -r '.blocked_by')
  assert_eq "daily" "$blocked_by"
}

# =============================================================================
# Run all tests
# =============================================================================
echo "SPEC-010-2-04: Cost Governor (Budget Enforcement) Tests"
echo "========================================================"

run_test "All below caps (pass)"                            test_all_below_caps
run_test "Per-request exceeded (blocked)"                   test_per_request_exceeded
run_test "Daily exceeded (blocked)"                         test_daily_exceeded
run_test "Monthly exceeded (blocked)"                       test_monthly_exceeded
run_test "Daily at exactly cap (>= is exceeded)"            test_daily_at_exactly_cap
run_test "Monthly takes precedence over daily"              test_monthly_takes_precedence
run_test "Post-session per-request pause"                   test_post_session_per_request_pause
run_test "Post-session daily pause (all requests)"          test_post_session_daily_pause
run_test "Escalation payload: daily cap"                    test_escalation_payload_daily
run_test "Escalation payload: per-request (1 affected)"     test_escalation_payload_per_request
run_test "Escalation payload: monthly (next month)"         test_escalation_payload_monthly
run_test "Budget check reads config (dynamic cap)"          test_budget_check_reads_config

report
