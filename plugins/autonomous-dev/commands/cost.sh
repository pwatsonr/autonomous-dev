#!/usr/bin/env bash
# cost.sh -- Cost reporting CLI for autonomous-dev
# Part of SPEC-010-2-03: Cost CLI Commands & Ledger Error Handling
#
# Usage:
#   autonomous-dev cost                       # today + current month summary
#   autonomous-dev cost --daily               # daily breakdown for current month
#   autonomous-dev cost --monthly             # monthly breakdown for current year
#   autonomous-dev cost --request REQ-X       # per-request per-phase breakdown
#   autonomous-dev cost --repo /path/to/repo  # per-repo breakdown
#
# Dependencies: jq (1.6+), bc, bash 4+

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve PLUGIN_ROOT
# ---------------------------------------------------------------------------
if [[ -z "${PLUGIN_ROOT:-}" ]]; then
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# Source dependencies
source "${PLUGIN_ROOT}/lib/config_loader.sh"
source "${PLUGIN_ROOT}/lib/cost_ledger.sh"

# ---------------------------------------------------------------------------
# cost_default -- Default output: today's spend + current month summary
#
# Arguments:
#   $@ -- forwarded to load_config for CLI overrides
#
# Stdout:
#   Human-readable cost summary with today and this-month figures
# ---------------------------------------------------------------------------
cost_default() {
  local daily_total monthly_total
  daily_total=$(get_daily_total)
  monthly_total=$(get_monthly_total)

  # Check for empty ledger
  if [[ "$daily_total" == "0.00" ]] && [[ "$monthly_total" == "0.00" ]]; then
    # Verify there is genuinely no data (not just a new day/month with prior data)
    if [[ ! -f "$COST_LEDGER_PATH" ]] || [[ ! -s "$COST_LEDGER_PATH" ]]; then
      printf "Cost Summary (%s)\n" "$(date -u +%Y-%m-%d)"
      printf "=========================\n\n"
      printf "No cost data recorded yet.\n"
      return 0
    fi
  fi

  local config
  config=$(load_config "$@")

  local daily_cap monthly_cap
  daily_cap=$(echo "$config" | jq -r '.governance.daily_cost_cap_usd')
  monthly_cap=$(echo "$config" | jq -r '.governance.monthly_cost_cap_usd')

  local daily_remaining monthly_remaining
  daily_remaining=$(echo "$daily_cap - $daily_total" | bc -l)
  monthly_remaining=$(echo "$monthly_cap - $monthly_total" | bc -l)

  # Count active requests
  local active_count=0
  if declare -F get_active_request_ids >/dev/null 2>&1; then
    active_count=$(get_active_request_ids "$config" | grep -c . || true)
  fi

  printf "Cost Summary (%s)\n" "$(date -u +%Y-%m-%d)"
  printf "=========================\n\n"
  printf "Today:\n"
  printf "  Spent:     \$%.2f\n" "$daily_total"
  printf "  Cap:       \$%'.2f\n" "$daily_cap"
  printf "  Remaining: \$%.2f\n\n" "$daily_remaining"
  printf "This Month (%s):\n" "$(date -u +"%B %Y")"
  printf "  Spent:     \$%.2f\n" "$monthly_total"
  printf "  Cap:       \$%'.2f\n" "$monthly_cap"
  printf "  Remaining: \$%.2f\n\n" "$monthly_remaining"
  printf "Active Requests: %d\n" "$active_count"
}

# ---------------------------------------------------------------------------
# cost_daily -- Daily breakdown table for the current month
#
# Stdout:
#   Tabular per-day cost breakdown
# ---------------------------------------------------------------------------
cost_daily() {
  local month
  month=$(date -u +"%Y-%m")
  local breakdown
  breakdown=$(get_daily_breakdown "$month")

  # Check for empty data
  if [[ "$breakdown" == "[]" ]]; then
    printf "Daily Cost Breakdown - %s\n" "$(date -u +"%B %Y")"
    printf "==================================\n\n"
    printf "No cost data recorded yet.\n"
    return 0
  fi

  printf "Daily Cost Breakdown - %s\n" "$(date -u +"%B %Y")"
  printf "==================================\n"
  printf "%-12s| %8s | %s\n" "Date" "Sessions" "Cost"
  printf "------------|----------|--------\n"

  echo "$breakdown" | jq -r '.[] | [.date, (.entries | tostring), (.total | tostring)] | @tsv' | \
    while IFS=$'\t' read -r date entries total; do
      printf "%-12s| %8s | \$%.2f\n" "$date" "$entries" "$total"
    done

  local grand_total
  grand_total=$(echo "$breakdown" | jq '[.[].total] | add')
  local total_sessions
  total_sessions=$(echo "$breakdown" | jq '[.[].entries] | add')
  printf "------------|----------|--------\n"
  printf "%-12s| %8s | \$%.2f\n" "Total" "$total_sessions" "$grand_total"
}

# ---------------------------------------------------------------------------
# cost_monthly -- Monthly breakdown table for the current year
#
# Stdout:
#   Tabular per-month cost breakdown
# ---------------------------------------------------------------------------
cost_monthly() {
  local year
  year=$(date -u +"%Y")
  local breakdown
  breakdown=$(get_monthly_breakdown "$year")

  # Check for empty data
  if [[ "$breakdown" == "[]" ]]; then
    printf "Monthly Cost Breakdown - %s\n" "$year"
    printf "==============================\n\n"
    printf "No cost data recorded yet.\n"
    return 0
  fi

  printf "Monthly Cost Breakdown - %s\n" "$year"
  printf "==============================\n"
  printf "%-12s| %8s | %s\n" "Month" "Sessions" "Cost"
  printf "------------|----------|----------\n"

  echo "$breakdown" | jq -r '.[] | [.month_name, (.entries | tostring), (.total | tostring)] | @tsv' | \
    while IFS=$'\t' read -r month_name entries total; do
      printf "%-12s| %8s | \$%.2f\n" "$month_name" "$entries" "$total"
    done

  local grand_total
  grand_total=$(echo "$breakdown" | jq '[.[].total] | add')
  local total_sessions
  total_sessions=$(echo "$breakdown" | jq '[.[].entries] | add')
  printf "------------|----------|----------\n"
  printf "%-12s| %8s | \$%.2f\n" "Year Total" "$total_sessions" "$grand_total"
}

# ---------------------------------------------------------------------------
# cost_request -- Per-request per-phase breakdown
#
# Arguments:
#   $1 -- request_id: e.g., "REQ-20260408-a3f1"
#
# Stdout:
#   Per-phase cost and turn breakdown for the specified request
# ---------------------------------------------------------------------------
cost_request() {
  local request_id="$1"

  if [[ -z "$request_id" ]]; then
    echo "Error: --request requires a request ID argument." >&2
    return 1
  fi

  local request_data
  request_data=$(get_request_cost "$request_id")

  local session_count
  session_count=$(echo "$request_data" | jq -r '.session_count')

  if [[ "$session_count" == "0" ]] || [[ "$session_count" == "null" ]]; then
    printf "No data found for request: %s\n" "$request_id"
    return 0
  fi

  local total_cost repository status
  total_cost=$(echo "$request_data" | jq -r '.total_cost_usd')
  repository=$(get_request_repository "$request_id")
  status=$(get_request_status "$request_id")

  printf "Request: %s\n" "$request_id"
  printf "Repository: %s\n" "$repository"
  printf "Status: %s\n" "$status"
  printf "Total Cost: \$%.2f\n\n" "$total_cost"

  printf "Phase Breakdown:\n"
  printf "  %-12s| %8s | %7s | %s\n" "Phase" "Sessions" "Cost" "Turns"
  printf "  ------------|----------|---------|------\n"

  echo "$request_data" | jq -r '.phases[] | [.phase, (.sessions | tostring), (.cost | tostring), (.turns | tostring)] | @tsv' | \
    while IFS=$'\t' read -r phase sessions cost turns; do
      printf "  %-12s| %8s | \$%.2f  | %5s\n" "$phase" "$sessions" "$cost" "$turns"
    done

  local total_turns
  total_turns=$(echo "$request_data" | jq '[.phases[].turns] | add // 0')
  printf "  ------------|----------|---------|------\n"
  printf "  %-12s| %8s | \$%.2f  | %5s\n" "Total" "$session_count" "$total_cost" "$total_turns"
}

# ---------------------------------------------------------------------------
# cost_repo -- Per-repo cost breakdown showing all requests
#
# Arguments:
#   $1 -- repo_path: absolute path to the repository
#
# Stdout:
#   Per-request cost breakdown for the specified repository
# ---------------------------------------------------------------------------
cost_repo() {
  local repo_path="$1"

  if [[ -z "$repo_path" ]]; then
    echo "Error: --repo requires a repository path argument." >&2
    return 1
  fi

  local repo_data
  repo_data=$(get_repo_cost "$repo_path")

  local request_count
  request_count=$(echo "$repo_data" | jq -r '.request_count')

  if [[ "$request_count" == "0" ]] || [[ "$request_count" == "null" ]]; then
    printf "No data found for repository: %s\n" "$repo_path"
    return 0
  fi

  local total_cost
  total_cost=$(echo "$repo_data" | jq -r '.total_cost_usd')

  printf "Repository: %s\n" "$repo_path"
  printf "Total Cost: \$%.2f\n" "$total_cost"
  printf "Requests: %s\n\n" "$request_count"

  printf "Request Breakdown:\n"
  printf "  %-23s| %-11s | %s\n" "Request ID" "Status" "Cost"
  printf "  -----------------------|-------------|--------\n"

  # Enrich each request's status from state files
  local enriched_data="$repo_data"
  local req_ids
  req_ids=$(echo "$repo_data" | jq -r '.requests[].request_id')
  while IFS= read -r req_id; do
    [[ -z "$req_id" ]] && continue
    local actual_status
    actual_status=$(get_request_status "$req_id")
    enriched_data=$(echo "$enriched_data" | jq --arg rid "$req_id" --arg st "$actual_status" \
      '.requests = [.requests[] | if .request_id == $rid then .status = $st else . end]')
  done <<< "$req_ids"

  echo "$enriched_data" | jq -r '.requests[] | [.request_id, .status, (.cost | tostring)] | @tsv' | \
    while IFS=$'\t' read -r req_id status cost; do
      printf "  %-23s| %-11s | \$%.2f\n" "$req_id" "$status" "$cost"
    done
}

# ---------------------------------------------------------------------------
# get_request_repository -- Look up repository path for a request from ledger
#
# Arguments:
#   $1 -- request_id
#
# Stdout:
#   Repository path string, or "unknown"
# ---------------------------------------------------------------------------
get_request_repository() {
  local request_id="$1"

  if [[ ! -f "$COST_LEDGER_PATH" ]] || [[ ! -s "$COST_LEDGER_PATH" ]]; then
    echo "unknown"
    return 0
  fi

  local repo
  repo=$(grep "\"${request_id}\"" "$COST_LEDGER_PATH" 2>/dev/null \
    | head -1 \
    | jq -r '.repository // "unknown"')

  echo "${repo:-unknown}"
}

# ---------------------------------------------------------------------------
# get_request_status -- Look up current status for a request from state files
#
# Tries to find the state.json for the request across allowlisted repos.
# Falls back to inferring from ledger data if state file not found.
#
# Arguments:
#   $1 -- request_id
#
# Stdout:
#   Status string (e.g., "in_progress", "completed")
# ---------------------------------------------------------------------------
get_request_status() {
  local request_id="$1"

  # Try to find state file via config allowlist
  local config
  if config=$(load_config 2>/dev/null); then
    local allowlist
    allowlist=$(echo "$config" | jq -r '.repositories.allowlist[]' 2>/dev/null || true)
    while IFS= read -r repo; do
      [[ -z "$repo" ]] && continue
      local state_file="${repo}/.autonomous-dev/requests/${request_id}/state.json"
      if [[ -f "$state_file" ]]; then
        jq -r '.status // "unknown"' "$state_file" 2>/dev/null
        return 0
      fi
    done <<< "$allowlist"
  fi

  # Fallback: infer from repository in ledger
  if [[ -f "$COST_LEDGER_PATH" ]] && [[ -s "$COST_LEDGER_PATH" ]]; then
    local repo_path
    repo_path=$(grep "\"${request_id}\"" "$COST_LEDGER_PATH" 2>/dev/null \
      | head -1 \
      | jq -r '.repository // empty')
    if [[ -n "$repo_path" ]]; then
      local state_file="${repo_path}/.autonomous-dev/requests/${request_id}/state.json"
      if [[ -f "$state_file" ]]; then
        jq -r '.status // "unknown"' "$state_file" 2>/dev/null
        return 0
      fi
    fi
  fi

  echo "unknown"
}

# ---------------------------------------------------------------------------
# Main -- Parse arguments and dispatch
# ---------------------------------------------------------------------------
main() {
  # Verify jq is installed
  if ! command -v jq >/dev/null 2>&1; then
    echo "Error: jq is required but not installed." >&2
    return 1
  fi

  local mode="default"
  local request_id=""
  local repo_path=""
  local passthrough_args=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --daily)
        mode="daily"
        shift
        ;;
      --monthly)
        mode="monthly"
        shift
        ;;
      --request)
        mode="request"
        shift
        request_id="${1:-}"
        [[ -n "$request_id" ]] && shift
        ;;
      --repo)
        mode="repo"
        shift
        repo_path="${1:-}"
        [[ -n "$repo_path" ]] && shift
        ;;
      --config.*)
        passthrough_args+=("$1")
        shift
        ;;
      -h|--help)
        echo "Usage:"
        echo "  autonomous-dev cost                       # today + current month summary"
        echo "  autonomous-dev cost --daily               # daily breakdown for current month"
        echo "  autonomous-dev cost --monthly             # monthly breakdown for current year"
        echo "  autonomous-dev cost --request REQ-X       # per-request per-phase breakdown"
        echo "  autonomous-dev cost --repo /path/to/repo  # per-repo breakdown"
        return 0
        ;;
      *)
        echo "Error: Unknown argument: $1" >&2
        echo "Run 'autonomous-dev cost --help' for usage." >&2
        return 1
        ;;
    esac
  done

  case "$mode" in
    default)
      cost_default "${passthrough_args[@]+"${passthrough_args[@]}"}"
      ;;
    daily)
      cost_daily
      ;;
    monthly)
      cost_monthly
      ;;
    request)
      cost_request "$request_id"
      ;;
    repo)
      cost_repo "$repo_path"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Run if executed directly (not sourced)
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
