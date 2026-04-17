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

# Source guard
if [[ -n "${_LIFECYCLE_ENGINE_LOADED:-}" ]]; then return 0 2>/dev/null || true; fi
_LIFECYCLE_ENGINE_LOADED=1

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

  # Cannot advance from meta-states
  if [[ "$current_status" == "paused" || "$current_status" == "failed" ]]; then
    echo "_handle_advance: cannot advance from meta-state '${current_status}'" >&2
    return 1
  fi

  # Check for valid forward transition
  if [[ -z "${FORWARD_TRANSITIONS[$current_status]+x}" ]]; then
    echo "_handle_advance: no forward transition from '${current_status}'" >&2
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

# _handle_review_fail -- Process a "review_fail" event (backward transition)
#
# Valid from: prd_review, tdd_review, plan_review, spec_review, code_review
# Transitions to: prd, tdd, plan, spec, code (respectively)
#
# Preconditions:
#   - Current status must be a _review state
#   - retry_count < max_retries for the review phase
#
# State mutations:
#   1. If retry_count >= max_retries: trigger pause (escalation) instead
#   2. Close current phase history entry (exit_reason: "review_fail")
#   3. Append new entry for generation state with retry_count incremented
#   4. Preserve review_feedback in current_phase_metadata
#   5. Set status to generation state
#   6. Increment escalation_count if escalating to paused
#
# Arguments:
#   $1 -- state_json
#   $2 -- metadata_json: Expected to contain "review_feedback", "max_retries"
#   $3 -- timestamp
_handle_review_fail() {
  local state_json="$1"
  local metadata_json="$2"
  local timestamp="$3"

  local current_status
  current_status="$(echo "$state_json" | jq -r '.status')"

  # Validate: must be a review state
  if [[ -z "${REVIEW_REGRESSIONS[$current_status]+x}" ]]; then
    echo "_handle_review_fail: review_fail only valid from _review states, current: ${current_status}" >&2
    return 1
  fi

  local target_state="${REVIEW_REGRESSIONS[$current_status]}"

  # Get current retry count from the current phase history entry
  local current_retry_count
  current_retry_count="$(echo "$state_json" | jq '.phase_history[-1].retry_count // 0')"

  # Get max_retries from metadata (caller must provide) or default to 3
  local max_retries
  max_retries="$(echo "$metadata_json" | jq '.max_retries // 3')"

  # Check retry exhaustion
  if (( current_retry_count >= max_retries )); then
    # Escalate to paused instead of regressing
    echo "_handle_review_fail: retries exhausted (${current_retry_count}/${max_retries}), escalating to paused" >&2
    local pause_metadata
    pause_metadata="$(jq -n \
      --arg reason "review_retries_exhausted" \
      --arg phase "$current_status" \
      --argjson retry_count "$current_retry_count" \
      '{reason: $reason, phase: $phase, retry_count: $retry_count}')"
    _handle_pause "$state_json" "$pause_metadata" "$timestamp"
    return $?
  fi

  # Extract review feedback for passing to generation state
  local review_feedback
  review_feedback="$(echo "$metadata_json" | jq -r '.review_feedback // ""')"

  local new_retry_count=$(( current_retry_count + 1 ))

  echo "$state_json" | jq \
    --arg target "$target_state" \
    --arg timestamp "$timestamp" \
    --argjson new_retry "$new_retry_count" \
    --arg review_feedback "$review_feedback" \
    '
    # Close current review phase entry
    .phase_history[-1].exited_at = $timestamp |
    .phase_history[-1].exit_reason = "review_fail" |

    # Append new generation phase entry with incremented retry
    .phase_history += [{
      state: $target,
      entered_at: $timestamp,
      exited_at: null,
      session_id: null,
      turns_used: 0,
      cost_usd: 0,
      retry_count: $new_retry,
      exit_reason: null
    }] |

    # Update state
    .status = $target |
    .updated_at = $timestamp |

    # Preserve review feedback in current_phase_metadata
    .current_phase_metadata = {
      review_feedback: $review_feedback
    }
    '
}

# _handle_pause -- Process a "pause" event
#
# Valid from: Any state except cancelled
# Transitions to: paused
#
# State mutations:
#   1. Set status to "paused"
#   2. Set paused_from to the current status
#   3. Set paused_reason from metadata
#   4. Increment escalation_count if review-triggered
#   5. Close current phase history entry (exit_reason: "paused")
#   6. Append new "paused" phase history entry
_handle_pause() {
  local state_json="$1"
  local metadata_json="$2"
  local timestamp="$3"

  local current_status
  current_status="$(echo "$state_json" | jq -r '.status')"

  # Already paused?
  if [[ "$current_status" == "paused" ]]; then
    echo "_handle_pause: already paused" >&2
    return 1
  fi

  local paused_reason
  paused_reason="$(echo "$metadata_json" | jq -r '.reason // "manual_pause"')"

  # Determine if this is review-triggered (should increment escalation_count)
  local is_review_triggered=false
  if [[ "$paused_reason" == "review_retries_exhausted" ]]; then
    is_review_triggered=true
  fi

  echo "$state_json" | jq \
    --arg timestamp "$timestamp" \
    --arg paused_from "$current_status" \
    --arg paused_reason "$paused_reason" \
    --argjson increment_escalation "$( [[ "$is_review_triggered" == "true" ]] && echo 1 || echo 0 )" \
    '
    # Close current phase entry
    .phase_history[-1].exited_at = $timestamp |
    .phase_history[-1].exit_reason = "paused" |

    # Append paused phase entry
    .phase_history += [{
      state: "paused",
      entered_at: $timestamp,
      exited_at: null,
      session_id: null,
      turns_used: 0,
      cost_usd: 0,
      retry_count: 0,
      exit_reason: null
    }] |

    .status = "paused" |
    .paused_from = $paused_from |
    .paused_reason = $paused_reason |
    .updated_at = $timestamp |
    .escalation_count = (.escalation_count + $increment_escalation)
    '
}

# _handle_resume -- Process a "resume" event
#
# Valid from: paused ONLY
# Transitions to: the state stored in paused_from
#
# State mutations:
#   1. Restore status to paused_from
#   2. Clear paused_from and paused_reason
#   3. Close paused phase history entry
#   4. Append new entry for the restored state
_handle_resume() {
  local state_json="$1"
  local metadata_json="$2"
  local timestamp="$3"

  local current_status
  current_status="$(echo "$state_json" | jq -r '.status')"

  if [[ "$current_status" != "paused" ]]; then
    echo "_handle_resume: resume only valid from paused, current: ${current_status}" >&2
    return 1
  fi

  local paused_from
  paused_from="$(echo "$state_json" | jq -r '.paused_from')"

  if [[ -z "$paused_from" || "$paused_from" == "null" ]]; then
    echo "_handle_resume: paused_from is not set, cannot determine resume target" >&2
    return 1
  fi

  echo "$state_json" | jq \
    --arg timestamp "$timestamp" \
    --arg restore_status "$paused_from" \
    '
    # Close paused phase entry
    .phase_history[-1].exited_at = $timestamp |
    .phase_history[-1].exit_reason = "completed" |

    # Append restored state entry
    .phase_history += [{
      state: $restore_status,
      entered_at: $timestamp,
      exited_at: null,
      session_id: null,
      turns_used: 0,
      cost_usd: 0,
      retry_count: 0,
      exit_reason: null
    }] |

    .status = $restore_status |
    .paused_from = null |
    .paused_reason = null |
    .updated_at = $timestamp
    '
}

# _handle_fail -- Process a "fail" event
#
# Valid from: Any state except cancelled
# Transitions to: failed
#
# State mutations:
#   1. Set status to "failed"
#   2. Populate error object from metadata (code, message, phase, timestamp)
#   3. Set failure_reason from metadata
#   4. Close current phase history entry (exit_reason: "error")
#   5. Append new "failed" phase history entry
_handle_fail() {
  local state_json="$1"
  local metadata_json="$2"
  local timestamp="$3"

  local current_status
  current_status="$(echo "$state_json" | jq -r '.status')"

  echo "$state_json" | jq \
    --arg timestamp "$timestamp" \
    --argjson metadata "$metadata_json" \
    --arg current_status "$current_status" \
    '
    # Close current phase entry
    .phase_history[-1].exited_at = $timestamp |
    .phase_history[-1].exit_reason = "error" |

    # Append failed phase entry
    .phase_history += [{
      state: "failed",
      entered_at: $timestamp,
      exited_at: null,
      session_id: null,
      turns_used: 0,
      cost_usd: 0,
      retry_count: 0,
      exit_reason: null
    }] |

    .status = "failed" |
    .failure_reason = ($metadata.reason // "unknown") |
    .error = {
      message: ($metadata.message // "Request failed"),
      code: ($metadata.code // "unknown"),
      phase: $current_status,
      timestamp: $timestamp,
      session_id: ($metadata.session_id // null),
      details: ($metadata.details // {})
    } |
    .updated_at = $timestamp
    '
}

# _handle_retry -- Process a "retry" event
#
# Valid from: failed ONLY, and only when last_checkpoint is set
# Transitions to: the state stored in last_checkpoint
#
# State mutations:
#   1. Restore status to last_checkpoint
#   2. Clear error and failure_reason
#   3. Reset retry count for the target phase to 0
#   4. Close failed phase entry, append new entry for checkpoint state
_handle_retry() {
  local state_json="$1"
  local metadata_json="$2"
  local timestamp="$3"

  local current_status
  current_status="$(echo "$state_json" | jq -r '.status')"

  if [[ "$current_status" != "failed" ]]; then
    echo "_handle_retry: retry only valid from failed, current: ${current_status}" >&2
    return 1
  fi

  local last_checkpoint
  last_checkpoint="$(echo "$state_json" | jq -r '.last_checkpoint')"

  if [[ -z "$last_checkpoint" || "$last_checkpoint" == "null" ]]; then
    echo "_handle_retry: no checkpoint available for retry" >&2
    return 1
  fi

  echo "$state_json" | jq \
    --arg timestamp "$timestamp" \
    --arg checkpoint "$last_checkpoint" \
    '
    # Close failed phase entry
    .phase_history[-1].exited_at = $timestamp |
    .phase_history[-1].exit_reason = "completed" |

    # Append new entry for checkpoint state
    .phase_history += [{
      state: $checkpoint,
      entered_at: $timestamp,
      exited_at: null,
      session_id: null,
      turns_used: 0,
      cost_usd: 0,
      retry_count: 0,
      exit_reason: null
    }] |

    .status = $checkpoint |
    .error = null |
    .failure_reason = null |
    .updated_at = $timestamp
    '
}

# _handle_cancel -- Process a "cancel" event
#
# Valid from: Any state except cancelled
# Transitions to: cancelled (terminal)
#
# State mutations:
#   1. Set status to "cancelled"
#   2. Close current phase history entry (exit_reason: "cancelled")
#   3. Append "cancelled" phase history entry
_handle_cancel() {
  local state_json="$1"
  local metadata_json="$2"
  local timestamp="$3"

  echo "$state_json" | jq \
    --arg timestamp "$timestamp" \
    '
    .phase_history[-1].exited_at = $timestamp |
    .phase_history[-1].exit_reason = "cancelled" |

    .phase_history += [{
      state: "cancelled",
      entered_at: $timestamp,
      exited_at: null,
      session_id: null,
      turns_used: 0,
      cost_usd: 0,
      retry_count: 0,
      exit_reason: null
    }] |

    .status = "cancelled" |
    .updated_at = $timestamp
    '
}

# get_next_state -- Look up the forward successor for a given state (utility)
#
# Arguments:
#   $1 -- current_status: A pipeline state name
#
# Stdout:
#   The next state name, or empty string if none
#
# Returns:
#   0 if a successor exists
#   1 if no successor (terminal/unknown state)
get_next_state() {
  local current_status="$1"
  if [[ -n "${FORWARD_TRANSITIONS[$current_status]+x}" ]]; then
    echo "${FORWARD_TRANSITIONS[$current_status]}"
    return 0
  fi
  return 1
}

# get_review_regression_target -- Look up the regression target for a review state (utility)
#
# Arguments:
#   $1 -- review_status: A review state name
#
# Stdout:
#   The generation state to regress to, or empty string if not a review state
#
# Returns:
#   0 if this is a review state
#   1 if not a review state
get_review_regression_target() {
  local review_status="$1"
  if [[ -n "${REVIEW_REGRESSIONS[$review_status]+x}" ]]; then
    echo "${REVIEW_REGRESSIONS[$review_status]}"
    return 0
  fi
  return 1
}

# is_review_state -- Check if a state is a review state (utility)
#
# Arguments:
#   $1 -- status: A state name
#
# Returns:
#   0 if it is a review state
#   1 if not
is_review_state() {
  local status="$1"
  [[ -n "${REVIEW_REGRESSIONS[$status]+x}" ]]
}

# is_terminal_state -- Check if a state is terminal (utility)
#
# Arguments:
#   $1 -- status: A state name
#
# Returns:
#   0 if terminal (cancelled)
#   1 if not
is_terminal_state() {
  local status="$1"
  [[ "$status" == "cancelled" ]]
}

# is_meta_state -- Check if a state is a meta-state (utility)
#
# Arguments:
#   $1 -- status: A state name
#
# Returns:
#   0 if meta-state (paused, failed, cancelled)
#   1 if not
is_meta_state() {
  local status="$1"
  [[ "$status" == "paused" || "$status" == "failed" || "$status" == "cancelled" ]]
}

# get_pipeline_index -- Get the zero-based index of a state in pipeline order (utility)
#
# Arguments:
#   $1 -- status: A pipeline state name
#
# Stdout:
#   The zero-based index
#
# Returns:
#   0 if found
#   1 if not a pipeline state
get_pipeline_index() {
  local status="$1"
  local i
  for ((i=0; i<${#PIPELINE_ORDER[@]}; i++)); do
    if [[ "${PIPELINE_ORDER[$i]}" == "$status" ]]; then
      echo "$i"
      return 0
    fi
  done
  return 1
}

# =============================================================================
# SPEC-002-3-03: Timeout Enforcement, Retry Accounting, Dependency Evaluation
# =============================================================================

# _timestamp_to_epoch -- Convert ISO-8601 UTC timestamp to epoch seconds
#
# Arguments:
#   $1 -- timestamp: ISO-8601 string (e.g., "2026-04-08T09:15:00Z")
#
# Stdout:
#   Epoch seconds as integer
#
# Portability:
#   macOS: date -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts" "+%s"
#   Linux: date -d "$ts" "+%s"
_timestamp_to_epoch() {
  local ts="$1"
  if date -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts" "+%s" 2>/dev/null; then
    return 0
  elif date -d "$ts" "+%s" 2>/dev/null; then
    return 0
  else
    echo "0"
    return 1
  fi
}

# check_phase_timeout -- Determine if the current phase has exceeded its timeout
#
# Arguments:
#   $1 -- state_json:         Complete state JSON
#   $2 -- timeouts_json:      JSON object mapping phase names to timeout seconds
#                              e.g., {"prd": 3600, "prd_review": 1800, "monitor": -1}
#                              -1 means indefinite (no timeout)
#   $3 -- current_timestamp:  ISO-8601 UTC timestamp (now)
#
# Stdout:
#   JSON object: {"timed_out": bool, "action": "retry"|"fail"|"pause"|"none",
#                 "elapsed_seconds": N, "timeout_seconds": N}
#
# Returns:
#   0 always (result is in the stdout JSON)
#
# Logic:
#   1. Get current phase from last phase_history entry
#   2. Look up timeout for that phase
#   3. If timeout is -1 (indefinite), return not timed out
#   4. Compute elapsed = current_timestamp - entered_at
#   5. If elapsed > timeout:
#      a. If retry_count < max_retries -> action: "retry"
#      b. If review phase -> action: "pause" (escalation)
#      c. Else -> action: "fail"
#   6. If not timed out -> action: "none"
check_phase_timeout() {
  local state_json="$1"
  local timeouts_json="$2"
  local current_timestamp="$3"

  local current_phase
  current_phase="$(echo "$state_json" | jq -r '.phase_history[-1].state')"

  local entered_at
  entered_at="$(echo "$state_json" | jq -r '.phase_history[-1].entered_at')"

  local retry_count
  retry_count="$(echo "$state_json" | jq '.phase_history[-1].retry_count // 0')"

  # Look up timeout for this phase (-1 = indefinite)
  local timeout_seconds
  timeout_seconds="$(echo "$timeouts_json" | jq --arg phase "$current_phase" '.[$phase] // 3600')"

  # Monitor is exempt
  if [[ "$current_phase" == "monitor" ]] || (( timeout_seconds < 0 )); then
    jq -n '{timed_out: false, action: "none", elapsed_seconds: 0, timeout_seconds: -1}'
    return 0
  fi

  # Convert timestamps to epoch seconds for comparison
  local entered_epoch current_epoch
  entered_epoch="$(_timestamp_to_epoch "$entered_at")"
  current_epoch="$(_timestamp_to_epoch "$current_timestamp")"

  local elapsed=$(( current_epoch - entered_epoch ))

  if (( elapsed > timeout_seconds )); then
    # Timed out -- determine action
    local max_retries
    max_retries="$(echo "$timeouts_json" | jq --arg phase "$current_phase" '.max_retries // 3')"

    local action
    if (( retry_count < max_retries )); then
      action="retry"
    elif [[ "$current_phase" == *"_review" ]]; then
      action="pause"
    else
      action="fail"
    fi

    jq -n \
      --argjson timed_out true \
      --arg action "$action" \
      --argjson elapsed "$elapsed" \
      --argjson timeout "$timeout_seconds" \
      '{timed_out: $timed_out, action: $action, elapsed_seconds: $elapsed, timeout_seconds: $timeout}'
  else
    jq -n \
      --argjson elapsed "$elapsed" \
      --argjson timeout "$timeout_seconds" \
      '{timed_out: false, action: "none", elapsed_seconds: $elapsed, timeout_seconds: $timeout}'
  fi
}

# get_retry_count -- Get the retry count for the current phase
#
# Arguments:
#   $1 -- state_json: Complete state JSON
#
# Stdout:
#   Integer retry count
get_retry_count() {
  local state_json="$1"
  echo "$state_json" | jq '.phase_history[-1].retry_count // 0'
}

# is_retry_exhausted -- Check if retries are exhausted for the current phase
#
# Arguments:
#   $1 -- state_json: Complete state JSON
#   $2 -- max_retries: Maximum allowed retries for this phase
#
# Returns:
#   0 if exhausted (retry_count >= max_retries)
#   1 if retries remain
is_retry_exhausted() {
  local state_json="$1"
  local max_retries="${2:-3}"

  local retry_count
  retry_count="$(get_retry_count "$state_json")"

  if (( retry_count >= max_retries )); then
    return 0
  else
    return 1
  fi
}

# Completed states for dependency evaluation
readonly -a COMPLETED_STATES=(deploy monitor cancelled)

# is_blocked -- Check if a request is blocked by its dependencies
#
# Arguments:
#   $1 -- state_json: Complete state JSON of the request to check
#   $2 -- state_reader_func: Name of a function that reads state JSON given a request ID
#          Signature: func(request_id) -> state_json on stdout, returns 0/non-zero
#          This indirection preserves the pure-function constraint:
#          the caller (supervisor_interface) provides the I/O function.
#
# Stdout:
#   JSON: {"blocked": bool, "blocking_ids": [...], "reason": "..."}
#
# Returns:
#   0 always (result in stdout JSON)
#
# Logic per TDD Section 3.4.5:
#   - Empty blocked_by -> not blocked
#   - For each dep_id in blocked_by:
#     - If dep state cannot be read -> blocked (unknown = blocked, safe default)
#     - If dep status NOT in {deploy, monitor, cancelled} -> blocked
#     - If dep status in {deploy, monitor, cancelled} -> not blocking
#   - If dep status is "failed" -> the blocked request should fail too
is_blocked() {
  local state_json="$1"
  local state_reader_func="$2"

  local blocked_by
  blocked_by="$(echo "$state_json" | jq -r '.blocked_by[]' 2>/dev/null)"

  if [[ -z "$blocked_by" ]]; then
    jq -n '{blocked: false, blocking_ids: [], reason: "no dependencies"}'
    return 0
  fi

  local -a blocking_ids=()
  local -a failed_ids=()

  while IFS= read -r dep_id; do
    [[ -z "$dep_id" ]] && continue

    local dep_state_json
    if ! dep_state_json="$("$state_reader_func" "$dep_id" 2>/dev/null)"; then
      # Cannot read -> treat as blocked (safe default)
      blocking_ids+=("$dep_id")
      continue
    fi

    local dep_status
    dep_status="$(echo "$dep_state_json" | jq -r '.status')"

    # Check if dependency is completed
    local is_completed=false
    for cs in "${COMPLETED_STATES[@]}"; do
      if [[ "$dep_status" == "$cs" ]]; then
        is_completed=true
        break
      fi
    done

    if [[ "$is_completed" == "false" ]]; then
      blocking_ids+=("$dep_id")
    fi

    if [[ "$dep_status" == "failed" ]]; then
      failed_ids+=("$dep_id")
    fi
  done <<< "$blocked_by"

  if [[ ${#failed_ids[@]} -gt 0 ]]; then
    local ids_json
    ids_json="$(printf '%s\n' "${failed_ids[@]}" | jq -R . | jq -s .)"
    jq -n --argjson ids "$ids_json" '{blocked: true, blocking_ids: $ids, reason: "dependency_failed"}'
  elif [[ ${#blocking_ids[@]} -gt 0 ]]; then
    local ids_json
    ids_json="$(printf '%s\n' "${blocking_ids[@]}" | jq -R . | jq -s .)"
    jq -n --argjson ids "$ids_json" '{blocked: true, blocking_ids: $ids, reason: "dependency_not_completed"}'
  else
    jq -n '{blocked: false, blocking_ids: [], reason: "all_dependencies_completed"}'
  fi
}

# detect_circular_dependencies -- Follow blocked_by chains to detect cycles
#
# Arguments:
#   $1 -- request_id: The starting request ID
#   $2 -- state_reader_func: Function to read state JSON by request ID
#   $3 -- max_depth: Maximum chain depth (default: 10)
#
# Returns:
#   0 if no cycle detected
#   1 if cycle detected (cycle path on stderr)
detect_circular_dependencies() {
  local request_id="$1"
  local state_reader_func="$2"
  local max_depth="${3:-10}"

  local -a visited=()

  _follow_dependency_chain "$request_id" "$state_reader_func" "$max_depth" visited
}

# _follow_dependency_chain -- Recursive helper for circular dependency detection
#
# Arguments:
#   $1 -- current_id: Current request ID being inspected
#   $2 -- state_reader_func: Function to read state JSON by request ID
#   $3 -- max_depth: Maximum chain depth
#   $4 -- visited_ref: Name of the visited array (nameref)
#
# Returns:
#   0 if no cycle detected in this branch
#   1 if cycle detected or depth exceeded
_follow_dependency_chain() {
  local current_id="$1"
  local state_reader_func="$2"
  local max_depth="$3"
  local -n visited_ref="$4"

  # Check depth limit
  if (( ${#visited_ref[@]} >= max_depth )); then
    echo "detect_circular_dependencies: chain depth exceeds ${max_depth}, possible cycle" >&2
    return 1
  fi

  # Check for cycle
  for v in "${visited_ref[@]}"; do
    if [[ "$v" == "$current_id" ]]; then
      echo "detect_circular_dependencies: cycle detected: ${visited_ref[*]} -> ${current_id}" >&2
      return 1
    fi
  done

  visited_ref+=("$current_id")

  # Read state for current request
  local state_json
  if ! state_json="$("$state_reader_func" "$current_id" 2>/dev/null)"; then
    return 0  # Cannot read state; not a cycle, just missing
  fi

  # Follow each dependency
  local deps
  deps="$(echo "$state_json" | jq -r '.blocked_by[]' 2>/dev/null)"
  while IFS= read -r dep_id; do
    [[ -z "$dep_id" ]] && continue
    if ! _follow_dependency_chain "$dep_id" "$state_reader_func" "$max_depth" visited_ref; then
      return 1
    fi
  done <<< "$deps"

  return 0
}

# =============================================================================
# SPEC-002-3-04: Automatic Error-State Transitions
# =============================================================================

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
