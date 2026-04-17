#!/usr/bin/env bash
# cost_governor.sh -- Budget checks and enforcement logic
# Part of TDD-010 / SPEC-010-2-02: Per-Request Cost Tracking & Budget Enforcement
#
# Dependencies: jq (1.6+), bc, bash 4+
# Sources: cost_ledger.sh (for get_monthly_total, get_daily_total, get_request_cumulative_cost)
#
# Usage:
#   source cost_governor.sh
#   budget_status=$(check_budgets "$request_id" "$effective_config")
#   post_session_check "$request_id" "$effective_config"

set -euo pipefail

# Source guard
if [[ -n "${_COST_GOVERNOR_LOADED:-}" ]]; then return 0 2>/dev/null || true; fi
_COST_GOVERNOR_LOADED=1

# ---------------------------------------------------------------------------
# Resolve PLUGIN_ROOT for sourcing sibling libraries
# ---------------------------------------------------------------------------
if [[ -z "${PLUGIN_ROOT:-}" ]]; then
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# ---------------------------------------------------------------------------
# Source cost_ledger.sh for aggregation functions
# ---------------------------------------------------------------------------
# Guard against double-sourcing: only source if the functions are not yet defined
if ! declare -F get_monthly_total >/dev/null 2>&1; then
  source "${PLUGIN_ROOT}/lib/cost_ledger.sh"
fi

# ---------------------------------------------------------------------------
# Logging helpers (write to stderr so stdout stays clean for data output)
# Only define if not already defined (e.g., when sourced by supervisor-loop.sh)
# ---------------------------------------------------------------------------
if ! declare -F log_error >/dev/null 2>&1; then
  log_error() {
    local tag="$1"; shift
    echo "[${tag}] ERROR: $*" >&2
  }
fi

if ! declare -F log_warning >/dev/null 2>&1; then
  log_warning() {
    local tag="$1"; shift
    echo "[${tag}] WARNING: $*" >&2
  }
fi

if ! declare -F log_info >/dev/null 2>&1; then
  log_info() {
    local tag="$1"; shift
    echo "[${tag}] INFO: $*" >&2
  }
fi

# ---------------------------------------------------------------------------
# get_request_cumulative_cost -- Get cumulative cost for a request from ledger
#
# Tail-read strategy: reads the last entry for the given request_id from the
# JSONL cost ledger and returns its cumulative_request_cost_usd field.
#
# Arguments:
#   $1 -- request_id: e.g., "REQ-20260408-a3f1"
#
# Stdout:
#   Decimal string (e.g., "4.07"), or "0.00" if no entries found
#
# Returns:
#   0 always
# ---------------------------------------------------------------------------
get_request_cumulative_cost() {
  local request_id="$1"

  if [[ ! -f "$COST_LEDGER_PATH" ]] || [[ ! -s "$COST_LEDGER_PATH" ]]; then
    echo "0.00"
    return 0
  fi

  local last_entry
  last_entry=$(grep "\"${request_id}\"" "$COST_LEDGER_PATH" 2>/dev/null | tail -1)

  if [[ -z "$last_entry" ]]; then
    echo "0.00"
    return 0
  fi

  local cumulative
  cumulative=$(echo "$last_entry" | jq -r '.cumulative_request_cost_usd // 0')

  if [[ -z "$cumulative" ]] || [[ "$cumulative" == "null" ]] || [[ "$cumulative" == "0" ]]; then
    echo "0.00"
    return 0
  fi

  printf "%.2f" "$cumulative"
}

# ---------------------------------------------------------------------------
# get_active_request_ids -- Scan all allowlisted repos for active request IDs
#
# Arguments:
#   $1 -- effective_config: JSON string of the effective configuration
#
# Stdout:
#   One request ID per line
#
# Returns:
#   0 always
# ---------------------------------------------------------------------------
get_active_request_ids() {
  local effective_config="$1"
  local allowlist
  allowlist=$(echo "$effective_config" | jq -r '.repositories.allowlist[]' 2>/dev/null)

  while IFS= read -r repo; do
    [[ -z "$repo" ]] && continue
    local requests_dir="${repo}/.autonomous-dev/requests"
    [[ -d "$requests_dir" ]] || continue
    for req_dir in "$requests_dir"/*/; do
      local state_file="${req_dir}state.json"
      [[ -f "$state_file" ]] || continue
      local status
      status=$(jq -r '.status' "$state_file" 2>/dev/null || echo "unknown")
      case "$status" in
        completed|cancelled|failed|paused) continue ;;
      esac
      jq -r '.id // empty' "$state_file" 2>/dev/null
    done
  done <<< "$allowlist"
}

# ---------------------------------------------------------------------------
# check_budgets -- Pre-session budget check
#
# Reads cap values from the effective config and compares against current
# totals from the cost ledger. Returns structured JSON status.
#
# Arguments:
#   $1 -- request_id:      The request about to be worked on
#   $2 -- effective_config: JSON string of the effective configuration
#
# Stdout:
#   JSON object with status, blocked_by, scope, and all cap/total details
#
# Returns:
#   0 if all caps pass (status=pass)
#   1 if any cap is exceeded (status=fail)
#
# Check order: monthly (most severe) -> daily -> per-request
# ---------------------------------------------------------------------------
check_budgets() {
  local request_id="$1"
  local effective_config="$2"

  local monthly_cap daily_cap per_request_cap
  monthly_cap=$(echo "$effective_config" | jq -r '.governance.monthly_cost_cap_usd')
  daily_cap=$(echo "$effective_config" | jq -r '.governance.daily_cost_cap_usd')
  per_request_cap=$(echo "$effective_config" | jq -r '.governance.per_request_cost_cap_usd')

  local monthly_total daily_total request_total
  monthly_total=$(get_monthly_total)
  daily_total=$(get_daily_total)
  request_total=$(get_request_cumulative_cost "$request_id")

  local status="pass"
  local blocked_by=""
  local scope=""

  # Check in order: monthly (most severe) -> daily -> per-request
  if (( $(echo "$monthly_total >= $monthly_cap" | bc -l) )); then
    status="fail"
    blocked_by="monthly"
    scope="all"
  elif (( $(echo "$daily_total >= $daily_cap" | bc -l) )); then
    status="fail"
    blocked_by="daily"
    scope="all"
  elif (( $(echo "$request_total >= $per_request_cap" | bc -l) )); then
    status="fail"
    blocked_by="per_request"
    scope="request"
  fi

  jq -nc \
    --arg status "$status" \
    --arg blocked_by "$blocked_by" \
    --arg scope "$scope" \
    --argjson monthly_total "$monthly_total" \
    --argjson monthly_cap "$monthly_cap" \
    --argjson daily_total "$daily_total" \
    --argjson daily_cap "$daily_cap" \
    --argjson request_total "$request_total" \
    --argjson per_request_cap "$per_request_cap" \
    '{
      status: $status,
      blocked_by: $blocked_by,
      scope: $scope,
      monthly: {total: $monthly_total, cap: $monthly_cap},
      daily: {total: $daily_total, cap: $daily_cap},
      per_request: {total: $request_total, cap: $per_request_cap}
    }'

  if [[ "$status" == "fail" ]]; then
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# pause_request_by_state_file -- Transition a request to paused by state file
#
# Directly updates the state.json file to set status to "paused" and records
# the pause reason. Used by pause_all_active_requests when iterating over
# state files.
#
# Arguments:
#   $1 -- state_file: Absolute path to the state.json file
#
# Returns:
#   0 on success
#   1 on error
# ---------------------------------------------------------------------------
pause_request_by_state_file() {
  local state_file="$1"

  if [[ ! -f "$state_file" ]]; then
    log_error "cost_governor" "State file not found: $state_file"
    return 1
  fi

  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  local tmp="${state_file}.tmp"
  jq \
    --arg ts "$ts" \
    --arg reason "cost_cap_exceeded" '
    .status = "paused" |
    .updated_at = $ts |
    .current_phase_metadata.paused_at = $ts |
    .current_phase_metadata.pause_reason = $reason
  ' "$state_file" > "$tmp" || {
    log_error "cost_governor" "Failed to write temp file for pause"
    rm -f "$tmp"
    return 1
  }
  mv "$tmp" "$state_file"
  log_info "cost_governor" "Paused request via state file: $state_file"
  return 0
}

# ---------------------------------------------------------------------------
# pause_request -- Transition a single request to paused
#
# Locates the request's state file across allowlisted repositories and
# transitions it to paused status. Uses the state machine transition
# function if available, otherwise falls back to direct state file update.
#
# Arguments:
#   $1 -- request_id: The request ID to pause
#
# Returns:
#   0 on success
#   1 on error (request not found or transition failed)
# ---------------------------------------------------------------------------
pause_request() {
  local request_id="$1"

  # If transition_state is available from the state machine (TDD-002), use it
  if declare -F transition_state >/dev/null 2>&1; then
    transition_state "$request_id" "paused" "cost_cap_exceeded"
    return $?
  fi

  # Fallback: locate and update state file directly
  # Need effective config to find repos; check if EFFECTIVE_CONFIG is set
  local config="${EFFECTIVE_CONFIG:-}"
  if [[ -z "$config" ]] && [[ -n "${_CG_EFFECTIVE_CONFIG:-}" ]]; then
    config="$_CG_EFFECTIVE_CONFIG"
  fi

  if [[ -z "$config" ]]; then
    log_error "cost_governor" "Cannot pause request ${request_id}: no effective config available"
    return 1
  fi

  local allowlist
  allowlist=$(echo "$config" | jq -r '.repositories.allowlist[]' 2>/dev/null)

  while IFS= read -r repo; do
    [[ -z "$repo" ]] && continue
    local state_file="${repo}/.autonomous-dev/requests/${request_id}/state.json"
    if [[ -f "$state_file" ]]; then
      pause_request_by_state_file "$state_file"
      return $?
    fi
  done <<< "$allowlist"

  log_error "cost_governor" "Request ${request_id} not found in any allowlisted repository"
  return 1
}

# ---------------------------------------------------------------------------
# pause_all_active_requests -- Scan for active requests and pause each
#
# Iterates over all allowlisted repositories, finds requests with active
# statuses (not completed, cancelled, failed, or already paused), and
# transitions them to paused.
#
# Arguments:
#   $1 -- effective_config: JSON string of the effective configuration
#
# Returns:
#   0 always (individual pause failures are logged but do not halt scan)
# ---------------------------------------------------------------------------
pause_all_active_requests() {
  local effective_config="$1"
  local allowlist
  allowlist=$(echo "$effective_config" | jq -r '.repositories.allowlist[]' 2>/dev/null)

  while IFS= read -r repo; do
    [[ -z "$repo" ]] && continue
    local requests_dir="${repo}/.autonomous-dev/requests"
    [[ -d "$requests_dir" ]] || continue
    for req_dir in "$requests_dir"/*/; do
      local state_file="${req_dir}state.json"
      [[ -f "$state_file" ]] || continue
      local status
      status=$(jq -r '.status' "$state_file" 2>/dev/null || echo "unknown")
      case "$status" in
        completed|cancelled|failed|paused) continue ;;
      esac
      pause_request_by_state_file "$state_file"
    done
  done <<< "$allowlist"
}

# ---------------------------------------------------------------------------
# emit_cost_escalation -- Construct and emit the cost escalation payload
#
# Builds the escalation payload per TDD-010 Section 3.4.3 and emits it
# via the escalation subsystem (emit_escalation or emit_alert fallback).
#
# Arguments:
#   $1 -- budget_status:      JSON output from check_budgets()
#   $2 -- trigger_request_id: The request that triggered the cap exceedance
#   $3 -- effective_config:   JSON string of the effective configuration
#
# Returns:
#   0 on success
#   1 on error
#
# Escalation payload fields:
#   escalation_type: "cost"
#   urgency: "immediate"
#   cap_type: "daily"|"monthly"|"per_request"
#   cap_value_usd: number
#   current_spend_usd: number
#   overage_usd: number
#   affected_requests: array of request ID strings
#   recommendation: string (varies by cap type)
# ---------------------------------------------------------------------------
emit_cost_escalation() {
  local budget_status="$1"
  local trigger_request_id="$2"
  local effective_config="$3"

  local cap_type cap_value current_spend overage
  cap_type=$(echo "$budget_status" | jq -r '.blocked_by')

  case "$cap_type" in
    monthly)
      cap_value=$(echo "$budget_status" | jq -r '.monthly.cap')
      current_spend=$(echo "$budget_status" | jq -r '.monthly.total')
      ;;
    daily)
      cap_value=$(echo "$budget_status" | jq -r '.daily.cap')
      current_spend=$(echo "$budget_status" | jq -r '.daily.total')
      ;;
    per_request)
      cap_value=$(echo "$budget_status" | jq -r '.per_request.cap')
      current_spend=$(echo "$budget_status" | jq -r '.per_request.total')
      ;;
    *)
      log_error "cost_governor" "Unknown cap_type: $cap_type"
      return 1
      ;;
  esac

  overage=$(echo "$current_spend - $cap_value" | bc -l)
  overage=$(printf "%.2f" "$overage")

  # Collect affected request IDs
  local affected_requests
  if [[ "$cap_type" == "per_request" ]]; then
    affected_requests="[\"$trigger_request_id\"]"
  else
    affected_requests=$(get_active_request_ids "$effective_config" | jq -R -s 'split("\n") | map(select(. != ""))')
  fi

  # Recommendation text varies by cap type
  local recommendation
  case "$cap_type" in
    per_request) recommendation="Review request ${trigger_request_id}. Either raise the per-request cap or cancel it." ;;
    daily) recommendation="Review active requests. Either raise the daily cap or cancel low-priority requests." ;;
    monthly) recommendation="Monthly budget exhausted. Raise the monthly cap or wait until next month." ;;
  esac

  local payload
  payload=$(jq -nc \
    --arg cap_type "$cap_type" \
    --argjson cap_value "$cap_value" \
    --argjson current_spend "$current_spend" \
    --argjson overage "$overage" \
    --argjson affected "$affected_requests" \
    --arg recommendation "$recommendation" \
    '{
      escalation_type: "cost",
      urgency: "immediate",
      cap_type: $cap_type,
      cap_value_usd: $cap_value,
      current_spend_usd: $current_spend,
      overage_usd: $overage,
      affected_requests: $affected,
      recommendation: $recommendation
    }')

  # Emit via escalation subsystem (TDD-009)
  # Use emit_escalation if available, otherwise fall back to emit_alert
  if declare -F emit_escalation >/dev/null 2>&1; then
    emit_escalation "$payload"
  elif declare -F emit_alert >/dev/null 2>&1; then
    emit_alert "cost_cap_exceeded" "$payload"
  else
    # Last resort: write to stderr and alerts directory
    echo "[cost_governor] ESCALATION: $payload" >&2
    local alerts_dir="${HOME}/.autonomous-dev/alerts"
    mkdir -p "$alerts_dir"
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local alert_file="${alerts_dir}/alert-cost_cap_exceeded-$(date +%s)-$$.json"
    echo "$payload" > "${alert_file}.tmp"
    mv "${alert_file}.tmp" "$alert_file"
  fi
}

# ---------------------------------------------------------------------------
# post_session_check -- After recording cost, check if any cap is newly exceeded
#
# Called after a session completes and its cost has been recorded in the
# ledger. Checks all three budget tiers. If a cap is exceeded:
#   - daily/monthly: pauses ALL active requests
#   - per_request: pauses only the triggering request
# Always emits an escalation payload on cap exceedance.
#
# Arguments:
#   $1 -- request_id:      The request that just completed a session
#   $2 -- effective_config: JSON string of the effective configuration
#
# Returns:
#   0 always (cap exceedance is handled via pause + escalation, not error codes)
# ---------------------------------------------------------------------------
post_session_check() {
  local request_id="$1"
  local effective_config="$2"

  # Store config for use by pause_request's fallback path
  _CG_EFFECTIVE_CONFIG="$effective_config"

  local budget_status
  budget_status=$(check_budgets "$request_id" "$effective_config")
  local exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    local blocked_by scope
    blocked_by=$(echo "$budget_status" | jq -r '.blocked_by')
    scope=$(echo "$budget_status" | jq -r '.scope')

    if [[ "$scope" == "all" ]]; then
      # Daily or monthly cap exceeded: pause ALL active requests
      pause_all_active_requests "$effective_config"
    else
      # Per-request cap exceeded: pause only this request
      pause_request "$request_id"
    fi

    # Emit escalation
    emit_cost_escalation "$budget_status" "$request_id" "$effective_config"
  fi
}
