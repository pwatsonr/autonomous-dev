#!/usr/bin/env bash
# test_cost_enforcement.sh -- Integration tests for end-to-end cost cap enforcement
# SPEC-010-2-05: Task 13 -- Full cost lifecycle integration test
#
# Simulates a full cost lifecycle: submit requests, record multiple session
# costs, verify budget checks gate correctly, observe request pausing when
# the daily cap is hit, and confirm the escalation payload is emitted.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

source "${PROJECT_ROOT}/tests/test_harness.sh"

###############################################################################
# Override assert_eq to accept a label as the first arg (spec convention)
# Signature: assert_eq "label" "expected" "actual"
###############################################################################
assert_eq() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" == "$actual" ]]; then return 0; fi
  echo "  ASSERT_EQ FAILED [${label}]: expected='${expected}' actual='${actual}'" >&2
  return 1
}

###############################################################################
# Override setup/teardown for cost enforcement tests
###############################################################################
setup() {
  TEST_DIR=$(mktemp -d)
  _TEST_DIR="$TEST_DIR"
  FAKE_HOME="${TEST_DIR}/home"
  FAKE_REPO="${TEST_DIR}/repo"

  mkdir -p "${FAKE_HOME}/.claude"
  mkdir -p "${FAKE_HOME}/.autonomous-dev/logs"
  mkdir -p "${FAKE_REPO}/.git"
  mkdir -p "${FAKE_REPO}/.claude"
  mkdir -p "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a001"
  mkdir -p "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a002"

  export HOME="$FAKE_HOME"
  export REPO_ROOT="$FAKE_REPO"
  export PLUGIN_ROOT="$PROJECT_ROOT"
  export COST_LEDGER_PATH="${FAKE_HOME}/.autonomous-dev/cost-ledger.jsonl"
  export ESCALATION_LOG="${FAKE_HOME}/.autonomous-dev/escalations.log"

  # Set a low daily cap for testing
  cat > "${FAKE_HOME}/.claude/autonomous-dev.json" <<'EOF'
{
  "governance": {
    "daily_cost_cap_usd": 10.00,
    "monthly_cost_cap_usd": 100.00,
    "per_request_cost_cap_usd": 8.00
  },
  "repositories": {
    "allowlist": []
  }
}
EOF

  # Inject the FAKE_REPO into the allowlist (needs the actual path, not a literal)
  local tmp_cfg="${FAKE_HOME}/.claude/autonomous-dev.json.tmp"
  jq --arg repo "$FAKE_REPO" '.repositories.allowlist = [$repo]' \
    "${FAKE_HOME}/.claude/autonomous-dev.json" > "$tmp_cfg"
  mv "$tmp_cfg" "${FAKE_HOME}/.claude/autonomous-dev.json"

  # Create request state files
  for req_id in REQ-20260408-a001 REQ-20260408-a002; do
    cat > "${FAKE_REPO}/.autonomous-dev/requests/${req_id}/state.json" <<STEOF
{
  "request_id": "${req_id}",
  "id": "${req_id}",
  "status": "in_progress",
  "cost_accrued_usd": 0,
  "phase_history": [
    {"phase": "prd", "started_at": "2026-04-08T09:00:00Z", "ended_at": null, "cost_usd": 0}
  ]
}
STEOF
  done

  # Define emit_escalation to write to ESCALATION_LOG so the test can verify
  emit_escalation() {
    local payload="$1"
    mkdir -p "$(dirname "$ESCALATION_LOG")"
    echo "$payload" >> "$ESCALATION_LOG"
  }
  export -f emit_escalation

  # Source the libs fresh for each test (they read env vars at source time)
  source "$PLUGIN_ROOT/lib/config_loader.sh"
  source "$PLUGIN_ROOT/lib/cost_ledger.sh"
  source "$PLUGIN_ROOT/lib/cost_governor.sh"
  source "$PLUGIN_ROOT/lib/cost_request_tracker.sh"
}

teardown() {
  rm -rf "$TEST_DIR"
  # Restore HOME so subsequent test setup works
  unset COST_LEDGER_PATH ESCALATION_LOG REPO_ROOT FAKE_HOME FAKE_REPO
}

###############################################################################
# Test 1: Daily Cap Enforcement
#
# Lifecycle: 3 cost recordings ($3 + $4 + $4.50 = $11.50), daily cap $10.
# Third recording triggers pause of all requests and escalation.
###############################################################################
test_daily_cap_enforcement() {
  local config
  config=$(load_config)

  # --- Step 1: Record $3.00 for REQ-a001 (under all caps) ---
  append_cost_entry "REQ-20260408-a001" "$FAKE_REPO" "prd" "sess_001" "3.00" 25
  update_request_cost "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a001" "prd" "3.00"
  post_session_check "REQ-20260408-a001" "$config"

  # Verify: daily total is 3, no cap exceeded
  assert_eq "step1 daily total" "3" "$(get_daily_total)"
  local state1
  state1=$(jq -r '.status' "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a001/state.json")
  assert_eq "step1 REQ-a001 still active" "in_progress" "$state1"

  # --- Step 2: Record $4.00 for REQ-a002 (daily total now 7.00, under cap) ---
  append_cost_entry "REQ-20260408-a002" "$FAKE_REPO" "prd" "sess_002" "4.00" 30
  update_request_cost "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a002" "prd" "4.00"
  post_session_check "REQ-20260408-a002" "$config"

  assert_eq "step2 daily total" "7" "$(get_daily_total)"

  # --- Step 3: Record $4.50 for REQ-a001 (daily total now 11.50, EXCEEDS $10 cap) ---
  append_cost_entry "REQ-20260408-a001" "$FAKE_REPO" "prd" "sess_003" "4.50" 35
  update_request_cost "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a001" "prd" "4.50"
  post_session_check "REQ-20260408-a001" "$config"

  assert_eq "step3 daily total" "11.5" "$(get_daily_total)"

  # Verify: both requests should be paused
  local state_a001 state_a002
  state_a001=$(jq -r '.status' "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a001/state.json")
  state_a002=$(jq -r '.status' "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a002/state.json")
  assert_eq "step3 REQ-a001 paused" "paused" "$state_a001"
  assert_eq "step3 REQ-a002 paused" "paused" "$state_a002"

  # --- Step 4: Pre-session check should now block ---
  local budget_status
  budget_status=$(check_budgets "REQ-20260408-a001" "$config") || true
  local blocked
  blocked=$(echo "$budget_status" | jq -r '.blocked_by')
  assert_eq "step4 pre-session blocked" "daily" "$blocked"

  # --- Step 5: Verify escalation was emitted ---
  assert_eq "escalation emitted" "true" "$(test -s "$ESCALATION_LOG" && echo true || echo false)"
  local escalation
  escalation=$(tail -1 "$ESCALATION_LOG")
  local esc_type
  esc_type=$(echo "$escalation" | jq -r '.escalation_type')
  assert_eq "escalation type is cost" "cost" "$esc_type"
  local cap_type
  cap_type=$(echo "$escalation" | jq -r '.cap_type')
  assert_eq "cap type is daily" "daily" "$cap_type"
}

###############################################################################
# Test 2: Per-Request Cap Enforcement
#
# 2 cost recordings for same request ($5 + $4 = $9), per-request cap $8.
# Second recording pauses only that request.
###############################################################################
test_per_request_cap_enforcement() {
  local config
  config=$(load_config)

  local req_dir="${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a001"

  # Record $5.00 for REQ-a001 in prd phase
  append_cost_entry "REQ-20260408-a001" "$FAKE_REPO" "prd" "sess_001" "5.00" 40
  update_request_cost "$req_dir" "prd" "5.00"

  # Add a tdd phase entry to the state file before recording tdd costs
  local tmp="${req_dir}/state.json.tmp"
  jq '.phase_history += [{"phase": "tdd", "started_at": "2026-04-08T10:00:00Z", "ended_at": null, "cost_usd": 0}]' \
    "${req_dir}/state.json" > "$tmp"
  mv "$tmp" "${req_dir}/state.json"

  # Record $4.00 more for REQ-a001 in tdd phase (cumulative 9.00, exceeds per-request cap of $8.00)
  append_cost_entry "REQ-20260408-a001" "$FAKE_REPO" "tdd" "sess_002" "4.00" 30
  update_request_cost "$req_dir" "tdd" "4.00"
  post_session_check "REQ-20260408-a001" "$config"

  # Verify: REQ-a001 paused, REQ-a002 still active
  local state_a001 state_a002
  state_a001=$(jq -r '.status' "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a001/state.json")
  state_a002=$(jq -r '.status' "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a002/state.json")
  assert_eq "per-request: REQ-a001 paused" "paused" "$state_a001"
  assert_eq "per-request: REQ-a002 still active" "in_progress" "$state_a002"

  # Verify cost tracking in state file
  local accrued
  accrued=$(jq -r '.cost_accrued_usd' "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a001/state.json")
  assert_eq "per-request: accrued cost correct" "9" "$accrued"
}

###############################################################################
# Test 3: Pre-Session Check Blocks When Cap Already Exceeded
#
# Ledger already exceeds daily cap. check_budgets returns non-zero before
# any session is spawned.
###############################################################################
test_pre_session_blocks() {
  # Seed the ledger with entries that exceed the daily cap
  local today
  today=$(date -u +"%Y-%m-%d")
  local this_month
  this_month=$(date -u +"%Y-%m")

  cat > "$COST_LEDGER_PATH" <<EOF
{"timestamp":"${today}T08:00:00Z","request_id":"REQ-20260408-x","repository":"/tmp/repo","phase":"prd","session_id":"s1","cost_usd":6.00,"turns_used":40,"cumulative_request_cost_usd":6.00,"daily_total_usd":6.00,"monthly_total_usd":6.00}
{"timestamp":"${today}T09:00:00Z","request_id":"REQ-20260408-x","repository":"/tmp/repo","phase":"tdd","session_id":"s2","cost_usd":5.00,"turns_used":35,"cumulative_request_cost_usd":11.00,"daily_total_usd":11.00,"monthly_total_usd":11.00}
EOF

  local config
  config=$(load_config)

  # Pre-session check should fail
  local exit_code=0
  check_budgets "REQ-20260408-a001" "$config" >/dev/null 2>&1 || exit_code=$?
  assert_eq "pre-session check blocks" "1" "$exit_code"
}

###############################################################################
# Test 4: State File Cost Accuracy
#
# After the lifecycle, cost_accrued_usd in state.json equals the sum of
# all phase costs for that request.
###############################################################################
test_state_file_cost_accuracy() {
  local config
  config=$(load_config)

  local req_dir="${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a001"

  # Add a tdd phase entry to the state file for REQ-a001
  local tmp="${req_dir}/state.json.tmp"
  jq '.phase_history += [{"phase": "tdd", "started_at": "2026-04-08T10:00:00Z", "ended_at": null, "cost_usd": 0}]' \
    "${req_dir}/state.json" > "$tmp"
  mv "$tmp" "${req_dir}/state.json"

  # Record multiple costs across different phases
  append_cost_entry "REQ-20260408-a001" "$FAKE_REPO" "prd" "sess_001" "2.50" 20
  update_request_cost "$req_dir" "prd" "2.50"

  append_cost_entry "REQ-20260408-a001" "$FAKE_REPO" "prd" "sess_002" "1.75" 15
  update_request_cost "$req_dir" "prd" "1.75"

  append_cost_entry "REQ-20260408-a001" "$FAKE_REPO" "tdd" "sess_003" "3.00" 25
  update_request_cost "$req_dir" "tdd" "3.00"

  # Verify cost_accrued_usd = 2.50 + 1.75 + 3.00 = 7.25
  local accrued
  accrued=$(jq -r '.cost_accrued_usd' "${req_dir}/state.json")
  assert_eq "accrued cost total" "7.25" "$accrued"

  # Verify per-phase costs
  local prd_cost
  prd_cost=$(jq -r '.phase_history[] | select(.phase == "prd") | .cost_usd' "${req_dir}/state.json")
  assert_eq "prd phase cost" "4.25" "$prd_cost"

  local tdd_cost
  tdd_cost=$(jq -r '.phase_history[] | select(.phase == "tdd" and .ended_at == null) | .cost_usd' "${req_dir}/state.json")
  assert_eq "tdd phase cost" "3" "$tdd_cost"
}

###############################################################################
# Test 5: Escalation Payload Correctness
#
# Escalation contains correct cap_type, cap_value_usd, current_spend_usd,
# overage_usd, and affected_requests.
###############################################################################
test_escalation_payload_correctness() {
  local config
  config=$(load_config)

  # Drive daily total past the $10 cap
  append_cost_entry "REQ-20260408-a001" "$FAKE_REPO" "prd" "sess_001" "6.00" 40
  update_request_cost "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a001" "prd" "6.00"
  post_session_check "REQ-20260408-a001" "$config"

  append_cost_entry "REQ-20260408-a002" "$FAKE_REPO" "prd" "sess_002" "5.50" 35
  update_request_cost "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a002" "prd" "5.50"
  post_session_check "REQ-20260408-a002" "$config"

  # Verify escalation log was written
  assert_eq "escalation log exists" "true" "$(test -s "$ESCALATION_LOG" && echo true || echo false)"

  # Parse the escalation payload
  local escalation
  escalation=$(tail -1 "$ESCALATION_LOG")

  local esc_type
  esc_type=$(echo "$escalation" | jq -r '.escalation_type')
  assert_eq "esc escalation_type" "cost" "$esc_type"

  local cap_type
  cap_type=$(echo "$escalation" | jq -r '.cap_type')
  assert_eq "esc cap_type" "daily" "$cap_type"

  local cap_value
  cap_value=$(echo "$escalation" | jq -r '.cap_value_usd')
  assert_eq "esc cap_value_usd" "10" "$cap_value"

  local current_spend
  current_spend=$(echo "$escalation" | jq -r '.current_spend_usd')
  assert_eq "esc current_spend_usd" "11.5" "$current_spend"

  local overage
  overage=$(echo "$escalation" | jq -r '.overage_usd')
  assert_eq "esc overage_usd" "1.5" "$overage"

  # Verify recommendation is present
  local recommendation
  recommendation=$(echo "$escalation" | jq -r '.recommendation')
  assert_eq "esc has recommendation" "true" "$(test -n "$recommendation" && echo true || echo false)"

  # Verify urgency
  local urgency
  urgency=$(echo "$escalation" | jq -r '.urgency')
  assert_eq "esc urgency" "immediate" "$urgency"
}

###############################################################################
# Test 6: Ledger Entries Correctness
#
# The ledger contains all entries with correct daily/monthly totals after
# each step.
###############################################################################
test_ledger_entries_correctness() {
  # Record 3 entries and verify ledger state after each
  append_cost_entry "REQ-20260408-a001" "$FAKE_REPO" "prd" "sess_001" "3.00" 25

  # Verify first entry
  local entry1
  entry1=$(tail -1 "$COST_LEDGER_PATH")
  local daily1 monthly1 cum1
  daily1=$(echo "$entry1" | jq -r '.daily_total_usd')
  monthly1=$(echo "$entry1" | jq -r '.monthly_total_usd')
  cum1=$(echo "$entry1" | jq -r '.cumulative_request_cost_usd')
  # Note: jq outputs numbers without trailing zeros (3.00 -> 3, 7.50 -> 7.5)
  assert_eq "entry1 daily" "3" "$daily1"
  assert_eq "entry1 monthly" "3" "$monthly1"
  assert_eq "entry1 cumulative" "3" "$cum1"

  append_cost_entry "REQ-20260408-a002" "$FAKE_REPO" "prd" "sess_002" "4.00" 30

  # Verify second entry
  local entry2
  entry2=$(tail -1 "$COST_LEDGER_PATH")
  local daily2 monthly2 cum2
  daily2=$(echo "$entry2" | jq -r '.daily_total_usd')
  monthly2=$(echo "$entry2" | jq -r '.monthly_total_usd')
  cum2=$(echo "$entry2" | jq -r '.cumulative_request_cost_usd')
  assert_eq "entry2 daily" "7" "$daily2"
  assert_eq "entry2 monthly" "7" "$monthly2"
  assert_eq "entry2 cumulative for a002" "4" "$cum2"

  append_cost_entry "REQ-20260408-a001" "$FAKE_REPO" "prd" "sess_003" "4.50" 35

  # Verify third entry
  local entry3
  entry3=$(tail -1 "$COST_LEDGER_PATH")
  local daily3 monthly3 cum3
  daily3=$(echo "$entry3" | jq -r '.daily_total_usd')
  monthly3=$(echo "$entry3" | jq -r '.monthly_total_usd')
  cum3=$(echo "$entry3" | jq -r '.cumulative_request_cost_usd')
  assert_eq "entry3 daily" "11.5" "$daily3"
  assert_eq "entry3 monthly" "11.5" "$monthly3"
  assert_eq "entry3 cumulative for a001" "7.5" "$cum3"

  # Verify total line count
  local line_count
  line_count=$(wc -l < "$COST_LEDGER_PATH" | tr -d ' ')
  assert_eq "ledger entry count" "3" "$line_count"
}

###############################################################################
# Test 7: Cleanup -- Verify temp artifacts are cleaned up
#
# All temp artifacts are cleaned up after the test.
###############################################################################
test_cleanup() {
  # Run a full cycle to create artifacts
  local config
  config=$(load_config)

  append_cost_entry "REQ-20260408-a001" "$FAKE_REPO" "prd" "sess_001" "3.00" 25
  update_request_cost "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a001" "prd" "3.00"
  post_session_check "REQ-20260408-a001" "$config"

  # Verify no .tmp files left behind
  local tmp_count
  tmp_count=$(find "$TEST_DIR" -name "*.tmp" -o -name "*.tmp.*" 2>/dev/null | wc -l | tr -d ' ')
  assert_eq "no temp files remaining" "0" "$tmp_count"
}

###############################################################################
# Run all tests
###############################################################################
run_test "Cost Enforcement: Daily cap lifecycle" test_daily_cap_enforcement
run_test "Cost Enforcement: Per-request cap lifecycle" test_per_request_cap_enforcement
run_test "Cost Enforcement: Pre-session blocks when cap exceeded" test_pre_session_blocks
run_test "Cost Enforcement: State file cost accuracy" test_state_file_cost_accuracy
run_test "Cost Enforcement: Escalation payload correctness" test_escalation_payload_correctness
run_test "Cost Enforcement: Ledger entries correctness" test_ledger_entries_correctness
run_test "Cost Enforcement: Temp artifact cleanup" test_cleanup

report
