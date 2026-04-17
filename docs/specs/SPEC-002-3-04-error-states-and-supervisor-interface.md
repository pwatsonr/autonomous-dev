# SPEC-002-3-04: Automatic Error-State Transitions and Supervisor Integration Interface

## Metadata
- **Parent Plan**: PLAN-002-3
- **Tasks Covered**: Task 9 (Automatic error-state transitions), Task 10 (Supervisor integration interface)
- **Estimated effort**: 6 hours

## Description
Implement two components: (1) handlers for all automatic error-state transitions triggered by session crashes, timeouts, corruption, cost caps, kill switch, dependency failure, and rate limits (TDD Section 5.5), and (2) the public supervisor integration interface -- three functions (`process_request()`, `complete_phase()`, `handle_session_failure()`) that bridge the pure-function Lifecycle Engine to the file-I/O world of the supervisor loop. The supervisor interface is the ONLY place in the state machine subsystem where file reads, writes, checkpoints, and event appends occur.

## Files to Create/Modify
- **Path**: `lib/state/lifecycle_engine.sh`
- **Action**: Modify (append error-state transition handlers)
- **Description**: Add `trigger_error_transition()` that maps error triggers to the appropriate transition type (fail, pause, or retry).

- **Path**: `lib/state/supervisor_interface.sh`
- **Action**: Create
- **Description**: Supervisor integration layer. Sources all other state modules and provides `process_request()`, `complete_phase()`, `handle_session_failure()`. This is the ONLY module that does file I/O for state transitions.

## Implementation Details

### Error-State Transition Handler (`lifecycle_engine.sh`)

```bash
# trigger_error_transition -- Map an error trigger to the correct transition
#
# Arguments:
#   $1 -- state_json:    Current state JSON
#   $2 -- trigger:       Error trigger code (see table below)
#   $3 -- metadata_json: Additional error context
#   $4 -- timestamp:     ISO-8601 UTC timestamp
#
# Stdout:
#   New state JSON (result of the delegated transition)
#
# Returns:
#   0 on success
#   1 on failure
#
# Trigger codes and their target transitions (per TDD Section 5.5):
#   session_crash       -> retry (if retries remain) or fail
#   timeout             -> retry (if retries remain) or pause (if review) or fail
#   state_corruption    -> fail (always)
#   event_log_corruption -> fail (always)
#   cost_cap_exceeded   -> pause (always)
#   turn_budget_exceeded -> fail or pause (treated as timeout_exhausted)
#   kill_switch         -> pause (always)
#   dependency_failed   -> fail (always)
#   rate_limited        -> pause (always)
trigger_error_transition() {
  local state_json="$1"
  local trigger="$2"
  local metadata_json="$3"
  local timestamp="$4"

  local current_status
  current_status="$(echo "$state_json" | jq -r '.status')"

  local retry_count
  retry_count="$(get_retry_count "$state_json")"

  local max_retries
  max_retries="$(echo "$metadata_json" | jq '.max_retries // 3')"

  case "$trigger" in
    session_crash)
      if (( retry_count < max_retries )); then
        local error_meta
        error_meta="$(echo "$metadata_json" | jq --arg code "session_crash" '. + {code: $code}')"
        # Re-enter the same phase (retry semantics handled by supervisor)
        # Return current state with incremented retry count
        _reenter_current_phase "$state_json" "$error_meta" "$timestamp"
      else
        _handle_fail "$state_json" "$(echo "$metadata_json" | jq '. + {code: "session_crash", reason: "session_crash_retries_exhausted"}')" "$timestamp"
      fi
      ;;

    timeout)
      if (( retry_count < max_retries )); then
        _reenter_current_phase "$state_json" "$(echo "$metadata_json" | jq '. + {code: "timeout"}')" "$timestamp"
      elif [[ "$current_status" == *"_review" ]]; then
        _handle_pause "$state_json" "$(jq -n --arg reason "timeout_exhausted" '{reason: $reason}')" "$timestamp"
      else
        _handle_fail "$state_json" "$(echo "$metadata_json" | jq '. + {code: "timeout_exhausted", reason: "timeout_exhausted"}')" "$timestamp"
      fi
      ;;

    state_corruption)
      _handle_fail "$state_json" "$(jq -n '{code: "state_corruption", reason: "state_corruption", message: "State file failed validation"}')" "$timestamp"
      ;;

    event_log_corruption)
      _handle_fail "$state_json" "$(jq -n '{code: "event_log_corruption", reason: "event_log_corruption", message: "Event log has mid-file corruption"}')" "$timestamp"
      ;;

    cost_cap_exceeded)
      _handle_pause "$state_json" "$(jq -n '{reason: "per_request_cost_cap"}')" "$timestamp"
      ;;

    turn_budget_exceeded)
      _handle_fail "$state_json" "$(echo "$metadata_json" | jq '. + {code: "turn_budget_exceeded", reason: "turn_budget_exceeded"}')" "$timestamp"
      ;;

    kill_switch)
      _handle_pause "$state_json" "$(jq -n '{reason: "kill_switch"}')" "$timestamp"
      ;;

    dependency_failed)
      _handle_fail "$state_json" "$(echo "$metadata_json" | jq '. + {code: "dependency_failed", reason: "dependency_failed"}')" "$timestamp"
      ;;

    rate_limited)
      _handle_pause "$state_json" "$(jq -n '{reason: "rate_limited"}')" "$timestamp"
      ;;

    *)
      echo "trigger_error_transition: unknown trigger: ${trigger}" >&2
      return 1
      ;;
  esac
}

# _reenter_current_phase -- Re-enter the current phase with incremented retry count
#
# Used by error triggers that should retry the phase rather than failing.
#
# Arguments:
#   $1 -- state_json
#   $2 -- metadata_json
#   $3 -- timestamp
_reenter_current_phase() {
  local state_json="$1"
  local metadata_json="$2"
  local timestamp="$3"

  local current_phase
  current_phase="$(echo "$state_json" | jq -r '.phase_history[-1].state')"

  local retry_count
  retry_count="$(echo "$state_json" | jq '.phase_history[-1].retry_count // 0')"
  local new_retry=$(( retry_count + 1 ))

  echo "$state_json" | jq \
    --arg timestamp "$timestamp" \
    --arg phase "$current_phase" \
    --argjson new_retry "$new_retry" \
    '
    .phase_history[-1].exited_at = $timestamp |
    .phase_history[-1].exit_reason = "error" |

    .phase_history += [{
      state: $phase,
      entered_at: $timestamp,
      exited_at: null,
      session_id: null,
      turns_used: 0,
      cost_usd: 0,
      retry_count: $new_retry,
      exit_reason: null
    }] |

    .updated_at = $timestamp
    '
}
```

### Supervisor Integration Interface (`supervisor_interface.sh`)

```bash
#!/usr/bin/env bash
# supervisor_interface.sh -- Public API for the supervisor loop
# Part of TDD-002: State Machine & Request Lifecycle
#
# This is the ONLY module that performs file I/O for state transitions.
# All pure logic lives in lifecycle_engine.sh.
#
# Dependencies: jq (1.6+)
# Sources: state_file_manager.sh, event_logger.sh, request_tracker.sh, lifecycle_engine.sh

set -euo pipefail

_SI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${_SI_DIR}/state_file_manager.sh"
source "${_SI_DIR}/event_logger.sh"
source "${_SI_DIR}/request_tracker.sh"
source "${_SI_DIR}/lifecycle_engine.sh"
```

### `process_request(request_dir, timeouts_json, current_timestamp)`

```bash
# process_request -- Determine the next action for a request
#
# Arguments:
#   $1 -- request_dir:       Absolute path to the request directory
#   $2 -- timeouts_json:     Phase timeout configuration JSON
#   $3 -- current_timestamp: ISO-8601 UTC now
#
# Stdout:
#   JSON: {"action": "spawn"|"skip"|"wait"|"fail"|"retry"|"pause",
#          "request_id": "...", "phase": "...", "reason": "..."}
#
# Returns:
#   0 on success
#   1 on state read failure
#
# Logic:
#   1. Read state file (state_read)
#   2. If status is paused/failed/cancelled/monitor -> action: skip
#   3. Check if blocked (is_blocked) -> action: wait
#   4. Check timeout (check_phase_timeout)
#      a. If timed out and action=retry -> perform retry transition, action: spawn
#      b. If timed out and action=fail -> perform fail transition, action: skip
#      c. If timed out and action=pause -> perform pause transition, action: skip
#   5. Else -> action: spawn (ready for session)
process_request() {
  local request_dir="$1"
  local timeouts_json="$2"
  local current_timestamp="$3"

  # Read state
  local state_json
  if ! state_json="$(state_read "$request_dir")"; then
    echo "process_request: failed to read state for: ${request_dir}" >&2
    return 1
  fi

  local request_id
  request_id="$(echo "$state_json" | jq -r '.id')"

  local status
  status="$(echo "$state_json" | jq -r '.status')"

  local phase
  phase="$(echo "$state_json" | jq -r '.phase_history[-1].state')"

  # Skip non-actionable states
  case "$status" in
    paused|failed|cancelled|monitor)
      jq -n --arg id "$request_id" --arg phase "$phase" --arg reason "$status" \
        '{action: "skip", request_id: $id, phase: $phase, reason: $reason}'
      return 0
      ;;
  esac

  # Check blocked
  local block_result
  block_result="$(is_blocked "$state_json" "_read_dep_state")"
  local is_blocked_val
  is_blocked_val="$(echo "$block_result" | jq -r '.blocked')"

  if [[ "$is_blocked_val" == "true" ]]; then
    local block_reason
    block_reason="$(echo "$block_result" | jq -r '.reason')"

    if [[ "$block_reason" == "dependency_failed" ]]; then
      # Dependency failed -> fail this request
      local new_state
      new_state="$(trigger_error_transition "$state_json" "dependency_failed" '{}' "$current_timestamp")"
      state_write_atomic "$request_dir" "$new_state"
      _emit_event "$request_dir" "$request_id" "failed" "$status" "failed" "$current_timestamp" \
        "$(jq -n '{trigger: "dependency_failed"}')"
    fi

    jq -n --arg id "$request_id" --arg phase "$phase" --arg reason "blocked" \
      '{action: "wait", request_id: $id, phase: $phase, reason: $reason}'
    return 0
  fi

  # Check timeout
  local timeout_result
  timeout_result="$(check_phase_timeout "$state_json" "$timeouts_json" "$current_timestamp")"
  local timed_out
  timed_out="$(echo "$timeout_result" | jq -r '.timed_out')"

  if [[ "$timed_out" == "true" ]]; then
    local timeout_action
    timeout_action="$(echo "$timeout_result" | jq -r '.action')"

    local new_state
    new_state="$(trigger_error_transition "$state_json" "timeout" '{}' "$current_timestamp")"
    state_write_atomic "$request_dir" "$new_state"

    local new_status
    new_status="$(echo "$new_state" | jq -r '.status')"

    _emit_event "$request_dir" "$request_id" "timeout" "$status" "$new_status" "$current_timestamp" \
      "$(echo "$timeout_result" | jq '.')"

    case "$timeout_action" in
      retry)
        jq -n --arg id "$request_id" --arg phase "$phase" --arg reason "timeout_retry" \
          '{action: "spawn", request_id: $id, phase: $phase, reason: $reason}'
        ;;
      *)
        jq -n --arg id "$request_id" --arg phase "$phase" --arg reason "timeout_$timeout_action" \
          '{action: "skip", request_id: $id, phase: $phase, reason: $reason}'
        ;;
    esac
    return 0
  fi

  # Ready for session
  jq -n --arg id "$request_id" --arg phase "$phase" \
    '{action: "spawn", request_id: $id, phase: $phase, reason: "ready"}'
}
```

### `complete_phase(request_dir, metadata_json, timestamp)`

```bash
# complete_phase -- Advance a request after a successful session
#
# Arguments:
#   $1 -- request_dir:   Absolute path to the request directory
#   $2 -- metadata_json: Session results (turns_used, cost_usd, artifacts, etc.)
#   $3 -- timestamp:     ISO-8601 UTC timestamp
#
# Returns:
#   0 on success
#   1 on failure
#
# Behavior:
#   1. Read current state
#   2. Create checkpoint
#   3. Apply advance transition
#   4. Write new state atomically
#   5. Emit state_transition event
complete_phase() {
  local request_dir="$1"
  local metadata_json="$2"
  local timestamp="$3"

  local state_json
  state_json="$(state_read "$request_dir")" || return 1

  local request_id
  request_id="$(echo "$state_json" | jq -r '.id')"
  local from_status
  from_status="$(echo "$state_json" | jq -r '.status')"

  # Checkpoint before advancing
  state_checkpoint "$request_dir"

  # Apply transition
  local new_state
  if ! new_state="$(state_transition "$state_json" "advance" "$metadata_json" "$timestamp")"; then
    echo "complete_phase: transition failed" >&2
    return 1
  fi

  # Write new state
  state_write_atomic "$request_dir" "$new_state"

  local to_status
  to_status="$(echo "$new_state" | jq -r '.status')"

  # Emit event
  _emit_event "$request_dir" "$request_id" "state_transition" "$from_status" "$to_status" "$timestamp" \
    "$(echo "$metadata_json" | jq --arg trigger "advance" '. + {trigger: $trigger}')"

  return 0
}
```

### `handle_session_failure(request_dir, error_metadata_json, timestamp)`

```bash
# handle_session_failure -- Handle a session that exited with non-zero
#
# Arguments:
#   $1 -- request_dir:        Absolute path
#   $2 -- error_metadata_json: Error details (exit_code, stderr_tail, etc.)
#   $3 -- timestamp:           ISO-8601 UTC timestamp
#
# Returns:
#   0 on success
#   1 on failure
#
# Behavior:
#   1. Read current state
#   2. Apply error transition (retry or fail based on retry count)
#   3. Write new state atomically
#   4. Emit error event
handle_session_failure() {
  local request_dir="$1"
  local error_metadata_json="$2"
  local timestamp="$3"

  local state_json
  state_json="$(state_read "$request_dir")" || return 1

  local request_id
  request_id="$(echo "$state_json" | jq -r '.id')"
  local from_status
  from_status="$(echo "$state_json" | jq -r '.status')"

  local new_state
  if ! new_state="$(trigger_error_transition "$state_json" "session_crash" "$error_metadata_json" "$timestamp")"; then
    echo "handle_session_failure: error transition failed" >&2
    return 1
  fi

  state_write_atomic "$request_dir" "$new_state"

  local to_status
  to_status="$(echo "$new_state" | jq -r '.status')"

  _emit_event "$request_dir" "$request_id" "error" "$from_status" "$to_status" "$timestamp" \
    "$error_metadata_json"

  return 0
}
```

### Helper: `_emit_event`

```bash
# _emit_event -- Construct and append an event to the request's event log
_emit_event() {
  local request_dir="$1"
  local request_id="$2"
  local event_type="$3"
  local from_state="$4"
  local to_state="$5"
  local timestamp="$6"
  local metadata="$7"

  local event
  event="$(jq -n \
    --arg ts "$timestamp" \
    --arg et "$event_type" \
    --arg rid "$request_id" \
    --arg from "$from_state" \
    --arg to "$to_state" \
    --argjson meta "$metadata" \
    '{timestamp: $ts, event_type: $et, request_id: $rid, from_state: $from, to_state: $to, session_id: null, metadata: $meta}')"

  event_append "${request_dir}/events.jsonl" "$event"
}

# _read_dep_state -- Read state JSON for a dependency request ID
# Used as the state_reader_func argument to is_blocked()
_read_dep_state() {
  local dep_id="$1"
  # Search all repos for this request
  local -a repos=()
  if [[ -n "${REPO_ALLOWLIST+x}" ]]; then
    repos=("${REPO_ALLOWLIST[@]}")
  fi
  for repo in "${repos[@]}"; do
    local dep_dir="${repo}/.autonomous-dev/requests/${dep_id}"
    if [[ -d "$dep_dir" ]]; then
      state_read "$dep_dir"
      return $?
    fi
  done
  return 1
}
```

## Acceptance Criteria
1. [ ] `trigger_error_transition()` maps all 9 trigger codes to the correct target transition
2. [ ] `session_crash` retries when retries remain, fails when exhausted
3. [ ] `timeout` retries when retries remain, pauses for review phases, fails otherwise
4. [ ] `state_corruption` and `event_log_corruption` always fail
5. [ ] `cost_cap_exceeded`, `kill_switch`, and `rate_limited` always pause
6. [ ] `dependency_failed` always fails
7. [ ] Error objects are populated with correct `code`, `message`, `phase`, `timestamp`
8. [ ] `process_request()` returns correct action for each state category (active, paused, blocked, timed out)
9. [ ] `process_request()` reads state from disk and writes updated state on transitions
10. [ ] `complete_phase()` creates checkpoint, applies advance, writes state, emits event
11. [ ] `handle_session_failure()` applies error transition, writes state, emits event
12. [ ] All three supervisor functions emit events via `event_append()`
13. [ ] `_reenter_current_phase()` increments retry count correctly

## Test Cases
1. **Session crash, retries remain** -- trigger `session_crash`, retry_count 0, max 3. Assertion: same phase re-entered, retry_count 1.
2. **Session crash, retries exhausted** -- retry_count 3, max 3. Assertion: status `failed`.
3. **Timeout, retries remain** -- Assertion: same phase re-entered, retry_count incremented.
4. **Timeout exhausted, review phase** -- `prd_review`, retries exhausted. Assertion: status `paused`.
5. **Timeout exhausted, non-review** -- `code`, retries exhausted. Assertion: status `failed`.
6. **State corruption** -- Assertion: status `failed`, error code `state_corruption`.
7. **Event log corruption** -- Assertion: status `failed`, error code `event_log_corruption`.
8. **Cost cap exceeded** -- Assertion: status `paused`, reason `per_request_cost_cap`.
9. **Kill switch** -- Assertion: status `paused`, reason `kill_switch`.
10. **Dependency failed** -- Assertion: status `failed`, error code `dependency_failed`.
11. **Rate limited** -- Assertion: status `paused`, reason `rate_limited`.
12. **process_request skips paused** -- State at `paused`. Assertion: `action: "skip"`.
13. **process_request spawns active** -- State at `prd`, not blocked, not timed out. Assertion: `action: "spawn"`.
14. **process_request waits blocked** -- State at `intake`, blocked. Assertion: `action: "wait"`.
15. **complete_phase happy path** -- State at `prd`, call `complete_phase`. Assertion: state file now `prd_review`, checkpoint exists, event appended.
16. **handle_session_failure** -- State at `code`, call with exit_code 1. Assertion: state updated (retry or fail), event appended.
