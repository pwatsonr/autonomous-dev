# SPEC-002-3-01: Transition Dispatcher and Forward Transitions

## Metadata
- **Parent Plan**: PLAN-002-3
- **Tasks Covered**: Task 1 (Implement the transition dispatcher `state_transition()`), Task 2 (Implement forward transitions)
- **Estimated effort**: 8 hours

## Description
Implement the core of the Lifecycle Engine: the transition dispatcher `state_transition()` that routes events to handlers, and the 13 forward transition handlers that advance requests through the sequential pipeline from `intake` to `monitor`. This is the most critical code in TDD-002 -- it must be a pure function (no file I/O, no side effects) that deterministically transforms state JSON given an event.

## Files to Create/Modify
- **Path**: `lib/state/lifecycle_engine.sh`
- **Action**: Create
- **Description**: The Lifecycle Engine library. Contains `state_transition()` (the central dispatcher) and all transition handler functions. Pure functions only -- no file I/O. Sources `state_file_manager.sh` only for constants (PIPELINE_ORDER, ALL_STATUSES).

## Implementation Details

### File Header

```bash
#!/usr/bin/env bash
# lifecycle_engine.sh -- Pure-function state transition logic
# Part of TDD-002: State Machine & Request Lifecycle
#
# IMPORTANT: All functions in this file are PURE FUNCTIONS.
# They accept JSON on arguments and produce JSON on stdout.
# They do NOT read or write files, append events, or create checkpoints.
# File I/O is the responsibility of supervisor_interface.sh.
#
# Dependencies: jq (1.6+)
# Sources: state_file_manager.sh (for constants only)

set -euo pipefail

_LE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${_LE_DIR}/state_file_manager.sh"

# Forward transition lookup table (from_state -> to_state)
declare -A FORWARD_TRANSITIONS=(
  [intake]=prd
  [prd]=prd_review
  [prd_review]=tdd
  [tdd]=tdd_review
  [tdd_review]=plan
  [plan]=plan_review
  [plan_review]=spec
  [spec]=spec_review
  [spec_review]=code
  [code]=code_review
  [code_review]=integration
  [integration]=deploy
  [deploy]=monitor
)

# Review-to-generation regression lookup (review_state -> generation_state)
declare -A REVIEW_REGRESSIONS=(
  [prd_review]=prd
  [tdd_review]=tdd
  [plan_review]=plan
  [spec_review]=spec
  [code_review]=code
)
```

### `state_transition(current_state_json, event_type, metadata_json, timestamp)`

```bash
# state_transition -- Central transition dispatcher (PURE FUNCTION)
#
# Arguments:
#   $1 -- current_state_json: Complete state JSON string
#   $2 -- event_type:         One of: advance, review_fail, pause, resume, fail, retry, cancel
#   $3 -- metadata_json:      Event-specific metadata JSON string (or "{}")
#   $4 -- timestamp:          ISO-8601 UTC timestamp for the transition
#
# Stdout:
#   New state JSON on success
#
# Stderr:
#   Error message on failure
#
# Returns:
#   0 on success (new state JSON on stdout)
#   1 on invalid transition (error on stderr)
#
# Pure function guarantee:
#   Given identical inputs, always produces identical output.
#   No file I/O, no network calls, no global state mutation.
state_transition() {
  local current_state_json="$1"
  local event_type="$2"
  local metadata_json="${3:-\{\}}"
  local timestamp="$4"

  # Validate inputs
  if [[ -z "$current_state_json" || -z "$event_type" || -z "$timestamp" ]]; then
    echo "state_transition: missing required arguments" >&2
    return 1
  fi

  # Parse current status
  local current_status
  current_status="$(echo "$current_state_json" | jq -r '.status')"

  # Rule 6: Terminal state immutability
  if [[ "$current_status" == "cancelled" ]]; then
    echo "state_transition: cannot transition from cancelled (terminal state)" >&2
    return 1
  fi

  # Dispatch to handler
  case "$event_type" in
    advance)
      _handle_advance "$current_state_json" "$metadata_json" "$timestamp"
      ;;
    review_fail)
      _handle_review_fail "$current_state_json" "$metadata_json" "$timestamp"
      ;;
    pause)
      _handle_pause "$current_state_json" "$metadata_json" "$timestamp"
      ;;
    resume)
      _handle_resume "$current_state_json" "$metadata_json" "$timestamp"
      ;;
    fail)
      _handle_fail "$current_state_json" "$metadata_json" "$timestamp"
      ;;
    retry)
      _handle_retry "$current_state_json" "$metadata_json" "$timestamp"
      ;;
    cancel)
      _handle_cancel "$current_state_json" "$metadata_json" "$timestamp"
      ;;
    *)
      echo "state_transition: unrecognized event_type: ${event_type}" >&2
      return 1
      ;;
  esac
}
```

### `_handle_advance(state_json, metadata_json, timestamp)`

Implements all 13 forward transitions from TDD Section 5.1.

```bash
# _handle_advance -- Process an "advance" event (forward transition)
#
# Validates:
#   - Current status has a forward successor (not monitor, not meta-state)
#   - Status is not paused or failed (must be an active pipeline state)
#   - No state skipping (implicit -- lookup table enforces adjacency)
#
# State mutations:
#   1. Set status to the next state in pipeline order
#   2. Close current phase history entry: set exited_at, exit_reason
#   3. Append new phase history entry: entered_at=timestamp, exited_at=null
#   4. Update last_checkpoint to the PREVIOUS state (the one just completed)
#   5. Clear and repopulate current_phase_metadata
#   6. Update updated_at to timestamp
#
# Exit reasons by source state:
#   - _review states: "review_pass"
#   - All other states: "completed"
_handle_advance() {
  local state_json="$1"
  local metadata_json="$2"
  local timestamp="$3"

  local current_status
  current_status="$(echo "$state_json" | jq -r '.status')"

  # Check for valid forward transition
  if [[ -z "${FORWARD_TRANSITIONS[$current_status]+x}" ]]; then
    echo "_handle_advance: no forward transition from '${current_status}'" >&2
    return 1
  fi

  # Cannot advance from meta-states
  if [[ "$current_status" == "paused" || "$current_status" == "failed" ]]; then
    echo "_handle_advance: cannot advance from meta-state '${current_status}'" >&2
    return 1
  fi

  local next_status="${FORWARD_TRANSITIONS[$current_status]}"

  # Determine exit reason
  local exit_reason="completed"
  if [[ "$current_status" == *"_review" ]]; then
    exit_reason="review_pass"
  fi

  # Build the new state
  echo "$state_json" | jq \
    --arg next_status "$next_status" \
    --arg timestamp "$timestamp" \
    --arg exit_reason "$exit_reason" \
    --arg prev_status "$current_status" \
    --argjson metadata "$metadata_json" \
    '
    # Close current phase history entry
    .phase_history[-1].exited_at = $timestamp |
    .phase_history[-1].exit_reason = $exit_reason |

    # Append new phase history entry
    .phase_history += [{
      state: $next_status,
      entered_at: $timestamp,
      exited_at: null,
      session_id: null,
      turns_used: 0,
      cost_usd: 0,
      retry_count: 0,
      exit_reason: null
    }] |

    # Update state fields
    .status = $next_status |
    .updated_at = $timestamp |
    .last_checkpoint = $prev_status |

    # Clear and repopulate current_phase_metadata
    .current_phase_metadata = ($metadata // {})
    '
}
```

### Pipeline Order and Skip Prevention

The `FORWARD_TRANSITIONS` associative array inherently prevents state skipping: each state maps to exactly one successor. There is no path from `intake` to `tdd` that bypasses `prd` and `prd_review`. The dispatcher simply looks up the current status in the table; if there is no entry, the transition is rejected.

### Phase History Entry Lifecycle

On every `advance`:
1. The **current** (last) phase history entry gets `exited_at` set to the transition timestamp and `exit_reason` set to `"completed"` or `"review_pass"`.
2. A **new** entry is appended with `entered_at` = timestamp, `exited_at` = null, all counters at 0, `exit_reason` = null.
3. Phase history entries are **never removed** (Property 3 from TDD Section 10.3).

### `last_checkpoint` Update

On every forward transition, `last_checkpoint` is set to the **previous** state (the one that was just exited). This provides a restore point if the next phase fails.

### `current_phase_metadata` Lifecycle

On every transition:
1. The old `current_phase_metadata` is **discarded** (not preserved in history -- phase history entries are the record).
2. The new `current_phase_metadata` is populated from the `metadata_json` argument. If the caller provides no metadata, it defaults to `{}`.

## Acceptance Criteria
1. [ ] `state_transition()` dispatches to the correct handler based on `event_type`
2. [ ] `state_transition()` returns well-formed error for unrecognized event types
3. [ ] `state_transition()` rejects all transitions from `cancelled` state
4. [ ] `state_transition()` updates `updated_at` on every successful transition
5. [ ] `state_transition()` is a pure function: same inputs always produce same outputs
6. [ ] All 13 forward transitions produce the correct `to_state` per the pipeline order
7. [ ] Forward transition from `monitor` is rejected (no successor)
8. [ ] Forward transition from `paused` or `failed` is rejected
9. [ ] Previous phase history entry gets `exited_at` set and correct `exit_reason`
10. [ ] New phase history entry is appended with `entered_at`, null `exited_at`, zero counters
11. [ ] `last_checkpoint` is updated to the previous state on each advance
12. [ ] `current_phase_metadata` is cleared and repopulated from metadata argument
13. [ ] Skipping states (e.g., `intake` -> `tdd`) returns error
14. [ ] `_review` states produce `exit_reason: "review_pass"`, others produce `"completed"`

## Test Cases
1. **Dispatch advance** -- Transition `intake` + `advance`. Assertion: new state has `status: "prd"`.
2. **Dispatch unknown event** -- Transition with `event_type: "bogus"`. Assertion: returns 1, error mentions "unrecognized".
3. **All 13 forward transitions** -- For each pair in pipeline order, apply `advance`. Assertions per pair:
   - `intake` -> `prd`: exit_reason `completed`, new entry state `prd`
   - `prd` -> `prd_review`: exit_reason `completed`
   - `prd_review` -> `tdd`: exit_reason `review_pass`
   - `tdd` -> `tdd_review`: exit_reason `completed`
   - `tdd_review` -> `plan`: exit_reason `review_pass`
   - `plan` -> `plan_review`: exit_reason `completed`
   - `plan_review` -> `spec`: exit_reason `review_pass`
   - `spec` -> `spec_review`: exit_reason `completed`
   - `spec_review` -> `code`: exit_reason `review_pass`
   - `code` -> `code_review`: exit_reason `completed`
   - `code_review` -> `integration`: exit_reason `review_pass`
   - `integration` -> `deploy`: exit_reason `completed`
   - `deploy` -> `monitor`: exit_reason `completed`
4. **Advance from monitor rejected** -- `state_transition(monitor_state, advance)`. Assertion: returns 1, error mentions "no forward transition".
5. **Advance from cancelled rejected** -- `state_transition(cancelled_state, advance)`. Assertion: returns 1, error mentions "terminal state".
6. **Phase history grows** -- Start with 1 entry, advance once. Assertion: phase_history has 2 entries.
7. **Phase history previous entry closed** -- After advance, check `phase_history[-2]`. Assertion: `exited_at` is set, `exit_reason` is set.
8. **last_checkpoint updated** -- Advance from `prd` to `prd_review`. Assertion: `last_checkpoint` is `"prd"`.
9. **current_phase_metadata cleared** -- Start with metadata `{"foo": "bar"}`, advance with metadata `{"baz": "qux"}`. Assertion: new state has `current_phase_metadata: {"baz": "qux"}`, no `foo` key.
10. **updated_at changes** -- Advance with a new timestamp. Assertion: `updated_at` equals the new timestamp.
11. **Pure function determinism** -- Call `state_transition` twice with identical inputs. Assertion: outputs are identical (byte-for-byte after formatting).
12. **Skip state rejected** -- Build state at `intake`, try to force `tdd` via advance (advance only goes to next, so this test confirms advance from `intake` goes to `prd`, never `tdd`). Assertion: no path to skip.
