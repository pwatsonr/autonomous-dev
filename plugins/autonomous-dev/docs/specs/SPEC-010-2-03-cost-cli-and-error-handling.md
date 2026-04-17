# SPEC-010-2-03: Cost CLI Commands & Ledger Error Handling

## Metadata
- **Parent Plan**: PLAN-010-2
- **Tasks Covered**: Task 8, Task 9
- **Estimated effort**: 7 hours

## Description

Implement the `autonomous-dev cost` CLI reporting commands (today, daily, monthly, per-request, per-repo breakdowns) and comprehensive error handling for all ledger failure scenarios.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Create | `commands/cost.sh` | Cost reporting CLI |
| Modify | `lib/cost_ledger.sh` | Error handling for missing, corrupt, write-failure, stale scenarios |

## Implementation Details

### commands/cost.sh

**Usage**:
```
autonomous-dev cost                       # today + current month summary
autonomous-dev cost --daily               # daily breakdown for current month
autonomous-dev cost --monthly             # monthly breakdown for current year
autonomous-dev cost --request REQ-X       # per-request per-phase breakdown
autonomous-dev cost --repo /path/to/repo  # per-repo breakdown
```

**Default output** (no flags):

```
Cost Summary (2026-04-08)
=========================

Today:
  Spent:     $14.53
  Cap:       $100.00
  Remaining: $85.47

This Month (April 2026):
  Spent:     $189.32
  Cap:       $2,000.00
  Remaining: $1,810.68

Active Requests: 2
```

Implementation:

```bash
cost_default() {
  source "$PLUGIN_ROOT/lib/config_loader.sh"
  source "$PLUGIN_ROOT/lib/cost_ledger.sh"
  
  local config
  config=$(load_config "$@")
  
  local daily_total monthly_total daily_cap monthly_cap
  daily_total=$(get_daily_total)
  monthly_total=$(get_monthly_total)
  daily_cap=$(echo "$config" | jq -r '.governance.daily_cost_cap_usd')
  monthly_cap=$(echo "$config" | jq -r '.governance.monthly_cost_cap_usd')
  
  local daily_remaining monthly_remaining
  daily_remaining=$(echo "$daily_cap - $daily_total" | bc -l)
  monthly_remaining=$(echo "$monthly_cap - $monthly_total" | bc -l)
  
  printf "Cost Summary (%s)\n" "$(date -u +%Y-%m-%d)"
  printf "=========================\n\n"
  printf "Today:\n"
  printf "  Spent:     \$%.2f\n" "$daily_total"
  printf "  Cap:       \$%'.2f\n" "$daily_cap"
  printf "  Remaining: \$%.2f\n\n" "$daily_remaining"
  printf "This Month (%s):\n" "$(date -u +"%B %Y")"
  printf "  Spent:     \$%.2f\n" "$monthly_total"
  printf "  Cap:       \$%'.2f\n" "$monthly_cap"
  printf "  Remaining: \$%.2f\n" "$monthly_remaining"
}
```

**`--daily` output** (tabular):

```
Daily Cost Breakdown - April 2026
==================================
Date        | Sessions | Cost
------------|----------|--------
2026-04-01  |       5  | $12.30
2026-04-02  |       8  | $18.45
2026-04-03  |       3  |  $6.10
...
2026-04-08  |       4  | $14.53
------------|----------|--------
Total       |      47  | $189.32
```

Implementation uses full-scan `get_daily_breakdown()`:

```bash
cost_daily() {
  local month
  month=$(date -u +"%Y-%m")
  local breakdown
  breakdown=$(get_daily_breakdown "$month")
  
  printf "Daily Cost Breakdown - %s\n" "$(date -u +"%B %Y")"
  printf "==================================\n"
  printf "%-12s| %8s | %s\n" "Date" "Sessions" "Cost"
  printf "------------|----------|--------\n"
  
  echo "$breakdown" | jq -r '.[] | [.date, (.entries | tostring), (.total | tostring)] | @tsv' | \
    while IFS=$'\t' read -r date entries total; do
      printf "%-12s| %8s | \$%.2f\n" "$date" "$entries" "$total"
    done
  
  local grand_total
  grand_total=$(echo "$breakdown" | jq '[.[].total] | add')
  local total_sessions
  total_sessions=$(echo "$breakdown" | jq '[.[].entries] | add')
  printf "------------|----------|--------\n"
  printf "%-12s| %8s | \$%.2f\n" "Total" "$total_sessions" "$grand_total"
}
```

**`--monthly` output**:

```
Monthly Cost Breakdown - 2026
==============================
Month       | Sessions | Cost
------------|----------|----------
January     |      89  |   $823.45
February    |     102  | $1,045.20
March       |      95  |   $912.80
April       |      47  |   $189.32
------------|----------|----------
Year Total  |     333  | $2,970.77
```

**`--request REQ-X` output**:

```
Request: REQ-20260408-a3f1
Repository: /Users/pwatson/codebase/dashboard-app
Status: in_progress
Total Cost: $4.07

Phase Breakdown:
  Phase       | Sessions | Cost    | Turns
  ------------|----------|---------|------
  prd         |        1 |  $1.97  |    28
  tdd         |        1 |  $2.10  |    35
  ------------|----------|---------|------
  Total       |        2 |  $4.07  |    63
```

**`--repo /path` output**:

```
Repository: /Users/pwatson/codebase/dashboard-app
Total Cost: $45.23
Requests: 3

Request Breakdown:
  Request ID             | Status      | Cost
  -----------------------|-------------|--------
  REQ-20260401-f8c2      | completed   | $22.10
  REQ-20260405-b3a1      | completed   | $19.06
  REQ-20260408-a3f1      | in_progress |  $4.07
```

**Empty ledger**: All commands produce clean output:

```
Cost Summary (2026-04-08)
=========================

No cost data recorded yet.
```

### Ledger Error Handling (in lib/cost_ledger.sh)

**Missing ledger file** -- Auto-create on first write:

```bash
ensure_ledger_exists() {
  if [[ ! -f "$COST_LEDGER_PATH" ]]; then
    local ledger_dir
    ledger_dir=$(dirname "$COST_LEDGER_PATH")
    mkdir -p "$ledger_dir"
    touch "$COST_LEDGER_PATH"
    log_warning "cost_ledger" "Created new cost ledger: $COST_LEDGER_PATH"
  fi
}
```

**Corrupted last line** -- Refuse to start:

```bash
validate_ledger_integrity() {
  if [[ ! -s "$COST_LEDGER_PATH" ]]; then
    return 0  # Empty is OK
  fi
  
  local last_line
  last_line=$(tail -1 "$COST_LEDGER_PATH")
  if ! echo "$last_line" | jq '.' >/dev/null 2>&1; then
    log_error "cost_ledger" "FATAL: Corrupted last line in cost ledger. Manual repair required."
    log_error "cost_ledger" "File: $COST_LEDGER_PATH"
    log_error "cost_ledger" "Last line: $last_line"
    return 1
  fi
  return 0
}
```

**Write failure** -- Retry once, then pause and escalate:

```bash
append_with_retry() {
  local entry="$1"
  local tmp_file="${COST_LEDGER_PATH}.tmp.$$"
  
  echo "$entry" > "$tmp_file" 2>/dev/null
  if cat "$tmp_file" >> "$COST_LEDGER_PATH" 2>/dev/null; then
    rm -f "$tmp_file"
    return 0
  fi
  
  log_warning "cost_ledger" "First append attempt failed. Retrying..."
  sleep 1
  
  if cat "$tmp_file" >> "$COST_LEDGER_PATH" 2>/dev/null; then
    rm -f "$tmp_file"
    return 0
  fi
  
  log_error "cost_ledger" "FATAL: Cost ledger write failed after retry. Pausing all requests."
  rm -f "$tmp_file"
  
  # Pause all requests and escalate
  pause_all_active_requests "$(load_config)"
  emit_escalation "$(jq -nc '{
    escalation_type: "infrastructure",
    urgency: "immediate",
    message: "Cost ledger write failure. Cost was incurred but is unrecorded. All requests paused.",
    recommendation: "Check disk space and filesystem permissions for ~/.autonomous-dev/cost-ledger.jsonl"
  }')"
  
  return 1
}
```

**Stale daily/monthly totals** -- Already handled in `append_cost_entry()` by comparing dates/months of the last entry against current UTC time.

## Acceptance Criteria

1. Default `autonomous-dev cost` shows today's spend, remaining daily budget, current month's spend, and remaining monthly budget.
2. `--daily` shows a table of per-day totals for the current month.
3. `--monthly` shows per-month totals for the current year.
4. `--request REQ-X` shows per-phase breakdowns with cost and turns.
5. `--repo /path` shows per-request breakdowns for that repository.
6. Output is human-readable with dollar formatting (`$X.XX`).
7. Empty ledger produces clean "no data" output (no errors, no tracebacks).
8. Missing ledger file is auto-created on first write.
9. Corrupted last line causes the system to refuse work and log a FATAL error.
10. Write failure retries once; on second failure, pauses all requests and emits an infrastructure escalation.
11. Stale date transitions reset daily/monthly totals correctly.

## Test Cases

1. **Default output with data**: Ledger has entries. Output shows correct today/month totals and remaining.
2. **Default output empty ledger**: No ledger file. Output says "No cost data recorded yet."
3. **Daily breakdown**: Ledger spans 5 days. Table has 5 rows with correct totals per day.
4. **Monthly breakdown**: Ledger spans 3 months. Table has 3 rows.
5. **Request breakdown**: Request has 3 sessions across 2 phases. Correct per-phase totals shown.
6. **Repo breakdown**: Repo has 2 requests. Both listed with costs.
7. **Unknown request**: `--request REQ-nonexistent` shows "No data found for request."
8. **Missing ledger auto-create**: Ledger file does not exist. First write creates it.
9. **Corrupted last line detection**: Ledger's last line is `{invalid`. `validate_ledger_integrity` returns 1.
10. **Write failure retry success**: First append fails (simulate via read-only FS), retry succeeds. Entry is written.
11. **Write failure retry failure**: Both attempts fail. All requests paused. Escalation emitted.
12. **Stale daily reset**: Last entry from yesterday. New entry has `daily_total_usd` = new cost only.
13. **Stale monthly reset**: Last entry from previous month. Both totals reset.
