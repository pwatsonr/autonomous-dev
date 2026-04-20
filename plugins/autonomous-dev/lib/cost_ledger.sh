#!/usr/bin/env bash
# cost_ledger.sh -- Append-only JSONL ledger with aggregate computation
# Part of TDD-010 / SPEC-010-2-01: Cost Extraction & Append-Only Cost Ledger
# Error handling added in SPEC-010-2-03: Cost CLI Commands & Ledger Error Handling
#
# Dependencies: jq (1.6+), bc, bash 4+
#
# Usage:
#   source cost_ledger.sh
#   append_cost_entry "REQ-20260408-a3f1" "/path/to/repo" "prd" "sess_abc" "1.85" 28
#   daily=$(get_daily_total)
#   monthly=$(get_monthly_total)

set -euo pipefail

# Source guard
if [[ -n "${_COST_LEDGER_LOADED:-}" ]]; then return 0 2>/dev/null || true; fi
_COST_LEDGER_LOADED=1

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
COST_LEDGER_PATH="${COST_LEDGER_PATH:-${HOME}/.autonomous-dev/cost-ledger.jsonl}"

# ---------------------------------------------------------------------------
# Resolve PLUGIN_ROOT for sourcing sibling libraries (needed by append_with_retry)
# ---------------------------------------------------------------------------
if [[ -z "${PLUGIN_ROOT:-}" ]]; then
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# ---------------------------------------------------------------------------
# Logging helpers (write to stderr so stdout stays clean for data output)
# ---------------------------------------------------------------------------
if ! declare -F log_warning >/dev/null 2>&1; then
  log_warning() {
    local tag="$1"; shift
    echo "[${tag}] WARNING: $*" >&2
  }
fi

if ! declare -F log_error >/dev/null 2>&1; then
  log_error() {
    local tag="$1"; shift
    echo "[${tag}] ERROR: $*" >&2
  }
fi

# ---------------------------------------------------------------------------
# ensure_ledger_exists -- Auto-create ledger file on first write
#
# Creates the ledger directory and file if they do not exist.
# Logs a warning when creating a new ledger.
#
# Returns:
#   0 always
# ---------------------------------------------------------------------------
ensure_ledger_exists() {
  if [[ ! -f "$COST_LEDGER_PATH" ]]; then
    local ledger_dir
    ledger_dir=$(dirname "$COST_LEDGER_PATH")
    mkdir -p "$ledger_dir"
    touch "$COST_LEDGER_PATH"
    log_warning "cost_ledger" "Created new cost ledger: $COST_LEDGER_PATH"
  fi
}

# ---------------------------------------------------------------------------
# validate_ledger_integrity -- Check that the last line of the ledger is valid JSON
#
# An empty ledger is considered valid. A non-empty ledger with a corrupted
# last line causes a FATAL error -- the system should refuse to start.
#
# Returns:
#   0 if the ledger is valid (or empty)
#   1 if the last line is corrupted
# ---------------------------------------------------------------------------
validate_ledger_integrity() {
  if [[ ! -s "$COST_LEDGER_PATH" ]]; then
    return 0  # Empty is OK
  fi

  local last_line
  last_line=$(tail -1 "$COST_LEDGER_PATH")
  if ! echo "$last_line" | jq '.' >/dev/null 2>&1; then
    log_error "cost_ledger" "FATAL: Corrupted last line in cost ledger. Manual repair required."
    log_error "cost_ledger" "File: $COST_LEDGER_PATH"
    log_error "cost_ledger" "Last line: $last_line"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# append_with_retry -- Write an entry to the ledger with one retry on failure
#
# On first failure, waits 1 second and retries. On second failure, pauses
# all active requests and emits an infrastructure escalation.
#
# Arguments:
#   $1 -- entry: JSON string to append
#
# Returns:
#   0 on success
#   1 on permanent failure (both attempts failed)
# ---------------------------------------------------------------------------
append_with_retry() {
  local entry="$1"
  local tmp_file="${COST_LEDGER_PATH}.tmp.$$"

  echo "$entry" > "$tmp_file" 2>/dev/null
  if cat "$tmp_file" >> "$COST_LEDGER_PATH" 2>/dev/null; then
    rm -f "$tmp_file"
    return 0
  fi

  log_warning "cost_ledger" "First append attempt failed. Retrying..."
  sleep 1

  if cat "$tmp_file" >> "$COST_LEDGER_PATH" 2>/dev/null; then
    rm -f "$tmp_file"
    return 0
  fi

  log_error "cost_ledger" "FATAL: Cost ledger write failed after retry. Pausing all requests."
  rm -f "$tmp_file"

  # Pause all requests and escalate
  # Source cost_governor if pause_all_active_requests is not yet available
  if ! declare -F pause_all_active_requests >/dev/null 2>&1; then
    if [[ -f "${PLUGIN_ROOT}/lib/cost_governor.sh" ]]; then
      source "${PLUGIN_ROOT}/lib/cost_governor.sh"
    fi
  fi

  if declare -F pause_all_active_requests >/dev/null 2>&1; then
    local config
    if declare -F load_config >/dev/null 2>&1; then
      config=$(load_config 2>/dev/null || echo '{}')
    else
      config='{}'
    fi
    pause_all_active_requests "$config"
  fi

  # Emit escalation
  local escalation_payload
  escalation_payload=$(jq -nc '{
    escalation_type: "infrastructure",
    urgency: "immediate",
    message: "Cost ledger write failure. Cost was incurred but is unrecorded. All requests paused.",
    recommendation: "Check disk space and filesystem permissions for ~/.autonomous-dev/cost-ledger.jsonl"
  }')

  if declare -F emit_escalation >/dev/null 2>&1; then
    emit_escalation "$escalation_payload"
  elif declare -F emit_alert >/dev/null 2>&1; then
    emit_alert "infrastructure" "$escalation_payload"
  else
    echo "[cost_ledger] ESCALATION: $escalation_payload" >&2
    local alerts_dir="${HOME}/.autonomous-dev/alerts"
    mkdir -p "$alerts_dir"
    local alert_file="${alerts_dir}/alert-ledger_write_failure-$(date +%s)-$$.json"
    echo "$escalation_payload" > "${alert_file}.tmp"
    mv "${alert_file}.tmp" "$alert_file"
  fi

  return 1
}

# ---------------------------------------------------------------------------
# append_cost_entry -- Append a single JSONL line to the cost ledger
#
# Arguments:
#   $1 -- request_id:  e.g., "REQ-20260408-a3f1"
#   $2 -- repository:  absolute path
#   $3 -- phase:       pipeline phase name
#   $4 -- session_id:  Claude Code session ID
#   $5 -- cost_usd:    session cost as decimal string
#   $6 -- turns_used:  integer
#
# Returns:
#   0 on success
#   1 on error (corrupted ledger, write failure)
#
# Behavior:
#   1. Read last line of ledger (if exists) for current daily/monthly totals.
#   2. Compute new daily/monthly totals based on date boundaries.
#   3. Compute cumulative_request_cost_usd from prior entries for same request_id.
#   4. Construct JSON entry.
#   5. Write to temp file, then append atomically.
# ---------------------------------------------------------------------------
append_cost_entry() {
  local request_id="$1"
  local repository="$2"
  local phase="$3"
  local session_id="$4"
  local cost_usd="$5"
  local turns_used="$6"

  # Ensure ledger file exists (auto-create on first write)
  ensure_ledger_exists

  # Validate ledger integrity before appending
  if ! validate_ledger_integrity; then
    return 1
  fi

  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local today
  today=$(date -u +"%Y-%m-%d")
  local this_month
  this_month=$(date -u +"%Y-%m")

  local daily_total="$cost_usd"
  local monthly_total="$cost_usd"

  if [[ -s "$COST_LEDGER_PATH" ]]; then
    local last_line
    last_line=$(tail -1 "$COST_LEDGER_PATH")

    local last_date last_month last_daily last_monthly
    last_date=$(echo "$last_line" | jq -r '.timestamp[:10]')
    last_month=$(echo "$last_line" | jq -r '.timestamp[:7]')
    last_daily=$(echo "$last_line" | jq -r '.daily_total_usd')
    last_monthly=$(echo "$last_line" | jq -r '.monthly_total_usd')

    if [[ "$last_date" == "$today" ]]; then
      # Same day: increment both
      daily_total=$(echo "$last_daily + $cost_usd" | bc -l)
      monthly_total=$(echo "$last_monthly + $cost_usd" | bc -l)
    elif [[ "$last_month" == "$this_month" ]]; then
      # Same month, new day: reset daily, increment monthly
      daily_total="$cost_usd"
      monthly_total=$(echo "$last_monthly + $cost_usd" | bc -l)
    else
      # New month: reset both
      daily_total="$cost_usd"
      monthly_total="$cost_usd"
    fi
  fi

  # Compute cumulative request cost
  local cumulative_request_cost="$cost_usd"
  if [[ -s "$COST_LEDGER_PATH" ]]; then
    local prev_cumulative
    prev_cumulative=$(grep "\"$request_id\"" "$COST_LEDGER_PATH" 2>/dev/null \
      | tail -1 \
      | jq -r '.cumulative_request_cost_usd // 0' || true)
    if [[ -n "$prev_cumulative" ]] && [[ "$prev_cumulative" != "0" ]] && [[ "$prev_cumulative" != "null" ]]; then
      cumulative_request_cost=$(echo "$prev_cumulative + $cost_usd" | bc -l)
    fi
  fi

  # Format numbers to 2 decimal places
  daily_total=$(printf "%.2f" "$daily_total")
  monthly_total=$(printf "%.2f" "$monthly_total")
  cumulative_request_cost=$(printf "%.2f" "$cumulative_request_cost")
  local cost_usd_fmt
  cost_usd_fmt=$(printf "%.2f" "$cost_usd")

  # Construct entry
  local entry
  entry=$(jq -nc \
    --arg ts "$timestamp" \
    --arg rid "$request_id" \
    --arg repo "$repository" \
    --arg phase "$phase" \
    --arg sid "$session_id" \
    --argjson cost "$cost_usd_fmt" \
    --argjson turns "$turns_used" \
    --argjson cum "$cumulative_request_cost" \
    --argjson daily "$daily_total" \
    --argjson monthly "$monthly_total" \
    '{
      timestamp: $ts,
      request_id: $rid,
      repository: $repo,
      phase: $phase,
      session_id: $sid,
      cost_usd: $cost,
      turns_used: $turns,
      cumulative_request_cost_usd: $cum,
      daily_total_usd: $daily,
      monthly_total_usd: $monthly
    }')

  # Append with retry logic
  append_with_retry "$entry"
}

# ---------------------------------------------------------------------------
# get_daily_total -- Tail-read strategy for budget checks (Strategy A)
#
# Reads only the last line of the ledger. If the last entry's date matches
# today (UTC), returns its daily_total_usd. Otherwise returns "0.00".
#
# Stdout:
#   Decimal string (e.g., "12.43")
#
# Returns:
#   0 always
# ---------------------------------------------------------------------------
get_daily_total() {
  local today
  today=$(date -u +"%Y-%m-%d")

  if [[ ! -f "$COST_LEDGER_PATH" ]] || [[ ! -s "$COST_LEDGER_PATH" ]]; then
    echo "0.00"
    return 0
  fi

  local last_line
  last_line=$(tail -1 "$COST_LEDGER_PATH")
  local last_date
  last_date=$(echo "$last_line" | jq -r '.timestamp[:10]')

  if [[ "$last_date" == "$today" ]]; then
    echo "$last_line" | jq -r '.daily_total_usd'
  else
    echo "0.00"
  fi
}

# ---------------------------------------------------------------------------
# get_monthly_total -- Tail-read strategy for budget checks
#
# Reads only the last line of the ledger. If the last entry's month matches
# this month (UTC), returns its monthly_total_usd. Otherwise returns "0.00".
#
# Stdout:
#   Decimal string (e.g., "187.22")
#
# Returns:
#   0 always
# ---------------------------------------------------------------------------
get_monthly_total() {
  local this_month
  this_month=$(date -u +"%Y-%m")

  if [[ ! -f "$COST_LEDGER_PATH" ]] || [[ ! -s "$COST_LEDGER_PATH" ]]; then
    echo "0.00"
    return 0
  fi

  local last_line
  last_line=$(tail -1 "$COST_LEDGER_PATH")
  local last_month
  last_month=$(echo "$last_line" | jq -r '.timestamp[:7]')

  if [[ "$last_month" == "$this_month" ]]; then
    echo "$last_line" | jq -r '.monthly_total_usd'
  else
    echo "0.00"
  fi
}

# ---------------------------------------------------------------------------
# get_daily_breakdown -- Full-scan strategy for reporting (Strategy B)
#
# Arguments:
#   $1 -- month (optional): YYYY-MM format, defaults to current UTC month
#
# Stdout:
#   JSON array of objects: [{date, total, entries}, ...]
#
# Returns:
#   0 always
# ---------------------------------------------------------------------------
get_daily_breakdown() {
  local month="${1:-$(date -u +"%Y-%m")}"

  if [[ ! -f "$COST_LEDGER_PATH" ]] || [[ ! -s "$COST_LEDGER_PATH" ]]; then
    echo "[]"
    return 0
  fi

  jq -r "select(.timestamp[:7] == \"$month\")" "$COST_LEDGER_PATH" \
    | jq -s 'group_by(.timestamp[:10]) | map({date: .[0].timestamp[:10], total: (map(.cost_usd) | add), entries: length})'
}

# ---------------------------------------------------------------------------
# get_request_cost -- Full-scan for a specific request
#
# Arguments:
#   $1 -- request_id: e.g., "REQ-20260408-a3f1"
#
# Stdout:
#   JSON object: {request_id, total_cost_usd, phases: [{phase, cost, sessions, turns}], session_count}
#
# Returns:
#   0 always
# ---------------------------------------------------------------------------
get_request_cost() {
  local request_id="$1"

  if [[ ! -f "$COST_LEDGER_PATH" ]] || [[ ! -s "$COST_LEDGER_PATH" ]]; then
    echo '{"request_id":"'"$request_id"'","total_cost_usd":0,"phases":[],"session_count":0}'
    return 0
  fi

  local matched
  matched=$(jq -r "select(.request_id == \"$request_id\")" "$COST_LEDGER_PATH" | jq -s '.')

  if [[ "$matched" == "[]" ]] || [[ -z "$matched" ]]; then
    echo '{"request_id":"'"$request_id"'","total_cost_usd":0,"phases":[],"session_count":0}'
    return 0
  fi

  echo "$matched" | jq '{
      request_id: .[0].request_id,
      total_cost_usd: (map(.cost_usd) | add),
      phases: (group_by(.phase) | map({
        phase: .[0].phase,
        cost: (map(.cost_usd) | add),
        sessions: length,
        turns: (map(.turns_used) | add)
      })),
      session_count: length
    }'
}

# ---------------------------------------------------------------------------
# get_monthly_breakdown -- Full-scan strategy for yearly reporting
#
# Arguments:
#   $1 -- year (optional): YYYY format, defaults to current UTC year
#
# Stdout:
#   JSON array of objects: [{month, month_name, total, entries}, ...]
#
# Returns:
#   0 always
# ---------------------------------------------------------------------------
get_monthly_breakdown() {
  local year="${1:-$(date -u +"%Y")}"

  if [[ ! -f "$COST_LEDGER_PATH" ]] || [[ ! -s "$COST_LEDGER_PATH" ]]; then
    echo "[]"
    return 0
  fi

  jq -r "select(.timestamp[:4] == \"$year\")" "$COST_LEDGER_PATH" \
    | jq -s '
      if length == 0 then []
      else
        group_by(.timestamp[:7]) | map({
          month: .[0].timestamp[:7],
          month_name: (.[0].timestamp[5:7] | tonumber |
            if . == 1 then "January"
            elif . == 2 then "February"
            elif . == 3 then "March"
            elif . == 4 then "April"
            elif . == 5 then "May"
            elif . == 6 then "June"
            elif . == 7 then "July"
            elif . == 8 then "August"
            elif . == 9 then "September"
            elif . == 10 then "October"
            elif . == 11 then "November"
            elif . == 12 then "December"
            else "Unknown" end
          ),
          total: (map(.cost_usd) | add),
          entries: length
        })
      end
    '
}

# ---------------------------------------------------------------------------
# get_repo_cost -- Full-scan for a specific repository
#
# Arguments:
#   $1 -- repo_path: absolute path to the repository
#
# Stdout:
#   JSON object: {repository, total_cost_usd, request_count,
#                 requests: [{request_id, cost, status}, ...]}
#
# Returns:
#   0 always
# ---------------------------------------------------------------------------
get_repo_cost() {
  local repo_path="$1"

  if [[ ! -f "$COST_LEDGER_PATH" ]] || [[ ! -s "$COST_LEDGER_PATH" ]]; then
    echo "{\"repository\":\"${repo_path}\",\"total_cost_usd\":0,\"request_count\":0,\"requests\":[]}"
    return 0
  fi

  local matched
  matched=$(jq -r "select(.repository == \"$repo_path\")" "$COST_LEDGER_PATH" | jq -s '.')

  if [[ "$matched" == "[]" ]] || [[ -z "$matched" ]]; then
    echo "{\"repository\":\"${repo_path}\",\"total_cost_usd\":0,\"request_count\":0,\"requests\":[]}"
    return 0
  fi

  # Build the per-request breakdown; status will be filled in by the CLI layer
  echo "$matched" | jq --arg repo "$repo_path" '{
    repository: $repo,
    total_cost_usd: (map(.cost_usd) | add),
    request_count: (map(.request_id) | unique | length),
    requests: (group_by(.request_id) | map({
      request_id: .[0].request_id,
      cost: (map(.cost_usd) | add),
      status: "unknown"
    }))
  }'
}
