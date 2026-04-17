#!/usr/bin/env bash
# test_crash_recovery.sh -- Chaos/destructive tests
# SPEC-002-4-04: Task 12 -- Chaos tests
# WARNING: These tests kill processes and may fill disk. Run in isolation.
# Skip in CI with --skip-chaos flag.
set -euo pipefail

# Check for skip flag
if [[ "${1:-}" == "--skip-chaos" ]]; then
  echo "Chaos tests skipped (--skip-chaos)"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

source "${PROJECT_ROOT}/tests/test_harness.sh"
source "${PROJECT_ROOT}/tests/fixtures/state_builder.sh"
source "${PROJECT_ROOT}/lib/state/state_file_manager.sh"
source "${PROJECT_ROOT}/lib/state/event_logger.sh"

###############################################################################
# Helper: assert_true (not in base harness)
###############################################################################
assert_true() {
  local expr="$1"
  local msg="${2:-expression was false}"
  if eval "$expr"; then
    return 0
  fi
  echo "  ASSERT_TRUE FAILED: ${msg}" >&2
  return 1
}

###############################################################################
# Test A: Kill-and-recover (100 iterations)
# Scenario: Kill the state write process at random points
# Verify state.json is ALWAYS valid JSON after every iteration.
###############################################################################
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
    new_state="$(build_state --status "prd_review" --entered-at "2026-04-08T10:$(printf '%02d' $((i % 60))):00Z")"

    # Start write in background
    state_write_atomic "$dir" "$new_state" &
    local write_pid=$!

    # Random delay then kill
    local delay=$(( RANDOM % 50 ))
    sleep "0.0${delay}s" 2>/dev/null || sleep 0 2>/dev/null || true
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

###############################################################################
# Test B: Disk-full simulation
# Scenario: Disk becomes full during state write (simulated via read-only dir)
# Verify original state.json is intact.
###############################################################################
test_disk_full() {
  local dir="${_TEST_DIR}/diskfull"
  mkdir -p "$dir"

  local initial_state
  initial_state="$(build_state --status prd)"
  state_write_atomic "$dir" "$initial_state"

  # Capture the initial state content for comparison
  local initial_content
  initial_content="$(cat "${dir}/state.json")"

  local new_state
  new_state="$(build_state --status prd_review)"

  # Make the directory read-only to simulate write failure
  chmod 555 "$dir"

  local exit_code=0
  state_write_atomic "$dir" "$new_state" 2>/dev/null || exit_code=$?

  # Restore permissions for cleanup
  chmod 755 "$dir"

  assert_true "(( exit_code != 0 ))" "Expected write to fail with non-zero exit"

  # Verify original state is intact
  local current_status
  current_status="$(jq -r '.status' "${dir}/state.json")"
  assert_eq "prd" "$current_status" "Original state should be preserved"

  # Verify content matches exactly
  local current_content
  current_content="$(cat "${dir}/state.json")"
  assert_eq "$initial_content" "$current_content" "File content should be unchanged"
}

###############################################################################
# Test C: State corruption injection
# Scenario: Corrupt state.json with random bytes, verify detection.
# If checkpoint exists, fallback occurs. Otherwise returns parse error.
###############################################################################
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
    assert_eq "3" "$exit_code" "Should be parse error (exit code 3)"
  fi
}

###############################################################################
# Test D: Event log truncation
# Scenario: Truncate events.jsonl at random byte offset.
# Verify torn-write recovery discards partial last line and recovers.
###############################################################################
test_event_truncation() {
  local dir="${_TEST_DIR}/truncate"
  mkdir -p "$dir"
  local events_file="${dir}/events.jsonl"

  # Write 10 events
  for i in $(seq 1 10); do
    local padded_i
    padded_i="$(printf '%02d' "$i")"
    local event
    event="$(jq -n --arg ts "2026-04-08T09:${padded_i}:00Z" --arg rid "REQ-20260408-a3f1" \
      '{timestamp: $ts, event_type: "state_transition", request_id: $rid, session_id: null, metadata: {}}')"
    event_append "$events_file" "$event"
  done

  local original_size
  original_size="$(wc -c < "$events_file" | tr -d ' ')"

  # Truncate at ~90% (should hit last line)
  local trunc_size=$(( original_size * 9 / 10 ))
  dd if="$events_file" of="${events_file}.trunc" bs=1 count="$trunc_size" 2>/dev/null
  mv -f "${events_file}.trunc" "$events_file"

  local exit_code=0
  local result
  result="$(event_read_all "$events_file" 2>/dev/null)" || exit_code=$?

  if [[ $exit_code -eq 0 ]]; then
    # Should recover (last line discarded)
    local event_count
    event_count="$(echo "$result" | jq 'length')"
    assert_true "(( event_count >= 8 && event_count <= 9 ))" \
      "Expected 8-9 events after truncation, got ${event_count}"
  else
    # Mid-file corruption was detected (truncation went deeper)
    assert_eq "1" "$exit_code" "If not recovered, should be corruption exit code"
  fi
}

###############################################################################
# Run all tests
###############################################################################
run_test "Chaos: Kill-and-recover (100 iterations)" test_kill_and_recover
run_test "Chaos: Disk-full simulation" test_disk_full
run_test "Chaos: State corruption injection" test_corruption_injection
run_test "Chaos: Event log truncation" test_event_truncation

report
