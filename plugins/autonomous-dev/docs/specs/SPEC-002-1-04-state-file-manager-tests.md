# SPEC-002-1-04: State File Manager Unit Tests

## Metadata
- **Parent Plan**: PLAN-002-1
- **Tasks Covered**: Task 8 (Unit tests for State File Manager)
- **Estimated effort**: 6 hours

## Description
Comprehensive unit test suite for the State File Manager, covering all functions from SPEC-002-1-02 and SPEC-002-1-03: atomic writes, schema validation (valid and invalid), orphaned `.tmp` recovery, checkpointing (create, prune, restore), and permission enforcement. The test file is a self-contained bash script using only `jq` -- no external test framework. Minimum 25 test cases as specified in the plan.

## Files to Create/Modify
- **Path**: `tests/unit/test_state_file_manager.sh`
- **Action**: Create
- **Description**: Unit test script for `lib/state/state_file_manager.sh`. Self-contained, produces TAP-like output (test name + PASS/FAIL), returns exit 0 if all pass, exit 1 if any fail.

- **Path**: `tests/fixtures/state_valid.json`
- **Action**: Create
- **Description**: Golden valid state file fixture matching TDD Section 4.3 example. Used as the baseline for positive tests and as the template for negative tests (mutate one field at a time).

## Implementation Details

### Test Harness

```bash
#!/usr/bin/env bash
# test_state_file_manager.sh -- Unit tests for State File Manager
# Requires: jq, bash 4+
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source the module under test
source "${PROJECT_ROOT}/lib/state/state_file_manager.sh"

# Test counters
_TESTS_RUN=0
_TESTS_PASSED=0
_TESTS_FAILED=0

# Test working directory (cleaned up at exit)
_TEST_DIR=""

setup() {
  _TEST_DIR="$(mktemp -d)"
  chmod 0700 "$_TEST_DIR"
}

teardown() {
  [[ -n "$_TEST_DIR" && -d "$_TEST_DIR" ]] && rm -rf "$_TEST_DIR"
}

assert_eq() {
  local expected="$1" actual="$2" msg="${3:-}"
  if [[ "$expected" == "$actual" ]]; then
    return 0
  else
    echo "  ASSERTION FAILED: expected='${expected}' actual='${actual}' ${msg}" >&2
    return 1
  fi
}

assert_exit_code() {
  local expected="$1"
  shift
  local actual_exit=0
  "$@" > /dev/null 2>&1 || actual_exit=$?
  if [[ "$actual_exit" -eq "$expected" ]]; then
    return 0
  else
    echo "  ASSERTION FAILED: expected exit ${expected}, got ${actual_exit}" >&2
    return 1
  fi
}

run_test() {
  local test_name="$1"
  local test_func="$2"
  (( _TESTS_RUN++ ))
  setup
  if "$test_func"; then
    echo "PASS: ${test_name}"
    (( _TESTS_PASSED++ ))
  else
    echo "FAIL: ${test_name}"
    (( _TESTS_FAILED++ ))
  fi
  teardown
}

report() {
  echo ""
  echo "Results: ${_TESTS_PASSED}/${_TESTS_RUN} passed, ${_TESTS_FAILED} failed"
  if [[ $_TESTS_FAILED -gt 0 ]]; then
    exit 1
  fi
  exit 0
}
```

### Golden Fixture (`tests/fixtures/state_valid.json`)

Exact copy of TDD Section 4.3 example:

```json
{
  "schema_version": 1,
  "id": "REQ-20260408-a3f1",
  "status": "prd_review",
  "priority": 1,
  "title": "Add dark mode support to dashboard",
  "description": "Users have requested dark mode...",
  "repository": "/Users/pwatson/codebase/dashboard-app",
  "branch": "autonomous/REQ-20260408-a3f1",
  "worktree_path": "/Users/pwatson/.autonomous-dev/worktrees/REQ-20260408-a3f1",
  "created_at": "2026-04-08T09:15:00Z",
  "updated_at": "2026-04-08T10:42:00Z",
  "cost_accrued_usd": 2.47,
  "turn_count": 38,
  "escalation_count": 0,
  "blocked_by": [],
  "phase_history": [
    {
      "state": "intake",
      "entered_at": "2026-04-08T09:15:00Z",
      "exited_at": "2026-04-08T09:16:12Z",
      "session_id": "sess_abc123",
      "turns_used": 3,
      "cost_usd": 0.12,
      "retry_count": 0,
      "exit_reason": "completed"
    },
    {
      "state": "prd",
      "entered_at": "2026-04-08T09:16:12Z",
      "exited_at": "2026-04-08T10:05:30Z",
      "session_id": "sess_def456",
      "turns_used": 28,
      "cost_usd": 1.85,
      "retry_count": 0,
      "exit_reason": "completed"
    },
    {
      "state": "prd_review",
      "entered_at": "2026-04-08T10:05:30Z",
      "exited_at": null,
      "session_id": "sess_ghi789",
      "turns_used": 7,
      "cost_usd": 0.50,
      "retry_count": 0,
      "exit_reason": null
    }
  ],
  "current_phase_metadata": {
    "review_criteria": "completeness, feasibility, clarity",
    "review_feedback": null,
    "artifacts": ["docs/prd/PRD-dark-mode.md"]
  },
  "error": null,
  "last_checkpoint": "prd",
  "paused_from": null,
  "paused_reason": null,
  "failure_reason": null,
  "generation": 0,
  "tags": ["dashboard", "ux"]
}
```

### Test Cases (28 total)

**Schema Validation (10 tests):**

1. `test_valid_state_passes_validation` -- Load `state_valid.json`, call `_validate_state_schema`. Assert: returns 0.
2. `test_missing_required_field_status` -- Remove `status` from valid JSON. Assert: returns 1, error mentions "Missing required field: status".
3. `test_missing_required_field_id` -- Remove `id` from valid JSON. Assert: returns 1, error mentions "Missing required field: id".
4. `test_invalid_status_enum` -- Set `status` to `"bogus"`. Assert: returns 1, error mentions "Invalid status".
5. `test_invalid_schema_version` -- Set `schema_version` to 99. Assert: returns 1.
6. `test_invalid_id_format` -- Set `id` to `"INVALID"`. Assert: returns 1.
7. `test_temporal_inconsistency` -- Set `updated_at` to timestamp before `created_at`. Assert: returns 1.
8. `test_invalid_priority_too_high` -- Set `priority` to 10. Assert: returns 1.
9. `test_invalid_priority_negative` -- Set `priority` to -1. Assert: returns 1.
10. `test_phase_history_missing_field` -- Remove `entered_at` from first phase history entry. Assert: returns 1.

**Atomic Write (5 tests):**

11. `test_atomic_write_success` -- Write valid JSON, read file back. Assert: content matches.
12. `test_atomic_write_no_tmp_residue` -- Write valid JSON. Assert: `state.json.tmp` does not exist.
13. `test_atomic_write_rejects_invalid_json` -- Call with `"not json"`. Assert: returns 1, no files created.
14. `test_atomic_write_rejects_empty_args` -- Call with empty strings. Assert: returns 1.
15. `test_atomic_write_preserves_existing` -- Write initial valid state, then attempt write that would fail (nonexistent directory for a second call). Assert: original `state.json` unchanged.

**Orphaned Tmp Recovery (5 tests):**

16. `test_tmp_with_state_deletes_tmp` -- Create both files, call `recover_orphaned_tmp`. Assert: `.tmp` gone, `state.json` unchanged.
17. `test_tmp_alone_valid_promotes` -- Create only `.tmp` with valid JSON. Assert: `state.json` created, `.tmp` gone.
18. `test_tmp_alone_invalid_quarantines` -- Create only `.tmp` with invalid JSON. Assert: `corrupt/` dir created, `.tmp` moved there, returns 1.
19. `test_no_tmp_noop` -- No `.tmp` file. Assert: returns 0, no changes.
20. `test_tmp_alone_parse_error_quarantines` -- Create `.tmp` with non-JSON text. Assert: moved to `corrupt/`, returns 1.

**Checkpoint (5 tests):**

21. `test_checkpoint_creates_file` -- Write state, call `state_checkpoint`. Assert: `checkpoint/` dir exists, contains one `state.json.*` file.
22. `test_checkpoint_prune_keeps_five` -- Call `state_checkpoint` 7 times (with distinct timestamps). Assert: exactly 5 files remain.
23. `test_checkpoint_restore_latest` -- Create 3 checkpoints with different content, modify `state.json`, restore. Assert: `state.json` matches the third checkpoint content.
24. `test_checkpoint_restore_specific` -- Create 3 checkpoints, restore the first one by path. Assert: `state.json` matches first checkpoint.
25. `test_checkpoint_restore_no_checkpoints` -- Call restore on empty dir. Assert: returns 1.

**Permissions and Edge Cases (3 tests):**

26. `test_permissions_new_directory` -- Call `ensure_dir_permissions` on new path. Assert: permissions are `0700`.
27. `test_permissions_new_file` -- Write file, call `ensure_file_permissions`. Assert: permissions are `0600`.
28. `test_permissions_warning_on_read` -- Write valid state, `chmod 644`, call `state_read`. Assert: exit 0, stderr contains "WARNING".

### Helper for mutating fixture JSON

```bash
# Utility: create a mutated copy of the golden fixture
# Usage: mutate_fixture '.status = "bogus"' > modified.json
mutate_fixture() {
  local jq_filter="$1"
  jq "$jq_filter" "${PROJECT_ROOT}/tests/fixtures/state_valid.json"
}
```

## Acceptance Criteria
1. [ ] Test script is executable and runs with `bash tests/unit/test_state_file_manager.sh`
2. [ ] All 28 tests pass on a clean system with `jq` 1.6+ and `bash` 4+
3. [ ] Each test creates and tears down its own temporary directory (no test pollution)
4. [ ] Test output clearly shows PASS/FAIL for each test with a descriptive name
5. [ ] Summary line at end shows total passed/failed/run
6. [ ] Test script returns exit 0 when all pass, exit 1 when any fail
7. [ ] Golden fixture `state_valid.json` matches TDD Section 4.3 exactly
8. [ ] Tests cover all 5 categories: schema validation (10), atomic write (5), orphaned tmp (5), checkpoint (5), permissions (3)
9. [ ] Negative tests verify error messages contain expected substrings (not just exit codes)

## Test Cases
These are meta-tests (tests about the test suite):
1. **Test suite runs to completion** -- Execute `bash tests/unit/test_state_file_manager.sh`. Expected: exits 0, prints "28/28 passed".
2. **Test suite catches regressions** -- Introduce a deliberate bug (e.g., remove a required field check from `_validate_state_schema`). Expected: at least one test fails, exit 1.
3. **Test isolation** -- Run the suite twice in succession. Expected: both runs produce identical results (no stale temp files).
