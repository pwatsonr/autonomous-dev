# SPEC-002-4-01: Startup Recovery, Corrupt State Detection, Orphaned Resources, and Stale Heartbeat

## Metadata
- **Parent Plan**: PLAN-002-4
- **Tasks Covered**: Task 1 (Startup recovery scan), Task 2 (Corrupt state detection with checkpoint fallback), Task 3 (Orphaned resource detection), Task 4 (Stale heartbeat recovery)
- **Estimated effort**: 11 hours

## Description
Implement the four recovery mechanisms that run on supervisor startup to restore the system to a consistent state after any crash or unexpected termination: (1) a full startup scan that orchestrates all recovery actions, (2) corrupt state detection that falls back to checkpoints, (3) orphaned resource detection for worktrees and lock files, and (4) stale heartbeat detection that identifies requests with un-exited phases. Together these make the state machine production-grade -- survivable across process crashes, power loss, and system sleeps.

## Files to Create/Modify
- **Path**: `lib/state/recovery.sh`
- **Action**: Create
- **Description**: Recovery module. Contains `startup_recovery()`, `detect_orphaned_resources()`, `detect_stale_heartbeat()`, and internal helpers. Sources all other state modules.

- **Path**: `lib/state/state_file_manager.sh`
- **Action**: Modify (extend `state_read()` with checkpoint fallback per Task 2)
- **Description**: Enhance `state_read()` to attempt checkpoint restoration when JSON parse fails, before returning a parse error.

## Implementation Details

### `startup_recovery(repos_array)`

```bash
#!/usr/bin/env bash
# recovery.sh -- Crash recovery procedures
# Part of TDD-002: State Machine & Request Lifecycle
set -euo pipefail

_REC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${_REC_DIR}/state_file_manager.sh"
source "${_REC_DIR}/event_logger.sh"
source "${_REC_DIR}/request_tracker.sh"
source "${_REC_DIR}/lifecycle_engine.sh"

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
#   1. For each request directory across all repos:
#      a. Handle orphaned .tmp files (recover_orphaned_tmp from state_file_manager)
#      b. Attempt to read state.json (with checkpoint fallback)
#      c. If corrupt and no checkpoint: transition to failed
#      d. If state has un-exited current phase: flag for re-entry
#   2. Detect orphaned worktrees (detect_orphaned_resources)
#   3. Detect orphaned lock files (via lock_manager, SPEC-002-4-02)
#   4. Check heartbeat staleness (detect_stale_heartbeat)
#   5. Log summary of all recovery actions taken
startup_recovery() {
  local -a repos=()
  if [[ $# -gt 0 ]]; then
    repos=("$@")
  elif [[ -n "${REPO_ALLOWLIST+x}" ]]; then
    repos=("${REPO_ALLOWLIST[@]}")
  fi

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
        (( failure_count++ ))
        continue
      fi

      # Step 1b: Read state (with checkpoint fallback)
      local state_json
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
          # Parse failure -- attempt checkpoint fallback
          _handle_corrupt_state "$req_dir" "$timestamp"
          (( recovery_count++ ))
          ;;
        4)
          # Validation failure -- state is readable but invalid
          _handle_invalid_state "$req_dir" "$state_json" "$timestamp"
          (( recovery_count++ ))
          ;;
      esac
    done
  done

  # Phase 2: Orphaned resources
  detect_orphaned_resources "${repos[@]}"

  # Phase 3: Stale heartbeat
  detect_stale_heartbeat

  echo "INFO: Recovery scan complete. Recovered: ${recovery_count}, Failures: ${failure_count}" >&2
  [[ $failure_count -eq 0 ]] && return 0 || return 1
}
```

### Corrupt State Detection with Checkpoint Fallback

Modify `state_read()` in `state_file_manager.sh`:

```bash
# Enhanced state_read with checkpoint fallback
# When JSON parse fails (exit 3), attempt to restore from most recent checkpoint
# before returning the error.
#
# New behavior at parse failure point:
#   1. Look for checkpoint directory
#   2. Find most recent checkpoint
#   3. Validate checkpoint
#   4. If valid: restore checkpoint, log warning, re-read
#   5. If invalid or no checkpoints: proceed with original error
state_read() {
  local dir="$1"
  local target="${dir}/state.json"

  if [[ ! -f "$target" ]]; then
    echo "state_read: state file not found: ${target}" >&2
    return 2
  fi

  _check_file_permissions "$target"

  local json
  if ! json="$(jq '.' "$target" 2>/dev/null)"; then
    # Parse failure -- attempt checkpoint fallback
    echo "WARNING: JSON parse failed for ${target}, attempting checkpoint fallback" >&2
    if _attempt_checkpoint_fallback "$dir"; then
      # Re-read after successful restore
      if json="$(jq '.' "$target" 2>/dev/null)"; then
        if _validate_state_schema "$json" > /dev/null 2>&1; then
          echo "$json"
          return 0
        fi
      fi
    fi
    echo "state_read: JSON parse failed and checkpoint fallback unsuccessful: ${target}" >&2
    return 3
  fi

  local validation_errors
  if ! validation_errors="$(_validate_state_schema "$json")"; then
    echo "state_read: schema validation failed for: ${target}" >&2
    echo "$validation_errors" >&2
    return 4
  fi

  echo "$json"
  return 0
}

# _attempt_checkpoint_fallback -- Try to restore from the most recent valid checkpoint
#
# Arguments:
#   $1 -- dir: Request directory
#
# Returns:
#   0 if checkpoint was successfully restored
#   1 if no valid checkpoint found
_attempt_checkpoint_fallback() {
  local dir="$1"
  local checkpoint_dir="${dir}/checkpoint"
  local corrupt_dir="${dir}/corrupt"

  if [[ ! -d "$checkpoint_dir" ]]; then
    return 1
  fi

  # Try checkpoints from most recent to oldest
  local -a checkpoints
  while IFS= read -r f; do
    checkpoints+=("$f")
  done < <(ls -1 "${checkpoint_dir}"/state.json.* 2>/dev/null | sort -r)

  if [[ ${#checkpoints[@]} -eq 0 ]]; then
    return 1
  fi

  for cp in "${checkpoints[@]}"; do
    local cp_json
    if cp_json="$(jq '.' "$cp" 2>/dev/null)" && _validate_state_schema "$cp_json" > /dev/null 2>&1; then
      # Valid checkpoint found -- restore it
      echo "INFO: Restoring from checkpoint: ${cp}" >&2

      # Move corrupt state.json to corrupt/ for forensics
      mkdir -p "$corrupt_dir"
      chmod 0700 "$corrupt_dir"
      local ts
      ts="$(date -u +%Y%m%dT%H%M%SZ)"
      mv -f "${dir}/state.json" "${corrupt_dir}/state.json.corrupt.${ts}" 2>/dev/null || true

      # Restore checkpoint via atomic write
      state_write_atomic "$dir" "$cp_json"
      return 0
    fi
  done

  # No valid checkpoint found
  echo "ERROR: No valid checkpoint found for: ${dir}" >&2

  # Move corrupt files to corrupt/
  mkdir -p "$corrupt_dir"
  chmod 0700 "$corrupt_dir"
  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  mv -f "${dir}/state.json" "${corrupt_dir}/state.json.corrupt.${ts}" 2>/dev/null || true

  return 1
}
```

### Internal Recovery Helpers

```bash
# _check_unexit_phase -- Detect un-exited phase history entries
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
_handle_corrupt_state() {
  local req_dir="$1"
  local timestamp="$2"

  # checkpoint fallback already attempted by state_read
  # If we're here, no valid checkpoint exists
  # Create a minimal failed state
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
```

### Orphaned Resource Detection

```bash
# detect_orphaned_resources -- Scan for orphaned worktrees and lock files
#
# Arguments:
#   Repos as positional args
#
# Behavior:
#   1. For each repo, list git worktrees
#   2. Compare against active request worktree_path values
#   3. Log orphaned worktrees as warnings (do NOT auto-delete per TDD 6.3)
#   4. Check daemon lock file (delegated to lock_manager)
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
```

### Stale Heartbeat Detection

```bash
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
```

## Acceptance Criteria
1. [ ] `startup_recovery()` scans all repos and all request directories
2. [ ] Orphaned `.tmp` files are handled per PLAN-002-1 rules
3. [ ] Corrupt `state.json` with valid checkpoint: checkpoint is restored, warning logged
4. [ ] Corrupt `state.json` with no checkpoints: request transitions to `failed`
5. [ ] Corrupt `state.json` with all corrupt checkpoints: both files moved to `corrupt/`, request fails
6. [ ] Valid `state.json` is unaffected by recovery logic
7. [ ] Requests with `exited_at: null` in current phase are identified but NOT modified (flagged only)
8. [ ] Recovery scan completes without errors on a clean system (no-op)
9. [ ] Events are logged for every recovery action taken
10. [ ] Orphaned worktrees are logged as warnings (not auto-deleted)
11. [ ] Lock files with dead PIDs are detected (actual release is in lock_manager, SPEC-002-4-02)
12. [ ] Stale heartbeat is detected when last beat is older than 2x poll interval
13. [ ] Log summary includes counts of recovered requests and failures
14. [ ] Corrupt state files are moved to `corrupt/` subdirectory for forensic inspection

## Test Cases
1. **Clean startup** -- No corrupt files, no orphans. Assertion: returns 0, no warnings.
2. **Orphaned tmp recovery** -- Create `.tmp` alongside `state.json`. Assertion: `.tmp` deleted.
3. **Corrupt state with valid checkpoint** -- Write garbage to `state.json`, create valid checkpoint. Call `startup_recovery()`. Assertion: `state.json` restored from checkpoint.
4. **Corrupt state with no checkpoint** -- Write garbage, no `checkpoint/` dir. Assertion: request flagged as failed, corrupt file moved.
5. **Corrupt state with corrupt checkpoint** -- Both `state.json` and checkpoint are garbage. Assertion: both moved to `corrupt/`, request fails.
6. **Un-exited phase detected** -- State with `exited_at: null`. Assertion: log message identifies the request and phase, state NOT modified.
7. **Orphaned worktree detected** -- Create a git worktree not referenced by any request. Assertion: warning logged.
8. **Stale heartbeat** -- Write heartbeat from 120 seconds ago, poll_interval=30. Assertion: returns 1, warning logged.
9. **Fresh heartbeat** -- Write heartbeat from 10 seconds ago. Assertion: returns 0, no warning.
10. **No heartbeat file** -- First run, no file. Assertion: returns 0, info message about first run.
11. **Multiple requests with mixed states** -- 3 requests: one clean, one corrupt, one with un-exited phase. Assertion: each handled correctly, summary counts accurate.
12. **Validation failure triggers failed transition** -- State that parses but fails validation. Assertion: transitions to `failed` via `trigger_error_transition`.
