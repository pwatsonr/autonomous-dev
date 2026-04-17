#!/usr/bin/env bash
# test_lifecycle_properties.sh -- Unit tests for SPEC-002-3-05 (Task 13)
# Property-based tests validating the 5 invariants from TDD Section 10.3
# with 50+ randomized inputs. Each property runs multiple iterations internally.
#
# Requires: jq (1.6+), bash 4+, bc
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source shared test harness
source "${SCRIPT_DIR}/../test_harness.sh"

# Source the fixture builder
source "${SCRIPT_DIR}/../fixtures/state_builder.sh"

# Source the module under test
source "${PROJECT_ROOT}/lib/state/lifecycle_engine.sh"

###############################################################################
# Random generators
###############################################################################

# All pipeline statuses available for random selection (excludes cancelled
# since it's terminal and would fail all transitions -- tested separately)
_RANDOM_STATUSES=(intake prd prd_review tdd tdd_review plan plan_review
  spec spec_review code code_review integration deploy monitor
  paused failed)

# All event types
_RANDOM_EVENTS=(advance review_fail pause resume fail retry cancel)

# generate_random_state -- Build a state at a random pipeline position
generate_random_state() {
  local random_idx=$(( RANDOM % ${#_RANDOM_STATUSES[@]} ))
  local status="${_RANDOM_STATUSES[$random_idx]}"
  local retry_count=$(( RANDOM % 5 ))
  local escalation_count=$(( RANDOM % 3 ))
  local cost
  cost="$(echo "scale=2; $RANDOM / 1000" | bc)"

  local extra_args=()
  extra_args+=(--status "$status")
  extra_args+=(--retry-count "$retry_count")
  extra_args+=(--escalation-count "$escalation_count")
  extra_args+=(--cost "$cost")

  # Add required fields for meta-states
  case "$status" in
    paused)
      extra_args+=(--paused-from "prd")
      extra_args+=(--paused-reason "manual_pause")
      ;;
    failed)
      extra_args+=(--last-checkpoint "code")
      ;;
  esac

  build_state "${extra_args[@]}"
}

# generate_random_event -- Pick a random event type
generate_random_event() {
  local random_idx=$(( RANDOM % ${#_RANDOM_EVENTS[@]} ))
  echo "${_RANDOM_EVENTS[$random_idx]}"
}

###############################################################################
# Validation helpers
###############################################################################

# assert_valid_state -- Verify that a JSON string is a valid state object
# Checks: valid JSON, has required fields, status is known
assert_valid_state() {
  local json="$1"

  # Must be valid JSON
  if ! echo "$json" | jq empty 2>/dev/null; then
    echo "  ASSERT_VALID_STATE FAILED: not valid JSON" >&2
    return 1
  fi

  # Must have status field
  local status
  status="$(echo "$json" | jq -r '.status // empty')"
  if [[ -z "$status" ]]; then
    echo "  ASSERT_VALID_STATE FAILED: missing status field" >&2
    return 1
  fi

  # Status must be in ALL_STATUSES
  local valid=false
  for s in "${ALL_STATUSES[@]}"; do
    if [[ "$status" == "$s" ]]; then
      valid=true
      break
    fi
  done
  if [[ "$valid" == "false" ]]; then
    echo "  ASSERT_VALID_STATE FAILED: unknown status '${status}'" >&2
    return 1
  fi

  # Must have phase_history as array
  if ! echo "$json" | jq -e '.phase_history | type == "array"' > /dev/null 2>&1; then
    echo "  ASSERT_VALID_STATE FAILED: phase_history not an array" >&2
    return 1
  fi

  # Must have updated_at
  if ! echo "$json" | jq -e '.updated_at' > /dev/null 2>&1; then
    echo "  ASSERT_VALID_STATE FAILED: missing updated_at" >&2
    return 1
  fi

  return 0
}

# assert_true -- Evaluate an expression and fail with message if false
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
# Property 1: Valid state + valid event -> valid state OR well-formed error
# (50 iterations)
###############################################################################
test_property_output_validity() {
  local failures=0
  for i in $(seq 1 50); do
    local state event result
    state="$(generate_random_state)"
    event="$(generate_random_event)"
    if result="$(state_transition "$state" "$event" '{}' '2026-04-08T12:00:00Z' 2>/dev/null)"; then
      # Successful transition: output must be a valid state JSON
      if ! assert_valid_state "$result" 2>/dev/null; then
        echo "  Property 1 violation at iteration ${i}: state=$(echo "$state" | jq -r .status) event=${event}" >&2
        (( failures++ )) || true
      fi
    fi
    # Failure (non-zero exit) is acceptable -- well-formed error
  done
  assert_eq "0" "$failures" "property_output_validity had ${failures} violations across 50 iterations"
}

###############################################################################
# Property 2: Cancelled is absorbing (all events rejected)
###############################################################################
test_property_cancelled_absorbing() {
  local cancelled_state
  cancelled_state="$(build_state --status cancelled)"
  local failures=0
  for event in advance review_fail pause resume fail retry cancel; do
    local exit_code=0
    state_transition "$cancelled_state" "$event" '{}' '2026-04-08T12:00:00Z' > /dev/null 2>&1 || exit_code=$?
    if [[ "$exit_code" -ne 1 ]]; then
      echo "  Property 2 violation: event '${event}' from cancelled returned exit ${exit_code}" >&2
      (( failures++ )) || true
    fi
  done
  assert_eq "0" "$failures" "cancelled_absorbing had ${failures} violations"
}

###############################################################################
# Property 3: Phase history only grows (20 iterations)
###############################################################################
test_property_history_grows() {
  local failures=0
  for i in $(seq 1 20); do
    local state event old_len result new_len
    state="$(generate_random_state)"
    event="$(generate_random_event)"
    old_len="$(echo "$state" | jq '.phase_history | length')"
    if result="$(state_transition "$state" "$event" '{}' '2026-04-08T12:00:00Z' 2>/dev/null)"; then
      new_len="$(echo "$result" | jq '.phase_history | length')"
      if (( new_len < old_len )); then
        echo "  Property 3 violation at iteration ${i}: history shrunk from ${old_len} to ${new_len}" >&2
        (( failures++ )) || true
      fi
    fi
  done
  assert_eq "0" "$failures" "history_grows had ${failures} violations across 20 iterations"
}

###############################################################################
# Property 4: updated_at is monotonically non-decreasing (20 iterations)
###############################################################################
test_property_updated_at_monotonic() {
  local failures=0
  for i in $(seq 1 20); do
    local state event old_ts result result_ts
    state="$(generate_random_state)"
    event="$(generate_random_event)"
    old_ts="$(echo "$state" | jq -r '.updated_at')"
    local new_ts="2026-04-08T23:59:59Z"
    if result="$(state_transition "$state" "$event" '{}' "$new_ts" 2>/dev/null)"; then
      result_ts="$(echo "$result" | jq -r '.updated_at')"
      if [[ "$result_ts" < "$old_ts" ]]; then
        echo "  Property 4 violation at iteration ${i}: updated_at went backward from '${old_ts}' to '${result_ts}'" >&2
        (( failures++ )) || true
      fi
    fi
  done
  assert_eq "0" "$failures" "updated_at_monotonic had ${failures} violations across 20 iterations"
}

###############################################################################
# Property 5: cost_accrued_usd is monotonically non-decreasing (20 iterations)
# Transition functions don't modify cost directly (session updates do), so
# cost should be unchanged after any transition.
###############################################################################
test_property_cost_monotonic() {
  local failures=0
  for i in $(seq 1 20); do
    local state event old_cost result new_cost
    state="$(generate_random_state)"
    event="$(generate_random_event)"
    old_cost="$(echo "$state" | jq '.cost_accrued_usd')"
    if result="$(state_transition "$state" "$event" '{}' '2026-04-08T12:00:00Z' 2>/dev/null)"; then
      new_cost="$(echo "$result" | jq '.cost_accrued_usd')"
      if [[ "$(echo "$new_cost < $old_cost" | bc -l)" == "1" ]]; then
        echo "  Property 5 violation at iteration ${i}: cost decreased from ${old_cost} to ${new_cost}" >&2
        (( failures++ )) || true
      fi
    fi
  done
  assert_eq "0" "$failures" "cost_monotonic had ${failures} violations across 20 iterations"
}

###############################################################################
# Run Tests
###############################################################################

run_test "property_output_validity" test_property_output_validity
run_test "property_cancelled_absorbing" test_property_cancelled_absorbing
run_test "property_history_grows" test_property_history_grows
run_test "property_updated_at_monotonic" test_property_updated_at_monotonic
run_test "property_cost_monotonic" test_property_cost_monotonic

report
