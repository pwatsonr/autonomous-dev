#!/usr/bin/env bash
# test_ledger_rotation.sh -- Unit tests for cost ledger rotation and pruning
# Part of SPEC-010-4-05: Unit and Integration Tests for Cleanup and Retention
#
# Tests: rotate_cost_ledger(), prune_cost_ledger_archives()
#
# Test count: 10
#
# Requires: jq (1.6+), bash 4+
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source shared test harness
source "${PROJECT_ROOT}/tests/test_harness.sh"

# Source the modules under test
source "${PROJECT_ROOT}/lib/cleanup_engine.sh"
source "${PROJECT_ROOT}/lib/ledger_rotation.sh"

# =============================================================================
# Override assert_eq to accept a label as the first arg (spec convention)
# Signature: assert_eq "label" "expected" "actual"
# =============================================================================
assert_eq() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" == "$actual" ]]; then return 0; fi
  echo "  ASSERT_EQ FAILED [${label}]: expected='${expected}' actual='${actual}'" >&2
  return 1
}

# =============================================================================
# Test Setup / Teardown
# =============================================================================
setup() {
  TEST_DIR=$(mktemp -d)
  _TEST_DIR="$TEST_DIR"
  export HOME="${TEST_DIR}/home"
  mkdir -p "${HOME}/.autonomous-dev"
  export COST_LEDGER_PATH="${HOME}/.autonomous-dev/cost-ledger.jsonl"
  export PLUGIN_ROOT="$PROJECT_ROOT"
}

# =============================================================================
# Utility: backdate files cross-platform
# =============================================================================
backdate_file() {
  local file="$1"
  local days_ago="$2"
  if [[ "$(uname)" == "Darwin" ]]; then
    local ts
    ts=$(date -u -v "-${days_ago}d" +"%Y%m%d%H%M.%S")
    touch -t "$ts" "$file"
  else
    touch -d "-${days_ago} days" "$file"
  fi
}

# =============================================================================
# Utility: Generate ledger entries
# =============================================================================
current_month() {
  date -u +"%Y-%m"
}

# month_offset -- Returns YYYY-MM for N months ago
month_offset() {
  local months_ago="$1"
  if [[ "$(uname)" == "Darwin" ]]; then
    date -u -v "-${months_ago}m" +"%Y-%m"
  else
    date -u -d "-${months_ago} months" +"%Y-%m"
  fi
}

create_ledger_entry() {
  local month="$1"
  local amount="${2:-1.50}"
  local day="${3:-15}"
  echo "{\"timestamp\":\"${month}-${day}T12:00:00Z\",\"request_id\":\"REQ-test\",\"cost_usd\":${amount},\"daily_total_usd\":${amount},\"monthly_total_usd\":${amount}}"
}

# =============================================================================
# Test 1: rotation_splits_by_month
# Ledger has March and April entries. After rotation, cost-ledger-2026-03.jsonl
# has March entries, active ledger has April only.
# =============================================================================
test_rotation_splits_by_month() {
  local ledger="${HOME}/.autonomous-dev/cost-ledger.jsonl"
  local cur_month
  cur_month=$(current_month)
  local prev_month
  prev_month=$(month_offset 1)

  create_ledger_entry "$prev_month" "3.00" > "$ledger"
  create_ledger_entry "$prev_month" "2.00" "20" >> "$ledger"
  create_ledger_entry "$cur_month" "5.00" >> "$ledger"

  rotate_cost_ledger

  local archive="${HOME}/.autonomous-dev/cost-ledger-${prev_month}.jsonl"

  # Archive should exist with 2 entries
  assert_eq "archive_exists" "true" "$(test -f "$archive" && echo true || echo false)"
  local archive_count
  archive_count=$(wc -l < "$archive" | tr -d ' ')
  assert_eq "archive_has_2_entries" "2" "$archive_count"

  # Active ledger should have only 1 entry (current month)
  local active_count
  active_count=$(wc -l < "$ledger" | tr -d ' ')
  assert_eq "active_has_1_entry" "1" "$active_count"

  # Verify active entry is from current month
  local active_month
  active_month=$(jq -r '.timestamp[:7]' "$ledger" | head -1)
  assert_eq "active_is_current_month" "$cur_month" "$active_month"
}

# =============================================================================
# Test 2: rotation_idempotent
# Rotate twice. Archive not duplicated. Active ledger unchanged.
# =============================================================================
test_rotation_idempotent() {
  local ledger="${HOME}/.autonomous-dev/cost-ledger.jsonl"
  local cur_month
  cur_month=$(current_month)
  local prev_month
  prev_month=$(month_offset 1)

  create_ledger_entry "$prev_month" "3.00" > "$ledger"
  create_ledger_entry "$cur_month" "5.00" >> "$ledger"

  # First rotation
  rotate_cost_ledger

  local archive="${HOME}/.autonomous-dev/cost-ledger-${prev_month}.jsonl"
  local first_count
  first_count=$(wc -l < "$archive" | tr -d ' ')

  # Second rotation -- should be a no-op
  rotate_cost_ledger

  local second_count
  second_count=$(wc -l < "$archive" | tr -d ' ')
  assert_eq "idempotent_archive_count" "$first_count" "$second_count"

  # Active ledger unchanged after second rotation
  local active_count
  active_count=$(wc -l < "$ledger" | tr -d ' ')
  assert_eq "idempotent_active_count" "1" "$active_count"
}

# =============================================================================
# Test 3: rotation_empty_ledger
# No-op, no error.
# =============================================================================
test_rotation_empty_ledger() {
  # Case 1: file does not exist
  local exit_code=0
  rotate_cost_ledger || exit_code=$?
  assert_eq "empty_ledger_no_file" "0" "$exit_code"

  # Case 2: file exists but is empty
  touch "${HOME}/.autonomous-dev/cost-ledger.jsonl"
  exit_code=0
  rotate_cost_ledger || exit_code=$?
  assert_eq "empty_ledger_empty_file" "0" "$exit_code"
}

# =============================================================================
# Test 4: rotation_all_current_month
# Only April entries. No rotation needed.
# =============================================================================
test_rotation_all_current_month() {
  local ledger="${HOME}/.autonomous-dev/cost-ledger.jsonl"
  local cur_month
  cur_month=$(current_month)

  create_ledger_entry "$cur_month" "3.00" > "$ledger"
  create_ledger_entry "$cur_month" "2.00" "20" >> "$ledger"

  rotate_cost_ledger

  # No archive files should be created
  local archive_count
  archive_count=$(ls "${HOME}/.autonomous-dev"/cost-ledger-[0-9]*.jsonl 2>/dev/null | wc -l | tr -d ' ')
  assert_eq "all_current_no_archives" "0" "$archive_count"

  # Active ledger unchanged
  local active_count
  active_count=$(wc -l < "$ledger" | tr -d ' ')
  assert_eq "all_current_preserved" "2" "$active_count"
}

# =============================================================================
# Test 5: rotation_multi_month
# Jan, Feb, Mar, Apr. Three archive files created.
# =============================================================================
test_rotation_multi_month() {
  local ledger="${HOME}/.autonomous-dev/cost-ledger.jsonl"
  local cur_month
  cur_month=$(current_month)
  local month1 month2 month3
  month1=$(month_offset 3)
  month2=$(month_offset 2)
  month3=$(month_offset 1)

  create_ledger_entry "$month1" "1.00" > "$ledger"
  create_ledger_entry "$month2" "2.00" >> "$ledger"
  create_ledger_entry "$month3" "3.00" >> "$ledger"
  create_ledger_entry "$cur_month" "4.00" >> "$ledger"

  rotate_cost_ledger

  # Three archive files should be created
  assert_eq "multi_archive_1" "true" "$(test -f "${HOME}/.autonomous-dev/cost-ledger-${month1}.jsonl" && echo true || echo false)"
  assert_eq "multi_archive_2" "true" "$(test -f "${HOME}/.autonomous-dev/cost-ledger-${month2}.jsonl" && echo true || echo false)"
  assert_eq "multi_archive_3" "true" "$(test -f "${HOME}/.autonomous-dev/cost-ledger-${month3}.jsonl" && echo true || echo false)"

  # Active ledger should only have current month
  local active_count
  active_count=$(wc -l < "$ledger" | tr -d ' ')
  assert_eq "multi_active_count" "1" "$active_count"
}

# =============================================================================
# Test 6: rotation_preserves_format
# Each line in archive is valid JSONL.
# =============================================================================
test_rotation_preserves_format() {
  local ledger="${HOME}/.autonomous-dev/cost-ledger.jsonl"
  local cur_month
  cur_month=$(current_month)
  local prev_month
  prev_month=$(month_offset 1)

  create_ledger_entry "$prev_month" "3.00" > "$ledger"
  create_ledger_entry "$prev_month" "2.50" "20" >> "$ledger"
  create_ledger_entry "$cur_month" "5.00" >> "$ledger"

  rotate_cost_ledger

  local archive="${HOME}/.autonomous-dev/cost-ledger-${prev_month}.jsonl"

  # Validate each line is valid JSON
  local invalid=0
  while IFS= read -r line; do
    if ! echo "$line" | jq . >/dev/null 2>&1; then
      ((invalid++))
    fi
  done < "$archive"

  assert_eq "preserves_format" "0" "$invalid"
}

# =============================================================================
# Test 7: archive_pruning_expired
# cost-ledger-2025-01.jsonl is 15 months old. Retention 12. Deleted.
# =============================================================================
test_archive_pruning_expired() {
  local old_month
  old_month=$(month_offset 15)
  local archive="${HOME}/.autonomous-dev/cost-ledger-${old_month}.jsonl"
  create_ledger_entry "$old_month" "1.00" > "$archive"

  local config
  config=$(jq -nc '{retention: {cost_ledger_months: 12}}')
  prune_cost_ledger_archives "$config"

  assert_eq "archive_pruning_expired" "false" "$(test -f "$archive" && echo true || echo false)"
}

# =============================================================================
# Test 8: archive_pruning_within_retention
# cost-ledger is 10 months old. Retention 12. Preserved.
# =============================================================================
test_archive_pruning_within_retention() {
  local recent_month
  recent_month=$(month_offset 10)
  local archive="${HOME}/.autonomous-dev/cost-ledger-${recent_month}.jsonl"
  create_ledger_entry "$recent_month" "2.00" > "$archive"

  local config
  config=$(jq -nc '{retention: {cost_ledger_months: 12}}')
  prune_cost_ledger_archives "$config"

  assert_eq "archive_pruning_within_retention" "true" "$(test -f "$archive" && echo true || echo false)"
}

# =============================================================================
# Test 9: archive_pruning_no_archives
# No archive files exist. No-op.
# =============================================================================
test_archive_pruning_no_archives() {
  local config
  config=$(jq -nc '{retention: {cost_ledger_months: 12}}')
  local exit_code=0
  prune_cost_ledger_archives "$config" || exit_code=$?
  assert_eq "archive_pruning_no_archives" "0" "$exit_code"
}

# =============================================================================
# Test 10: archive_filename_parsing
# Correctly extracts YYYY-MM from cost-ledger-YYYY-MM.jsonl.
# =============================================================================
test_archive_filename_parsing() {
  # Create archives with specific names and verify only the expired one is deleted
  local old_month
  old_month=$(month_offset 15)
  local recent_month
  recent_month=$(month_offset 6)

  local old_archive="${HOME}/.autonomous-dev/cost-ledger-${old_month}.jsonl"
  local recent_archive="${HOME}/.autonomous-dev/cost-ledger-${recent_month}.jsonl"
  create_ledger_entry "$old_month" "1.00" > "$old_archive"
  create_ledger_entry "$recent_month" "2.00" > "$recent_archive"

  local config
  config=$(jq -nc '{retention: {cost_ledger_months: 12}}')
  prune_cost_ledger_archives "$config"

  # Old should be deleted, recent preserved
  assert_eq "filename_parsing_old_deleted" "false" "$(test -f "$old_archive" && echo true || echo false)"
  assert_eq "filename_parsing_recent_kept" "true" "$(test -f "$recent_archive" && echo true || echo false)"
}

# =============================================================================
# Run all tests
# =============================================================================
run_test "rotation_splits_by_month" test_rotation_splits_by_month
run_test "rotation_idempotent" test_rotation_idempotent
run_test "rotation_empty_ledger" test_rotation_empty_ledger
run_test "rotation_all_current_month" test_rotation_all_current_month
run_test "rotation_multi_month" test_rotation_multi_month
run_test "rotation_preserves_format" test_rotation_preserves_format
run_test "archive_pruning_expired" test_archive_pruning_expired
run_test "archive_pruning_within_retention" test_archive_pruning_within_retention
run_test "archive_pruning_no_archives" test_archive_pruning_no_archives
run_test "archive_filename_parsing" test_archive_filename_parsing

report
