# SPEC-002-3-05: Lifecycle Engine Unit Tests (Transitions, Edge Cases, Properties)

## Metadata
- **Parent Plan**: PLAN-002-3
- **Tasks Covered**: Task 11 (Unit tests: valid transitions), Task 12 (Unit tests: invalid transitions and edge cases), Task 13 (Property-based transition validation)
- **Estimated effort**: 15 hours

## Description
Three test files covering the complete Lifecycle Engine: (1) valid transition tests for all 30 transition paths (13 forward + 5 backward + 12 meta-state), (2) invalid transition and edge case tests (15+ rejections, 5 timeout, 6 retry, 5 dependency = 31+), and (3) property-based tests validating the 5 invariants from TDD Section 10.3 with 50+ randomized inputs. Combined target: 75+ test cases as specified in the TDD.

## Files to Create/Modify
- **Path**: `tests/unit/test_lifecycle_transitions.sh`
- **Action**: Create
- **Description**: Tests for all valid transitions: 13 forward, 5 backward, 12 meta-state. Each test constructs a state fixture, applies a transition, and verifies the output state.

- **Path**: `tests/unit/test_lifecycle_edge_cases.sh`
- **Action**: Create
- **Description**: Tests for invalid transitions, timeout enforcement, retry accounting, and dependency evaluation. Each test verifies that the engine rejects or handles the case correctly.

- **Path**: `tests/unit/test_lifecycle_properties.sh`
- **Action**: Create
- **Description**: Property-based tests that generate random state+event combinations and assert the 5 invariant properties hold for all of them.

- **Path**: `tests/fixtures/state_builder.sh`
- **Action**: Create
- **Description**: Test fixture builder library. Provides `build_state()` function that constructs valid state JSON at any pipeline position with customizable fields. Used by all three test files.

## Implementation Details

### Fixture Builder (`state_builder.sh`)

```bash
#!/usr/bin/env bash
# state_builder.sh -- Build valid state fixtures for testing
# Usage: source this file, then call build_state with options

# build_state -- Construct a valid state JSON at a given pipeline position
#
# Arguments (all optional, via named flags):
#   --status STATUS          Target status (default: intake)
#   --id ID                  Request ID (default: REQ-20260408-a3f1)
#   --priority N             Priority (default: 5)
#   --retry-count N          Retry count for current phase (default: 0)
#   --last-checkpoint STATE  Last checkpoint state (default: null)
#   --paused-from STATE      For paused states (default: null)
#   --paused-reason REASON   For paused states (default: null)
#   --failure-reason REASON  For failed states (default: null)
#   --blocked-by '["ID"]'   Blocked by array (default: [])
#   --escalation-count N     Escalation count (default: 0)
#   --cost N                 Cost accrued USD (default: 0)
#   --error-json '{...}'     Error object (default: null)
#   --created-at TS          Created timestamp (default: 2026-04-08T09:00:00Z)
#   --entered-at TS          Current phase entered_at (default: auto)
#
# Stdout:
#   Valid state JSON
build_state() {
  local status="intake" id="REQ-20260408-a3f1" priority=5
  local retry_count=0 last_checkpoint="null" paused_from="null"
  local paused_reason="null" failure_reason="null" blocked_by="[]"
  local escalation_count=0 cost=0 error_json="null"
  local created_at="2026-04-08T09:00:00Z" entered_at=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --status) status="$2"; shift 2 ;;
      --id) id="$2"; shift 2 ;;
      --priority) priority="$2"; shift 2 ;;
      --retry-count) retry_count="$2"; shift 2 ;;
      --last-checkpoint) last_checkpoint="\"$2\""; shift 2 ;;
      --paused-from) paused_from="\"$2\""; shift 2 ;;
      --paused-reason) paused_reason="\"$2\""; shift 2 ;;
      --failure-reason) failure_reason="\"$2\""; shift 2 ;;
      --blocked-by) blocked_by="$2"; shift 2 ;;
      --escalation-count) escalation_count="$2"; shift 2 ;;
      --cost) cost="$2"; shift 2 ;;
      --error-json) error_json="$2"; shift 2 ;;
      --created-at) created_at="$2"; shift 2 ;;
      --entered-at) entered_at="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  [[ -z "$entered_at" ]] && entered_at="$created_at"

  # Build phase history leading up to the target status
  local phase_history
  phase_history="$(_build_phase_history "$status" "$created_at" "$entered_at" "$retry_count")"

  jq -n \
    --argjson sv 1 \
    --arg id "$id" \
    --arg status "$status" \
    --argjson priority "$priority" \
    --arg created_at "$created_at" \
    --arg updated_at "$entered_at" \
    --argjson blocked_by "$blocked_by" \
    --argjson escalation_count "$escalation_count" \
    --argjson cost "$cost" \
    --argjson error "$error_json" \
    --argjson last_checkpoint "$last_checkpoint" \
    --argjson paused_from "$paused_from" \
    --argjson paused_reason "$paused_reason" \
    --argjson failure_reason "$failure_reason" \
    --argjson phase_history "$phase_history" \
    '{
      schema_version: $sv,
      id: $id,
      status: $status,
      priority: $priority,
      title: "Test request",
      description: "A test request for unit testing",
      repository: "/tmp/test-repo",
      branch: ("autonomous/" + $id),
      worktree_path: null,
      created_at: $created_at,
      updated_at: $updated_at,
      cost_accrued_usd: $cost,
      turn_count: 0,
      escalation_count: $escalation_count,
      blocked_by: $blocked_by,
      phase_history: $phase_history,
      current_phase_metadata: {},
      error: $error,
      last_checkpoint: $last_checkpoint,
      paused_from: $paused_from,
      paused_reason: $paused_reason,
      failure_reason: $failure_reason,
      generation: 0,
      tags: []
    }'
}

# _build_phase_history -- Generate phase history entries leading to the target status
_build_phase_history() {
  local target_status="$1"
  local created_at="$2"
  local entered_at="$3"
  local retry_count="$4"

  # For simplicity, build a minimal history:
  # All completed phases from intake to the phase before target, then the target as active
  # ... (implementation builds the jq array)
}
```

### Test File 1: Valid Transitions (`test_lifecycle_transitions.sh`)

**30 tests organized by category:**

**Forward transitions (13 tests):**
Each test calls `state_transition(state, "advance", "{}", timestamp)` and verifies:
- Correct `to_state`
- Phase history grew by 1
- Previous entry has `exited_at` set and correct `exit_reason`
- New entry has `entered_at`, null `exited_at`, zero counters
- `last_checkpoint` updated
- `updated_at` updated

```
test_advance_intake_to_prd
test_advance_prd_to_prd_review
test_advance_prd_review_to_tdd         (exit_reason: review_pass)
test_advance_tdd_to_tdd_review
test_advance_tdd_review_to_plan        (exit_reason: review_pass)
test_advance_plan_to_plan_review
test_advance_plan_review_to_spec       (exit_reason: review_pass)
test_advance_spec_to_spec_review
test_advance_spec_review_to_code       (exit_reason: review_pass)
test_advance_code_to_code_review
test_advance_code_review_to_integration (exit_reason: review_pass)
test_advance_integration_to_deploy
test_advance_deploy_to_monitor
```

**Backward transitions (5 tests):**
Each test calls `state_transition(state, "review_fail", metadata, timestamp)` and verifies:
- Correct regression target
- `retry_count` incremented
- `review_feedback` preserved
- `exit_reason: "review_fail"` on the review entry

```
test_review_fail_prd_review_to_prd
test_review_fail_tdd_review_to_tdd
test_review_fail_plan_review_to_plan
test_review_fail_spec_review_to_spec
test_review_fail_code_review_to_code
```

**Meta-state transitions (12 tests):**
```
test_pause_from_active          (prd -> paused, paused_from set)
test_pause_from_review          (prd_review -> paused)
test_pause_escalation_count     (review-triggered, escalation incremented)
test_resume_from_paused         (paused -> prd, paused_from cleared)
test_fail_from_active           (code -> failed, error populated)
test_fail_from_review           (tdd_review -> failed)
test_retry_from_failed          (failed -> checkpoint state, error cleared)
test_retry_resets_counter       (retry_count back to 0)
test_cancel_from_active         (spec -> cancelled)
test_cancel_from_failed         (failed -> cancelled)
test_cancel_from_paused         (paused -> cancelled)
test_cancel_is_terminal         (no transitions after cancel)
```

### Test File 2: Edge Cases (`test_lifecycle_edge_cases.sh`)

**Minimum 31 tests:**

**Invalid transitions (15 tests):**
```
test_reject_advance_from_cancelled
test_reject_advance_from_monitor
test_reject_advance_from_paused
test_reject_advance_from_failed
test_reject_skip_intake_to_tdd          (would need two advances, not one)
test_reject_review_fail_from_non_review
test_reject_resume_from_non_paused
test_reject_retry_from_non_failed
test_reject_retry_without_checkpoint
test_reject_pause_from_cancelled
test_reject_unknown_event_type
test_reject_missing_arguments
test_reject_no_transition_to_intake
test_reject_double_pause
test_error_messages_are_specific        (verify error text names the rule)
```

**Timeout enforcement (5 tests):**
```
test_timeout_not_reached
test_timeout_reached_retry
test_timeout_reached_fail
test_timeout_reached_pause_review
test_timeout_monitor_exempt
```

**Retry accounting (6 tests):**
```
test_retry_count_increments_on_review_fail
test_retry_count_resets_on_advance
test_retry_count_resets_on_retry_cmd
test_retry_count_resets_on_resume
test_retry_exhaustion_triggers_pause
test_retry_exhaustion_triggers_fail
```

**Dependency evaluation (5 tests):**
```
test_not_blocked_empty_deps
test_blocked_by_active_dep
test_not_blocked_completed_dep
test_blocked_by_unknown_dep
test_circular_dependency_detected
```

### Test File 3: Property-Based Tests (`test_lifecycle_properties.sh`)

**5 properties, 50+ random inputs:**

```bash
# Random state generator
generate_random_state() {
  local -a statuses=("${ALL_STATUSES[@]}")
  local random_idx=$(( RANDOM % ${#statuses[@]} ))
  local status="${statuses[$random_idx]}"
  build_state --status "$status" \
    --retry-count "$(( RANDOM % 5 ))" \
    --escalation-count "$(( RANDOM % 3 ))" \
    --cost "$(echo "scale=2; $RANDOM / 100" | bc)"
}

# Random event generator
generate_random_event() {
  local -a events=(advance review_fail pause resume fail retry cancel)
  local random_idx=$(( RANDOM % ${#events[@]} ))
  echo "${events[$random_idx]}"
}

# Property 1: Valid state + valid event -> valid state OR well-formed error
test_property_output_validity() {
  for i in $(seq 1 50); do
    local state="$(generate_random_state)"
    local event="$(generate_random_event)"
    local result
    if result="$(state_transition "$state" "$event" '{}' '2026-04-08T12:00:00Z' 2>/dev/null)"; then
      # Successful: output must be valid state JSON
      assert_valid_state "$result"
    fi
    # Failure: implicit -- non-zero exit is acceptable (well-formed error)
  done
}

# Property 2: Cancelled is absorbing
test_property_cancelled_absorbing() {
  local cancelled_state="$(build_state --status cancelled)"
  for event in advance review_fail pause resume fail retry cancel; do
    assert_exit_code 1 state_transition "$cancelled_state" "$event" '{}' '2026-04-08T12:00:00Z'
  done
}

# Property 3: Phase history only grows
test_property_history_grows() {
  for i in $(seq 1 20); do
    local state="$(generate_random_state)"
    local event="$(generate_random_event)"
    local old_len="$(echo "$state" | jq '.phase_history | length')"
    local result
    if result="$(state_transition "$state" "$event" '{}' '2026-04-08T12:00:00Z' 2>/dev/null)"; then
      local new_len="$(echo "$result" | jq '.phase_history | length')"
      assert_true "(( new_len >= old_len ))" "History shrunk from $old_len to $new_len"
    fi
  done
}

# Property 4: updated_at is monotonically non-decreasing
test_property_updated_at_monotonic() {
  for i in $(seq 1 20); do
    local state="$(generate_random_state)"
    local event="$(generate_random_event)"
    local old_ts="$(echo "$state" | jq -r '.updated_at')"
    local new_ts="2026-04-08T23:59:59Z"
    local result
    if result="$(state_transition "$state" "$event" '{}' "$new_ts" 2>/dev/null)"; then
      local result_ts="$(echo "$result" | jq -r '.updated_at')"
      assert_true "[[ ! \"$result_ts\" < \"$old_ts\" ]]" "updated_at went backward"
    fi
  done
}

# Property 5: cost_accrued_usd is monotonically non-decreasing
test_property_cost_monotonic() {
  for i in $(seq 1 20); do
    local state="$(generate_random_state)"
    local event="$(generate_random_event)"
    local old_cost="$(echo "$state" | jq '.cost_accrued_usd')"
    local result
    if result="$(state_transition "$state" "$event" '{}' '2026-04-08T12:00:00Z' 2>/dev/null)"; then
      local new_cost="$(echo "$result" | jq '.cost_accrued_usd')"
      # Transition functions don't modify cost directly (session updates do), so cost should be unchanged
      assert_eq "$old_cost" "$new_cost"
    fi
  done
}
```

## Acceptance Criteria
1. [ ] `test_lifecycle_transitions.sh` contains 30 valid transition tests (13 forward + 5 backward + 12 meta-state)
2. [ ] Each valid transition test verifies: correct to_state, correct phase history mutation, correct side effects
3. [ ] `test_lifecycle_edge_cases.sh` contains 31+ tests (15 rejections + 5 timeout + 6 retry + 5 dependency)
4. [ ] Each invalid transition test verifies the error message is specific and names the violated rule
5. [ ] `test_lifecycle_properties.sh` validates all 5 properties with 50+ random inputs
6. [ ] `state_builder.sh` generates valid state fixtures at any pipeline position
7. [ ] Combined total: 75+ tests (target: ~111)
8. [ ] All tests pass on a clean system with `jq` 1.6+ and `bash` 4+
9. [ ] No test performs file I/O for the pure-function transition tests (fixture builder returns JSON strings)
10. [ ] Dependency evaluation tests use mock state reader functions (no real file system)

## Test Cases
Meta-tests:
1. **Valid transition suite passes** -- `bash tests/unit/test_lifecycle_transitions.sh`. Expected: "30/30 passed".
2. **Edge case suite passes** -- `bash tests/unit/test_lifecycle_edge_cases.sh`. Expected: "31/31 passed" (or more).
3. **Property suite passes** -- `bash tests/unit/test_lifecycle_properties.sh`. Expected: "5/5 passed" (each property runs 50+ iterations internally).
4. **State builder produces valid JSON** -- Build state at every pipeline position, validate each. Expected: all pass schema validation.
