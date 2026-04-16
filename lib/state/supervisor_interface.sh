#!/usr/bin/env bash
# supervisor_interface.sh -- Public API for the supervisor loop
# Part of TDD-002: State Machine & Request Lifecycle
# Spec: SPEC-002-3-04
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

# =============================================================================
# Helpers
# =============================================================================

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
