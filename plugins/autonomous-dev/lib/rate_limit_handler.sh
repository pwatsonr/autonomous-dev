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
# Logging + escalation (private to this module).
#
# Historically this file defined 2-arg `log_error/log_warning/log_info` and
# `emit_escalation` only when the host hadn't — but supervisor-loop.sh defines
# 1-arg `log_error/log_info`, so those calls logged the tag and dropped the
# message. Use a private `_rl_log`/`_rl_escalate` that DELEGATES to the host's
# structured loggers when present (correct message), else writes to stderr.
# Private names avoid any signature collision with the host.
# ---------------------------------------------------------------------------
if ! declare -F _rl_log >/dev/null 2>&1; then
  _rl_log() {
    # $1 = level (info|warn|error); remaining args = message
    local level="$1"; shift
    local msg="$*"
    case "$level" in
      warn)
        if declare -F log_warn >/dev/null 2>&1; then log_warn "rate_limit: ${msg}"
        else echo "[rate_limit_handler] WARNING: ${msg}" >&2; fi ;;
      error)
        if declare -F log_error >/dev/null 2>&1; then log_error "rate_limit: ${msg}"
        else echo "[rate_limit_handler] ERROR: ${msg}" >&2; fi ;;
      *)
        if declare -F log_info >/dev/null 2>&1; then log_info "rate_limit: ${msg}"
        else echo "[rate_limit_handler] INFO: ${msg}" >&2; fi ;;
    esac
  }
fi

if ! declare -F _rl_escalate >/dev/null 2>&1; then
  _rl_escalate() {
    local payload="$1"
    # Prefer the host's structured alert channel; else write to the alerts dir.
    if declare -F emit_alert >/dev/null 2>&1; then
      emit_alert "rate_limit_escalation" "$payload"
      return 0
    fi
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
    _rl_log error "Rate limit persists after $consecutive consecutive retries. Activating kill switch."

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
    _rl_escalate "$payload"

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

  _rl_log warn "Rate limit detected (consecutive: $consecutive). Backing off for ${backoff}s until $retry_at"

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
    _rl_log warn "Corrupted rate-limit state file. Deleting and recreating."
    rm -f "$state_file"
    return 0
  fi

  local active kill_switch retry_at
  active=$(echo "$state" | jq -r '.active')
  kill_switch=$(echo "$state" | jq -r '.kill_switch // false')
  retry_at=$(echo "$state" | jq -r '.retry_at // "null"')

  # Kill switch: do not proceed
  if [[ "$kill_switch" == "true" ]]; then
    _rl_log error "Kill switch active. Manual restart required."
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
      _rl_log info "Rate limit backoff active. ${remaining}s remaining until $retry_at"
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
    _rl_log info "Clearing rate limit state after successful session."
    write_rate_limit_state "$state_file" false 0 0 false
  fi
}

# ===========================================================================
# REQ-000061: Session-limit 429 backoff — new public functions
# ===========================================================================

# ---------------------------------------------------------------------------
# now_iso -- Current time as ISO-8601 UTC.
#
# Returns:
#   0 always. Stdout: "YYYY-MM-DDTHH:MM:SSZ"
# ---------------------------------------------------------------------------
now_iso() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# ---------------------------------------------------------------------------
# _rl_now_epoch -- Current Unix epoch (testable via SL_TEST_NOW_EPOCH override).
#
# Returns:
#   0 always. Stdout: integer epoch seconds.
# ---------------------------------------------------------------------------
_rl_now_epoch() {
  if [[ -n "${SL_TEST_NOW_EPOCH:-}" ]]; then
    echo "$SL_TEST_NOW_EPOCH"
  else
    date -u +%s
  fi
}

# ---------------------------------------------------------------------------
# iso_to_epoch -- Convert ISO-8601 UTC timestamp to Unix epoch.
#
# Arguments:
#   $1 -- iso: ISO-8601 UTC timestamp (e.g. "2026-07-07T22:20:00Z")
#
# Returns:
#   0 on success. Stdout: integer epoch seconds.
#   On parse failure emits 0 with a warn log.
# ---------------------------------------------------------------------------
iso_to_epoch() {
  local iso="$1"
  local epoch=0

  # Strip trailing Z and replace T with space for date parsing
  local clean="${iso%Z}"
  clean="${clean/T/ }"

  # Try GNU date
  if epoch=$(date -u -d "${clean}" +%s 2>/dev/null); then
    echo "$epoch"
    return 0
  fi

  # Try BSD date
  if epoch=$(date -u -j -f "%Y-%m-%d %H:%M:%S" "${clean}" +%s 2>/dev/null); then
    echo "$epoch"
    return 0
  fi

  # Try python3
  if command -v python3 >/dev/null 2>&1; then
    if epoch=$(python3 -c "
import datetime
ts = '${clean}'
dt = datetime.datetime.strptime(ts, '%Y-%m-%d %H:%M:%S')
dt = dt.replace(tzinfo=datetime.timezone.utc)
print(int(dt.timestamp()))
" 2>/dev/null); then
      echo "$epoch"
      return 0
    fi
  fi

  _rl_log warn "iso_to_epoch: cannot parse '${iso}'; returning 0"
  echo "0"
  return 0
}

# ---------------------------------------------------------------------------
# add_seconds_iso -- Add N seconds to an ISO-8601 UTC timestamp.
#
# Arguments:
#   $1 -- iso: ISO-8601 UTC timestamp
#   $2 -- seconds: integer (may be negative)
#
# Returns:
#   0 always. Stdout: ISO-8601 UTC timestamp.
# ---------------------------------------------------------------------------
add_seconds_iso() {
  local iso="$1"
  local seconds="$2"

  # Try GNU date
  local clean="${iso%Z}"
  clean="${clean/T/ }"
  local result
  if result=$(date -u -d "${clean} UTC ${seconds} seconds" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null); then
    echo "$result"
    return 0
  fi

  # Try BSD date: first get epoch, add, convert back
  local epoch=0
  epoch=$(iso_to_epoch "$iso")
  epoch=$(( epoch + seconds ))
  if result=$(date -u -r "${epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null); then
    echo "$result"
    return 0
  fi

  # python3 fallback
  if command -v python3 >/dev/null 2>&1; then
    result=$(python3 -c "
import datetime
ts = '${clean}'
dt = datetime.datetime.strptime(ts, '%Y-%m-%d %H:%M:%S')
dt = dt.replace(tzinfo=datetime.timezone.utc)
dt = dt + datetime.timedelta(seconds=${seconds})
print(dt.strftime('%Y-%m-%dT%H:%M:%SZ'))
" 2>/dev/null) && echo "$result" && return 0
  fi

  _rl_log warn "add_seconds_iso: cannot compute '${iso} + ${seconds}s'; returning input"
  echo "$iso"
  return 0
}

# ---------------------------------------------------------------------------
# detect_session_limit -- Classify session output as a Claude session-limit 429.
#
# Pure classifier: no filesystem writes, no network I/O, idempotent.
#
# Arguments:
#   $1 -- session_output: raw stdout+stderr text of a failed dispatch session
#
# Returns:
#   0 with JSON payload on stdout when classified as session-limit
#   1 with NO stdout when input is not session-limit
#
# JSON payload on match (exit 0):
#   {
#     "parse_status":     "ok" | "no_reset_clause" | "unparseable",
#     "raw_reset_text":   <string>|null,
#     "retry_at_iso":     <ISO-8601 UTC>|null,
#     "reset_local_hint": <string>|null,
#     "match_kind":       "429_session_text" | "session_text_only"
#   }
# ---------------------------------------------------------------------------
detect_session_limit() {
  local session_output="${1:-}"

  # Empty input: return 1 (no match), no output
  if [[ -z "$session_output" ]]; then
    return 1
  fi

  # Detection markers
  local has_429=false has_session=false

  if echo "$session_output" | grep -qiE 'HTTP[/ ]?1?[./]?[01]?[ ]?429|status[: ]+429|\b429\b'; then
    has_429=true
  fi
  if echo "$session_output" | grep -qiE 'session[ _-]?limit|hit your session|session usage|session[ _-]?quota'; then
    has_session=true
  fi

  # Must match session_marker to be classified as session-limit
  if [[ "$has_session" == "false" ]]; then
    return 1
  fi

  # Determine match_kind
  local match_kind
  if [[ "$has_429" == "true" ]]; then
    match_kind="429_session_text"
  else
    match_kind="session_text_only"
  fi

  # Extract reset clause
  local raw_reset_text=""
  raw_reset_text=$(echo "$session_output" | \
    grep -oiE 'resets?[[:space:]]+(at[[:space:]]+)?[0-9]{1,2}(:[0-9]{2})?[[:space:]]*(am|pm)?[[:space:]]*(\([A-Za-z_/]{1,32}\)|[A-Z]{1,5})?' | \
    head -1) || raw_reset_text=""

  local parse_result parse_status retry_at_iso reset_local_hint
  if [[ -n "$raw_reset_text" ]]; then
    # Wire in the parser
    local parser_out
    parser_out=$(parse_session_limit_reset "$session_output" "UTC" 2>/dev/null) || parser_out=""
    if [[ -n "$parser_out" ]]; then
      parse_status=$(echo "$parser_out" | jq -r '.parse_status // "unparseable"' 2>/dev/null) || parse_status="unparseable"
      retry_at_iso=$(echo "$parser_out" | jq -r '.retry_at_iso // "null"' 2>/dev/null) || retry_at_iso="null"
      reset_local_hint=$(echo "$parser_out" | jq -r '.reset_local_hint // "null"' 2>/dev/null) || reset_local_hint="null"
    else
      parse_status="unparseable"
      retry_at_iso="null"
      reset_local_hint="null"
    fi
  else
    parse_status="no_reset_clause"
    retry_at_iso="null"
    reset_local_hint="null"
    raw_reset_text="null"
  fi

  # Convert "null" string to actual null in JSON via jq
  local raw_reset_arg="$raw_reset_text"
  [[ "$raw_reset_arg" == "null" ]] && raw_reset_arg=""

  local retry_at_arg="$retry_at_iso"
  [[ "$retry_at_arg" == "null" ]] && retry_at_arg=""

  local hint_arg="$reset_local_hint"
  [[ "$hint_arg" == "null" ]] && hint_arg=""

  jq -nc \
    --arg parse_status "$parse_status" \
    --arg raw_reset_text "$raw_reset_arg" \
    --arg retry_at_iso "$retry_at_arg" \
    --arg reset_local_hint "$hint_arg" \
    --arg match_kind "$match_kind" \
    '{
      parse_status: $parse_status,
      raw_reset_text: (if $raw_reset_text == "" then null else $raw_reset_text end),
      retry_at_iso: (if $retry_at_iso == "" then null else $retry_at_iso end),
      reset_local_hint: (if $reset_local_hint == "" then null else $reset_local_hint end),
      match_kind: $match_kind
    }'
  return 0
}

# ---------------------------------------------------------------------------
# parse_session_limit_reset -- Extract reset clause and convert to ISO-8601 UTC.
#
# Always returns 0. The verdict lives in JSON's parse_status field.
# Pure parser: no filesystem writes, no network I/O.
#
# Arguments:
#   $1 -- session_output: raw session text
#   $2 -- local_tz:       IANA name or POSIX TZ; used when message omits a tz
#
# Returns:
#   0 always. Stdout = single-line JSON with parse_status, raw_reset_text,
#   retry_at_iso, reset_local_hint fields.
# ---------------------------------------------------------------------------
parse_session_limit_reset() {
  local session_output="${1:-}"
  local local_tz="${2:-UTC}"

  local _emit_no_reset
  _emit_no_reset() {
    jq -nc '{"parse_status":"no_reset_clause","raw_reset_text":null,"retry_at_iso":null,"reset_local_hint":null}'
  }

  local _emit_unparseable
  _emit_unparseable() {
    local raw="${1:-}"
    jq -nc --arg raw "$raw" \
      '{"parse_status":"unparseable","raw_reset_text":(if $raw=="" then null else $raw end),"retry_at_iso":null,"reset_local_hint":null}'
  }

  # Step 1: Extract reset clause
  local raw_clause=""
  raw_clause=$(echo "$session_output" | \
    grep -oiE 'resets?[[:space:]]+(at[[:space:]]+)?[0-9]{1,2}(:[0-9]{2})?[[:space:]]*(am|pm)?[[:space:]]*(\([A-Za-z_/]{1,32}\)|[A-Z]{1,5})?' | \
    head -1) || raw_clause=""

  if [[ -z "$raw_clause" ]]; then
    _emit_no_reset
    return 0
  fi

  # Step 2: Extract HH, MM, am/pm, tz token
  # Parse time part: "1:20pm", "8:00am", "13:20", "1pm", "12:00am"
  local time_part hh mm ampm_marker tz_token
  # Extract time portion from clause (everything after "resets" / "resets at" / "reset at")
  time_part=$(echo "$raw_clause" | \
    grep -oiE '[0-9]{1,2}(:[0-9]{2})?[[:space:]]*(am|pm)?' | \
    head -1) || time_part=""

  if [[ -z "$time_part" ]]; then
    _emit_unparseable "$raw_clause"
    return 0
  fi

  hh=$(echo "$time_part" | grep -oE '^[0-9]{1,2}') || hh=""
  mm=$(echo "$time_part" | grep -oE ':[0-9]{2}' | tr -d ':') || mm="00"
  [[ -z "$mm" ]] && mm="00"
  ampm_marker=$(echo "$time_part" | grep -oiE '(am|pm)$' | tr '[:upper:]' '[:lower:]') || ampm_marker=""

  # Step 3: Extract tz token
  # Look for (America/Chicago) or IANA/style or abbreviation
  tz_token=$(echo "$raw_clause" | grep -oE '\([A-Za-z_/]{1,32}\)' | tr -d '()') || tz_token=""
  if [[ -z "$tz_token" ]]; then
    # Try bare IANA (contains /) or abbreviation
    tz_token=$(echo "$raw_clause" | grep -oE '[A-Za-z][A-Za-z_/]{2,31}' | grep '/' | head -1) || tz_token=""
  fi
  if [[ -z "$tz_token" ]]; then
    # Try uppercase abbreviation (2-5 chars)
    tz_token=$(echo "$raw_clause" | grep -oE '\b[A-Z]{2,5}\b' | head -1) || tz_token=""
  fi

  # Step 3b: Resolve tz
  local resolved_tz=""
  if [[ -n "$tz_token" ]]; then
    if [[ "$tz_token" == *"/"* ]]; then
      # IANA name — use as-is
      resolved_tz="$tz_token"
    else
      # Try abbreviation_map lookup (hardcoded defaults; config lookup done in handler)
      case "$tz_token" in
        PST) resolved_tz="-08:00" ;;
        PDT) resolved_tz="-07:00" ;;
        MST) resolved_tz="-07:00" ;;
        MDT) resolved_tz="-06:00" ;;
        CST) resolved_tz="-06:00" ;;
        CDT) resolved_tz="-05:00" ;;
        EST) resolved_tz="-05:00" ;;
        EDT) resolved_tz="-04:00" ;;
        UTC|Z) resolved_tz="UTC" ;;
        *)
          # Unknown abbreviation → unparseable
          _emit_unparseable "$raw_clause"
          return 0
          ;;
      esac
    fi
  else
    # No tz in message → use local_tz
    resolved_tz="$local_tz"
  fi

  # Step 4: Normalize hour to 24h
  hh=$(( 10#$hh ))  # force decimal interpretation
  if [[ "$ampm_marker" == "am" ]]; then
    [[ $hh -eq 12 ]] && hh=0
  elif [[ "$ampm_marker" == "pm" ]]; then
    [[ $hh -ne 12 ]] && hh=$(( hh + 12 ))
  fi
  local hh_str mm_str
  printf -v hh_str "%02d" "$hh"
  printf -v mm_str "%02d" "${mm##0}"  # strip leading zero then reformat
  mm_str=$(printf "%02d" "${mm:-0}")
  # Fix: mm may have leading zeros from extraction, ensure numeric
  mm=$(( 10#$mm ))
  printf -v mm_str "%02d" "$mm"

  # Step 5: Compose epoch using resolved_tz
  local now_epoch today_local composed_epoch
  now_epoch=$(_rl_now_epoch)

  # Get today's date in the resolved timezone
  local tz_for_date="$resolved_tz"
  # If resolved_tz is an offset like "-08:00", we need to convert for TZ env var
  # Offsets work directly as TZ in Python but not in all POSIX shells
  # Prefer IANA names for `date`; for offsets, use python3 or arithmetic

  local use_offset=false
  if [[ "$tz_for_date" =~ ^[+-][0-9]{2}:[0-9]{2}$ ]]; then
    use_offset=true
  fi

  if [[ "$use_offset" == "true" ]]; then
    # Offset-based: compute UTC time directly
    # Convert offset to seconds
    local sign offset_h offset_m offset_total
    sign="${tz_for_date:0:1}"
    offset_h=$(echo "$tz_for_date" | grep -oE '[0-9]{2}' | head -1)
    offset_m=$(echo "$tz_for_date" | grep -oE '[0-9]{2}' | tail -1)
    offset_h=$(( 10#$offset_h ))
    offset_m=$(( 10#$offset_m ))
    offset_total=$(( offset_h * 3600 + offset_m * 60 ))
    [[ "$sign" == "-" ]] && offset_total=$(( -offset_total ))

    # The local time is hh:mm in offset timezone.
    # today_local = epoch → date in offset zone → compose HH:MM → epoch in UTC
    # today = floor((now_epoch + offset_total) / 86400) * 86400 - offset_total
    local today_midnight_utc
    today_midnight_utc=$(( ( (now_epoch + offset_total) / 86400 ) * 86400 - offset_total ))
    composed_epoch=$(( today_midnight_utc + hh * 3600 + mm * 60 ))
  else
    # IANA timezone
    # Try GNU date
    if today_local=$(TZ="$tz_for_date" date -d "@${now_epoch}" +%Y-%m-%d 2>/dev/null); then
      # GNU date epoch conversion in tz (include :00 seconds to avoid BSD second inheritance)
      if composed_epoch=$(TZ="$tz_for_date" date -d "${today_local} ${hh_str}:${mm_str}:00" +%s 2>/dev/null); then
        : # success
      elif composed_epoch=$(TZ="$tz_for_date" date -j -f "%Y-%m-%d %H:%M:%S" "${today_local} ${hh_str}:${mm_str}:00" +%s 2>/dev/null); then
        : # BSD fallback
      else
        composed_epoch=""
      fi
    # Try BSD date
    elif today_local=$(TZ="$tz_for_date" date -j -r "${now_epoch}" +%Y-%m-%d 2>/dev/null); then
      if composed_epoch=$(TZ="$tz_for_date" date -j -f "%Y-%m-%d %H:%M:%S" "${today_local} ${hh_str}:${mm_str}:00" +%s 2>/dev/null); then
        : # success
      else
        composed_epoch=""
      fi
    else
      today_local=""
      composed_epoch=""
    fi

    # python3 fallback (always sets seconds=0, microsecond=0)
    if [[ -z "$composed_epoch" ]]; then
      if command -v python3 >/dev/null 2>&1; then
        composed_epoch=$(python3 -c "
import datetime, zoneinfo, sys
try:
    tz = zoneinfo.ZoneInfo('${tz_for_date}')
    now = datetime.datetime.fromtimestamp(${now_epoch}, tz=tz)
    target = now.replace(hour=${hh}, minute=${mm}, second=0, microsecond=0)
    print(int(target.timestamp()))
except Exception as e:
    sys.exit(1)
" 2>/dev/null) || composed_epoch=""
        # Ensure integer (strip any trailing whitespace)
        composed_epoch="${composed_epoch%%[^0-9]*}"
      fi
    fi

    if [[ -z "$composed_epoch" ]]; then
      _rl_log warn "SL_DATE_BINARY_MISSING: neither GNU date, BSD date, nor python3 could parse '${raw_clause}'; using floor"
      _emit_unparseable "$raw_clause"
      return 0
    fi
  fi

  # Step 6: Next-day rollover if composed_epoch <= now_epoch
  # Check AUTONOMOUS_DEV_SL_NEXT_DAY_ROLLOVER env or default true
  local next_day_rollover="${AUTONOMOUS_DEV_SL_NEXT_DAY_ROLLOVER:-true}"
  if [[ "$next_day_rollover" != "false" ]]; then
    if (( composed_epoch <= now_epoch )); then
      composed_epoch=$(( composed_epoch + 86400 ))
    fi
  else
    if (( composed_epoch <= now_epoch )); then
      _emit_unparseable "$raw_clause"
      return 0
    fi
  fi

  # Step 7: Emit retry_at_iso
  local retry_at_iso reset_local_hint
  if retry_at_iso=$(date -u -d "@${composed_epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null); then
    :
  elif retry_at_iso=$(date -u -r "${composed_epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null); then
    :
  elif command -v python3 >/dev/null 2>&1; then
    retry_at_iso=$(python3 -c "
import datetime
dt = datetime.datetime.utcfromtimestamp(${composed_epoch})
print(dt.strftime('%Y-%m-%dT%H:%M:%SZ'))
" 2>/dev/null) || { _emit_unparseable "$raw_clause"; return 0; }
  else
    _rl_log warn "SL_DATE_BINARY_MISSING: cannot format epoch ${composed_epoch}; using floor"
    _emit_unparseable "$raw_clause"
    return 0
  fi

  reset_local_hint="${hh_str}:${mm_str} ${tz_token:-${local_tz}}"

  jq -nc \
    --arg parse_status "ok" \
    --arg raw_reset_text "$raw_clause" \
    --arg retry_at_iso "$retry_at_iso" \
    --arg reset_local_hint "$reset_local_hint" \
    '{
      parse_status: $parse_status,
      raw_reset_text: $raw_reset_text,
      retry_at_iso: $retry_at_iso,
      reset_local_hint: $reset_local_hint
    }'
  return 0
}

# ---------------------------------------------------------------------------
# write_rate_limit_state_v2 -- Superset of write_rate_limit_state with class fields.
#
# Arguments (positional, ALL required):
#   $1  -- state_file       (absolute path)
#   $2  -- active           "true" | "false"
#   $3  -- consecutive      integer (session-limit callers pass 1)
#   $4  -- backoff          integer seconds
#   $5  -- kill_switch      "true" | "false"
#   $6  -- retry_at         ISO-8601 UTC OR literal "null"
#   $7  -- class            "session_limit"
#   $8  -- raw_reset_text   string or literal "null"
#   $9  -- source           "parsed" | "floor"
#
# Returns: 0 on success; nonzero on tmp+mv failure (callers wrap in || true).
# ---------------------------------------------------------------------------
write_rate_limit_state_v2() {
  local state_file="$1"
  local active="$2"
  local consecutive="$3"
  local backoff="$4"
  local kill_switch="$5"
  local retry_at="${6:-null}"
  local class="${7:-session_limit}"
  local raw_reset_text="${8:-null}"
  local source="${9:-floor}"

  local triggered_at
  triggered_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  local state_dir
  state_dir=$(dirname "$state_file")
  mkdir -p "$state_dir"
  chmod 0700 "$state_dir" 2>/dev/null || true

  local tmp_file="${state_file}.tmp.$$"

  local raw_arg="$raw_reset_text"
  [[ "$raw_arg" == "null" ]] && raw_arg=""

  local retry_arg="$retry_at"
  [[ "$retry_arg" == "null" ]] && retry_arg=""

  jq -nc \
    --argjson schema_version 2 \
    --argjson active "$active" \
    --arg triggered_at "$triggered_at" \
    --argjson backoff "$backoff" \
    --arg retry_at "$retry_arg" \
    --argjson consecutive "$consecutive" \
    --argjson kill_switch "$kill_switch" \
    --arg class "$class" \
    --arg raw_reset_text "$raw_arg" \
    --arg source "$source" \
    '{
      "$schema_version": $schema_version,
      active: $active,
      triggered_at: $triggered_at,
      current_backoff_seconds: $backoff,
      retry_at: (if $retry_at == "" then null else $retry_at end),
      consecutive_rate_limits: $consecutive,
      kill_switch: $kill_switch,
      class: $class,
      raw_reset_text: (if $raw_reset_text == "" then null else $raw_reset_text end),
      source: $source
    }' > "$tmp_file" && mv "$tmp_file" "$state_file"

  chmod 0600 "$state_file" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# emit_rate_limit_backoff_event -- Best-effort append with tail-dedup (INV-2).
#
# Arguments:
#   $1 -- request_id       (e.g. "REQ-000061")
#   $2 -- project          (absolute path)
#   $3 -- retry_at         (ISO-8601 UTC)
#   $4 -- source           ("parsed" | "floor")
#   $5 -- raw_reset_text   (string, empty, or the literal word "null")
#
# Returns:
#   0 always. Errors are logged via `_rl_log warn` and swallowed.
# ---------------------------------------------------------------------------
emit_rate_limit_backoff_event() {
  local request_id="$1"
  local project="$2"
  local retry_at="$3"
  local source="$4"
  local raw_reset_text="${5:-}"

  local req_dir="${project}/.autonomous-dev/requests/${request_id}"
  if [[ ! -d "$req_dir" ]]; then
    return 0
  fi

  local events_file="${req_dir}/events.jsonl"

  # Tail-dedup: if last line is a rate_limit_backoff with the same retry_at, skip
  if [[ -f "$events_file" ]] && [[ -s "$events_file" ]]; then
    local last_line last_event_type last_retry_at
    last_line=$(tail -n 1 "$events_file" 2>/dev/null) || last_line=""
    if [[ -n "$last_line" ]]; then
      last_event_type=$(echo "$last_line" | jq -r '.event_type // ""' 2>/dev/null) || last_event_type=""
      last_retry_at=$(echo "$last_line" | jq -r '.retry_at // ""' 2>/dev/null) || last_retry_at=""
      if [[ "$last_event_type" == "rate_limit_backoff" ]] && [[ "$last_retry_at" == "$retry_at" ]]; then
        _rl_log info "SL_DEDUP_HIT: rate_limit_backoff event with retry_at=${retry_at} already present; skipping"
        return 0
      fi
    fi
  fi

  # Determine event_logger.sh path and source it if needed
  local event_logger_path
  if [[ -n "${PLUGIN_ROOT:-}" ]]; then
    event_logger_path="${PLUGIN_ROOT}/lib/state/event_logger.sh"
  else
    event_logger_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/state/event_logger.sh"
  fi

  # Source event_logger.sh only if event_append is not yet defined.
  # Important: do NOT re-source when event_append is already defined even if
  # VALID_EVENT_TYPES is invisible — in bash 3.2, readonly -a arrays sourced
  # inside a function do not persist to caller scope, so a re-source would
  # collide with STATE_SCHEMA_VERSION's global readonly declaration and
  # terminate the shell even when the source is wrapped in "|| true".
  if ! declare -F event_append >/dev/null 2>&1; then
    if [[ -f "$event_logger_path" ]]; then
      # shellcheck source=lib/state/event_logger.sh
      source "$event_logger_path" 2>/dev/null || true
    fi
  fi

  # Build event JSON (needed for both validated and direct-write paths below)
  # session_id = "rl-<epoch>-<pid>"
  local session_id
  session_id="rl-$(date -u +%s)-$$"

  # Normalize raw_reset_text
  local raw_arg="$raw_reset_text"
  [[ "$raw_arg" == "null" ]] && raw_arg=""

  local event_json
  event_json=$(jq -nc \
    --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    --arg request_id "$request_id" \
    --arg session_id "$session_id" \
    --arg retry_at "$retry_at" \
    --arg source "$source" \
    --arg raw_reset_text "$raw_arg" \
    '{
      timestamp: $timestamp,
      event_type: "rate_limit_backoff",
      request_id: $request_id,
      session_id: $session_id,
      class: "session_limit",
      retry_at: $retry_at,
      source: $source,
      raw_reset_text: (if $raw_reset_text == "" then null else $raw_reset_text end)
    }') || { _rl_log warn "SL_EVENT_APPEND_REJECTED: jq build failed"; return 0; }

  # If event_append is still not available, write the event directly
  if ! declare -F event_append >/dev/null 2>&1; then
    _rl_log warn "SL_DIRECT_APPEND: event_append unavailable; writing event directly"
    mkdir -p "$(dirname "$events_file")" 2>/dev/null || true
    printf '%s\n' "$event_json" >> "$events_file" 2>/dev/null || true
    return 0
  fi

  # If VALID_EVENT_TYPES is not visible (bash 3.2: readonly -a arrays from
  # sourcing inside a function do not persist to caller scope), fall back to
  # direct append rather than skipping the event — this happens in test
  # harnesses that source event_logger.sh inside setup(), not at global scope.
  local _valid_types_check="${VALID_EVENT_TYPES+x}"
  if [[ -z "$_valid_types_check" ]]; then
    _rl_log warn "SL_DIRECT_APPEND: VALID_EVENT_TYPES unbound (bash 3.2 scoping); writing event directly"
    mkdir -p "$(dirname "$events_file")" 2>/dev/null || true
    printf '%s\n' "$event_json" >> "$events_file" 2>/dev/null || true
    return 0
  fi

  event_append "$events_file" "$event_json" 2>/dev/null || {
    _rl_log warn "SL_EVENT_APPEND_REJECTED: event_append returned nonzero"
    return 0
  }

  return 0
}

# ---------------------------------------------------------------------------
# handle_session_limit -- Park dispatch until parsed reset + buffer (or floor).
#
# NEVER fails dispatch. Always returns 0. All I/O is best-effort.
# Pins consecutive_rate_limits=1 (INV-5): does NOT advance exponential ladder,
# does NOT trip kill-switch cap, does NOT increment escalation_count.
#
# Arguments:
#   $1 -- detect_json:      stdout of detect_session_limit (must be valid JSON)
#   $2 -- effective_config: full effective config JSON
#   $3 -- request_id:       e.g. "REQ-000061"
#   $4 -- project:          absolute path to the project root
#
# Returns:
#   0 always.
# ---------------------------------------------------------------------------
handle_session_limit() {
  local detect_json="$1"
  local effective_config="$2"
  local request_id="$3"
  local project="$4"

  local state_file="${HOME}/.autonomous-dev/rate-limit-state.json"

  # Read config values (env overrides first)
  local buffer_seconds floor_seconds

  # buffer_seconds
  if [[ -n "${AUTONOMOUS_DEV_SL_BUFFER_SECONDS:-}" ]]; then
    if [[ "${AUTONOMOUS_DEV_SL_BUFFER_SECONDS}" =~ ^[0-9]+$ ]]; then
      buffer_seconds="${AUTONOMOUS_DEV_SL_BUFFER_SECONDS}"
    else
      _rl_log warn "SL_BUFFER_MISCONFIG: AUTONOMOUS_DEV_SL_BUFFER_SECONDS=${AUTONOMOUS_DEV_SL_BUFFER_SECONDS} invalid; using 60"
      buffer_seconds=60
    fi
  else
    buffer_seconds=$(echo "$effective_config" | jq -r '.governance.session_limit.buffer_seconds // 60' 2>/dev/null) || buffer_seconds=60
    if [[ -z "$buffer_seconds" ]] || ! [[ "$buffer_seconds" =~ ^[0-9]+$ ]]; then
      _rl_log warn "SL_BUFFER_MISCONFIG: buffer_seconds=${buffer_seconds} invalid; using 60"
      buffer_seconds=60
    fi
  fi

  # floor_seconds
  if [[ -n "${AUTONOMOUS_DEV_SL_FLOOR_SECONDS:-}" ]]; then
    if [[ "${AUTONOMOUS_DEV_SL_FLOOR_SECONDS}" =~ ^[0-9]+$ ]] && [[ "${AUTONOMOUS_DEV_SL_FLOOR_SECONDS}" -gt 0 ]]; then
      floor_seconds="${AUTONOMOUS_DEV_SL_FLOOR_SECONDS}"
    else
      _rl_log warn "SL_FLOOR_MISCONFIG: AUTONOMOUS_DEV_SL_FLOOR_SECONDS=${AUTONOMOUS_DEV_SL_FLOOR_SECONDS} invalid; using 900"
      floor_seconds=900
    fi
  else
    floor_seconds=$(echo "$effective_config" | jq -r '.governance.session_limit.floor_seconds // 900' 2>/dev/null) || floor_seconds=900
    if [[ -z "$floor_seconds" ]] || ! [[ "$floor_seconds" =~ ^[0-9]+$ ]] || [[ "$floor_seconds" -le 0 ]]; then
      _rl_log warn "SL_FLOOR_MISCONFIG: floor_seconds=${floor_seconds} invalid; using 900"
      floor_seconds=900
    fi
  fi

  # Parse detect_json
  local parse_status retry_at_iso raw_reset_text
  parse_status=$(echo "$detect_json" | jq -r '.parse_status // "unparseable"' 2>/dev/null) || parse_status="unparseable"
  retry_at_iso=$(echo "$detect_json" | jq -r '.retry_at_iso // "null"' 2>/dev/null) || retry_at_iso="null"
  raw_reset_text=$(echo "$detect_json" | jq -r '.raw_reset_text // "null"' 2>/dev/null) || raw_reset_text="null"

  # Decision: use parsed time or floor
  local retry_at source now_epoch
  now_epoch=$(_rl_now_epoch)

  if [[ "$parse_status" == "ok" ]] && [[ "$retry_at_iso" != "null" ]] && [[ -n "$retry_at_iso" ]]; then
    retry_at=$(add_seconds_iso "$retry_at_iso" "$buffer_seconds")
    source="parsed"
  else
    retry_at=$(add_seconds_iso "$(now_iso)" "$floor_seconds")
    source="floor"
  fi

  # Compute backoff in seconds
  local retry_epoch backoff
  retry_epoch=$(iso_to_epoch "$retry_at")
  backoff=$(( retry_epoch - now_epoch ))
  [[ $backoff -lt 0 ]] && backoff=0

  _rl_log warn "Session-limit 429 detected for ${request_id}; parking dispatch until ${retry_at} (source=${source}, backoff=${backoff}s)"

  # Write state (best-effort)
  local raw_arg="$raw_reset_text"
  [[ "$raw_arg" == "null" ]] && raw_arg="null"

  write_rate_limit_state_v2 \
    "$state_file" \
    "true" \
    "1" \
    "$backoff" \
    "false" \
    "$retry_at" \
    "session_limit" \
    "$raw_arg" \
    "$source" || {
    _rl_log warn "SL_STATE_WRITE_FAILED: ${state_file}"
    true
  }

  # Emit event (best-effort)
  emit_rate_limit_backoff_event \
    "$request_id" \
    "$project" \
    "$retry_at" \
    "$source" \
    "$raw_reset_text" || true

  return 0
}
