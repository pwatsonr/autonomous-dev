# SPEC-002-2-04: Event Logger and Request Tracker Unit Tests

## Metadata
- **Parent Plan**: PLAN-002-2
- **Tasks Covered**: Task 9 (Unit tests for Event Logger), Task 10 (Unit tests for Request Tracker)
- **Estimated effort**: 8 hours

## Description
Comprehensive unit test suites for the Event Logger and Request Tracker, covering all functions from SPEC-002-2-01, SPEC-002-2-02, and SPEC-002-2-03. Two test files: one for the Event Logger (15+ tests), one for the Request Tracker (15+ tests). Both are self-contained bash scripts producing TAP-like output. Combined minimum: 30 test cases as specified in PLAN-002-2.

## Files to Create/Modify
- **Path**: `tests/unit/test_event_logger.sh`
- **Action**: Create
- **Description**: Unit test script for `lib/state/event_logger.sh`. Tests append, read, torn-write recovery, size guard, and edge cases.

- **Path**: `tests/unit/test_request_tracker.sh`
- **Action**: Create
- **Description**: Unit test script for `lib/state/request_tracker.sh`. Tests ID generation, discovery, scaffolding, validation, and sanitization.

- **Path**: `tests/fixtures/events_valid.jsonl`
- **Action**: Create
- **Description**: Golden valid event log fixture with 10 entries matching TDD Section 4.4 examples.

## Implementation Details

### Shared Test Harness

Both test files use the same harness pattern from SPEC-002-1-04 (`setup`, `teardown`, `assert_eq`, `assert_exit_code`, `run_test`, `report`). To avoid duplication, extract the harness to a shared file:

- **Path**: `tests/test_harness.sh`
- **Action**: Create
- **Description**: Shared test utilities sourced by all test scripts. Contains `setup()`, `teardown()`, assertion helpers, and `run_test()` dispatcher.

```bash
#!/usr/bin/env bash
# test_harness.sh -- Shared test utilities
set -euo pipefail

_TESTS_RUN=0
_TESTS_PASSED=0
_TESTS_FAILED=0
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
  if [[ "$expected" == "$actual" ]]; then return 0; fi
  echo "  ASSERT_EQ FAILED: expected='${expected}' actual='${actual}' ${msg}" >&2
  return 1
}

assert_contains() {
  local haystack="$1" needle="$2" msg="${3:-}"
  if [[ "$haystack" == *"$needle"* ]]; then return 0; fi
  echo "  ASSERT_CONTAINS FAILED: '${needle}' not found in output ${msg}" >&2
  return 1
}

assert_file_exists() {
  local path="$1"
  if [[ -f "$path" ]]; then return 0; fi
  echo "  ASSERT_FILE_EXISTS FAILED: ${path}" >&2
  return 1
}

assert_dir_exists() {
  local path="$1"
  if [[ -d "$path" ]]; then return 0; fi
  echo "  ASSERT_DIR_EXISTS FAILED: ${path}" >&2
  return 1
}

assert_file_not_exists() {
  local path="$1"
  if [[ ! -f "$path" ]]; then return 0; fi
  echo "  ASSERT_FILE_NOT_EXISTS FAILED: ${path} exists" >&2
  return 1
}

assert_permissions() {
  local path="$1" expected="$2"
  local actual
  actual="$(stat -f '%Lp' "$path" 2>/dev/null || stat -c '%a' "$path" 2>/dev/null)"
  if [[ "$actual" == "$expected" ]]; then return 0; fi
  echo "  ASSERT_PERMISSIONS FAILED: ${path} has ${actual}, expected ${expected}" >&2
  return 1
}

run_test() {
  local test_name="$1"
  local test_func="$2"
  (( _TESTS_RUN++ )) || true
  setup
  if "$test_func"; then
    echo "PASS: ${test_name}"
    (( _TESTS_PASSED++ )) || true
  else
    echo "FAIL: ${test_name}"
    (( _TESTS_FAILED++ )) || true
  fi
  teardown
}

report() {
  echo ""
  echo "Results: ${_TESTS_PASSED}/${_TESTS_RUN} passed, ${_TESTS_FAILED} failed"
  [[ $_TESTS_FAILED -gt 0 ]] && exit 1
  exit 0
}
```

### Event Logger Test File (`test_event_logger.sh`)

**Helper: build a valid event JSON**

```bash
make_event() {
  local event_type="${1:-request_created}"
  local request_id="${2:-REQ-20260408-a3f1}"
  local timestamp="${3:-2026-04-08T09:15:00Z}"
  jq -n \
    --arg ts "$timestamp" \
    --arg et "$event_type" \
    --arg rid "$request_id" \
    '{timestamp: $ts, event_type: $et, request_id: $rid, session_id: null, metadata: {}}'
}
```

**Test cases (18 total):**

| # | Test Name | Category | Description |
|---|-----------|----------|-------------|
| 1 | `test_append_valid_event` | Append | Append valid event, verify file has 1 line |
| 2 | `test_append_multiple_events` | Append | Append 3 events, verify 3 lines |
| 3 | `test_append_rejects_invalid_json` | Append | Pass non-JSON, verify returns 1 |
| 4 | `test_append_rejects_missing_event_type` | Append | JSON missing event_type, returns 1 |
| 5 | `test_append_rejects_invalid_event_type` | Append | event_type "bogus", returns 1 |
| 6 | `test_append_rejects_invalid_request_id` | Append | request_id "INVALID", returns 1 |
| 7 | `test_append_size_guard` | Append | Create >10MB file, attempt append, returns 2 |
| 8 | `test_append_sets_permissions` | Append | After append, file is 0600 |
| 9 | `test_read_all_valid` | Read | Write 5 events, read_all returns array of 5 |
| 10 | `test_read_all_empty_file` | Read | Empty file returns `[]` |
| 11 | `test_read_all_missing_file` | Read | Missing file returns `[]` |
| 12 | `test_read_since_filters` | Read | Events at T1,T2,T3; read_since(T2) returns 2 |
| 13 | `test_read_since_no_matches` | Read | All events before filter, returns `[]` |
| 14 | `test_torn_write_last_line` | Torn-write | 3 valid lines + truncated line; read returns 3 events, file truncated |
| 15 | `test_torn_write_mid_file` | Torn-write | Corrupt mid-file line; returns error 1 |
| 16 | `test_no_corruption_clean_file` | Torn-write | All valid lines; no modification to file |
| 17 | `test_torn_write_empty_file` | Torn-write | Empty file; returns `[]`, no error |
| 18 | `test_special_chars_in_metadata` | Edge case | Event with quotes, backslashes, unicode in metadata; round-trips correctly |

### Request Tracker Test File (`test_request_tracker.sh`)

**Test cases (17 total):**

| # | Test Name | Category | Description |
|---|-----------|----------|-------------|
| 1 | `test_generate_id_format` | ID gen | ID matches `^REQ-[0-9]{8}-[0-9a-f]{4}$` |
| 2 | `test_generate_id_uniqueness` | ID gen | 10 rapid calls produce 10 distinct IDs |
| 3 | `test_generate_id_collision_retry` | ID gen | Pre-create dirs, verify retry produces new ID |
| 4 | `test_generate_id_exhaustion` | ID gen | After 5 collisions, returns 1 |
| 5 | `test_discover_multi_repo` | Discovery | 3 repos x 2 requests = 6 discovered |
| 6 | `test_discover_skips_no_state` | Discovery | Dir without state.json is skipped |
| 7 | `test_discover_skips_no_requests_dir` | Discovery | Repo without .autonomous-dev/requests/ is skipped |
| 8 | `test_discover_empty` | Discovery | No requests anywhere, returns empty |
| 9 | `test_scaffold_structure` | Scaffolding | Creates state.json, events.jsonl, checkpoint/ |
| 10 | `test_scaffold_state_valid` | Scaffolding | Initial state.json passes schema validation |
| 11 | `test_scaffold_initial_event` | Scaffolding | events.jsonl has one request_created event |
| 12 | `test_scaffold_permissions` | Scaffolding | Dirs 0700, files 0600 |
| 13 | `test_scaffold_duplicate_fails` | Scaffolding | Second call with same ID returns 1 |
| 14 | `test_validate_id_valid` | Validation | Valid ID returns 0 |
| 15 | `test_validate_id_traversal` | Validation | ID with `..` returns 1 |
| 16 | `test_validate_id_malformed` | Validation | Various malformed IDs return 1 |
| 17 | `test_sanitize_metacharacters` | Sanitization | Shell metacharacters are safely encoded |

### Event Fixtures (`tests/fixtures/events_valid.jsonl`)

10 lines from TDD Section 4.4:

```jsonl
{"timestamp":"2026-04-08T09:15:00Z","event_type":"request_created","request_id":"REQ-20260408-a3f1","from_state":null,"to_state":"intake","session_id":null,"metadata":{"title":"Add dark mode support to dashboard","repository":"/Users/pwatson/codebase/dashboard-app","priority":1,"submitted_by":"cli"}}
{"timestamp":"2026-04-08T09:15:01Z","event_type":"session_started","request_id":"REQ-20260408-a3f1","from_state":null,"to_state":null,"session_id":"sess_abc123","metadata":{"phase":"intake","max_turns":10}}
...
```

## Acceptance Criteria
1. [ ] `test_event_logger.sh` contains minimum 15 test cases (target: 18)
2. [ ] `test_request_tracker.sh` contains minimum 15 test cases (target: 17)
3. [ ] Combined total: 35 test cases (exceeds PLAN-002-2 minimum of 30)
4. [ ] All tests pass on a clean system with `jq` 1.6+ and `bash` 4+
5. [ ] `test_harness.sh` is extracted as a shared utility and sourced by both test files
6. [ ] Each test isolates its own temp directory (no test pollution)
7. [ ] `events_valid.jsonl` fixture matches TDD Section 4.4 examples
8. [ ] Event Logger tests cover: append (3), read (4), torn-write (4), edge cases (2+)
9. [ ] Request Tracker tests cover: ID generation (4), discovery (3+), scaffolding (3+), validation (3), sanitization (2)
10. [ ] Test scripts return exit 0 on all-pass, exit 1 on any failure

## Test Cases
These are meta-tests:
1. **Event Logger test suite passes** -- `bash tests/unit/test_event_logger.sh`. Expected: "18/18 passed".
2. **Request Tracker test suite passes** -- `bash tests/unit/test_request_tracker.sh`. Expected: "17/17 passed".
3. **Shared harness reusable** -- Both test files source `test_harness.sh` without conflict.
