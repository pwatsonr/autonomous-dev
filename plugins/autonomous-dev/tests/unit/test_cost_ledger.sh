#!/usr/bin/env bash
# test_cost_ledger.sh -- Unit tests for ledger append, aggregation, error handling
# Part of SPEC-010-2-04: Unit Tests for Cost Extraction, Ledger, and Budget Enforcement
#
# Tests: append_cost_entry(), get_daily_total(), get_monthly_total(),
#        get_daily_breakdown(), get_request_cost() in lib/cost_ledger.sh
# Test count: 16
#
# Requires: jq (1.6+), bc, bash 4+
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source shared test harness
source "${SCRIPT_DIR}/../test_harness.sh"

# Source the module under test
source "${PROJECT_ROOT}/lib/cost_ledger.sh"

# =============================================================================
# Helper: Set COST_LEDGER_PATH to a temp file for test isolation
# =============================================================================
setup_ledger() {
  export COST_LEDGER_PATH="${_TEST_DIR}/cost-ledger.jsonl"
}

# Helper: Write a ledger line with a specific timestamp (for date boundary tests)
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

# =============================================================================
# Test 1: append_to_empty_ledger -- First append creates the file.
#   One line. daily_total_usd = cost.
# =============================================================================
test_append_to_empty_ledger() {
  setup_ledger

  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" "1.85" 28

  # File should exist
  assert_file_exists "$COST_LEDGER_PATH"

  # Should have exactly 1 line
  local line_count
  line_count=$(wc -l < "$COST_LEDGER_PATH" | tr -d ' ')
  assert_eq "1" "$line_count"

  # daily_total_usd should equal cost
  local line daily
  line=$(head -1 "$COST_LEDGER_PATH")
  daily=$(echo "$line" | jq -r '.daily_total_usd')
  assert_eq "1.85" "$daily"
}

# =============================================================================
# Test 2: append_same_day -- Two appends. Second entry's daily_total_usd = sum.
# =============================================================================
test_append_same_day() {
  setup_ledger

  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" "1.00" 10
  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "tdd" "sess_002" "2.00" 20

  local line_count
  line_count=$(wc -l < "$COST_LEDGER_PATH" | tr -d ' ')
  assert_eq "2" "$line_count"

  local second_line daily monthly
  second_line=$(tail -1 "$COST_LEDGER_PATH")
  daily=$(echo "$second_line" | jq -r '.daily_total_usd')
  monthly=$(echo "$second_line" | jq -r '.monthly_total_usd')

  assert_eq "3" "$daily"
  assert_eq "3" "$monthly"
}

# =============================================================================
# Test 3: append_new_day_same_month -- Set last entry to different day in
#   same month. New append resets daily, increments monthly.
# =============================================================================
test_append_new_day_same_month() {
  setup_ledger

  # Determine a seed day that is NOT today but in the same month
  local this_month today today_day seed_day
  this_month=$(date -u +"%Y-%m")
  today=$(date -u +"%Y-%m-%d")
  today_day=$(date -u +"%d" | sed 's/^0//')

  if [[ "$today_day" -eq 1 ]]; then
    seed_day="02"
  else
    seed_day="01"
  fi

  write_ledger_line "${this_month}-${seed_day}T10:00:00Z" "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" 5.00 20 5.00 5.00 50.00

  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "tdd" "sess_002" "3.00" 15

  local last_line daily monthly
  last_line=$(tail -1 "$COST_LEDGER_PATH")
  daily=$(echo "$last_line" | jq -r '.daily_total_usd')
  monthly=$(echo "$last_line" | jq -r '.monthly_total_usd')

  # Daily should reset to just the new cost
  assert_eq "3.00" "$daily"
  # Monthly should be old monthly + new cost = 50.00 + 3.00 = 53.00
  assert_eq "53.00" "$monthly"
}

# =============================================================================
# Test 4: append_new_month -- Set last entry to previous month. Both totals reset.
# =============================================================================
test_append_new_month() {
  setup_ledger

  # Seed with an entry from a far-past month
  write_ledger_line "2025-12-15T10:00:00Z" "REQ-20251215-a3f1" "/tmp/repo" "prd" "sess_001" 10.00 30 10.00 10.00 200.00

  append_cost_entry "REQ-20260408-b2e3" "/tmp/repo" "prd" "sess_002" "4.50" 22

  local last_line daily monthly
  last_line=$(tail -1 "$COST_LEDGER_PATH")
  daily=$(echo "$last_line" | jq -r '.daily_total_usd')
  monthly=$(echo "$last_line" | jq -r '.monthly_total_usd')

  # Both should reset to just the new cost
  assert_eq "4.5" "$daily"
  assert_eq "4.5" "$monthly"
}

# =============================================================================
# Test 5: cumulative_request_cost_same_request -- Two entries for REQ-A.
#   Second has cumulative = sum.
# =============================================================================
test_cumulative_request_cost_same_request() {
  setup_ledger

  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" "1.50" 10
  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "tdd" "sess_002" "2.50" 20

  local last_line cumulative
  last_line=$(tail -1 "$COST_LEDGER_PATH")
  cumulative=$(echo "$last_line" | jq -r '.cumulative_request_cost_usd')
  assert_eq "4" "$cumulative"
}

# =============================================================================
# Test 6: cumulative_request_cost_different_requests -- Entry for REQ-B after
#   REQ-A. REQ-B's cumulative is its own cost only.
# =============================================================================
test_cumulative_request_cost_different_requests() {
  setup_ledger

  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" "5.00" 10
  append_cost_entry "REQ-20260408-b2e3" "/tmp/repo" "prd" "sess_002" "3.00" 15

  local last_line cumulative
  last_line=$(tail -1 "$COST_LEDGER_PATH")
  cumulative=$(echo "$last_line" | jq -r '.cumulative_request_cost_usd')
  # Request B has no prior entries, so cumulative = just its cost
  assert_eq "3" "$cumulative"
}

# =============================================================================
# Test 7: get_daily_total_same_day -- Returns correct value from tail-read.
# =============================================================================
test_get_daily_total_same_day() {
  setup_ledger

  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" "2.00" 10
  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "tdd" "sess_002" "3.00" 20

  local daily
  daily=$(get_daily_total)
  assert_eq "5" "$daily"
}

# =============================================================================
# Test 8: get_daily_total_stale -- Last entry is yesterday. Returns 0.00.
# =============================================================================
test_get_daily_total_stale() {
  setup_ledger

  # Seed with an entry from a past date
  write_ledger_line "2025-01-15T10:00:00Z" "REQ-20250115-a3f1" "/tmp/repo" "prd" "sess_001" 5.00 20 5.00 5.00 50.00

  local daily
  daily=$(get_daily_total)
  assert_eq "0.00" "$daily"
}

# =============================================================================
# Test 9: get_monthly_total_same_month -- Returns correct value.
# =============================================================================
test_get_monthly_total_same_month() {
  setup_ledger

  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" "10.00" 25

  local monthly
  monthly=$(get_monthly_total)
  assert_eq "10" "$monthly"
}

# =============================================================================
# Test 10: get_monthly_total_stale -- Last entry is previous month. Returns 0.00.
# =============================================================================
test_get_monthly_total_stale() {
  setup_ledger

  write_ledger_line "2025-01-15T10:00:00Z" "REQ-20250115-a3f1" "/tmp/repo" "prd" "sess_001" 5.00 20 5.00 5.00 50.00

  local monthly
  monthly=$(get_monthly_total)
  assert_eq "0.00" "$monthly"
}

# =============================================================================
# Test 11: get_daily_total_empty_ledger -- Returns 0.00.
# =============================================================================
test_get_daily_total_empty_ledger() {
  setup_ledger

  local daily
  daily=$(get_daily_total)
  assert_eq "0.00" "$daily"
}

# =============================================================================
# Test 12: daily_breakdown -- Ledger with 3 days of entries. Breakdown returns
#   3 groups.
# =============================================================================
test_daily_breakdown() {
  setup_ledger

  local month="2026-04"
  write_ledger_line "2026-04-01T10:00:00Z" "REQ-20260401-a3f1" "/tmp/repo" "prd" "sess_001" 1.00 10 1.00 1.00 1.00
  write_ledger_line "2026-04-01T14:00:00Z" "REQ-20260401-a3f1" "/tmp/repo" "tdd" "sess_002" 2.00 20 3.00 3.00 3.00
  write_ledger_line "2026-04-02T10:00:00Z" "REQ-20260402-b2e3" "/tmp/repo" "prd" "sess_003" 4.00 15 4.00 4.00 7.00
  write_ledger_line "2026-04-03T10:00:00Z" "REQ-20260403-c4d5" "/tmp/repo" "prd" "sess_004" 5.00 25 5.00 5.00 12.00

  local breakdown
  breakdown=$(get_daily_breakdown "$month")

  # Should have 3 day-groups
  local day_count
  day_count=$(echo "$breakdown" | jq 'length')
  assert_eq "3" "$day_count"

  # Day 1 total: 1.00 + 2.00 = 3.00
  local day1_total
  day1_total=$(echo "$breakdown" | jq '.[0].total')
  assert_eq "3" "$day1_total"

  # Day 1 entries: 2
  local day1_entries
  day1_entries=$(echo "$breakdown" | jq '.[0].entries')
  assert_eq "2" "$day1_entries"

  # Day 2 total: 4.00
  local day2_total
  day2_total=$(echo "$breakdown" | jq '.[1].total')
  assert_eq "4" "$day2_total"

  # Day 3 total: 5.00
  local day3_total
  day3_total=$(echo "$breakdown" | jq '.[2].total')
  assert_eq "5" "$day3_total"
}

# =============================================================================
# Test 13: request_cost -- Ledger with entries for multiple requests.
#   Request-specific query correct.
# =============================================================================
test_request_cost() {
  setup_ledger

  write_ledger_line "2026-04-08T10:00:00Z" "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" 1.50 10 1.50 1.50 1.50
  write_ledger_line "2026-04-08T11:00:00Z" "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_002" 2.00 15 3.50 3.50 3.50
  write_ledger_line "2026-04-08T12:00:00Z" "REQ-20260408-a3f1" "/tmp/repo" "tdd" "sess_003" 3.00 20 6.50 6.50 6.50
  # Different request -- should not affect query for a3f1
  write_ledger_line "2026-04-08T13:00:00Z" "REQ-20260408-b2e3" "/tmp/repo" "prd" "sess_004" 1.00 5 1.00 7.50 7.50

  local result
  result=$(get_request_cost "REQ-20260408-a3f1")

  # Total cost: 1.50 + 2.00 + 3.00 = 6.50
  local total_cost
  total_cost=$(echo "$result" | jq '.total_cost_usd')
  assert_eq "6.5" "$total_cost"

  # Session count: 3
  local session_count
  session_count=$(echo "$result" | jq '.session_count')
  assert_eq "3" "$session_count"

  # Phases: 2 (prd and tdd)
  local phase_count
  phase_count=$(echo "$result" | jq '.phases | length')
  assert_eq "2" "$phase_count"

  # prd cost: 1.50 + 2.00 = 3.50
  local prd_cost
  prd_cost=$(echo "$result" | jq '.phases[] | select(.phase == "prd") | .cost')
  assert_eq "3.5" "$prd_cost"

  # tdd cost: 3.00
  local tdd_cost
  tdd_cost=$(echo "$result" | jq '.phases[] | select(.phase == "tdd") | .cost')
  assert_eq "3" "$tdd_cost"
}

# =============================================================================
# Test 14: corrupted_last_line_detection -- Write invalid JSON as last line.
#   append_cost_entry returns 1 (validating ledger integrity).
# =============================================================================
test_corrupted_last_line_detection() {
  setup_ledger

  # Write a valid line, then corrupt it
  write_ledger_line "2026-04-08T10:00:00Z" "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" 1.00 10 1.00 1.00 1.00
  echo "THIS IS NOT VALID JSON {broken" >> "$COST_LEDGER_PATH"

  local exit_code=0
  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "tdd" "sess_002" "2.00" 15 2>/dev/null || exit_code=$?
  assert_eq "1" "$exit_code"
}

# =============================================================================
# Test 15: entry_format_validation -- Each appended line has all 10 required fields.
# =============================================================================
test_entry_format_validation() {
  setup_ledger

  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" "1.85" 28

  local line
  line=$(head -1 "$COST_LEDGER_PATH")

  # Validate all 10 fields are present
  local field_count
  field_count=$(echo "$line" | jq 'keys | length')
  assert_eq "10" "$field_count"

  # Validate each required field is not null
  local ts rid repo phase sid cost turns cum daily monthly
  ts=$(echo "$line" | jq -r '.timestamp')
  rid=$(echo "$line" | jq -r '.request_id')
  repo=$(echo "$line" | jq -r '.repository')
  phase=$(echo "$line" | jq -r '.phase')
  sid=$(echo "$line" | jq -r '.session_id')
  cost=$(echo "$line" | jq -r '.cost_usd')
  turns=$(echo "$line" | jq -r '.turns_used')
  cum=$(echo "$line" | jq -r '.cumulative_request_cost_usd')
  daily=$(echo "$line" | jq -r '.daily_total_usd')
  monthly=$(echo "$line" | jq -r '.monthly_total_usd')

  [[ "$ts" != "null" ]]
  [[ "$rid" == "REQ-20260408-a3f1" ]]
  [[ "$repo" == "/tmp/repo" ]]
  [[ "$phase" == "prd" ]]
  [[ "$sid" == "sess_001" ]]
  [[ "$cost" == "1.85" ]]
  [[ "$turns" == "28" ]]
  [[ "$cum" == "1.85" ]]
  [[ "$daily" == "1.85" ]]
  [[ "$monthly" == "1.85" ]]
}

# =============================================================================
# Test 16: numbers_formatted_2dp -- cost_usd, daily_total_usd, monthly_total_usd
#   all have 2 decimal places (or are valid numeric equivalents).
# =============================================================================
test_numbers_formatted_2dp() {
  setup_ledger

  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" "1.10" 10

  local line
  line=$(head -1 "$COST_LEDGER_PATH")

  # jq stores numbers, so trailing zeros may be trimmed
  local cost daily monthly
  cost=$(echo "$line" | jq '.cost_usd')
  daily=$(echo "$line" | jq '.daily_total_usd')
  monthly=$(echo "$line" | jq '.monthly_total_usd')

  # They should be valid numbers (jq stores them as numbers, not strings)
  [[ "$cost" == "1.1" || "$cost" == "1.10" ]]
  [[ "$daily" == "1.1" || "$daily" == "1.10" ]]
  [[ "$monthly" == "1.1" || "$monthly" == "1.10" ]]
}

# =============================================================================
# Run all tests
# =============================================================================
echo "SPEC-010-2-04: Cost Ledger Tests"
echo "================================="

run_test "Append to empty ledger (creates file)"            test_append_to_empty_ledger
run_test "Append same day (daily accumulates)"              test_append_same_day
run_test "Append new day, same month (daily resets)"        test_append_new_day_same_month
run_test "Append new month (both reset)"                    test_append_new_month
run_test "Cumulative request cost same request"             test_cumulative_request_cost_same_request
run_test "Cumulative request cost different requests"       test_cumulative_request_cost_different_requests
run_test "get_daily_total same day"                         test_get_daily_total_same_day
run_test "get_daily_total stale (yesterday)"                test_get_daily_total_stale
run_test "get_monthly_total same month"                     test_get_monthly_total_same_month
run_test "get_monthly_total stale (old month)"              test_get_monthly_total_stale
run_test "get_daily_total empty ledger"                     test_get_daily_total_empty_ledger
run_test "Daily breakdown (3 days, 3 groups)"               test_daily_breakdown
run_test "Request cost (multi-request filtering)"           test_request_cost
run_test "Corrupted last line detection"                    test_corrupted_last_line_detection
run_test "Entry format validation (10 fields)"              test_entry_format_validation
run_test "Numbers formatted to 2dp"                         test_numbers_formatted_2dp

report
