#!/usr/bin/env bash
# event_logger.sh -- Append-only JSONL event log with torn-write recovery
# Part of TDD-002: State Machine & Request Lifecycle
#
# Dependencies: jq (1.6+)
# Sources: state_file_manager.sh (for ensure_file_permissions)

set -euo pipefail

_EL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${_EL_DIR}/state_file_manager.sh"

# Maximum event log size in bytes (10 MB)
readonly EVENT_LOG_MAX_SIZE=10485760

# All valid event types (25 values from TDD Section 4.2)
readonly -a VALID_EVENT_TYPES=(
  request_created state_transition phase_started phase_completed
  review_pass review_fail retry timeout error paused resumed
  failed cancelled escalation checkpoint_created
  checkpoint_restored cost_update context_window_warning
  dependency_resolved dependency_blocked session_started
  session_ended artifact_created pr_created pr_merged
  cleanup_started cleanup_completed
)

# event_append -- Append a validated event to the JSONL event log
#
# Arguments:
#   $1 -- events_file: Absolute path to the events.jsonl file
#   $2 -- event_json:  JSON string representing the event (single object)
#
# Returns:
#   0 on success
#   1 on validation failure (malformed JSON or invalid event structure)
#   2 on size guard violation (file exceeds 10 MB)
#
# Behavior:
#   1. Validate event_json is valid JSON
#   2. Validate required fields: timestamp, event_type, request_id, session_id
#   3. Validate event_type is in the enum
#   4. Validate request_id matches pattern
#   5. Check file size against 10 MB limit
#   6. Append as a single line terminated by newline
#   7. Set file permissions to 0600 (on first write/creation)
event_append() {
  local events_file="$1"
  local event_json="$2"

  # Validate JSON
  if ! echo "$event_json" | jq empty 2>/dev/null; then
    echo "event_append: invalid JSON" >&2
    return 1
  fi

  # Validate required fields
  for field in timestamp event_type request_id session_id; do
    if ! echo "$event_json" | jq -e "has(\"$field\")" > /dev/null 2>&1; then
      echo "event_append: missing required field: ${field}" >&2
      return 1
    fi
  done

  # Validate event_type enum
  local event_type
  event_type="$(echo "$event_json" | jq -r '.event_type')"
  local type_valid=false
  for t in "${VALID_EVENT_TYPES[@]}"; do
    if [[ "$event_type" == "$t" ]]; then
      type_valid=true
      break
    fi
  done
  if [[ "$type_valid" == "false" ]]; then
    echo "event_append: invalid event_type: ${event_type}" >&2
    return 1
  fi

  # Validate request_id format
  local request_id
  request_id="$(echo "$event_json" | jq -r '.request_id')"
  if [[ ! "$request_id" =~ ^REQ-[0-9]{8}-[0-9a-f]{4}$ ]]; then
    echo "event_append: invalid request_id format: ${request_id}" >&2
    return 1
  fi

  # Size guard
  if [[ -f "$events_file" ]]; then
    local file_size
    file_size="$(wc -c < "$events_file" | tr -d ' ')"
    if (( file_size > EVENT_LOG_MAX_SIZE )); then
      echo "WARNING: event log exceeds 10 MB, refusing to append: ${events_file}" >&2
      return 2
    fi
  fi

  # Compact the JSON to a single line and append
  local compact
  compact="$(echo "$event_json" | jq -c '.')"
  printf '%s\n' "$compact" >> "$events_file"

  # Ensure permissions
  ensure_file_permissions "$events_file"

  return 0
}

# event_read_all -- Read all valid events from the JSONL log
#
# Arguments:
#   $1 -- events_file: Absolute path to the events.jsonl file
#
# Stdout:
#   JSON array of event objects
#
# Returns:
#   0 on success (array on stdout, possibly empty)
#   1 on mid-file corruption (malformed non-last line detected)
#
# Behavior:
#   1. If file does not exist or is empty, return empty array "[]"
#   2. Parse each line independently
#   3. If last line is malformed: discard it, log warning, truncate file
#   4. If any non-last line is malformed: return error code 1 (corruption)
#   5. Return JSON array of all valid events
event_read_all() {
  local events_file="$1"

  # Handle missing or empty file
  if [[ ! -f "$events_file" ]] || [[ ! -s "$events_file" ]]; then
    echo "[]"
    return 0
  fi

  _read_events_with_recovery "$events_file" ""
}

# event_read_since -- Read events since a given ISO-8601 timestamp
#
# Arguments:
#   $1 -- events_file:    Absolute path to the events.jsonl file
#   $2 -- since_timestamp: ISO-8601 UTC timestamp (inclusive lower bound)
#
# Stdout:
#   JSON array of event objects with timestamp >= since_timestamp
#
# Returns:
#   0 on success
#   1 on mid-file corruption
event_read_since() {
  local events_file="$1"
  local since_timestamp="$2"

  if [[ ! -f "$events_file" ]] || [[ ! -s "$events_file" ]]; then
    echo "[]"
    return 0
  fi

  _read_events_with_recovery "$events_file" "$since_timestamp"
}

# _read_events_with_recovery -- Core read logic with torn-write handling
#
# Arguments:
#   $1 -- events_file: Path to events.jsonl
#   $2 -- since_timestamp: Filter timestamp (empty string = no filter)
#
# Returns:
#   0 on success
#   1 on mid-file corruption
_read_events_with_recovery() {
  local events_file="$1"
  local since_timestamp="$2"

  local total_lines
  total_lines="$(wc -l < "$events_file" | tr -d ' ')"

  local events_json="["
  local first=true
  local line_num=0
  local corruption_detected=false

  while IFS= read -r line || [[ -n "$line" ]]; do
    (( line_num++ ))

    # Skip empty lines
    [[ -z "$line" ]] && continue

    # Try to parse this line as JSON
    local parsed
    if ! parsed="$(echo "$line" | jq -c '.' 2>/dev/null)"; then
      # Malformed line
      if [[ "$line_num" -eq "$total_lines" ]]; then
        # Last line: torn write -- discard and truncate
        echo "WARNING: Discarding torn write at end of events.jsonl (line ${line_num})" >&2
        # Truncate file to remove the last line
        head -n $(( total_lines - 1 )) "$events_file" > "${events_file}.trunc"
        mv -f "${events_file}.trunc" "$events_file"
        continue
      else
        # Mid-file corruption
        echo "ERROR: Mid-file corruption at line ${line_num} in: ${events_file}" >&2
        corruption_detected=true
        break
      fi
    fi

    # Apply timestamp filter if specified
    if [[ -n "$since_timestamp" ]]; then
      local event_ts
      event_ts="$(echo "$parsed" | jq -r '.timestamp')"
      if [[ "$event_ts" < "$since_timestamp" ]]; then
        continue
      fi
    fi

    # Append to result array
    if [[ "$first" == "true" ]]; then
      events_json+="${parsed}"
      first=false
    else
      events_json+=",${parsed}"
    fi
  done < "$events_file"

  events_json+="]"

  if [[ "$corruption_detected" == "true" ]]; then
    return 1
  fi

  echo "$events_json"
  return 0
}
