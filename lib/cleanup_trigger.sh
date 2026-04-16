#!/usr/bin/env bash
# cleanup_trigger.sh -- Supervisor loop iteration counter and automatic cleanup trigger
# Part of SPEC-010-4-04: Cleanup Orchestrator, Automatic Trigger, and CLI Command
#
# Dependencies: jq (1.6+), bash 4+
#
# Usage:
#   source cleanup_trigger.sh
#   cleanup_run_if_due "$effective_config"
#
# The iteration counter persists across loop iterations but NOT across daemon
# restarts. It is intentionally stored in a shell variable, not a file.

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve PLUGIN_ROOT for sourcing sibling libraries
# ---------------------------------------------------------------------------
if [[ -z "${PLUGIN_ROOT:-}" ]]; then
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# ---------------------------------------------------------------------------
# Logging helpers (write to stderr so stdout stays clean for data output)
# Only define if not already defined (e.g., when sourced by another script)
# ---------------------------------------------------------------------------
if ! declare -F log_info >/dev/null 2>&1; then
  log_info() {
    local tag="$1"; shift
    echo "[${tag}] INFO: $*" >&2
  }
fi

if ! declare -F log_error >/dev/null 2>&1; then
  log_error() {
    local tag="$1"; shift
    echo "[${tag}] ERROR: $*" >&2
  }
fi

# ---------------------------------------------------------------------------
# Source cleanup_engine if not already loaded
# ---------------------------------------------------------------------------
if ! declare -F cleanup_run >/dev/null 2>&1; then
  source "${PLUGIN_ROOT}/lib/cleanup_engine.sh"
fi

# =============================================================================
# Iteration Counter
# =============================================================================

# Persists across iterations but NOT across daemon restarts.
# Resets to 0 on source and after triggering cleanup.
CLEANUP_ITERATION_COUNTER=0

# =============================================================================
# Automatic Cleanup Trigger
# =============================================================================

# cleanup_run_if_due -- Called at the END of each supervisor loop iteration
#
# Arguments:
#   $1 -- effective_config: Merged config JSON string
#
# Key behaviors:
#   - Counter increments every iteration.
#   - Cleanup runs every cleanup.auto_cleanup_interval_iterations (default: 100).
#   - Counter resets to 0 after triggering cleanup.
#   - Counter resets to 0 on daemon restart (no persistence file).
#   - Cleanup runs at the END of the iteration, after all work is done.
#   - Cleanup runs in a subshell so it does not block the next iteration.
cleanup_run_if_due() {
  local effective_config="$1"

  local interval
  interval=$(echo "$effective_config" | jq -r '.cleanup.auto_cleanup_interval_iterations')

  ((CLEANUP_ITERATION_COUNTER++))

  if (( CLEANUP_ITERATION_COUNTER >= interval )); then
    log_info "cleanup_trigger" "Auto-cleanup triggered at iteration $CLEANUP_ITERATION_COUNTER (interval: $interval)"
    CLEANUP_ITERATION_COUNTER=0

    # Run cleanup in a subshell so it doesn't block the next iteration
    # if it takes longer than the poll interval
    (cleanup_run "$effective_config" false) &
    local cleanup_pid=$!

    # Don't wait -- let it run in background
    log_info "cleanup_trigger" "Cleanup running in background (PID: $cleanup_pid)"
  fi
}

# cleanup_get_counter -- Return the current iteration counter value
#
# Stdout:
#   Integer counter value
#
# Useful for testing and monitoring.
cleanup_get_counter() {
  echo "$CLEANUP_ITERATION_COUNTER"
}

# cleanup_reset_counter -- Reset the iteration counter to 0
#
# Useful for testing.
cleanup_reset_counter() {
  CLEANUP_ITERATION_COUNTER=0
}
