#!/usr/bin/env bash
# lock_manager.sh -- Daemon lock file management (split-brain prevention)
# Part of TDD-002: State Machine & Request Lifecycle
#
# Dependencies: None (pure bash)
# Sourced by: daemon.sh, supervisor_interface.sh
#
# Provides PID-based singleton enforcement to prevent multiple daemon
# instances from running simultaneously, which would cause split-brain
# corruption of state files.

set -euo pipefail

# Lock file location
readonly DAEMON_LOCK_FILE="${HOME}/.autonomous-dev/daemon.lock"

# acquire_lock -- Acquire the daemon lock
#
# Returns:
#   0 on success (lock acquired)
#   1 on failure (another live instance holds the lock)
#
# Behavior:
#   1. If lock file does not exist: create it with our PID, return 0
#   2. If lock file exists:
#      a. Read PID from file
#      b. If PID is not a valid integer: delete lock (corrupt), re-acquire
#      c. If PID is alive (kill -0): return 1 (another instance running)
#      d. If PID is dead: steal lock with warning, write our PID, return 0
#   3. Set up SIGTERM/SIGINT traps to release lock on shutdown
acquire_lock() {
  local lock_dir
  lock_dir="$(dirname "$DAEMON_LOCK_FILE")"

  # Ensure lock directory exists
  if [[ ! -d "$lock_dir" ]]; then
    mkdir -p "$lock_dir"
    chmod 0700 "$lock_dir"
  fi

  if [[ -f "$DAEMON_LOCK_FILE" ]]; then
    local existing_pid
    existing_pid="$(cat "$DAEMON_LOCK_FILE" 2>/dev/null)"

    # Check if PID is valid integer
    if [[ ! "$existing_pid" =~ ^[0-9]+$ ]]; then
      echo "WARNING: Corrupt lock file (not a valid PID: '${existing_pid}'), removing" >&2
      rm -f "$DAEMON_LOCK_FILE"
    elif kill -0 "$existing_pid" 2>/dev/null; then
      # Process is alive
      echo "ERROR: Another instance is running (PID: ${existing_pid})" >&2
      return 1
    else
      # Process is dead -- steal lock
      echo "WARNING: Stale lock detected (PID ${existing_pid} is dead), stealing lock" >&2
      rm -f "$DAEMON_LOCK_FILE"
    fi
  fi

  # Write our PID
  echo "$$" > "$DAEMON_LOCK_FILE"
  chmod 0600 "$DAEMON_LOCK_FILE"

  # Set up signal traps
  trap 'release_lock' EXIT SIGTERM SIGINT SIGHUP

  return 0
}

# release_lock -- Release the daemon lock
#
# Returns:
#   0 always
#
# Behavior:
#   1. Verify the lock file contains our PID (safety check)
#   2. Remove the lock file
release_lock() {
  if [[ -f "$DAEMON_LOCK_FILE" ]]; then
    local lock_pid
    lock_pid="$(cat "$DAEMON_LOCK_FILE" 2>/dev/null)"
    if [[ "$lock_pid" == "$$" ]]; then
      rm -f "$DAEMON_LOCK_FILE"
    else
      echo "WARNING: Lock file PID (${lock_pid}) does not match our PID ($$), not releasing" >&2
    fi
  fi
}

# is_lock_held -- Check if the daemon lock is currently held by a live process
#
# Returns:
#   0 if held by a live process
#   1 if not held or held by a dead process
is_lock_held() {
  if [[ ! -f "$DAEMON_LOCK_FILE" ]]; then
    return 1
  fi

  local existing_pid
  existing_pid="$(cat "$DAEMON_LOCK_FILE" 2>/dev/null)"

  if [[ ! "$existing_pid" =~ ^[0-9]+$ ]]; then
    return 1
  fi

  if kill -0 "$existing_pid" 2>/dev/null; then
    return 0
  fi

  return 1
}
