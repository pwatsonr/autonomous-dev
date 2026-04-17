# SPEC-010-2-02: Per-Request Cost Tracking & Budget Enforcement

## Metadata
- **Parent Plan**: PLAN-010-2
- **Tasks Covered**: Task 4, Task 5, Task 6, Task 7
- **Estimated effort**: 12 hours

## Description

Implement per-request cost tracking in state files, the three-tier budget enforcement system (pre-session and post-session checks), request pausing on cap exceedance, and cost escalation payload construction.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Create | `lib/cost_request_tracker.sh` | Per-phase and per-request cost in state.json |
| Create | `lib/cost_governor.sh` | Budget checks and enforcement logic |

## Implementation Details

### lib/cost_request_tracker.sh

**`update_request_cost()`** -- After recording a session cost, update the request's `state.json`:

```bash
update_request_cost() {
  local request_dir="$1"   # path to {repo}/.autonomous-dev/requests/{id}/
  local phase="$2"         # current phase name
  local session_cost="$3"  # cost of this session in USD
  
  local state_file="${request_dir}/state.json"
  
  if [[ ! -f "$state_file" ]]; then
    log_error "cost_request_tracker" "State file not found: $state_file"
    return 1
  fi
  
  # Read current state
  local current_state
  current_state=$(cat "$state_file")
  
  # Update the phase's cost_usd (increment, not replace)
  # Update the request's cost_accrued_usd (sum of all phase costs)
  local updated_state
  updated_state=$(echo "$current_state" | jq \
    --arg phase "$phase" \
    --argjson cost "$session_cost" '
    # Find the current phase entry in phase_history and increment its cost_usd
    .phase_history = [
      .phase_history[] |
      if .phase == $phase and .ended_at == null then
        .cost_usd = ((.cost_usd // 0) + $cost)
      else . end
    ] |
    # Recalculate cost_accrued_usd as sum of all phase costs
    .cost_accrued_usd = ([.phase_history[].cost_usd // 0] | add)
  ')
  
  # Atomic write
  local tmp_file="${state_file}.tmp"
  echo "$updated_state" > "$tmp_file" || {
    log_error "cost_request_tracker" "Failed to write temp state file"
    rm -f "$tmp_file"
    return 1
  }
  mv "$tmp_file" "$state_file" || {
    log_error "cost_request_tracker" "Failed to atomic-move state file"
    return 1
  }
  
  return 0
}
```

**State file cost fields** (within `state.json`):

```json
{
  "request_id": "REQ-20260408-a3f1",
  "status": "in_progress",
  "cost_accrued_usd": 4.07,
  "phase_history": [
    {
      "phase": "prd",
      "started_at": "2026-04-08T09:00:00Z",
      "ended_at": "2026-04-08T09:30:00Z",
      "cost_usd": 1.97
    },
    {
      "phase": "tdd",
      "started_at": "2026-04-08T10:00:00Z",
      "ended_at": null,
      "cost_usd": 2.10
    }
  ]
}
```

### lib/cost_governor.sh

**`check_budgets()`** -- Pre-session budget check. Returns structured JSON status.

```bash
check_budgets() {
  local request_id="$1"
  local effective_config="$2"
  
  source "$PLUGIN_ROOT/lib/cost_ledger.sh"
  
  local monthly_cap daily_cap per_request_cap
  monthly_cap=$(echo "$effective_config" | jq -r '.governance.monthly_cost_cap_usd')
  daily_cap=$(echo "$effective_config" | jq -r '.governance.daily_cost_cap_usd')
  per_request_cap=$(echo "$effective_config" | jq -r '.governance.per_request_cost_cap_usd')
  
  local monthly_total daily_total request_total
  monthly_total=$(get_monthly_total)
  daily_total=$(get_daily_total)
  request_total=$(get_request_cumulative_cost "$request_id")
  
  local status="pass"
  local blocked_by=""
  local scope=""
  
  # Check in order: monthly (most severe) -> daily -> per-request
  if (( $(echo "$monthly_total >= $monthly_cap" | bc -l) )); then
    status="fail"
    blocked_by="monthly"
    scope="all"
  elif (( $(echo "$daily_total >= $daily_cap" | bc -l) )); then
    status="fail"
    blocked_by="daily"
    scope="all"
  elif (( $(echo "$request_total >= $per_request_cap" | bc -l) )); then
    status="fail"
    blocked_by="per_request"
    scope="request"
  fi
  
  jq -nc \
    --arg status "$status" \
    --arg blocked_by "$blocked_by" \
    --arg scope "$scope" \
    --argjson monthly_total "$monthly_total" \
    --argjson monthly_cap "$monthly_cap" \
    --argjson daily_total "$daily_total" \
    --argjson daily_cap "$daily_cap" \
    --argjson request_total "$request_total" \
    --argjson per_request_cap "$per_request_cap" \
    '{
      status: $status,
      blocked_by: $blocked_by,
      scope: $scope,
      monthly: {total: $monthly_total, cap: $monthly_cap},
      daily: {total: $daily_total, cap: $daily_cap},
      per_request: {total: $request_total, cap: $per_request_cap}
    }'
  
  if [[ "$status" == "fail" ]]; then
    return 1
  fi
  return 0
}
```

**`post_session_check()`** -- After recording cost, check if any cap is newly exceeded:

```bash
post_session_check() {
  local request_id="$1"
  local effective_config="$2"
  
  local budget_status
  budget_status=$(check_budgets "$request_id" "$effective_config")
  local exit_code=$?
  
  if [[ $exit_code -ne 0 ]]; then
    local blocked_by scope
    blocked_by=$(echo "$budget_status" | jq -r '.blocked_by')
    scope=$(echo "$budget_status" | jq -r '.scope')
    
    if [[ "$scope" == "all" ]]; then
      # Daily or monthly cap exceeded: pause ALL active requests
      pause_all_active_requests "$effective_config"
    else
      # Per-request cap exceeded: pause only this request
      pause_request "$request_id"
    fi
    
    # Emit escalation
    emit_cost_escalation "$budget_status" "$request_id" "$effective_config"
  fi
}
```

**`pause_all_active_requests()`** -- Scan for active requests and transition each to `paused`:

```bash
pause_all_active_requests() {
  local effective_config="$1"
  local allowlist
  allowlist=$(echo "$effective_config" | jq -r '.repositories.allowlist[]')
  
  while IFS= read -r repo; do
    local requests_dir="${repo}/.autonomous-dev/requests"
    [[ -d "$requests_dir" ]] || continue
    for req_dir in "$requests_dir"/*/; do
      local state_file="${req_dir}state.json"
      [[ -f "$state_file" ]] || continue
      local status
      status=$(jq -r '.status' "$state_file")
      case "$status" in
        completed|cancelled|failed|paused) continue ;;
      esac
      pause_request_by_state_file "$state_file"
    done
  done <<< "$allowlist"
}
```

**`pause_request()`** -- Transition a single request to `paused` via the state machine:

```bash
pause_request() {
  local request_id="$1"
  # Locate request state file and update status
  # Uses state machine transition function (from TDD-002)
  transition_state "$request_id" "paused" "cost_cap_exceeded"
}
```

**`emit_cost_escalation()`** -- Construct the escalation payload per TDD-010 Section 3.4.3:

```bash
emit_cost_escalation() {
  local budget_status="$1"
  local trigger_request_id="$2"
  local effective_config="$3"
  
  local cap_type cap_value current_spend overage
  cap_type=$(echo "$budget_status" | jq -r '.blocked_by')
  
  case "$cap_type" in
    monthly)
      cap_value=$(echo "$budget_status" | jq -r '.monthly.cap')
      current_spend=$(echo "$budget_status" | jq -r '.monthly.total')
      ;;
    daily)
      cap_value=$(echo "$budget_status" | jq -r '.daily.cap')
      current_spend=$(echo "$budget_status" | jq -r '.daily.total')
      ;;
    per_request)
      cap_value=$(echo "$budget_status" | jq -r '.per_request.cap')
      current_spend=$(echo "$budget_status" | jq -r '.per_request.total')
      ;;
  esac
  
  overage=$(echo "$current_spend - $cap_value" | bc -l)
  overage=$(printf "%.2f" "$overage")
  
  # Collect affected request IDs
  local affected_requests
  if [[ "$cap_type" == "per_request" ]]; then
    affected_requests="[\"$trigger_request_id\"]"
  else
    affected_requests=$(get_active_request_ids "$effective_config" | jq -R -s 'split("\n") | map(select(. != ""))')
  fi
  
  # Recommendation text varies by cap type
  local recommendation
  case "$cap_type" in
    per_request) recommendation="Review request ${trigger_request_id}. Either raise the per-request cap or cancel it." ;;
    daily) recommendation="Review active requests. Either raise the daily cap or cancel low-priority requests." ;;
    monthly) recommendation="Monthly budget exhausted. Raise the monthly cap or wait until next month." ;;
  esac
  
  local payload
  payload=$(jq -nc \
    --arg cap_type "$cap_type" \
    --argjson cap_value "$cap_value" \
    --argjson current_spend "$current_spend" \
    --argjson overage "$overage" \
    --argjson affected "$affected_requests" \
    --arg recommendation "$recommendation" \
    '{
      escalation_type: "cost",
      urgency: "immediate",
      cap_type: $cap_type,
      cap_value_usd: $cap_value,
      current_spend_usd: $current_spend,
      overage_usd: $overage,
      affected_requests: $affected,
      recommendation: $recommendation
    }')
  
  # Emit via escalation subsystem (TDD-009)
  emit_escalation "$payload"
}
```

**Escalation payload JSON schema**:

```json
{
  "escalation_type": "cost",
  "urgency": "immediate",
  "cap_type": "daily|monthly|per_request",
  "cap_value_usd": 100.00,
  "current_spend_usd": 102.47,
  "overage_usd": 2.47,
  "affected_requests": ["REQ-20260408-a3f1", "REQ-20260408-b2c4"],
  "recommendation": "string"
}
```

## Acceptance Criteria

1. Phase cost is incremented (not replaced) on each session recording.
2. `cost_accrued_usd` is recalculated as the sum of all phase costs.
3. State file is updated atomically (`.tmp` + `mv`).
4. Works correctly when a request has multiple phases with costs.
5. Pre-session `check_budgets()` returns pass/fail status for each cap level.
6. Monthly cap exceedance blocks ALL work (scope = "all").
7. Daily cap exceedance blocks ALL work (scope = "all").
8. Per-request cap exceedance blocks only that request (scope = "request").
9. If any cap is exceeded, `check_budgets` returns non-zero.
10. Budget caps are read from the effective config (PLAN-010-1).
11. Post-session check triggers `pause_all_active_requests()` on daily/monthly exceedance.
12. Post-session check triggers `pause_request()` on per-request exceedance.
13. Paused requests have their status updated in `state.json`.
14. Escalation payload matches the TDD-010 Section 3.4.3 schema.
15. All escalation fields are populated: `cap_type`, `cap_value_usd`, `current_spend_usd`, `overage_usd`, `affected_requests`, `recommendation`.
16. Recommendation text varies by cap type.
17. Escalation urgency is always `"immediate"`.

## Test Cases

1. **Update single phase cost**: Request in `prd` phase. Record $1.85. State file shows `prd.cost_usd=1.85`, `cost_accrued_usd=1.85`.
2. **Update same phase twice**: Two sessions in `prd`. Costs $1.00 and $0.85. State: `prd.cost_usd=1.85`.
3. **Update two phases**: `prd` cost $1.85, then `tdd` cost $2.10. `cost_accrued_usd=3.95`.
4. **Atomic write**: State file update survives simulated partial-write (check `.tmp` file is cleaned up).
5. **All caps below limit**: daily=50/100, monthly=500/2000, request=25/50. `check_budgets` returns 0, status=pass.
6. **Per-request cap exceeded**: request=55/50. Returns 1, blocked_by=per_request, scope=request.
7. **Daily cap exceeded**: daily=105/100. Returns 1, blocked_by=daily, scope=all.
8. **Monthly cap exceeded**: monthly=2100/2000. Returns 1, blocked_by=monthly, scope=all.
9. **Monthly and daily both exceeded**: Monthly takes precedence (blocked_by=monthly).
10. **Post-session: per-request cap newly exceeded**: Only that request is paused.
11. **Post-session: daily cap newly exceeded**: ALL active requests are paused.
12. **Escalation payload for daily cap**: Contains correct cap_type, values, and recommendation.
13. **Escalation payload for per-request cap**: `affected_requests` contains only the one request.
14. **Escalation payload for monthly cap**: `affected_requests` contains all active requests.
15. **Budget check reads config**: Changing `daily_cost_cap_usd` in config changes the check threshold.
