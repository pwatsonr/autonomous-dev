#!/usr/bin/env bash
# rate_limit_handler.sh -- Rate-limit detection, exponential backoff state machine, and state management
# Part of SPEC-010-3-02: Rate-Limit Detection & Exponential Backoff State Machine
#
# Dependencies: jq (1.6+), bash 4+
#
# Usage:
#   source rate_limit_handler.sh
#   detect_rate_limit "$session_output"
#   handle_rate_limit "$effective_config"
#   check_rate_limit_state
#   clear_rate_limit_state

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve PLUGIN_ROOT for sourcing sibling libraries
# ---------------------------------------------------------------------------
if [[ -z "${PLUGIN_ROOT:-}" ]]; then
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
# emit_escalation fallback
# Only define if not already defined (e.g., when sourced by supervisor-loop.sh)
# ---------------------------------------------------------------------------
if ! declare -F emit_escalation >/dev/null 2>&1; then
  emit_escalation() {
    local payload="$1"
    # Last resort: write to stderr and alerts directory
    echo "[rate_limit_handler] ESCALATION: $payload" >&2
    local alerts_dir="${HOME}/.autonomous-dev/alerts"
    mkdir -p "$alerts_dir"
    local alert_file="${alerts_dir}/alert-rate_limit-$(date +%s)-$$.json"
    echo "$payload" > "${alert_file}.tmp"
    mv "${alert_file}.tmp" "$alert_file"
  }
fi

# ---------------------------------------------------------------------------
# detect_rate_limit -- Detect rate-limit indicators in session output
#
# Scans session output text for patterns indicating an API rate limit:
#   - HTTP 429 status codes
#   - Rate limit text variants (exceeded, reached, hit, error)
#   - Anthropic API specific errors (overloaded_error)
#   - "too many requests"
#
# False positive avoidance: The word "rate" alone (e.g., "approval rate")
# does not trigger detection.
#
# Arguments:
#   $1 -- session_output: Text output from a Claude Code session
#
# Returns:
#   0 if rate limit detected
#   1 if no rate limit detected
# ---------------------------------------------------------------------------
detect_rate_limit() {
  local session_output="$1"

  # Pattern 1: HTTP 429 status code
  if echo "$session_output" | grep -qiE '(HTTP[/ ]429|status[: ]+429)'; then
    return 0
  fi

  # Pattern 2: Rate limit text variants
  if echo "$session_output" | grep -qiE '(rate[_ -]?limit|rate[_ -]?limited|too many requests)'; then
    # Avoid false positives: reject if "rate" appears only in non-limit context
    # (e.g., "approval rate" or "error rate")
    if echo "$session_output" | grep -qiE '(rate[_ -]?limit (exceeded|reached|hit|error)|you are being rate[_ -]?limited|too many requests)'; then
      return 0
    fi
  fi

  # Pattern 3: Anthropic API specific errors
  if echo "$session_output" | grep -qiE 'anthropic.*rate.*limit|overloaded_error'; then
    return 0
  fi

  return 1
}

# ---------------------------------------------------------------------------
# write_rate_limit_state -- Atomic state file write
#
# Writes the rate-limit state file using a tmp+mv pattern for atomicity.
# Creates the parent directory if needed.
#
# Arguments:
#   $1 -- state_file:  Absolute path to the rate-limit state file
#   $2 -- active:      "true" or "false"
#   $3 -- consecutive: Number of consecutive rate limits (integer)
#   $4 -- backoff:     Current backoff in seconds (integer)
#   $5 -- kill_switch: "true" or "false" (default: "false")
#   $6 -- retry_at:    ISO-8601 timestamp or "null" (default: "null")
#
# Returns:
#   0 on success
# ---------------------------------------------------------------------------
write_rate_limit_state() {
  local state_file="$1"
  local active="$2"
  local consecutive="$3"
  local backoff="$4"
  local kill_switch="${5:-false}"
  local retry_at="${6:-null}"

  local triggered_at
  triggered_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  local state_dir
  state_dir=$(dirname "$state_file")
  mkdir -p "$state_dir"

  local tmp_file="${state_file}.tmp.$$"
  jq -nc \
    --argjson active "$active" \
    --arg triggered_at "$triggered_at" \
    --argjson backoff "$backoff" \
    --arg retry_at "$retry_at" \
    --argjson consecutive "$consecutive" \
    --argjson kill_switch "$kill_switch" \
    '{
      active: $active,
      triggered_at: $triggered_at,
      current_backoff_seconds: $backoff,
      retry_at: (if $retry_at == "null" then null else $retry_at end),
      consecutive_rate_limits: $consecutive,
      kill_switch: $kill_switch
    }' > "$tmp_file" && mv "$tmp_file" "$state_file"
}

# ---------------------------------------------------------------------------
# handle_rate_limit -- Called when a rate limit is detected. Advances backoff.
#
# Reads the current consecutive count from the state file, increments it,
# computes the exponential backoff (base * 2^(consecutive-1)), and writes
# updated state. If backoff exceeds max, activates the kill switch and
# emits an escalation.
#
# Backoff sequence (with default base=30s, max=900s):
#   consecutive=1: 30s
#   consecutive=2: 60s
#   consecutive=3: 120s
#   consecutive=4: 240s
#   consecutive=5: 480s
#   consecutive=6: 960s > 900s -> kill switch
#
# Arguments:
#   $1 -- effective_config: JSON string of the effective configuration
#
# Returns:
#   0 if backoff was set (caller should wait)
#   1 if kill switch was activated (caller should stop all work)
# ---------------------------------------------------------------------------
handle_rate_limit() {
  local effective_config="$1"
  local state_file="${HOME}/.autonomous-dev/rate-limit-state.json"

  local base_seconds max_seconds
  base_seconds=$(echo "$effective_config" | jq -r '.governance.rate_limit_backoff_base_seconds')
  max_seconds=$(echo "$effective_config" | jq -r '.governance.rate_limit_backoff_max_seconds')

  local consecutive=0
  if [[ -f "$state_file" ]]; then
    consecutive=$(jq -r '.consecutive_rate_limits // 0' "$state_file" 2>/dev/null) || consecutive=0
  fi
  consecutive=$((consecutive + 1))

  # Compute backoff: base * 2^(consecutive-1)
  local backoff=$((base_seconds * (1 << (consecutive - 1))))

  # Backoff sequence with defaults (base=30): 30, 60, 120, 240, 480, then pause
  if (( backoff > max_seconds )); then
    log_error "rate_limit_handler" "Rate limit persists after $consecutive consecutive retries. Activating kill switch."

    # Emit escalation
    local payload
    payload=$(jq -nc \
      --argjson consecutive "$consecutive" \
      --argjson max "$max_seconds" \
      '{
        escalation_type: "infrastructure",
        urgency: "immediate",
        message: ("API rate limit persists after " + ($consecutive|tostring) + " consecutive retries. System pausing all work."),
        consecutive_rate_limits: $consecutive,
        max_backoff_seconds: $max,
        recommendation: "Check Anthropic API status. Verify API key quota. Wait for rate limits to clear, then manually restart."
      }')
    emit_escalation "$payload"

    # Write kill switch state
    write_rate_limit_state "$state_file" true "$consecutive" "$max_seconds" true
    return 1
  fi

  # Compute retry_at timestamp
  local retry_at
  if [[ "$(uname)" == "Darwin" ]]; then
    retry_at=$(date -u -v "+${backoff}S" +"%Y-%m-%dT%H:%M:%SZ")
  else
    retry_at=$(date -u -d "+${backoff} seconds" +"%Y-%m-%dT%H:%M:%SZ")
  fi

  log_warning "rate_limit_handler" "Rate limit detected (consecutive: $consecutive). Backing off for ${backoff}s until $retry_at"

  write_rate_limit_state "$state_file" true "$consecutive" "$backoff" false "$retry_at"
  return 0
}

# ---------------------------------------------------------------------------
# check_rate_limit_state -- Pre-iteration rate-limit check
#
# Called at the start of each iteration to determine if work should proceed.
# Checks:
#   1. Missing state file -> proceed (no active rate limit)
#   2. Corrupted state file -> delete and proceed
#   3. Kill switch active -> block (manual restart required)
#   4. Not active -> proceed
#   5. retry_at in the future -> block (still in backoff)
#   6. retry_at in the past -> proceed (backoff expired)
#
# Arguments:
#   (none)
#
# Returns:
#   0 if work can proceed
#   1 if work should be blocked (backoff active or kill switch)
# ---------------------------------------------------------------------------
check_rate_limit_state() {
  local state_file="${HOME}/.autonomous-dev/rate-limit-state.json"

  # Missing file: no active rate limit
  if [[ ! -f "$state_file" ]]; then
    return 0
  fi

  # Parse state file
  local state
  if ! state=$(jq '.' "$state_file" 2>/dev/null); then
    log_warning "rate_limit_handler" "Corrupted rate-limit state file. Deleting and recreating."
    rm -f "$state_file"
    return 0
  fi

  local active kill_switch retry_at
  active=$(echo "$state" | jq -r '.active')
  kill_switch=$(echo "$state" | jq -r '.kill_switch // false')
  retry_at=$(echo "$state" | jq -r '.retry_at // "null"')

  # Kill switch: do not proceed
  if [[ "$kill_switch" == "true" ]]; then
    log_error "rate_limit_handler" "Kill switch active. Manual restart required."
    return 1
  fi

  # Not active: proceed
  if [[ "$active" != "true" ]]; then
    return 0
  fi

  # Check if retry_at has passed
  if [[ "$retry_at" != "null" ]] && [[ -n "$retry_at" ]]; then
    local now_epoch retry_epoch
    now_epoch=$(date -u +%s)
    if [[ "$(uname)" == "Darwin" ]]; then
      retry_epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$retry_at" +%s 2>/dev/null) || retry_epoch=0
    else
      retry_epoch=$(date -u -d "$retry_at" +%s 2>/dev/null) || retry_epoch=0
    fi

    if (( now_epoch < retry_epoch )); then
      local remaining=$((retry_epoch - now_epoch))
      log_info "rate_limit_handler" "Rate limit backoff active. ${remaining}s remaining until $retry_at"
      return 1  # Still in backoff period
    fi
  fi

  # Backoff expired: allow work to proceed (but state remains active until a successful session clears it)
  return 0
}

# ---------------------------------------------------------------------------
# clear_rate_limit_state -- Clear state after a successful session
#
# Called after a successful session that did not hit a rate limit.
# Resets state to inactive with zero consecutive count.
#
# Arguments:
#   (none)
#
# Returns:
#   0 always
# ---------------------------------------------------------------------------
clear_rate_limit_state() {
  local state_file="${HOME}/.autonomous-dev/rate-limit-state.json"

  if [[ ! -f "$state_file" ]]; then
    return 0
  fi

  local active
  active=$(jq -r '.active // false' "$state_file" 2>/dev/null) || active="false"

  if [[ "$active" == "true" ]]; then
    log_info "rate_limit_handler" "Clearing rate limit state after successful session."
    write_rate_limit_state "$state_file" false 0 0 false
  fi
}
