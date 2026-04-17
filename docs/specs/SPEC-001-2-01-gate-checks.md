# SPEC-001-2-01: Kill Switch and Cost Cap Gate Checks

## Metadata
- **Parent Plan**: PLAN-001-2
- **Tasks Covered**: Task 1 (Kill switch gate check), Task 2 (Cost cap gate check)
- **Estimated effort**: 2.5 hours

## Description
Replace the Plan 1 stub `check_gates()` with real gate checks: a kill switch based on file existence, and a cost cap that reads the cost ledger and compares daily/monthly spend against configured limits. These gates run at the top of every loop iteration and block work selection when engaged.

## Files to Create/Modify

- **Path**: `bin/supervisor-loop.sh`
  - **Action**: Modify
  - **Description**: Replace the `check_gates()` stub with real implementation. Add `check_cost_caps()` function.

- **Path**: `config/defaults.json`
  - **Action**: Modify
  - **Description**: Ensure `daemon.daily_cost_cap_usd` and `daemon.monthly_cost_cap_usd` fields exist (they should already be present from SPEC-001-1-04; verify and add if missing).

## Implementation Details

### Task 1: Kill Switch Gate Check

#### Updated `check_gates() -> int`

Replace the stub with:

```bash
check_gates() {
    # Kill switch: file existence check
    if [[ -f "${KILL_SWITCH_FILE}" ]]; then
        log_warn "Kill switch is engaged. Skipping iteration."
        return 1
    fi

    # Circuit breaker (stub until Plan 3)
    if [[ "${CIRCUIT_BREAKER_TRIPPED}" == "true" ]]; then
        log_warn "Circuit breaker is tripped. Skipping iteration."
        return 1
    fi

    # Cost cap check
    if ! check_cost_caps; then
        return 1
    fi

    return 0
}
```

- **Kill switch behavior**:
  - Check `[[ -f "${KILL_SWITCH_FILE}" ]]` only. Do NOT read file contents (existence is the only signal).
  - The file path is `$KILL_SWITCH_FILE` (`~/.autonomous-dev/kill-switch.flag`).
  - When present: log a WARN-level message, return 1.
  - When absent: proceed to next gate check.

- **Circuit breaker**: Keep the existing check on `$CIRCUIT_BREAKER_TRIPPED`. Plan 3 populates this variable with real logic. For now, the variable is always `false` (set by the `load_crash_state` stub).

### Task 2: Cost Cap Gate Check

#### `check_cost_caps() -> int`

- **Returns**: 0 if under all caps (or no ledger exists), 1 if any cap exceeded or ledger is corrupt.
- **Algorithm**:
  1. If `$COST_LEDGER_FILE` does not exist:
     - Return 0 (no spend recorded, under cap by definition).
  2. Validate the ledger is parseable JSON:
     ```bash
     if ! jq empty "${COST_LEDGER_FILE}" 2>/dev/null; then
         log_error "Cost ledger is corrupt. Refusing to process work."
         return 1
     fi
     ```
  3. Compute today's date key: `local today; today=$(date -u +"%Y-%m-%d")`.
  4. Read today's spend:
     ```bash
     local daily_spend
     daily_spend=$(jq -r ".daily[\"${today}\"].total_usd // 0" "${COST_LEDGER_FILE}")
     ```
  5. Compute current month key: `local month; month=$(date -u +"%Y-%m")`.
  6. Read this month's spend (sum all daily entries for the current month):
     ```bash
     local monthly_spend
     monthly_spend=$(jq -r "[.daily | to_entries[] | select(.key | startswith(\"${month}\")) | .value.total_usd] | add // 0" "${COST_LEDGER_FILE}")
     ```
  7. Compare against caps (using `bc` for floating-point comparison, or `awk`):
     ```bash
     if awk "BEGIN {exit !(${daily_spend} >= ${DAILY_COST_CAP})}"; then
         log_warn "Daily cost cap reached: \$${daily_spend} >= \$${DAILY_COST_CAP}"
         return 1
     fi
     if awk "BEGIN {exit !(${monthly_spend} >= ${MONTHLY_COST_CAP})}"; then
         log_warn "Monthly cost cap reached: \$${monthly_spend} >= \$${MONTHLY_COST_CAP}"
         return 1
     fi
     ```
  8. Return 0 (under caps).

- **Safe default**: If the ledger cannot be parsed, the gate FAILS (returns 1). This prevents runaway spending if the ledger is corrupt. This aligns with TDD Section 7.4 safe defaults.

### Cost Ledger JSON Schema (for reference)

The ledger is created and updated by SPEC-001-2-04. For the purposes of this spec, `check_cost_caps()` reads the following structure:

```json
{
  "daily": {
    "2026-04-08": {
      "total_usd": 12.50,
      "sessions": [
        {
          "request_id": "REQ-xxx",
          "cost_usd": 5.00,
          "timestamp": "2026-04-08T14:30:00Z"
        }
      ]
    }
  }
}
```

### Edge Cases
- Daily cap is 0.00: Every non-zero spend exceeds the cap. This is a valid configuration for "no autonomous spend allowed."
- Monthly cap is less than daily cap: Unusual but valid. Monthly check will trigger first.
- Ledger has entries from previous months only: Monthly sum for the current month is 0.
- `awk` not available: Extremely unlikely (POSIX standard). No fallback needed.
- Floating-point precision: Use `awk` for comparison (handles decimals correctly). Do NOT use bash integer arithmetic for dollar amounts.

## Acceptance Criteria
1. [ ] With `kill-switch.flag` present, `check_gates()` returns 1 and log contains "Kill switch is engaged"
2. [ ] Without the kill switch file, `check_gates()` proceeds to other checks
3. [ ] Kill switch check does NOT read file contents (existence only)
4. [ ] With a cost ledger showing $49 today and a $50 daily cap, `check_cost_caps()` returns 0 (under cap)
5. [ ] With a cost ledger showing $51 today and a $50 daily cap, `check_cost_caps()` returns 1 and log contains "Daily cost cap reached"
6. [ ] With a cost ledger showing $499 this month and a $500 monthly cap, `check_cost_caps()` returns 0
7. [ ] With a cost ledger showing $501 this month and a $500 monthly cap, `check_cost_caps()` returns 1 and log contains "Monthly cost cap reached"
8. [ ] With no cost ledger file, `check_cost_caps()` returns 0 (assumes zero spend)
9. [ ] With a corrupt (non-JSON) cost ledger, `check_cost_caps()` returns 1 (safe default)
10. [ ] `check_gates()` checks kill switch, then circuit breaker, then cost caps in that order
11. [ ] No shellcheck warnings at `--severity=warning` level

## Test Cases
1. **test_kill_switch_engaged** -- Create `$KILL_SWITCH_FILE`. Call `check_gates`. Assert return 1. Assert log contains "Kill switch is engaged".
2. **test_kill_switch_not_engaged** -- Ensure `$KILL_SWITCH_FILE` does not exist. Call `check_gates`. Assert return 0 (all other gates also pass).
3. **test_kill_switch_file_not_read** -- Create `$KILL_SWITCH_FILE` with content "some reason". Call `check_gates`. Assert it returns 1 without attempting to read contents (verify by making file unreadable with `chmod 000` -- gate still triggers on existence via `-f` which checks file type, not readability).
4. **test_cost_cap_under_daily** -- Create a ledger with today's spend at $49. Set `DAILY_COST_CAP=50`. Call `check_cost_caps`. Assert return 0.
5. **test_cost_cap_over_daily** -- Create a ledger with today's spend at $51. Set `DAILY_COST_CAP=50`. Call `check_cost_caps`. Assert return 1. Assert log contains "Daily cost cap reached".
6. **test_cost_cap_under_monthly** -- Create a ledger with multiple days in the current month totaling $450. Set `MONTHLY_COST_CAP=500`. Call `check_cost_caps`. Assert return 0.
7. **test_cost_cap_over_monthly** -- Create a ledger totaling $510 this month. Set `MONTHLY_COST_CAP=500`. Call `check_cost_caps`. Assert return 1.
8. **test_cost_cap_no_ledger** -- Ensure no ledger file exists. Call `check_cost_caps`. Assert return 0.
9. **test_cost_cap_corrupt_ledger** -- Write "not json" to the ledger file. Call `check_cost_caps`. Assert return 1. Assert log contains "corrupt".
10. **test_cost_cap_empty_ledger** -- Write `{}` to the ledger file. Call `check_cost_caps`. Assert return 0 (no daily entries, zero spend).
11. **test_circuit_breaker_gate** -- Set `CIRCUIT_BREAKER_TRIPPED=true`. Call `check_gates`. Assert return 1. Assert log contains "Circuit breaker is tripped".
