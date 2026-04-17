# SPEC-010-2-05: Integration Test for End-to-End Cost Cap Enforcement

## Metadata
- **Parent Plan**: PLAN-010-2
- **Tasks Covered**: Task 13
- **Estimated effort**: 3 hours

## Description

End-to-end integration test that simulates a full cost lifecycle: submit requests, record multiple session costs, verify budget checks gate correctly, observe request pausing when the daily cap is hit, and confirm the escalation payload is emitted.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Create | `test/integration/test_cost_enforcement.sh` | Full lifecycle cost enforcement test |

## Implementation Details

### Test Setup

```bash
setup() {
  TEST_DIR=$(mktemp -d)
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
    "allowlist": ["/tmp/test-repo"]
  }
}
EOF

  # Create request state files
  for req_id in REQ-20260408-a001 REQ-20260408-a002; do
    cat > "${FAKE_REPO}/.autonomous-dev/requests/${req_id}/state.json" <<EOF
{
  "request_id": "${req_id}",
  "status": "in_progress",
  "cost_accrued_usd": 0,
  "phase_history": [
    {"phase": "prd", "started_at": "2026-04-08T09:00:00Z", "ended_at": null, "cost_usd": 0}
  ]
}
EOF
  done
}

teardown() {
  rm -rf "$TEST_DIR"
}
```

### Test Scenario: Daily Cap Enforcement

This test simulates the lifecycle described in TDD-010 Section 3.4.1:

```bash
test_daily_cap_enforcement() {
  source "$PLUGIN_ROOT/lib/config_loader.sh"
  source "$PLUGIN_ROOT/lib/cost_ledger.sh"
  source "$PLUGIN_ROOT/lib/cost_governor.sh"
  source "$PLUGIN_ROOT/lib/cost_request_tracker.sh"
  
  local config
  config=$(load_config)
  
  # --- Step 1: Record $3.00 for REQ-a001 (under all caps) ---
  append_cost_entry "REQ-20260408-a001" "$FAKE_REPO" "prd" "sess_001" "3.00" 25
  update_request_cost "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a001" "prd" "3.00"
  post_session_check "REQ-20260408-a001" "$config"
  
  # Verify: daily total is 3.00, no cap exceeded
  assert_eq "step1 daily total" "3.00" "$(get_daily_total)"
  local state1
  state1=$(jq -r '.status' "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a001/state.json")
  assert_eq "step1 REQ-a001 still active" "in_progress" "$state1"
  
  # --- Step 2: Record $4.00 for REQ-a002 (daily total now 7.00, under cap) ---
  append_cost_entry "REQ-20260408-a002" "$FAKE_REPO" "prd" "sess_002" "4.00" 30
  update_request_cost "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a002" "prd" "4.00"
  post_session_check "REQ-20260408-a002" "$config"
  
  assert_eq "step2 daily total" "7.00" "$(get_daily_total)"
  
  # --- Step 3: Record $4.50 for REQ-a001 (daily total now 11.50, EXCEEDS $10 cap) ---
  append_cost_entry "REQ-20260408-a001" "$FAKE_REPO" "prd" "sess_003" "4.50" 35
  update_request_cost "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a001" "prd" "4.50"
  post_session_check "REQ-20260408-a001" "$config"
  
  assert_eq "step3 daily total" "11.50" "$(get_daily_total)"
  
  # Verify: both requests should be paused
  local state_a001 state_a002
  state_a001=$(jq -r '.status' "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a001/state.json")
  state_a002=$(jq -r '.status' "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a002/state.json")
  assert_eq "step3 REQ-a001 paused" "paused" "$state_a001"
  assert_eq "step3 REQ-a002 paused" "paused" "$state_a002"
  
  # --- Step 4: Pre-session check should now block ---
  local budget_status
  budget_status=$(check_budgets "REQ-20260408-a001" "$config")
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
```

### Test Scenario: Per-Request Cap Enforcement

```bash
test_per_request_cap_enforcement() {
  source "$PLUGIN_ROOT/lib/config_loader.sh"
  source "$PLUGIN_ROOT/lib/cost_ledger.sh"
  source "$PLUGIN_ROOT/lib/cost_governor.sh"
  source "$PLUGIN_ROOT/lib/cost_request_tracker.sh"
  
  local config
  config=$(load_config)
  
  # Record $5.00 for REQ-a001
  append_cost_entry "REQ-20260408-a001" "$FAKE_REPO" "prd" "sess_001" "5.00" 40
  update_request_cost "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a001" "prd" "5.00"
  
  # Record $4.00 more for REQ-a001 (cumulative 9.00, exceeds per-request cap of $8.00)
  append_cost_entry "REQ-20260408-a001" "$FAKE_REPO" "tdd" "sess_002" "4.00" 30
  update_request_cost "${FAKE_REPO}/.autonomous-dev/requests/REQ-20260408-a001" "tdd" "4.00"
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
  assert_eq "per-request: accrued cost correct" "9.00" "$accrued"
}
```

### Test Scenario: Pre-Session Check Blocks When Cap Already Exceeded

```bash
test_pre_session_blocks() {
  # Seed the ledger with entries that exceed the daily cap
  cat > "$COST_LEDGER_PATH" <<'EOF'
{"timestamp":"2026-04-08T08:00:00Z","request_id":"REQ-20260408-x","repository":"/tmp/repo","phase":"prd","session_id":"s1","cost_usd":6.00,"turns_used":40,"cumulative_request_cost_usd":6.00,"daily_total_usd":6.00,"monthly_total_usd":6.00}
{"timestamp":"2026-04-08T09:00:00Z","request_id":"REQ-20260408-x","repository":"/tmp/repo","phase":"tdd","session_id":"s2","cost_usd":5.00,"turns_used":35,"cumulative_request_cost_usd":11.00,"daily_total_usd":11.00,"monthly_total_usd":11.00}
EOF
  
  local config
  config=$(load_config)
  
  # Pre-session check should fail
  check_budgets "REQ-20260408-a001" "$config"
  local exit_code=$?
  assert_eq "pre-session check blocks" "1" "$exit_code"
}
```

## Acceptance Criteria

1. Test simulates multiple session cost recordings that approach and then exceed the daily cap ($10.00).
2. Pre-session check correctly blocks work after daily cap exceedance.
3. All active requests are paused when the daily cap is exceeded.
4. Per-request cap exceedance pauses only that one request.
5. Escalation payload is emitted with type `cost` and cap_type `daily`.
6. Cost tracking in `state.json` shows correct `cost_accrued_usd` and per-phase `cost_usd`.
7. The ledger contains all entries with correct daily/monthly totals after each step.
8. All temp artifacts are cleaned up after the test.

## Test Cases

1. **Daily cap lifecycle**: 3 cost recordings ($3 + $4 + $4.50 = $11.50), daily cap $10. Third recording triggers pause of all requests and escalation.
2. **Per-request cap lifecycle**: 2 cost recordings for same request ($5 + $4 = $9), per-request cap $8. Second recording pauses only that request.
3. **Pre-session block**: Ledger already exceeds daily cap. `check_budgets` returns non-zero before any session is spawned.
4. **State file cost accuracy**: After the lifecycle, `cost_accrued_usd` in `state.json` equals the sum of all phase costs for that request.
5. **Escalation payload correctness**: Escalation contains correct `cap_type`, `cap_value_usd`, `current_spend_usd`, `overage_usd`, and `affected_requests`.
