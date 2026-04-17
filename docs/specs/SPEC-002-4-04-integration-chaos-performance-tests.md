# SPEC-002-4-04: Integration Tests, Chaos Tests, and Performance Benchmarks

## Metadata
- **Parent Plan**: PLAN-002-4
- **Tasks Covered**: Task 11 (Integration tests), Task 12 (Chaos tests), Task 13 (Multi-repo discovery and performance validation)
- **Estimated effort**: 12 hours

## Description
Implement the three categories of higher-order tests that validate the state machine subsystem end-to-end: (1) integration tests that exercise full lifecycle scenarios with all components wired together, (2) chaos tests that inject failures (process kills, disk exhaustion, corruption) and verify recovery, and (3) performance benchmarks that validate discovery and state operations at scale. These tests prove the system is production-grade and compose correctly beyond unit-level function calls.

## Files to Create/Modify
- **Path**: `tests/integration/test_full_lifecycle.sh`
- **Action**: Create
- **Description**: Integration test suite. 9+ scenarios per TDD Section 10.2 including full happy path, review failure loops, concurrent isolation, and recovery scenarios.

- **Path**: `tests/chaos/test_crash_recovery.sh`
- **Action**: Create
- **Description**: Chaos test suite. Kill-and-recover, disk-full simulation, corruption injection, and event log truncation tests.

- **Path**: `tests/performance/test_discovery_benchmark.sh`
- **Action**: Create
- **Description**: Performance benchmarks. Discovery scaling tests and state read/write latency measurements.

## Implementation Details

### Integration Tests (`test_full_lifecycle.sh`)

```bash
#!/usr/bin/env bash
# test_full_lifecycle.sh -- Integration tests for the state machine subsystem
# These tests wire all components together and exercise full scenarios.
# Each test sets up a complete simulated environment in a temp directory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

source "${PROJECT_ROOT}/tests/test_harness.sh"
source "${PROJECT_ROOT}/lib/state/supervisor_interface.sh"
source "${PROJECT_ROOT}/lib/state/recovery.sh"
source "${PROJECT_ROOT}/lib/state/cleanup.sh"
source "${PROJECT_ROOT}/lib/state/lock_manager.sh"
source "${PROJECT_ROOT}/lib/state/migration.sh"
```

**Test 1: Full lifecycle happy path (`intake` -> `monitor`)**

```bash
# Scenario: A request goes through all 14 states with no failures
# Setup:
#   1. Create a mock repo with request directory scaffolding
#   2. For each phase: call process_request, then complete_phase
# Assertions:
#   - State progresses through all 14 states in order
#   - Phase history has 14 entries with proper enter/exit times
#   - Checkpoints exist for each phase
#   - Events logged for each transition
#   - Final state is "monitor"
test_happy_path() {
  local repo="${_TEST_DIR}/repo"
  mkdir -p "${repo}/.autonomous-dev/requests"
  # ... scaffold request, then loop through all phases ...
  local req_dir="${repo}/.autonomous-dev/requests/REQ-20260408-test"
  create_request_directory "${repo}/.autonomous-dev/requests" "REQ-20260408-test" \
    "Test request" "" "$repo" 5 "[]" "[]"

  local timeouts='{"prd": 3600, "prd_review": 1800, "tdd": 3600, "tdd_review": 1800, "plan": 3600, "plan_review": 1800, "spec": 3600, "spec_review": 1800, "code": 7200, "code_review": 3600, "integration": 3600, "deploy": 1800, "monitor": -1}'

  local timestamp="2026-04-08T10:00:00Z"

  # Advance through intake -> ... -> monitor (13 advances from intake)
  for i in $(seq 1 13); do
    complete_phase "$req_dir" '{}' "$timestamp"
    timestamp="2026-04-08T1${i}:00:00Z"  # Increment timestamp
  done

  # Verify final state
  local final_state
  final_state="$(state_read "$req_dir")"
  local final_status
  final_status="$(echo "$final_state" | jq -r '.status')"
  assert_eq "monitor" "$final_status" "Expected monitor state"

  local history_len
  history_len="$(echo "$final_state" | jq '.phase_history | length')"
  assert_eq "14" "$history_len" "Expected 14 phase history entries"
}
```

**Test 2: Review failure loop with escalation**

```bash
# Scenario: PRD review fails 3 times, triggering escalation to paused
# Setup:
#   1. Advance to prd_review
#   2. Apply review_fail 3 times (with max_retries=3)
#   3. On the 3rd fail, expect escalation to paused
# Assertions:
#   - First 2 review_fail transitions regress to prd
#   - 3rd review_fail triggers pause
#   - escalation_count is incremented
#   - paused_from is set correctly
```

**Test 3: Concurrent request isolation**

```bash
# Scenario: Two requests in different repos advance independently
# Setup:
#   1. Create request A in repo1
#   2. Create request B in repo2
#   3. Advance A to prd, advance B to tdd
# Assertions:
#   - A is at prd, B is at tdd (independent)
#   - Neither request's state file mentions the other
#   - discover_requests finds both
```

**Test 4: Stale heartbeat recovery**

```bash
# Scenario: Supervisor detects stale heartbeat, re-enters stuck request
# Setup:
#   1. Create request at code with exited_at: null
#   2. Write stale heartbeat file (2 minutes ago)
#   3. Run startup_recovery
# Assertions:
#   - Stale heartbeat is detected
#   - Request is identified as having un-exited phase
#   - State is NOT modified (flagged for re-entry only)
```

**Test 5: Schema migration**

```bash
# Scenario: Load a v1 fixture and verify it loads with current codebase
# Setup:
#   1. Copy v1 fixture to a request directory
#   2. Call migrate_state
# Assertions:
#   - State passes through unchanged (v1 is current)
#   - Schema validation passes
```

**Test 6: Cleanup and archival**

```bash
# Scenario: Complete request is archived after retention
# Setup:
#   1. Create request, advance to monitor
#   2. Backdate timestamps to 31 days ago
#   3. Run automated_cleanup
# Assertions:
#   - Request directory is gone
#   - Tarball exists in archive dir
#   - archive.log has entry
```

**Test 7: Lock file with dead PID**

```bash
# Scenario: Lock file contains a non-existent PID
# Setup:
#   1. Write lock file with PID 99999 (unlikely to exist)
#   2. Call acquire_lock
# Assertions:
#   - Lock is stolen
#   - Lock file now contains our PID
#   - Warning was logged
```

**Test 8: Dependency blocking and unblocking**

```bash
# Scenario: Request B is blocked by request A. A completes, B unblocks.
# Setup:
#   1. Create request A at prd
#   2. Create request B at intake with blocked_by: [A]
#   3. Check B: should be blocked
#   4. Advance A to monitor
#   5. Check B: should be unblocked
# Assertions:
#   - B is initially blocked
#   - After A reaches monitor, B is no longer blocked
```

**Test 9: Orphaned `.tmp` recovery**

```bash
# Scenario: Crash during write leaves .tmp file
# Setup:
#   1. Create valid state.json and a state.json.tmp alongside it
#   2. Run startup_recovery
# Assertions:
#   - .tmp is deleted
#   - state.json is untouched
```

### Chaos Tests (`test_crash_recovery.sh`)

```bash
#!/usr/bin/env bash
# test_crash_recovery.sh -- Chaos/destructive tests
# WARNING: These tests kill processes and may fill disk. Run in isolation.
# Skip in CI with --skip-chaos flag.
set -euo pipefail

# Check for skip flag
if [[ "${1:-}" == "--skip-chaos" ]]; then
  echo "Chaos tests skipped (--skip-chaos)"
  exit 0
fi
```

**Test A: Kill-and-recover (100 iterations)**

```bash
# Scenario: Kill the state write process at random points
# Method:
#   1. In a loop (100 iterations):
#      a. Start a background process that writes state
#      b. Kill it after random delay (0-50ms)
#      c. Verify state.json is valid (either old or new, never corrupt)
#      d. Clean up any .tmp files
# Assertion:
#   - state.json is ALWAYS valid JSON after every iteration
#   - No iteration leaves a corrupt state.json
test_kill_and_recover() {
  local dir="${_TEST_DIR}/crash"
  mkdir -p "$dir"

  # Write initial valid state
  local initial_state
  initial_state="$(build_state --status prd)"
  state_write_atomic "$dir" "$initial_state"

  local corruption_count=0
  for i in $(seq 1 100); do
    local new_state
    new_state="$(build_state --status "prd_review" --entered-at "2026-04-08T${i}:00:00Z")"

    # Start write in background
    state_write_atomic "$dir" "$new_state" &
    local write_pid=$!

    # Random delay then kill
    local delay=$(( RANDOM % 50 ))
    sleep "0.0${delay}s" 2>/dev/null || true
    kill -9 "$write_pid" 2>/dev/null || true
    wait "$write_pid" 2>/dev/null || true

    # Verify state.json integrity
    if [[ -f "${dir}/state.json" ]]; then
      if ! jq empty "${dir}/state.json" 2>/dev/null; then
        (( corruption_count++ ))
      fi
    fi

    # Clean up .tmp
    rm -f "${dir}/state.json.tmp"
  done

  assert_eq "0" "$corruption_count" "State corruption detected in ${corruption_count}/100 iterations"
}
```

**Test B: Disk-full simulation**

```bash
# Scenario: Disk becomes full during state write
# Method:
#   1. Create a small tmpfs (or use dd to fill a directory's filesystem)
#   2. Write valid state
#   3. Fill remaining space
#   4. Attempt state_write_atomic
# Assertion:
#   - Write fails (non-zero exit)
#   - state.json.tmp may be left (expected)
#   - Original state.json is intact
test_disk_full() {
  # Use a directory quota approach
  local dir="${_TEST_DIR}/diskfull"
  mkdir -p "$dir"

  local initial_state
  initial_state="$(build_state --status prd)"
  state_write_atomic "$dir" "$initial_state"

  # Make the directory read-only to simulate write failure
  local new_state
  new_state="$(build_state --status prd_review)"

  # Create a read-only subdirectory approach (simpler than tmpfs)
  chmod 555 "$dir"

  local exit_code=0
  state_write_atomic "$dir" "$new_state" 2>/dev/null || exit_code=$?

  # Restore permissions for cleanup
  chmod 755 "$dir"

  assert_eq "1" "$exit_code" "Expected write to fail"

  # Verify original state is intact
  local current_status
  current_status="$(jq -r '.status' "${dir}/state.json")"
  assert_eq "prd" "$current_status" "Original state should be preserved"
}
```

**Test C: State corruption injection**

```bash
# Scenario: Corrupt state.json with random bytes, verify detection
# Method:
#   1. Write valid state
#   2. Overwrite with random bytes
#   3. Call state_read
# Assertion:
#   - state_read returns exit 3 (parse failure)
#   - If checkpoint exists, fallback occurs
test_corruption_injection() {
  local dir="${_TEST_DIR}/corrupt"
  mkdir -p "$dir"

  state_write_atomic "$dir" "$(build_state --status code)"
  state_checkpoint "$dir"

  # Corrupt the state file
  dd if=/dev/urandom of="${dir}/state.json" bs=64 count=1 2>/dev/null

  # Read should fail or fall back to checkpoint
  local exit_code=0
  local result
  result="$(state_read "$dir" 2>/dev/null)" || exit_code=$?

  if [[ $exit_code -eq 0 ]]; then
    # Checkpoint fallback succeeded
    local status
    status="$(echo "$result" | jq -r '.status')"
    assert_eq "code" "$status" "Should have restored from checkpoint"
  else
    # No fallback available or fallback also corrupt
    assert_eq "3" "$exit_code" "Should be parse error"
  fi
}
```

**Test D: Event log truncation**

```bash
# Scenario: Truncate events.jsonl at random byte offset
# Method:
#   1. Write 10 valid events
#   2. Truncate at random point
#   3. Call event_read_all
# Assertion:
#   - If truncation is mid-last-line: torn write recovered, previous events returned
#   - If truncation is mid-earlier-line: corruption detected
test_event_truncation() {
  local dir="${_TEST_DIR}/truncate"
  mkdir -p "$dir"
  local events_file="${dir}/events.jsonl"

  # Write 10 events
  for i in $(seq 1 10); do
    local event
    event="$(jq -n --arg ts "2026-04-08T09:${i}:00Z" --arg rid "REQ-20260408-a3f1" \
      '{timestamp: $ts, event_type: "state_transition", request_id: $rid, session_id: null, metadata: {}}')"
    event_append "$events_file" "$event"
  done

  local original_size
  original_size="$(wc -c < "$events_file")"

  # Truncate at ~90% (should hit last line)
  local trunc_size=$(( original_size * 9 / 10 ))
  dd if="$events_file" of="${events_file}.trunc" bs=1 count="$trunc_size" 2>/dev/null
  mv -f "${events_file}.trunc" "$events_file"

  local exit_code=0
  local result
  result="$(event_read_all "$events_file" 2>/dev/null)" || exit_code=$?

  # Should recover (last line discarded)
  local event_count
  event_count="$(echo "$result" | jq 'length')"
  assert_true "(( event_count >= 8 && event_count <= 9 ))" \
    "Expected 8-9 events after truncation, got ${event_count}"
}
```

### Performance Benchmarks (`test_discovery_benchmark.sh`)

```bash
#!/usr/bin/env bash
# test_discovery_benchmark.sh -- Discovery and state operation performance
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

source "${PROJECT_ROOT}/tests/test_harness.sh"
source "${PROJECT_ROOT}/lib/state/state_file_manager.sh"
source "${PROJECT_ROOT}/lib/state/request_tracker.sh"
```

**Benchmark 1: 100 requests across 10 repos (< 1 second)**

```bash
# Setup: Create 10 mock repos with 10 minimal request directories each
# Measure: Time discover_requests across all 10 repos
# Threshold: < 1 second
test_discovery_100_requests() {
  local -a repos=()
  for r in $(seq 1 10); do
    local repo="${_TEST_DIR}/repo${r}"
    mkdir -p "${repo}/.autonomous-dev/requests"
    for i in $(seq 1 10); do
      local hex
      hex="$(printf '%04x' $((r * 100 + i)))"
      local req_dir="${repo}/.autonomous-dev/requests/REQ-20260408-${hex}"
      mkdir -p "$req_dir"
      # Write minimal valid state.json
      local state
      state="$(build_state --status intake --id "REQ-20260408-${hex}")"
      printf '%s\n' "$state" > "${req_dir}/state.json"
    done
    repos+=("$repo")
  done

  local start_time end_time elapsed
  start_time="$(date +%s%N)"
  local count=0
  while IFS= read -r dir; do
    (( count++ ))
  done < <(discover_requests "${repos[@]}")
  end_time="$(date +%s%N)"

  elapsed=$(( (end_time - start_time) / 1000000 ))  # milliseconds

  assert_eq "100" "$count" "Expected 100 discovered requests"
  assert_true "(( elapsed < 1000 ))" "Discovery took ${elapsed}ms, expected < 1000ms"
}
```

**Benchmark 2: 1000 requests across 10 repos (< 5 seconds)**

```bash
# Same as above but 100 requests per repo
test_discovery_1000_requests() {
  # Create 10 repos x 100 requests
  # ... similar setup ...
  # Threshold: < 5 seconds
}
```

**Benchmark 3: Single state read < 100ms**

```bash
# Setup: Create one request with full phase history (14 entries)
# Measure: Time state_read
# Threshold: < 100ms
test_state_read_latency() {
  local req_dir="${_TEST_DIR}/bench/REQ-20260408-0001"
  mkdir -p "$req_dir"
  local state
  state="$(build_state --status monitor)"
  state_write_atomic "$req_dir" "$state"

  local start_time end_time elapsed
  start_time="$(date +%s%N)"
  state_read "$req_dir" > /dev/null
  end_time="$(date +%s%N)"

  elapsed=$(( (end_time - start_time) / 1000000 ))

  assert_true "(( elapsed < 100 ))" "State read took ${elapsed}ms, expected < 100ms"
}
```

## Acceptance Criteria
1. [ ] 9+ integration tests covering all scenarios from TDD Section 10.2
2. [ ] Full happy path test advances through all 14 states successfully
3. [ ] Review failure loop test triggers escalation after max retries
4. [ ] Concurrent request isolation test proves no cross-contamination
5. [ ] Stale heartbeat recovery test identifies stuck requests
6. [ ] Schema migration test validates v1 fixture loads correctly
7. [ ] Cleanup test archives completed request with tarball creation
8. [ ] Lock file test verifies dead-PID steal behavior
9. [ ] Dependency blocking/unblocking test verifies correct resolution
10. [ ] Orphaned `.tmp` recovery test verifies crash-safe behavior
11. [ ] Chaos: kill-and-recover shows no state corruption over 100 iterations
12. [ ] Chaos: disk-full preserves original state.json
13. [ ] Chaos: corruption injection is detected and handled
14. [ ] Chaos: event log truncation triggers torn-write recovery
15. [ ] Performance: 100 requests discovered in < 1 second
16. [ ] Performance: 1000 requests discovered in < 5 seconds
17. [ ] Performance: single state read completes in < 100ms
18. [ ] Chaos tests can be skipped with `--skip-chaos` flag

## Test Cases
Integration tests (9):
1. **Happy path** -- intake through monitor. Assertion: 14 history entries, status monitor.
2. **Review failure escalation** -- 3 failures at prd_review. Assertion: paused, escalation_count > 0.
3. **Concurrent isolation** -- Two requests in different repos. Assertion: independent states.
4. **Stale heartbeat** -- Old heartbeat file. Assertion: warning logged, request flagged.
5. **Schema migration** -- v1 fixture loads. Assertion: validates successfully.
6. **Cleanup and archive** -- Old monitor request. Assertion: tarball exists, dir gone.
7. **Lock file dead PID** -- Non-existent PID in lock. Assertion: lock stolen.
8. **Dependency block/unblock** -- A blocks B, A completes, B unblocks. Assertion: correct blocking state at each step.
9. **Orphaned .tmp** -- .tmp alongside state.json. Assertion: .tmp cleaned up.

Chaos tests (4):
10. **Kill-and-recover** -- 100 interrupted writes. Assertion: 0 corruptions.
11. **Disk-full write** -- Write to read-only dir. Assertion: original state preserved.
12. **Corruption injection** -- Random bytes in state.json. Assertion: detected, checkpoint fallback or fail.
13. **Event log truncation** -- Random truncation. Assertion: torn-write recovery works.

Performance benchmarks (3):
14. **100 request discovery** -- 10 repos x 10 requests. Assertion: < 1 second.
15. **1000 request discovery** -- 10 repos x 100 requests. Assertion: < 5 seconds.
16. **State read latency** -- Single full state file. Assertion: < 100ms.
