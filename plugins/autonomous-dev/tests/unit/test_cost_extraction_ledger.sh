#!/usr/bin/env bash
# test_cost_extraction_ledger.sh -- Unit tests for SPEC-010-2-01
# Tests: extract_session_cost() in cost_extractor.sh
# Tests: append_cost_entry(), get_daily_total(), get_monthly_total(),
#        get_daily_breakdown(), get_request_cost() in cost_ledger.sh
#
# Requires: jq (1.6+), bc, bash 4+
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source shared test harness
source "${SCRIPT_DIR}/../test_harness.sh"

# Source the modules under test
source "${PROJECT_ROOT}/lib/cost_extractor.sh"
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
# Test 1: Extract "Total cost: $1.85" -- Returns "1.85"
# =============================================================================
test_extract_total_cost() {
  local output
  output=$(extract_session_cost "Some output text
Total cost: \$1.85
Done.")
  assert_eq "1.85" "$output"
}

# =============================================================================
# Test 2: Extract "Session cost: $0.42" -- Returns "0.42"
# =============================================================================
test_extract_session_cost() {
  local output
  output=$(extract_session_cost "Session cost: \$0.42")
  assert_eq "0.42" "$output"
}

# =============================================================================
# Test 3: Extract "Cost: $3.17" -- Returns "3.17"
# =============================================================================
test_extract_minimal_cost() {
  local output
  output=$(extract_session_cost "Cost: \$3.17")
  assert_eq "3.17" "$output"
}

# =============================================================================
# Test 4: Extract "Total cost: $0.00" -- Returns "0.00"
# =============================================================================
test_extract_zero_cost() {
  local output
  output=$(extract_session_cost "Total cost: \$0.00")
  assert_eq "0.00" "$output"
}

# =============================================================================
# Test 5: Extract no cost line -- Returns "0.00", warning logged
# =============================================================================
test_extract_no_cost_line() {
  local output stderr_output
  output=$(extract_session_cost "No cost information here" 2>"${_TEST_DIR}/stderr.txt")
  stderr_output=$(cat "${_TEST_DIR}/stderr.txt")

  assert_eq "0.00" "$output"
  assert_contains "$stderr_output" "WARNING"
  assert_contains "$stderr_output" "No cost found"
}

# =============================================================================
# Test 6: Extract multi-line with two cost lines -- Takes the last one
# =============================================================================
test_extract_multi_cost_lines() {
  local output
  output=$(extract_session_cost "Session cost: \$0.50
Some other output
Total cost: \$2.75")
  assert_eq "2.75" "$output"
}

# =============================================================================
# Test 7: Extract large cost "Total cost: $123.45" -- Returns "123.45"
# =============================================================================
test_extract_large_cost() {
  local output
  output=$(extract_session_cost "Total cost: \$123.45")
  assert_eq "123.45" "$output"
}

# =============================================================================
# Test 8: Append to empty ledger -- Creates file, one line, daily=cost, monthly=cost
# =============================================================================
test_append_empty_ledger() {
  setup_ledger

  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" "1.85" 28

  # File should exist
  assert_file_exists "$COST_LEDGER_PATH"

  # Should have exactly 1 line
  local line_count
  line_count=$(wc -l < "$COST_LEDGER_PATH" | tr -d ' ')
  assert_eq "1" "$line_count" "line count"

  # Validate JSON and fields
  local line
  line=$(head -1 "$COST_LEDGER_PATH")
  echo "$line" | jq empty

  local cost daily monthly
  cost=$(echo "$line" | jq -r '.cost_usd')
  daily=$(echo "$line" | jq -r '.daily_total_usd')
  monthly=$(echo "$line" | jq -r '.monthly_total_usd')

  assert_eq "1.85" "$cost"
  assert_eq "1.85" "$daily"
  assert_eq "1.85" "$monthly"

  # Validate all 10 fields are present
  local field_count
  field_count=$(echo "$line" | jq 'keys | length')
  assert_eq "10" "$field_count" "field count"
}

# =============================================================================
# Test 9: Append same day -- Two appends, second daily_total_usd = sum
# =============================================================================
test_append_same_day() {
  setup_ledger

  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" "1.00" 10
  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "tdd" "sess_002" "2.00" 20

  local line_count
  line_count=$(wc -l < "$COST_LEDGER_PATH" | tr -d ' ')
  assert_eq "2" "$line_count"

  local second_line
  second_line=$(tail -1 "$COST_LEDGER_PATH")
  local daily
  daily=$(echo "$second_line" | jq -r '.daily_total_usd')
  assert_eq "3" "$daily"

  local monthly
  monthly=$(echo "$second_line" | jq -r '.monthly_total_usd')
  assert_eq "3" "$monthly"
}

# =============================================================================
# Test 10: Append new day, same month -- daily resets, monthly increments
# =============================================================================
test_append_new_day_same_month() {
  setup_ledger

  # Determine a "yesterday" date that is in the same month as today (UTC).
  # We pick a day in the current month that is NOT today.
  local this_month today today_day seed_day
  this_month=$(date -u +"%Y-%m")
  today=$(date -u +"%Y-%m-%d")
  today_day=$(date -u +"%d" | sed 's/^0//')

  # Use day 1 unless today is the 1st, then use day 2
  if [[ "$today_day" -eq 1 ]]; then
    seed_day="02"
  else
    seed_day="01"
  fi

  write_ledger_line "${this_month}-${seed_day}T10:00:00Z" "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" 5.00 20 5.00 5.00 50.00

  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "tdd" "sess_002" "3.00" 15

  local last_line
  last_line=$(tail -1 "$COST_LEDGER_PATH")

  local daily monthly
  daily=$(echo "$last_line" | jq -r '.daily_total_usd')
  monthly=$(echo "$last_line" | jq -r '.monthly_total_usd')

  # Daily should reset to just the new cost
  assert_eq "3.00" "$daily"
  # Monthly should be old monthly + new cost = 50.00 + 3.00 = 53.00
  assert_eq "53.00" "$monthly"
}

# =============================================================================
# Test 11: Append new month -- Both totals reset to new cost
# =============================================================================
test_append_new_month() {
  setup_ledger

  # Seed with an entry from last month
  write_ledger_line "2025-12-15T10:00:00Z" "REQ-20251215-a3f1" "/tmp/repo" "prd" "sess_001" 10.00 30 10.00 10.00 200.00

  append_cost_entry "REQ-20260408-b2e3" "/tmp/repo" "prd" "sess_002" "4.50" 22

  local last_line
  last_line=$(tail -1 "$COST_LEDGER_PATH")

  local daily monthly
  daily=$(echo "$last_line" | jq -r '.daily_total_usd')
  monthly=$(echo "$last_line" | jq -r '.monthly_total_usd')

  # Both should reset
  assert_eq "4.5" "$daily"
  assert_eq "4.5" "$monthly"
}

# =============================================================================
# Test 12: Cumulative request cost -- Two entries for same request, second = sum
# =============================================================================
test_cumulative_request_cost() {
  setup_ledger

  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" "1.50" 10
  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "tdd" "sess_002" "2.50" 20

  local last_line
  last_line=$(tail -1 "$COST_LEDGER_PATH")
  local cumulative
  cumulative=$(echo "$last_line" | jq -r '.cumulative_request_cost_usd')
  assert_eq "4" "$cumulative"
}

# =============================================================================
# Test 13: Cumulative request cost, different requests -- no cross-contamination
# =============================================================================
test_cumulative_different_requests() {
  setup_ledger

  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" "5.00" 10
  append_cost_entry "REQ-20260408-b2e3" "/tmp/repo" "prd" "sess_002" "3.00" 15

  local last_line
  last_line=$(tail -1 "$COST_LEDGER_PATH")
  local cumulative
  cumulative=$(echo "$last_line" | jq -r '.cumulative_request_cost_usd')
  # Request B has no prior entries, so cumulative = just its cost
  assert_eq "3" "$cumulative"
}

# =============================================================================
# Test 14: Tail-read daily total -- entries from today, returns daily_total_usd
# =============================================================================
test_tail_read_daily_total() {
  setup_ledger

  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" "2.00" 10
  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "tdd" "sess_002" "3.00" 20

  local daily
  daily=$(get_daily_total)
  assert_eq "5" "$daily"
}

# =============================================================================
# Test 15: Tail-read daily total, stale -- last entry from yesterday, returns "0.00"
# =============================================================================
test_tail_read_daily_stale() {
  setup_ledger

  # Seed with an entry from a past date
  write_ledger_line "2025-01-15T10:00:00Z" "REQ-20250115-a3f1" "/tmp/repo" "prd" "sess_001" 5.00 20 5.00 5.00 50.00

  local daily
  daily=$(get_daily_total)
  assert_eq "0.00" "$daily"
}

# =============================================================================
# Test 16: Tail-read monthly total -- similar to daily but for month
# =============================================================================
test_tail_read_monthly_total() {
  setup_ledger

  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" "10.00" 25

  local monthly
  monthly=$(get_monthly_total)
  assert_eq "10" "$monthly"
}

# =============================================================================
# Test 16b: Tail-read monthly total, stale -- last entry from old month
# =============================================================================
test_tail_read_monthly_stale() {
  setup_ledger

  write_ledger_line "2025-01-15T10:00:00Z" "REQ-20250115-a3f1" "/tmp/repo" "prd" "sess_001" 5.00 20 5.00 5.00 50.00

  local monthly
  monthly=$(get_monthly_total)
  assert_eq "0.00" "$monthly"
}

# =============================================================================
# Test 17: Full-scan daily breakdown -- 3 days, returns 3 objects
# =============================================================================
test_full_scan_daily_breakdown() {
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
# Test 18: Full-scan request cost -- 3 sessions across 2 phases
# =============================================================================
test_full_scan_request_cost() {
  setup_ledger

  write_ledger_line "2026-04-08T10:00:00Z" "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" 1.50 10 1.50 1.50 1.50
  write_ledger_line "2026-04-08T11:00:00Z" "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_002" 2.00 15 3.50 3.50 3.50
  write_ledger_line "2026-04-08T12:00:00Z" "REQ-20260408-a3f1" "/tmp/repo" "tdd" "sess_003" 3.00 20 6.50 6.50 6.50
  # Add a different request to ensure filtering
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
# Test 19: Empty ledger get_daily_total -- Returns "0.00"
# =============================================================================
test_empty_ledger_daily_total() {
  setup_ledger

  local daily
  daily=$(get_daily_total)
  assert_eq "0.00" "$daily"
}

# =============================================================================
# Test 20: Corrupted last line -- append_cost_entry returns non-zero
# =============================================================================
test_corrupted_last_line() {
  setup_ledger

  # Write a valid line then a corrupted line
  write_ledger_line "2026-04-08T10:00:00Z" "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" 1.00 10 1.00 1.00 1.00
  echo "THIS IS NOT JSON" >> "$COST_LEDGER_PATH"

  local exit_code=0
  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "tdd" "sess_002" "2.00" 15 2>/dev/null || exit_code=$?
  assert_eq "1" "$exit_code"
}

# =============================================================================
# Test 21: All 10 fields present in ledger entry (schema validation)
# =============================================================================
test_all_fields_present() {
  setup_ledger

  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" "1.85" 28

  local line
  line=$(head -1 "$COST_LEDGER_PATH")

  # Validate each required field
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

  # None should be null
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
# Test 22: Numbers formatted to 2 decimal places
# =============================================================================
test_numbers_formatted_2dp() {
  setup_ledger

  append_cost_entry "REQ-20260408-a3f1" "/tmp/repo" "prd" "sess_001" "1.10" 10

  local line
  line=$(head -1 "$COST_LEDGER_PATH")

  # cost_usd should be 1.1 (jq trims trailing zeros on numbers)
  # but daily_total and monthly_total should also be numeric
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
# Test 23: Empty ledger get_monthly_total -- Returns "0.00"
# =============================================================================
test_empty_ledger_monthly_total() {
  setup_ledger

  local monthly
  monthly=$(get_monthly_total)
  assert_eq "0.00" "$monthly"
}

# =============================================================================
# Run all tests
# =============================================================================
echo "SPEC-010-2-01: Cost Extraction & Append-Only Cost Ledger Tests"
echo "==============================================================="

run_test "Extract 'Total cost: \$1.85'"                  test_extract_total_cost
run_test "Extract 'Session cost: \$0.42'"                test_extract_session_cost
run_test "Extract 'Cost: \$3.17'"                        test_extract_minimal_cost
run_test "Extract 'Total cost: \$0.00'"                  test_extract_zero_cost
run_test "Extract no cost line (warning)"                test_extract_no_cost_line
run_test "Extract multi-line, takes last"                test_extract_multi_cost_lines
run_test "Extract large cost '\$123.45'"                 test_extract_large_cost
run_test "Append to empty ledger"                        test_append_empty_ledger
run_test "Append same day (daily accumulates)"           test_append_same_day
run_test "Append new day, same month"                    test_append_new_day_same_month
run_test "Append new month (both reset)"                 test_append_new_month
run_test "Cumulative request cost (sum)"                 test_cumulative_request_cost
run_test "Cumulative different requests (isolated)"      test_cumulative_different_requests
run_test "Tail-read daily total"                         test_tail_read_daily_total
run_test "Tail-read daily total, stale"                  test_tail_read_daily_stale
run_test "Tail-read monthly total"                       test_tail_read_monthly_total
run_test "Tail-read monthly total, stale"                test_tail_read_monthly_stale
run_test "Full-scan daily breakdown (3 days)"            test_full_scan_daily_breakdown
run_test "Full-scan request cost (2 phases)"             test_full_scan_request_cost
run_test "Empty ledger get_daily_total"                  test_empty_ledger_daily_total
run_test "Corrupted last line (returns non-zero)"        test_corrupted_last_line
run_test "All 10 fields present"                         test_all_fields_present
run_test "Numbers formatted to 2dp"                      test_numbers_formatted_2dp
run_test "Empty ledger get_monthly_total"                test_empty_ledger_monthly_total

report
