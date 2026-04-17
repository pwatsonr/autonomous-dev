#!/usr/bin/env bash
# test_discovery_benchmark.sh -- Discovery and state operation performance
# SPEC-002-4-04: Task 13 -- Performance benchmarks
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

source "${PROJECT_ROOT}/tests/test_harness.sh"
source "${PROJECT_ROOT}/tests/fixtures/state_builder.sh"
source "${PROJECT_ROOT}/lib/state/state_file_manager.sh"
source "${PROJECT_ROOT}/lib/state/request_tracker.sh"

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
# Helper: Create minimal request dirs in bulk (fast, bypasses full scaffold)
###############################################################################
_create_bulk_requests() {
  local repo="$1"
  local count="$2"
  local offset="${3:-0}"

  local req_base="${repo}/.autonomous-dev/requests"
  mkdir -p "$req_base"

  for i in $(seq 1 "$count"); do
    local idx=$(( offset + i ))
    local hex
    hex="$(printf '%04x' "$idx")"
    local req_id="REQ-20260408-${hex}"
    local req_dir="${req_base}/${req_id}"
    mkdir -p "$req_dir"
    # Write minimal valid state.json directly (bypasses scaffold for speed)
    local state
    state="$(build_state --status intake --id "$req_id")"
    printf '%s\n' "$state" > "${req_dir}/state.json"
    chmod 0600 "${req_dir}/state.json"
  done
}

###############################################################################
# Benchmark 1: 100 requests across 10 repos (< 1 second)
###############################################################################
test_discovery_100_requests() {
  local -a repos=()
  for r in $(seq 1 10); do
    local repo="${_TEST_DIR}/repo${r}"
    _create_bulk_requests "$repo" 10 $(( (r - 1) * 10 ))
    repos+=("$repo")
  done

  local start_time end_time elapsed
  start_time="$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')"
  local count=0
  while IFS= read -r dir; do
    (( count++ ))
  done < <(discover_requests "${repos[@]}")
  end_time="$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')"

  elapsed=$(( (end_time - start_time) / 1000000 ))  # milliseconds

  assert_eq "100" "$count" "Expected 100 discovered requests"
  assert_true "(( elapsed < 1000 ))" "Discovery took ${elapsed}ms, expected < 1000ms"
  echo "  [BENCH] 100 requests discovered in ${elapsed}ms" >&2
}

###############################################################################
# Benchmark 2: 1000 requests across 10 repos (< 5 seconds)
###############################################################################
test_discovery_1000_requests() {
  local -a repos=()
  for r in $(seq 1 10); do
    local repo="${_TEST_DIR}/repo${r}"
    _create_bulk_requests "$repo" 100 $(( (r - 1) * 100 ))
    repos+=("$repo")
  done

  local start_time end_time elapsed
  start_time="$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')"
  local count=0
  while IFS= read -r dir; do
    (( count++ ))
  done < <(discover_requests "${repos[@]}")
  end_time="$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')"

  elapsed=$(( (end_time - start_time) / 1000000 ))  # milliseconds

  assert_eq "1000" "$count" "Expected 1000 discovered requests"
  assert_true "(( elapsed < 5000 ))" "Discovery took ${elapsed}ms, expected < 5000ms"
  echo "  [BENCH] 1000 requests discovered in ${elapsed}ms" >&2
}

###############################################################################
# Benchmark 3: Single state read < 100ms
###############################################################################
test_state_read_latency() {
  local req_dir="${_TEST_DIR}/bench/REQ-20260408-0001"
  mkdir -p "$req_dir"
  local state
  state="$(build_state --status monitor --id "REQ-20260408-0001")"
  state_write_atomic "$req_dir" "$state"

  local start_time end_time elapsed
  start_time="$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')"
  state_read "$req_dir" > /dev/null
  end_time="$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')"

  elapsed=$(( (end_time - start_time) / 1000000 ))

  assert_true "(( elapsed < 100 ))" "State read took ${elapsed}ms, expected < 100ms"
  echo "  [BENCH] Single state read completed in ${elapsed}ms" >&2
}

###############################################################################
# Run all tests
###############################################################################
run_test "Performance: 100 request discovery (< 1s)" test_discovery_100_requests
run_test "Performance: 1000 request discovery (< 5s)" test_discovery_1000_requests
run_test "Performance: Single state read latency (< 100ms)" test_state_read_latency

report
