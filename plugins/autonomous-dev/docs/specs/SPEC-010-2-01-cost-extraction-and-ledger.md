# SPEC-010-2-01: Cost Extraction & Append-Only Cost Ledger

## Metadata
- **Parent Plan**: PLAN-010-2
- **Tasks Covered**: Task 1, Task 2, Task 3
- **Estimated effort**: 11 hours

## Description

Implement cost extraction from Claude Code session output, the append-only JSONL cost ledger with denormalized daily/monthly aggregates, and the tail-read / full-scan aggregation strategies.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Create | `lib/cost_extractor.sh` | Parse session output for cost dollar amounts |
| Create | `lib/cost_ledger.sh` | Append-only JSONL ledger with aggregate computation |

## Implementation Details

### lib/cost_extractor.sh

**`extract_session_cost()`** -- Takes Claude Code session output (stdin or argument), returns the cost as a decimal string.

```bash
extract_session_cost() {
  local session_output="$1"
  local cost
  
  # Match patterns:
  #   "Total cost: $1.85"
  #   "Session cost: $1.85"
  #   "Cost: $1.85"
  #   "Total cost: $0.00"
  # Takes the LAST match (in case of multiple cost lines, the final one is authoritative)
  cost=$(echo "$session_output" | grep -oE '(Total |Session )?[Cc]ost:\s*\$[0-9]+\.[0-9]+' | tail -1 | grep -oE '[0-9]+\.[0-9]+')
  
  if [[ -z "$cost" ]]; then
    log_warning "cost_extractor" "No cost found in session output. Recording 0.00."
    echo "0.00"
    return 0
  fi
  
  echo "$cost"
}
```

**Pattern variations handled**:
- `Total cost: $1.85` -- standard format
- `Session cost: $0.42` -- alternate label
- `Cost: $3.17` -- minimal label
- `Total cost: $0.00` -- zero cost
- `Total cost: $123.45` -- three-digit dollar amounts
- Multiple cost lines in output -- takes the last one

**Not handled** (returns 0.00 with warning):
- Crashed sessions with no output
- Sessions that printed only partial output before crash
- Non-dollar cost formats (future-proofing deferred per TDD-010 OQ-1)

### lib/cost_ledger.sh

**Constants**:

```bash
COST_LEDGER_PATH="${HOME}/.autonomous-dev/cost-ledger.jsonl"
```

**`append_cost_entry()`** -- Appends a single JSONL line to the ledger.

Parameters:
- `request_id` -- e.g., `REQ-20260408-a3f1`
- `repository` -- absolute path
- `phase` -- pipeline phase name
- `session_id` -- Claude Code session ID
- `cost_usd` -- session cost as decimal string
- `turns_used` -- integer

Logic:
1. Read the last line of the ledger (if it exists) to get current daily/monthly totals.
2. Compute new daily/monthly totals:
   - If the last entry's date (UTC) matches today, add `cost_usd` to `daily_total_usd`.
   - If the last entry's date is a different day but the same month, reset daily to `cost_usd`, carry forward `monthly_total_usd + cost_usd`.
   - If the last entry's month differs from this month, reset both to `cost_usd`.
   - If the ledger is empty, both start at `cost_usd`.
3. Compute `cumulative_request_cost_usd` by scanning back for entries with the same `request_id` and summing `cost_usd` values (or reading from the last entry with that request_id and adding).
4. Construct the JSON entry.
5. Write to a temp file, then append atomically.

```bash
append_cost_entry() {
  local request_id="$1"
  local repository="$2"
  local phase="$3"
  local session_id="$4"
  local cost_usd="$5"
  local turns_used="$6"
  
  local ledger_dir
  ledger_dir=$(dirname "$COST_LEDGER_PATH")
  mkdir -p "$ledger_dir"
  
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local today
  today=$(date -u +"%Y-%m-%d")
  local this_month
  this_month=$(date -u +"%Y-%m")
  
  local daily_total="$cost_usd"
  local monthly_total="$cost_usd"
  
  if [[ -f "$COST_LEDGER_PATH" ]] && [[ -s "$COST_LEDGER_PATH" ]]; then
    local last_line
    last_line=$(tail -1 "$COST_LEDGER_PATH")
    
    # Validate last line is valid JSON
    if ! echo "$last_line" | jq '.' >/dev/null 2>&1; then
      log_error "cost_ledger" "Corrupted last line in cost ledger. Refusing to append."
      return 1
    fi
    
    local last_date last_month last_daily last_monthly
    last_date=$(echo "$last_line" | jq -r '.timestamp[:10]')
    last_month=$(echo "$last_line" | jq -r '.timestamp[:7]')
    last_daily=$(echo "$last_line" | jq -r '.daily_total_usd')
    last_monthly=$(echo "$last_line" | jq -r '.monthly_total_usd')
    
    if [[ "$last_date" == "$today" ]]; then
      # Same day: increment both
      daily_total=$(echo "$last_daily + $cost_usd" | bc -l)
      monthly_total=$(echo "$last_monthly + $cost_usd" | bc -l)
    elif [[ "$last_month" == "$this_month" ]]; then
      # Same month, new day: reset daily, increment monthly
      daily_total="$cost_usd"
      monthly_total=$(echo "$last_monthly + $cost_usd" | bc -l)
    else
      # New month: reset both
      daily_total="$cost_usd"
      monthly_total="$cost_usd"
    fi
  fi
  
  # Compute cumulative request cost
  local cumulative_request_cost="$cost_usd"
  if [[ -f "$COST_LEDGER_PATH" ]]; then
    local prev_cumulative
    prev_cumulative=$(grep "\"$request_id\"" "$COST_LEDGER_PATH" 2>/dev/null \
      | tail -1 \
      | jq -r '.cumulative_request_cost_usd // 0')
    if [[ -n "$prev_cumulative" ]] && [[ "$prev_cumulative" != "0" ]]; then
      cumulative_request_cost=$(echo "$prev_cumulative + $cost_usd" | bc -l)
    fi
  fi
  
  # Format numbers to 2 decimal places
  daily_total=$(printf "%.2f" "$daily_total")
  monthly_total=$(printf "%.2f" "$monthly_total")
  cumulative_request_cost=$(printf "%.2f" "$cumulative_request_cost")
  cost_usd_fmt=$(printf "%.2f" "$cost_usd")
  
  # Construct entry
  local entry
  entry=$(jq -nc \
    --arg ts "$timestamp" \
    --arg rid "$request_id" \
    --arg repo "$repository" \
    --arg phase "$phase" \
    --arg sid "$session_id" \
    --argjson cost "$cost_usd_fmt" \
    --argjson turns "$turns_used" \
    --argjson cum "$cumulative_request_cost" \
    --argjson daily "$daily_total" \
    --argjson monthly "$monthly_total" \
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
    }')
  
  # Atomic append: write to temp, then append
  local tmp_file="${COST_LEDGER_PATH}.tmp.$$"
  echo "$entry" > "$tmp_file" || {
    log_error "cost_ledger" "Failed to write temp file: $tmp_file"
    rm -f "$tmp_file"
    return 1
  }
  cat "$tmp_file" >> "$COST_LEDGER_PATH" || {
    log_error "cost_ledger" "Failed to append to ledger"
    rm -f "$tmp_file"
    return 1
  }
  rm -f "$tmp_file"
  return 0
}
```

**Ledger JSONL format** -- Each line is a self-contained JSON object:

```jsonl
{"timestamp":"2026-04-08T10:05:30Z","request_id":"REQ-20260408-a3f1","repository":"/Users/pwatson/codebase/dashboard-app","phase":"prd","session_id":"sess_def456","cost_usd":1.85,"turns_used":28,"cumulative_request_cost_usd":1.97,"daily_total_usd":12.43,"monthly_total_usd":187.22}
{"timestamp":"2026-04-08T11:30:00Z","request_id":"REQ-20260408-a3f1","repository":"/Users/pwatson/codebase/dashboard-app","phase":"tdd","session_id":"sess_ghi789","cost_usd":2.10,"turns_used":35,"cumulative_request_cost_usd":4.07,"daily_total_usd":14.53,"monthly_total_usd":189.32}
```

### Aggregation Strategies

**`get_daily_total()`** -- Tail-read strategy for budget checks (Strategy A):

```bash
get_daily_total() {
  local today
  today=$(date -u +"%Y-%m-%d")
  
  if [[ ! -f "$COST_LEDGER_PATH" ]] || [[ ! -s "$COST_LEDGER_PATH" ]]; then
    echo "0.00"
    return 0
  fi
  
  local last_line
  last_line=$(tail -1 "$COST_LEDGER_PATH")
  local last_date
  last_date=$(echo "$last_line" | jq -r '.timestamp[:10]')
  
  if [[ "$last_date" == "$today" ]]; then
    echo "$last_line" | jq -r '.daily_total_usd'
  else
    echo "0.00"
  fi
}
```

**`get_monthly_total()`** -- Tail-read strategy:

```bash
get_monthly_total() {
  local this_month
  this_month=$(date -u +"%Y-%m")
  
  if [[ ! -f "$COST_LEDGER_PATH" ]] || [[ ! -s "$COST_LEDGER_PATH" ]]; then
    echo "0.00"
    return 0
  fi
  
  local last_line
  last_line=$(tail -1 "$COST_LEDGER_PATH")
  local last_month
  last_month=$(echo "$last_line" | jq -r '.timestamp[:7]')
  
  if [[ "$last_month" == "$this_month" ]]; then
    echo "$last_line" | jq -r '.monthly_total_usd'
  else
    echo "0.00"
  fi
}
```

**`get_daily_breakdown()`** -- Full-scan strategy for reporting (Strategy B):

```bash
get_daily_breakdown() {
  local month="${1:-$(date -u +"%Y-%m")}"
  jq -r "select(.timestamp[:7] == \"$month\")" "$COST_LEDGER_PATH" \
    | jq -s 'group_by(.timestamp[:10]) | map({date: .[0].timestamp[:10], total: (map(.cost_usd) | add), entries: length})'
}
```

**`get_request_cost()`** -- Full-scan for a specific request:

```bash
get_request_cost() {
  local request_id="$1"
  jq -r "select(.request_id == \"$request_id\")" "$COST_LEDGER_PATH" \
    | jq -s '{
        request_id: .[0].request_id,
        total_cost_usd: (map(.cost_usd) | add),
        phases: (group_by(.phase) | map({phase: .[0].phase, cost: (map(.cost_usd) | add), sessions: length})),
        session_count: length
      }'
}
```

## Acceptance Criteria

1. `extract_session_cost` correctly extracts dollar amounts from `"Total cost: $1.85"`, `"Session cost: $0.42"`, and `"Cost: $3.17"`.
2. `extract_session_cost` returns `"0.00"` when no cost line is present (crashed session) and logs a warning.
3. `extract_session_cost` takes the last cost line when multiple are present in the output.
4. Each call to `append_cost_entry` appends exactly one line to the ledger.
5. Each ledger line is valid JSON matching the Section 4.2 schema with all 10 fields.
6. `daily_total_usd` reflects the running total for the current UTC day.
7. `monthly_total_usd` reflects the running total for the current UTC month.
8. Day boundary: when the last entry's date differs from today, `daily_total_usd` resets to the new cost.
9. Month boundary: when the last entry's month differs, both `daily_total_usd` and `monthly_total_usd` reset.
10. Ledger file is created if it does not exist.
11. `get_daily_total()` returns correct total via tail-read strategy.
12. `get_monthly_total()` returns correct total via tail-read strategy.
13. `get_daily_total()` returns `"0.00"` if the last entry is from a previous day.
14. Full-scan functions correctly compute per-day, per-request, and per-repo aggregates.
15. Numbers are formatted to 2 decimal places.

## Test Cases

1. **Extract "Total cost: $1.85"**: Returns `"1.85"`.
2. **Extract "Session cost: $0.42"**: Returns `"0.42"`.
3. **Extract "Cost: $3.17"**: Returns `"3.17"`.
4. **Extract "Total cost: $0.00"**: Returns `"0.00"`.
5. **Extract no cost line**: Returns `"0.00"`, warning logged.
6. **Extract multi-line with two cost lines**: Takes the last one.
7. **Extract large cost "Total cost: $123.45"**: Returns `"123.45"`.
8. **Append to empty ledger**: Creates file, writes one line, daily=cost, monthly=cost.
9. **Append same day**: Two appends on same UTC day. Second entry's `daily_total_usd` = sum of both costs.
10. **Append new day, same month**: Last entry is yesterday. New entry's `daily_total_usd` = new cost only. `monthly_total_usd` = old monthly + new cost.
11. **Append new month**: Last entry is previous month. Both totals reset to new cost.
12. **Cumulative request cost**: Two entries for same request. Second entry's `cumulative_request_cost_usd` = sum.
13. **Cumulative request cost, different requests**: Entry for request B does not affect request A's cumulative.
14. **Tail-read daily total**: Ledger has entries from today. `get_daily_total()` returns the last entry's `daily_total_usd`.
15. **Tail-read daily total, stale**: Ledger's last entry is from yesterday. `get_daily_total()` returns `"0.00"`.
16. **Tail-read monthly total**: Similar to daily but for month.
17. **Full-scan daily breakdown**: Ledger spans 3 days. Breakdown returns 3 objects with correct totals.
18. **Full-scan request cost**: Request has 3 sessions across 2 phases. Breakdown is correct.
19. **Empty ledger get_daily_total**: Returns `"0.00"`.
20. **Corrupted last line**: `append_cost_entry` detects invalid JSON and returns non-zero.
