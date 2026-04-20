#!/usr/bin/env bash
# cost_request_tracker.sh -- Per-phase and per-request cost in state.json
# Part of TDD-010 / SPEC-010-2-02: Per-Request Cost Tracking & Budget Enforcement
#
# Dependencies: jq (1.6+), bash 4+
#
# Usage:
#   source cost_request_tracker.sh
#   update_request_cost "/path/to/requests/REQ-20260408-a3f1" "prd" "1.85"

set -euo pipefail

# Source guard
if [[ -n "${_COST_REQUEST_TRACKER_LOADED:-}" ]]; then return 0 2>/dev/null || true; fi
_COST_REQUEST_TRACKER_LOADED=1

# ---------------------------------------------------------------------------
# Logging helpers (write to stderr so stdout stays clean for data output)
# ---------------------------------------------------------------------------
if ! declare -F log_error >/dev/null 2>&1; then
  log_error() {
    local tag="$1"; shift
    echo "[${tag}] ERROR: $*" >&2
  }
fi

if ! declare -F log_info >/dev/null 2>&1; then
  log_info() {
    local tag="$1"; shift
    echo "[${tag}] INFO: $*" >&2
  }
fi

# ---------------------------------------------------------------------------
# update_request_cost -- After recording a session cost, update the
#   request's state.json with incremented phase cost and recalculated
#   total accrued cost.
#
# Arguments:
#   $1 -- request_dir:  Path to {repo}/.autonomous-dev/requests/{id}/
#   $2 -- phase:        Current phase name (e.g., "prd", "tdd")
#   $3 -- session_cost: Cost of this session in USD (decimal string)
#
# Returns:
#   0 on success
#   1 on error (missing state file, write failure)
#
# Behavior:
#   1. Read current state.json.
#   2. Find the active phase entry in phase_history (matching phase name,
#      ended_at == null) and increment its cost_usd.
#   3. Recalculate cost_accrued_usd as the sum of all phase costs.
#   4. Write atomically via tmp + mv pattern.
# ---------------------------------------------------------------------------
update_request_cost() {
  local request_dir="$1"   # path to {repo}/.autonomous-dev/requests/{id}/
  local phase="$2"         # current phase name
  local session_cost="$3"  # cost of this session in USD

  local state_file="${request_dir}/state.json"

  if [[ ! -f "$state_file" ]]; then
    log_error "cost_request_tracker" "State file not found: $state_file"
    return 1
  fi

  # Read current state
  local current_state
  current_state=$(cat "$state_file")

  # Validate it's valid JSON
  if ! echo "$current_state" | jq empty 2>/dev/null; then
    log_error "cost_request_tracker" "State file is invalid JSON: $state_file"
    return 1
  fi

  # Update the phase's cost_usd (increment, not replace)
  # Update the request's cost_accrued_usd (sum of all phase costs)
  local updated_state
  updated_state=$(echo "$current_state" | jq \
    --arg phase "$phase" \
    --argjson cost "$session_cost" '
    # Find the current phase entry in phase_history and increment its cost_usd
    .phase_history = [
      .phase_history[] |
      if .phase == $phase and .ended_at == null then
        .cost_usd = ((.cost_usd // 0) + $cost)
      else . end
    ] |
    # Recalculate cost_accrued_usd as sum of all phase costs
    .cost_accrued_usd = ([.phase_history[].cost_usd // 0] | add)
  ')

  # Atomic write
  local tmp_file="${state_file}.tmp"
  echo "$updated_state" > "$tmp_file" || {
    log_error "cost_request_tracker" "Failed to write temp state file"
    rm -f "$tmp_file"
    return 1
  }
  mv "$tmp_file" "$state_file" || {
    log_error "cost_request_tracker" "Failed to atomic-move state file"
    return 1
  }

  log_info "cost_request_tracker" "Updated cost for phase '${phase}': +\$${session_cost} in ${state_file}"
  return 0
}
