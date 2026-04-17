#!/usr/bin/env bash
# recovery.sh -- Crash recovery procedures
# Part of TDD-002: State Machine & Request Lifecycle
# Spec: SPEC-002-4-01
#
# Implements startup recovery scan, corrupt state detection with checkpoint
# fallback, orphaned resource detection, and stale heartbeat recovery.
#
# Dependencies: jq (1.6+), git
# Sources: state_file_manager.sh, event_logger.sh, request_tracker.sh, lifecycle_engine.sh

set -euo pipefail

# Source guard
if [[ -n "${_RECOVERY_LOADED:-}" ]]; then return 0 2>/dev/null || true; fi
_RECOVERY_LOADED=1

_REC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${_REC_DIR}/state_file_manager.sh"
source "${_REC_DIR}/event_logger.sh"
source "${_REC_DIR}/request_tracker.sh"
source "${_REC_DIR}/lifecycle_engine.sh"

# =============================================================================
# Split-Brain Prevention via PID-Based Lock
# =============================================================================

# _RECOVERY_LOCK_FILE -- PID lock file for preventing concurrent recovery scans
readonly _RECOVERY_LOCK_FILE="${HOME}/.autonomous-dev/recovery.lock"

# _acquire_recovery_lock -- Acquire PID-based lock to prevent split-brain
#
# Returns:
#   0 on success (lock acquired)
#   1 on failure (another recovery process is running)
#
# Side effects:
#   Creates lock file with current PID
_acquire_recovery_lock() {
  local lock_dir
  lock_dir="$(dirname "$_RECOVERY_LOCK_FILE")"
  mkdir -p "$lock_dir"

  # Check if lock file exists and if the owning process is still alive
  if [[ -f "$_RECOVERY_LOCK_FILE" ]]; then
    local existing_pid
    existing_pid="$(cat "$_RECOVERY_LOCK_FILE" 2>/dev/null)"
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
      echo "ERROR: Recovery scan already running (PID: ${existing_pid})" >&2
      return 1
    fi
    # Stale lock from dead process -- remove it
    echo "INFO: Removing stale recovery lock (PID: ${existing_pid} is dead)" >&2
    rm -f "$_RECOVERY_LOCK_FILE"
  fi

  # Write our PID
  echo "$$" > "$_RECOVERY_LOCK_FILE"
  chmod 0600 "$_RECOVERY_LOCK_FILE"

  # Verify we actually own the lock (race condition guard)
  local check_pid
  check_pid="$(cat "$_RECOVERY_LOCK_FILE" 2>/dev/null)"
  if [[ "$check_pid" != "$$" ]]; then
    echo "ERROR: Lost recovery lock race condition" >&2
    return 1
  fi

  return 0
}

# _release_recovery_lock -- Release the PID-based recovery lock
#
# Side effects:
#   Removes lock file if owned by current process
_release_recovery_lock() {
  if [[ -f "$_RECOVERY_LOCK_FILE" ]]; then
    local lock_pid
    lock_pid="$(cat "$_RECOVERY_LOCK_FILE" 2>/dev/null)"
    if [[ "$lock_pid" == "$$" ]]; then
      rm -f "$_RECOVERY_LOCK_FILE"
    fi
  fi
}

# =============================================================================
# Main Entry Point
# =============================================================================

# startup_recovery -- Run full recovery scan on supervisor startup
#
# Arguments:
#   Repos passed as positional args, or uses REPO_ALLOWLIST
#
# Returns:
#   0 on success (all recovery actions completed)
#   1 on partial failure (some requests could not be recovered)
#
# Sequence:
#   1. Acquire PID-based lock (split-brain prevention)
#   2. For each request directory across all repos:
#      a. Handle orphaned .tmp files (recover_orphaned_tmp from state_file_manager)
#      b. Attempt to read state.json (with checkpoint fallback)
#      c. If corrupt and no checkpoint: transition to failed
#      d. If state has un-exited current phase: flag for re-entry
#   3. Detect orphaned worktrees (detect_orphaned_resources)
#   4. Check heartbeat staleness (detect_stale_heartbeat)
#   5. Log summary of all recovery actions taken
#   6. Release PID-based lock
startup_recovery() {
  local -a repos=()
  if [[ $# -gt 0 ]]; then
    repos=("$@")
  elif [[ -n "${REPO_ALLOWLIST+x}" ]]; then
    repos=("${REPO_ALLOWLIST[@]}")
  fi

  # Acquire lock to prevent concurrent recovery scans
  if ! _acquire_recovery_lock; then
    return 1
  fi

  # Ensure lock is released on exit (including errors and signals)
  trap '_release_recovery_lock' EXIT

  local recovery_count=0
  local failure_count=0
  local timestamp
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  echo "INFO: Starting recovery scan at ${timestamp}" >&2

  # Phase 1: Per-request recovery
  for repo in "${repos[@]}"; do
    local req_base="${repo}/.autonomous-dev/requests"
    [[ -d "$req_base" ]] || continue

    for req_dir in "${req_base}"/REQ-*/; do
      [[ -d "$req_dir" ]] || continue
      req_dir="${req_dir%/}"

      # Step 1a: Orphaned .tmp files
      if ! recover_orphaned_tmp "$req_dir"; then
        echo "WARNING: Orphaned .tmp recovery failed for: ${req_dir}" >&2
        (( failure_count++ )) || true
        continue
      fi

      # Step 1b: Read state (with checkpoint fallback)
      local state_json=""
      local read_exit=0
      state_json="$(state_read "$req_dir" 2>/dev/null)" || read_exit=$?

      case "$read_exit" in
        0)
          # Valid state -- check for un-exited phase
          _check_unexit_phase "$req_dir" "$state_json" "$timestamp"
          ;;
        2)
          # File not found after .tmp recovery -- request is gone
          echo "WARNING: No state.json found for: ${req_dir}" >&2
          ;;
        3)
          # Parse failure -- checkpoint fallback already attempted by state_read
          _handle_corrupt_state "$req_dir" "$timestamp"
          (( recovery_count++ )) || true
          ;;
        4)
          # Validation failure -- state is readable but invalid
          _handle_invalid_state "$req_dir" "$state_json" "$timestamp"
          (( recovery_count++ )) || true
          ;;
      esac
    done
  done

  # Phase 2: Orphaned resources
  if [[ ${#repos[@]} -gt 0 ]]; then
    detect_orphaned_resources "${repos[@]}"
  fi

  # Phase 3: Stale heartbeat
  detect_stale_heartbeat

  echo "INFO: Recovery scan complete. Recovered: ${recovery_count}, Failures: ${failure_count}" >&2

  # Lock released by EXIT trap
  [[ $failure_count -eq 0 ]] && return 0 || return 1
}

# =============================================================================
# Internal Recovery Helpers
# =============================================================================

# _check_unexit_phase -- Detect un-exited phase history entries
#
# Arguments:
#   $1 -- req_dir:    Absolute path to the request directory
#   $2 -- state_json: Current state JSON
#   $3 -- timestamp:  ISO-8601 UTC timestamp
#
# Side effects:
#   Logs info message if un-exited phase detected.
#   Does NOT modify state -- the supervisor will re-enter on next iteration.
_check_unexit_phase() {
  local req_dir="$1"
  local state_json="$2"
  local timestamp="$3"

  local exited_at
  exited_at="$(echo "$state_json" | jq -r '.phase_history[-1].exited_at')"

  if [[ "$exited_at" == "null" ]]; then
    local request_id
    request_id="$(echo "$state_json" | jq -r '.id')"
    local phase
    phase="$(echo "$state_json" | jq -r '.phase_history[-1].state')"
    echo "INFO: Un-exited phase detected for ${request_id} in phase ${phase}, flagging for re-entry" >&2
    # Do NOT modify state -- the supervisor will re-enter on next iteration
  fi
}

# _handle_corrupt_state -- Handle a state file that cannot be parsed
#
# Arguments:
#   $1 -- req_dir:   Absolute path to the request directory
#   $2 -- timestamp: ISO-8601 UTC timestamp
#
# Behavior:
#   Checkpoint fallback was already attempted by state_read.
#   If we reach here, no valid checkpoint exists.
#   Emits a failed event to events.jsonl for forensic tracking.
_handle_corrupt_state() {
  local req_dir="$1"
  local timestamp="$2"

  # checkpoint fallback already attempted by state_read
  # If we're here, no valid checkpoint exists
  local request_id
  request_id="$(basename "$req_dir")"

  echo "ERROR: Corrupt state with no valid checkpoint for: ${request_id}" >&2

  # Emit event if events.jsonl is accessible
  local event
  event="$(jq -n \
    --arg ts "$timestamp" \
    --arg rid "$request_id" \
    '{timestamp: $ts, event_type: "failed", request_id: $rid, from_state: "unknown", to_state: "failed", session_id: null, metadata: {reason: "state_corruption_no_checkpoint"}}')"
  event_append "${req_dir}/events.jsonl" "$event" 2>/dev/null || true
}

# _handle_invalid_state -- Handle a state file that parses but fails validation
#
# Arguments:
#   $1 -- req_dir:    Absolute path to the request directory
#   $2 -- state_json: The parsed (but invalid) state JSON
#   $3 -- timestamp:  ISO-8601 UTC timestamp
#
# Behavior:
#   Attempts to transition the request to failed via trigger_error_transition.
#   Writes the new state atomically.
_handle_invalid_state() {
  local req_dir="$1"
  local state_json="$2"
  local timestamp="$3"

  local request_id
  request_id="$(echo "$state_json" | jq -r '.id // "unknown"')"

  echo "WARNING: State validation failed for ${request_id}, transitioning to failed" >&2

  local new_state
  if new_state="$(trigger_error_transition "$state_json" "state_corruption" '{}' "$timestamp" 2>/dev/null)"; then
    state_write_atomic "$req_dir" "$new_state"
  fi
}

# =============================================================================
# Orphaned Resource Detection
# =============================================================================

# detect_orphaned_resources -- Scan for orphaned worktrees and lock files
#
# Arguments:
#   Repos as positional args
#
# Side effects:
#   Logs warnings for each orphaned worktree detected.
#   Does NOT auto-delete worktrees (per TDD 6.3).
#
# Behavior:
#   1. For each repo, list git worktrees
#   2. Compare against active request worktree_path values
#   3. Log orphaned worktrees as warnings
detect_orphaned_resources() {
  local -a repos=("$@")

  for repo in "${repos[@]}"; do
    [[ -d "$repo/.git" ]] || continue

    # Get list of worktrees from git
    local -a git_worktrees=()
    while IFS= read -r wt; do
      [[ -n "$wt" ]] && git_worktrees+=("$wt")
    done < <(git -C "$repo" worktree list --porcelain 2>/dev/null | grep '^worktree ' | sed 's/^worktree //')

    # Get list of active request worktrees
    local -a active_worktrees=()
    local req_base="${repo}/.autonomous-dev/requests"
    if [[ -d "$req_base" ]]; then
      for req_dir in "${req_base}"/REQ-*/; do
        [[ -d "$req_dir" ]] || continue
        local wt_path
        wt_path="$(jq -r '.worktree_path // empty' "${req_dir}/state.json" 2>/dev/null)"
        [[ -n "$wt_path" ]] && active_worktrees+=("$wt_path")
      done
    fi

    # Find orphaned worktrees (in git but not in any active request)
    for gwt in "${git_worktrees[@]}"; do
      # Skip the main worktree
      [[ "$gwt" == "$repo" ]] && continue

      local is_active=false
      for awt in "${active_worktrees[@]}"; do
        if [[ "$gwt" == "$awt" ]]; then
          is_active=true
          break
        fi
      done

      if [[ "$is_active" == "false" && "$gwt" == *"autonomous-dev"* ]]; then
        echo "WARNING: Orphaned worktree detected: ${gwt}" >&2
      fi
    done
  done
}

# =============================================================================
# Stale Heartbeat Detection
# =============================================================================

# detect_stale_heartbeat -- Check if the heartbeat is stale
#
# Reads heartbeat file at ~/.autonomous-dev/heartbeat
# Format: ISO-8601 timestamp on a single line
#
# A heartbeat is stale if it is older than 2x the poll interval.
# Default poll interval: 30 seconds, so stale threshold: 60 seconds.
#
# Returns:
#   0 if heartbeat is fresh or no heartbeat file
#   1 if heartbeat is stale
detect_stale_heartbeat() {
  local heartbeat_file="${HOME}/.autonomous-dev/heartbeat"
  local poll_interval="${POLL_INTERVAL:-30}"
  local stale_threshold=$(( poll_interval * 2 ))

  if [[ ! -f "$heartbeat_file" ]]; then
    echo "INFO: No heartbeat file found (first run or clean start)" >&2
    return 0
  fi

  local last_beat
  last_beat="$(cat "$heartbeat_file" 2>/dev/null)"
  if [[ -z "$last_beat" ]]; then
    return 0
  fi

  local last_epoch current_epoch
  last_epoch="$(_timestamp_to_epoch "$last_beat" 2>/dev/null || echo 0)"
  current_epoch="$(date -u +%s)"

  local age=$(( current_epoch - last_epoch ))

  if (( age > stale_threshold )); then
    echo "WARNING: Stale heartbeat detected. Last beat: ${last_beat} (${age}s ago, threshold: ${stale_threshold}s)" >&2
    echo "INFO: Assumed prior crash or system sleep. Active requests will be re-entered." >&2
    return 1
  fi

  return 0
}
