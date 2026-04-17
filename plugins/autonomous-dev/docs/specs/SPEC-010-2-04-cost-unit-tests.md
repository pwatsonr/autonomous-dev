# SPEC-010-2-04: Unit Tests for Cost Extraction, Ledger, and Budget Enforcement

## Metadata
- **Parent Plan**: PLAN-010-2
- **Tasks Covered**: Task 10, Task 11, Task 12
- **Estimated effort**: 10 hours

## Description

Build unit test suites for cost extraction regex, ledger operations, and budget enforcement logic, plus the cost-related test fixtures.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Create | `test/unit/test_cost_extractor.sh` | Cost extraction regex tests |
| Create | `test/unit/test_cost_ledger.sh` | Ledger append, aggregation, error handling tests |
| Create | `test/unit/test_cost_governor.sh` | Budget check and enforcement tests |
| Create | `test/fixtures/cost-ledger-sample.jsonl` | Multi-day/month ledger fixture |
| Create | `test/fixtures/claude-output-with-cost.txt` | Realistic session output with cost |
| Create | `test/fixtures/claude-output-crashed.txt` | Session output with no cost line |

## Implementation Details

### test/unit/test_cost_extractor.sh

```bash
test_extract_total_cost() {
  local output="Some output text\nTotal cost: \$1.85\nSession ended."
  local result
  result=$(extract_session_cost "$output")
  assert_eq "extract Total cost" "1.85" "$result"
}

test_extract_session_cost() {
  local output="Session cost: \$0.42"
  local result
  result=$(extract_session_cost "$output")
  assert_eq "extract Session cost" "0.42" "$result"
}

test_extract_cost_minimal() {
  local output="Cost: \$3.17"
  local result
  result=$(extract_session_cost "$output")
  assert_eq "extract Cost:" "3.17" "$result"
}

test_extract_zero_cost() {
  local output="Total cost: \$0.00"
  local result
  result=$(extract_session_cost "$output")
  assert_eq "extract zero cost" "0.00" "$result"
}

test_extract_no_cost_line() {
  local output="Session crashed\nNo cost information"
  local result
  result=$(extract_session_cost "$output" 2>/dev/null)
  assert_eq "no cost returns 0.00" "0.00" "$result"
}

test_extract_multi_cost_lines() {
  local output="Cost: \$1.00\nSome middle text\nTotal cost: \$2.50"
  local result
  result=$(extract_session_cost "$output")
  assert_eq "takes last cost line" "2.50" "$result"
}

test_extract_large_cost() {
  local output="Total cost: \$123.45"
  local result
  result=$(extract_session_cost "$output")
  assert_eq "large cost" "123.45" "$result"
}

test_extract_embedded_in_long_output() {
  # Simulate realistic Claude Code output (many lines, cost near end)
  local output
  output=$(cat "$PROJECT_ROOT/test/fixtures/claude-output-with-cost.txt")
  local result
  result=$(extract_session_cost "$output")
  assert_eq "realistic output extraction" "1.85" "$result"
}

test_extract_crashed_output() {
  local output
  output=$(cat "$PROJECT_ROOT/test/fixtures/claude-output-crashed.txt")
  local result
  result=$(extract_session_cost "$output" 2>/dev/null)
  assert_eq "crashed output returns 0.00" "0.00" "$result"
}
```

### test/unit/test_cost_ledger.sh

Tests use a temporary ledger file in `$TEST_DIR`:

```bash
setup() {
  TEST_DIR=$(mktemp -d)
  export COST_LEDGER_PATH="${TEST_DIR}/cost-ledger.jsonl"
}

teardown() {
  rm -rf "$TEST_DIR"
}
```

**Test cases**:

1. **append_to_empty_ledger**: First append creates the file. One line. `daily_total_usd` = cost.
2. **append_same_day**: Two appends. Second entry's `daily_total_usd` = sum of both.
3. **append_new_day_same_month**: Set last entry to yesterday. New append resets daily, increments monthly.
4. **append_new_month**: Set last entry to previous month. Both totals reset.
5. **cumulative_request_cost_same_request**: Two entries for REQ-A. Second has cumulative = sum.
6. **cumulative_request_cost_different_requests**: Entry for REQ-B after REQ-A. REQ-B's cumulative is its own cost only.
7. **get_daily_total_same_day**: Returns correct value from tail-read.
8. **get_daily_total_stale**: Last entry is yesterday. Returns 0.00.
9. **get_monthly_total_same_month**: Returns correct value.
10. **get_monthly_total_stale**: Last entry is previous month. Returns 0.00.
11. **get_daily_total_empty_ledger**: Returns 0.00.
12. **daily_breakdown**: Ledger with 3 days of entries. Breakdown returns 3 groups.
13. **request_cost**: Ledger with entries for multiple requests. Request-specific query correct.
14. **corrupted_last_line_detection**: Write invalid JSON as last line. `validate_ledger_integrity` returns 1.
15. **entry_format_validation**: Each appended line has all 10 required fields.
16. **numbers_formatted_2dp**: `cost_usd`, `daily_total_usd`, `monthly_total_usd` all have 2 decimal places.

### test/unit/test_cost_governor.sh

Tests mock the ledger functions and config:

```bash
setup() {
  TEST_DIR=$(mktemp -d)
  export COST_LEDGER_PATH="${TEST_DIR}/cost-ledger.jsonl"
  # Create a mock effective config
  MOCK_CONFIG='{"governance":{"daily_cost_cap_usd":100,"monthly_cost_cap_usd":2000,"per_request_cost_cap_usd":50},"repositories":{"allowlist":[]}}'
}
```

**Test cases**:

1. **all_below_caps**: daily=50, monthly=500, request=25. `check_budgets` returns 0 (pass).
2. **per_request_exceeded**: request=55. Returns 1, blocked_by=per_request, scope=request.
3. **daily_exceeded**: daily=105. Returns 1, blocked_by=daily, scope=all.
4. **monthly_exceeded**: monthly=2100. Returns 1, blocked_by=monthly, scope=all.
5. **daily_at_exactly_cap**: daily=100.00. Returns 1 (>= is exceeded, not just >).
6. **monthly_takes_precedence**: Both daily and monthly exceeded. blocked_by=monthly.
7. **post_session_per_request_pause**: Simulate per-request cap hit. Verify only that request is paused.
8. **post_session_daily_pause**: Simulate daily cap hit. Verify all active requests are paused.
9. **escalation_payload_daily**: Verify payload has correct cap_type, values, recommendation.
10. **escalation_payload_per_request**: Verify affected_requests has only one entry.
11. **escalation_payload_monthly**: Verify recommendation mentions "next month".
12. **budget_check_reads_config**: Change config cap. Verify check uses new cap.

### Test Fixture Files

**`test/fixtures/cost-ledger-sample.jsonl`**:

```jsonl
{"timestamp":"2026-03-28T10:00:00Z","request_id":"REQ-20260328-a1b2","repository":"/Users/pwatson/codebase/api-service","phase":"prd","session_id":"sess_001","cost_usd":2.50,"turns_used":30,"cumulative_request_cost_usd":2.50,"daily_total_usd":2.50,"monthly_total_usd":850.00}
{"timestamp":"2026-03-28T14:30:00Z","request_id":"REQ-20260328-a1b2","repository":"/Users/pwatson/codebase/api-service","phase":"tdd","session_id":"sess_002","cost_usd":3.10,"turns_used":42,"cumulative_request_cost_usd":5.60,"daily_total_usd":5.60,"monthly_total_usd":853.10}
{"timestamp":"2026-03-29T09:00:00Z","request_id":"REQ-20260328-a1b2","repository":"/Users/pwatson/codebase/api-service","phase":"code","session_id":"sess_003","cost_usd":8.20,"turns_used":95,"cumulative_request_cost_usd":13.80,"daily_total_usd":8.20,"monthly_total_usd":861.30}
{"timestamp":"2026-04-01T08:00:00Z","request_id":"REQ-20260401-c3d4","repository":"/Users/pwatson/codebase/dashboard-app","phase":"prd","session_id":"sess_004","cost_usd":1.85,"turns_used":28,"cumulative_request_cost_usd":1.85,"daily_total_usd":1.85,"monthly_total_usd":1.85}
{"timestamp":"2026-04-01T11:00:00Z","request_id":"REQ-20260401-c3d4","repository":"/Users/pwatson/codebase/dashboard-app","phase":"tdd","session_id":"sess_005","cost_usd":2.40,"turns_used":33,"cumulative_request_cost_usd":4.25,"daily_total_usd":4.25,"monthly_total_usd":4.25}
{"timestamp":"2026-04-02T09:30:00Z","request_id":"REQ-20260402-e5f6","repository":"/Users/pwatson/codebase/api-service","phase":"prd","session_id":"sess_006","cost_usd":1.50,"turns_used":22,"cumulative_request_cost_usd":1.50,"daily_total_usd":1.50,"monthly_total_usd":5.75}
{"timestamp":"2026-04-08T10:05:30Z","request_id":"REQ-20260408-a3f1","repository":"/Users/pwatson/codebase/dashboard-app","phase":"prd","session_id":"sess_007","cost_usd":1.85,"turns_used":28,"cumulative_request_cost_usd":1.85,"daily_total_usd":1.85,"monthly_total_usd":7.60}
{"timestamp":"2026-04-08T11:30:00Z","request_id":"REQ-20260408-a3f1","repository":"/Users/pwatson/codebase/dashboard-app","phase":"tdd","session_id":"sess_008","cost_usd":2.10,"turns_used":35,"cumulative_request_cost_usd":3.95,"daily_total_usd":3.95,"monthly_total_usd":9.70}
```

**`test/fixtures/claude-output-with-cost.txt`**:

```
╭──────────────────────────────────────────╮
│ Session: sess_def456                     │
│ Request: REQ-20260408-a3f1               │
╰──────────────────────────────────────────╯

> Analyzing repository structure...
> Reading existing documentation...
> Generating PRD for dashboard-app redesign...

I've created the PRD for the dashboard-app redesign. The document covers:

1. Executive Summary
2. Problem Statement  
3. User Stories (12 stories across 3 personas)
4. Functional Requirements (FR-001 through FR-045)
5. Non-Functional Requirements
6. Success Metrics

The PRD has been written to docs/prd/PRD-042-dashboard-redesign.md

╭──────────────────────────────────────────╮
│ Session Summary                          │
│ Duration: 8m 23s                         │
│ Turns: 28                                │
│ Total cost: $1.85                        │
╰──────────────────────────────────────────╯
```

**`test/fixtures/claude-output-crashed.txt`**:

```
╭──────────────────────────────────────────╮
│ Session: sess_crash01                    │
│ Request: REQ-20260408-x9y8              │
╰──────────────────────────────────────────╯

> Analyzing repository structure...
> Reading existing documentation...
> Starting TDD generation...

Error: Connection reset by peer
Traceback (most recent call last):
  Process exited with code 137 (SIGKILL)
```

## Acceptance Criteria

1. `test_cost_extractor.sh` has at least 9 test cases covering all extraction patterns.
2. `test_cost_ledger.sh` has at least 16 test cases covering append, aggregation, boundaries, and errors.
3. `test_cost_governor.sh` has at least 12 test cases covering all cap levels and enforcement actions.
4. Each test is independent (no shared state between tests).
5. `cost-ledger-sample.jsonl` spans March and April 2026 with multiple requests and repos.
6. `claude-output-with-cost.txt` contains realistic session output with `Total cost: $1.85`.
7. `claude-output-crashed.txt` contains session output with no cost line.
8. All fixtures are used by the test suites (no orphan fixtures).

## Test Cases

All test cases are enumerated in the Implementation Details section above:
- 9 cost extractor tests
- 16 cost ledger tests
- 12 cost governor tests
- Total: 37 test cases
