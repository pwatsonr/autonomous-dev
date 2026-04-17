# SPEC-010-1-04: Unit Tests for Config Loading, Merge, and Validation

## Metadata
- **Parent Plan**: PLAN-010-1
- **Tasks Covered**: Task 9, Task 10, Task 11
- **Estimated effort**: 12 hours

## Description

Build the full unit test suites for configuration loading/merge logic and all 20 validation rules, plus the test fixtures required by TDD-010 Section 7.4.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Create | `test/unit/test_config_loader.sh` | Tests for deep merge, layer loading, CLI overrides |
| Create | `test/unit/test_config_validator.sh` | 40+ tests covering all 20 validation rules |
| Create | `test/fixtures/config-valid-full.json` | Every field set to a non-default valid value |
| Create | `test/fixtures/config-valid-minimal.json` | Empty object `{}` -- all defaults |
| Create | `test/fixtures/config-invalid-v001.json` through `config-invalid-v020.json` | One invalid field per file per rule |

## Implementation Details

### Test Runner Convention

All test files use a lightweight bash test harness pattern:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

source "$PROJECT_ROOT/lib/config_loader.sh"

PASS=0
FAIL=0

assert_eq() {
  local description="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $description"
    ((PASS++))
  else
    echo "  FAIL: $description"
    echo "    Expected: $expected"
    echo "    Actual:   $actual"
    ((FAIL++))
  fi
}

assert_exit_code() {
  local description="$1" expected_code="$2"
  shift 2
  local actual_code=0
  "$@" >/dev/null 2>&1 || actual_code=$?
  assert_eq "$description" "$expected_code" "$actual_code"
}

# ... test cases ...

echo ""
echo "Results: $PASS passed, $FAIL failed"
exit $((FAIL > 0 ? 1 : 0))
```

### test/unit/test_config_loader.sh

**Test cases** (minimum 12):

1. **merge_two_objects_overlapping_keys**: `{"a":1,"b":2}` merged with `{"b":3,"c":4}` produces `{"a":1,"b":3,"c":4}`.
2. **merge_array_replacement**: `{"arr":[1,2]}` merged with `{"arr":[3]}` produces `{"arr":[3]}` (not `[1,2,3]`).
3. **merge_three_layers**: Defaults `{"a":1,"b":2,"c":3}`, global `{"b":20}`, project `{"c":30}` produces `{"a":1,"b":20,"c":30}`.
4. **merge_deep_nested**: `{"x":{"y":{"z":1}}}` merged with `{"x":{"y":{"w":2}}}` produces `{"x":{"y":{"z":1,"w":2}}}`.
5. **merge_overlay_replaces_nested_object_key**: `{"x":{"y":1}}` merged with `{"x":{"y":2}}` produces `{"x":{"y":2}}`.
6. **merge_with_empty_overlay**: `{"a":1}` merged with `{}` produces `{"a":1}`.
7. **merge_with_empty_base**: `{}` merged with `{"a":1}` produces `{"a":1}`.
8. **cli_override_number**: `parse_single_override "governance.daily_cost_cap_usd" "50"` produces `{"governance":{"daily_cost_cap_usd":50}}`.
9. **cli_override_float**: `parse_single_override "parallel.disk_warning_threshold_gb" "2.5"` produces the float `2.5`.
10. **cli_override_boolean_true**: `parse_single_override "trust.promotion.enabled" "true"` produces boolean `true`.
11. **cli_override_boolean_false**: `parse_single_override "trust.promotion.enabled" "false"` produces boolean `false`.
12. **cli_override_string**: `parse_single_override "escalation.routing.mode" "advanced"` produces string `"advanced"`.
13. **cli_override_deep_path**: `parse_single_override "daemon.max_turns_by_phase.code" "150"` produces `{"daemon":{"max_turns_by_phase":{"code":150}}}`.
14. **defaults_only_load**: No global or project file. `load_config` returns the full defaults. Spot-check 5 fields.
15. **missing_global_file**: Global path does not exist. Load succeeds. Warning logged to stderr.
16. **missing_project_file**: Project path does not exist. Load succeeds. Warning logged to stderr.

### test/unit/test_config_validator.sh

**Test cases** (minimum 40 -- 2 per rule + extras):

For each rule V-001 through V-020, there is a "positive" test (valid value passes) and a "negative" test (invalid value fails with the expected rule ID). The tests use the corresponding `config-invalid-vNNN.json` fixtures.

| Test # | Rule | Type | Description |
|--------|------|------|-------------|
| 1 | V-001 | positive | All numeric fields are numbers. Passes. |
| 2 | V-001 | negative | `governance.daily_cost_cap_usd` set to `"fifty"`. Fails V-001. |
| 3 | V-002 | positive | `daemon.poll_interval_seconds` is 30 (> 0). Passes. |
| 4 | V-002 | negative | `daemon.poll_interval_seconds` is 0. Fails V-002. |
| 5 | V-003 | positive | `daily=100`, `monthly=2000`. Passes. |
| 6 | V-003 | negative | `daily=150`, `monthly=100`. Fails V-003. |
| 7 | V-004 | positive | `per_request=50`, `daily=100`. Passes. |
| 8 | V-004 | negative | `per_request=200`, `daily=100`. Warns V-004 (but does not error). |
| 9 | V-005 | positive | Allowlist `["/absolute/path"]`. Passes. |
| 10 | V-005 | negative | Allowlist `["relative/path"]`. Fails V-005. |
| 11 | V-006 | positive | Allowlist path exists and has `.git`. Passes. |
| 12 | V-006 | negative | Allowlist path does not exist. Warns V-006. |
| 13 | V-007 | positive | `trust.system_default_level` is 2. Passes. |
| 14 | V-007 | negative | `trust.system_default_level` is 5. Fails V-007. |
| 15 | V-008 | positive | `daemon.circuit_breaker_threshold` is 3. Passes. |
| 16 | V-008 | negative | `daemon.circuit_breaker_threshold` is 0. Fails V-008. |
| 17 | V-009 | positive | DND start `22:00`, end `07:00`. Passes. |
| 18 | V-009 | negative | DND start `25:00`. Fails V-009. |
| 19 | V-010 | positive | Timezone `America/New_York`. Passes. |
| 20 | V-010 | negative | Timezone `Not/A_Zone`. Fails V-010. |
| 21 | V-011 | positive | `daemon.max_turns_by_phase.code` is 200. Passes. |
| 22 | V-011 | negative | `daemon.max_turns_by_phase.code` is 0. Fails V-011. |
| 23 | V-012 | positive | `state_machine.retry_limits_by_phase.prd` is 2. Passes. |
| 24 | V-012 | negative | `state_machine.retry_limits_by_phase.prd` is -1. Fails V-012. |
| 25 | V-013 | positive | `escalation.routing.mode` is `"default"`. Passes. |
| 26 | V-013 | negative | `escalation.routing.mode` is `"invalid"`. Fails V-013. |
| 27 | V-014 | positive | `parallel.max_worktrees` is 5. Passes. |
| 28 | V-014 | negative | `parallel.max_worktrees` is 0. Fails V-014. |
| 29 | V-015 | positive | `conflict_ai_confidence_threshold` is 0.85. Passes. |
| 30 | V-015 | negative | `conflict_ai_confidence_threshold` is 1.5. Fails V-015. |
| 31 | V-016 | positive | `default_method` is `"cli"`. Passes. |
| 32 | V-016 | negative | `default_method` is `"email"`. Fails V-016. |
| 33 | V-017 | positive | Config file is 0600 with webhooks. No warning. |
| 34 | V-017 | negative | Config file is 0644 with webhooks. Warns V-017. |
| 35 | V-018 | positive | `review_gates.thresholds_by_type.PRD` is 85. Passes. |
| 36 | V-018 | negative | `review_gates.thresholds_by_type.PRD` is 150. Fails V-018. |
| 37 | V-019 | positive | `backoff_max=900`, `backoff_base=30`. Passes. |
| 38 | V-019 | negative | `backoff_max=10`, `backoff_base=30`. Fails V-019. |
| 39 | V-020 | positive | `disk_hard=5.0`, `disk_warn=2.0`. Passes. |
| 40 | V-020 | negative | `disk_hard=1.0`, `disk_warn=2.0`. Fails V-020. |
| 41 | IMMUTABLE | negative | `trust.promotion.require_human_approval=false`. Fails. |
| 42 | IMMUTABLE | negative | `emergency.restart_requires_human=false`. Fails. |
| 43 | cross-field combo | negative | Config violates V-003 AND V-019 simultaneously. Both errors reported. |

### Test Fixture Files

**`test/fixtures/config-valid-full.json`**: Sets every field to a non-default but valid value. Examples:

```json
{
  "$schema_version": 1,
  "daemon": {
    "poll_interval_seconds": 60,
    "heartbeat_interval_seconds": 15,
    "circuit_breaker_threshold": 5,
    "log_retention_days": 14,
    "idle_backoff_base_seconds": 10,
    "idle_backoff_max_seconds": 600,
    "max_turns_by_phase": {
      "intake": 5, "prd": 40, "prd_review": 20, "tdd": 40,
      "tdd_review": 20, "plan": 40, "plan_review": 20, "spec": 40,
      "spec_review": 20, "code": 150, "code_review": 40,
      "integration": 80, "deploy": 20
    }
  },
  "governance": {
    "daily_cost_cap_usd": 200.00,
    "monthly_cost_cap_usd": 5000.00,
    "per_request_cost_cap_usd": 100.00,
    "max_concurrent_requests": 5,
    "disk_usage_limit_gb": 20.0,
    "rate_limit_backoff_base_seconds": 60,
    "rate_limit_backoff_max_seconds": 1800
  }
}
```

(All other sections follow the same pattern: non-default but valid values.)

**`test/fixtures/config-valid-minimal.json`**:

```json
{}
```

**`test/fixtures/config-invalid-v001.json`** (type violation):

```json
{
  "governance": {
    "daily_cost_cap_usd": "fifty"
  }
}
```

**`test/fixtures/config-invalid-v003.json`** (cross-field):

```json
{
  "governance": {
    "daily_cost_cap_usd": 150.00,
    "monthly_cost_cap_usd": 100.00
  }
}
```

One fixture file per rule (V-001 through V-020), each containing exactly one invalid field targeting the named rule. For V-002 through V-020, each fixture sets only the minimum fields needed to trigger that specific rule.

## Acceptance Criteria

1. `test_config_loader.sh` contains at least 16 test cases.
2. `test_config_validator.sh` contains at least 40 test cases (2 per rule minimum).
3. Each test is independent (no order dependencies).
4. Test runner reports pass/fail per case with a summary.
5. `config-valid-full.json` sets every field to a non-default but valid value and passes full validation.
6. `config-valid-minimal.json` is `{}` and passes full validation (all defaults apply).
7. Each `config-invalid-vNNN.json` contains exactly one invalid field targeting that specific rule.
8. All 20 rules are covered by both positive and negative tests.
9. Tests for immutable fields verify that `false` values are rejected.
10. Test for multiple simultaneous violations confirms all errors are reported.

## Test Cases

All test cases are listed in the Implementation Details tables above. The key meta-tests:

1. **Full fixture passes**: Load `config-valid-full.json` as project config over defaults. Validation passes with zero errors.
2. **Minimal fixture passes**: Load `config-valid-minimal.json`. Validation passes with zero errors (defaults are all valid).
3. **Each invalid fixture fails**: For each `config-invalid-vNNN.json`, validation fails and the error output references rule V-NNN.
4. **Test isolation**: Running any single test in isolation produces the same result as running the full suite.
