#!/usr/bin/env bash
# request_tracker.sh -- Request ID generation, discovery, and directory scaffolding
# Part of TDD-002: State Machine & Request Lifecycle
#
# Dependencies: jq (1.6+), openssl (for rand), date
# Sources: state_file_manager.sh, event_logger.sh

set -euo pipefail

_RT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${_RT_DIR}/state_file_manager.sh"
source "${_RT_DIR}/event_logger.sh"

# Request ID format regex
readonly REQUEST_ID_PATTERN='^REQ-[0-9]{8}-[0-9a-f]{4}$'

# Maximum collision retries
readonly MAX_ID_RETRIES=5

# =============================================================================
# Supporting Functions
# =============================================================================

# validate_request_id -- Validate a request ID against the format regex
#
# Arguments:
#   $1 -- request_id: The ID string to validate
#
# Returns:
#   0 if valid
#   1 if invalid (error message on stderr)
#
# Validation rules:
#   1. Must match regex: ^REQ-[0-9]{8}-[0-9a-f]{4}$
#   2. Must NOT contain: ".." (path traversal)
#   3. Must NOT contain: "/" (path separator)
#   4. Must NOT contain: spaces or control characters
#   5. Must be non-empty
validate_request_id() {
  local request_id="${1:-}"

  if [[ -z "$request_id" ]]; then
    echo "validate_request_id: empty request ID" >&2
    return 1
  fi

  # Check for path traversal characters FIRST (defense in depth)
  if [[ "$request_id" == *".."* ]]; then
    echo "validate_request_id: path traversal detected in ID: ${request_id}" >&2
    return 1
  fi

  if [[ "$request_id" == *"/"* ]]; then
    echo "validate_request_id: path separator detected in ID: ${request_id}" >&2
    return 1
  fi

  if [[ "$request_id" == *" "* ]]; then
    echo "validate_request_id: spaces detected in ID: ${request_id}" >&2
    return 1
  fi

  # Check format regex
  if [[ ! "$request_id" =~ ^REQ-[0-9]{8}-[0-9a-f]{4}$ ]]; then
    echo "validate_request_id: invalid format: ${request_id} (expected: REQ-YYYYMMDD-XXXX)" >&2
    return 1
  fi

  return 0
}

# sanitize_input -- Sanitize user-provided strings for safe JSON inclusion
#
# Arguments:
#   $1 -- input_string: The raw user input
#   $2 -- max_length:   Maximum allowed length in characters
#
# Stdout:
#   The sanitized string (safe for JSON embedding)
#
# Returns:
#   0 always (truncation is a warning, not an error)
#
# Behavior:
#   1. Pass through jq for proper JSON string encoding
#      (escapes quotes, backslashes, control characters, unicode)
#   2. Check length. If exceeds max_length, truncate and log warning.
#   3. Output the sanitized string (without surrounding quotes)
#
# Key guarantee:
#   The output is safe to embed in a JSON value constructed via jq --arg.
#   Shell metacharacters ($, `, !, etc.) are NOT interpreted.
sanitize_input() {
  local input_string="$1"
  local max_length="${2:-10000}"

  # Use jq to safely encode the string (handles all special characters)
  # jq --arg passes the string as a JSON string, properly escaping everything
  # We extract just the raw value (no quotes) for use with --arg later
  local sanitized
  sanitized="$(printf '%s' "$input_string" | jq -Rs '.')"
  # Remove surrounding quotes added by jq -Rs
  sanitized="${sanitized#\"}"
  sanitized="${sanitized%\"}"

  # Check length and truncate if needed
  local current_length=${#sanitized}
  if (( current_length > max_length )); then
    echo "WARNING: Input truncated from ${current_length} to ${max_length} characters" >&2
    sanitized="${sanitized:0:$max_length}"
  fi

  echo "$sanitized"
  return 0
}

# =============================================================================
# Core Functions
# =============================================================================

# generate_request_id -- Generate a unique request ID with collision detection
#
# Arguments:
#   $1 -- base_dir: The requests directory to check for collisions
#                   (e.g., /path/to/repo/.autonomous-dev/requests)
#
# Stdout:
#   The generated request ID (e.g., REQ-20260408-a3f1)
#
# Returns:
#   0 on success
#   1 on failure (5 consecutive collisions)
#
# Algorithm:
#   1. date_part = date -u +%Y%m%d
#   2. hex_part = openssl rand -hex 2 (fallback: /dev/urandom)
#   3. id = "REQ-${date_part}-${hex_part}"
#   4. If ${base_dir}/${id}/ exists, retry (up to 5 times)
#   5. Return the unique id
generate_request_id() {
  local base_dir="$1"
  local attempts=0

  while (( attempts < MAX_ID_RETRIES )); do
    local date_part
    date_part="$(date -u +%Y%m%d)"

    local hex_part
    if command -v openssl > /dev/null 2>&1; then
      hex_part="$(openssl rand -hex 2)"
    else
      # Fallback: /dev/urandom
      hex_part="$(head -c 2 /dev/urandom | xxd -p)"
    fi

    # Ensure lowercase
    hex_part="$(echo "$hex_part" | tr '[:upper:]' '[:lower:]')"

    local id="REQ-${date_part}-${hex_part}"

    # Check for collision
    if [[ ! -d "${base_dir}/${id}" ]]; then
      echo "$id"
      return 0
    fi

    echo "WARNING: ID collision for ${id}, retrying (attempt $((attempts + 1)))" >&2
    (( attempts++ ))
  done

  echo "generate_request_id: exhausted ${MAX_ID_RETRIES} attempts due to collisions" >&2
  return 1
}

# discover_requests -- Scan configured repos for request directories with state.json
#
# Arguments:
#   Reads from the REPO_ALLOWLIST array variable (must be set by caller)
#   OR accepts repos as positional arguments: discover_requests /repo1 /repo2 ...
#
# Stdout:
#   One absolute request directory path per line (only dirs with state.json)
#
# Returns:
#   0 always (empty result is not an error)
#
# Behavior:
#   For each repo in allowlist:
#     1. Check if {repo}/.autonomous-dev/requests/ exists
#     2. For each REQ-*/ subdirectory:
#        a. Check if state.json exists (file test only, no validation)
#        b. If yes, output the directory path
discover_requests() {
  local -a repos=()

  if [[ $# -gt 0 ]]; then
    repos=("$@")
  elif [[ -n "${REPO_ALLOWLIST+x}" ]]; then
    repos=("${REPO_ALLOWLIST[@]}")
  else
    echo "discover_requests: no repos provided and REPO_ALLOWLIST not set" >&2
    return 0
  fi

  for repo in "${repos[@]}"; do
    local req_dir="${repo}/.autonomous-dev/requests"
    [[ -d "$req_dir" ]] || continue

    for dir in "${req_dir}"/REQ-*/; do
      # Guard against glob non-match (dir is literal "REQ-*/")
      [[ -d "$dir" ]] || continue
      [[ -f "${dir}/state.json" ]] || continue
      # Output the absolute path (remove trailing slash)
      echo "${dir%/}"
    done
  done

  return 0
}

# create_request_directory -- Scaffold the complete directory structure for a new request
#
# Arguments:
#   $1 -- base_dir:       Requests directory (e.g., /repo/.autonomous-dev/requests)
#   $2 -- request_id:     The generated request ID
#   $3 -- title:          Request title (will be sanitized)
#   $4 -- description:    Request description (will be sanitized)
#   $5 -- repository:     Absolute path to the target repository
#   $6 -- priority:       Integer 0-9, default 5
#   $7 -- blocked_by_json: JSON array of blocking request IDs (e.g., '["REQ-xxx"]')
#   $8 -- tags_json:      JSON array of tags (e.g., '["tag1","tag2"]')
#
# Returns:
#   0 on success
#   1 on failure (invalid ID, directory already exists, write failure)
#
# Creates:
#   {base_dir}/{request_id}/
#   {base_dir}/{request_id}/state.json       (initial state: intake)
#   {base_dir}/{request_id}/events.jsonl     (with request_created event)
#   {base_dir}/{request_id}/checkpoint/
#
# Permissions:
#   Directories: 0700
#   Files: 0600
create_request_directory() {
  local base_dir="$1"
  local request_id="$2"
  local title="$3"
  local description="${4:-}"
  local repository="$5"
  local priority="${6:-5}"
  local blocked_by_json="${7:-[]}"
  local tags_json="${8:-[]}"

  # Validate request ID
  if ! validate_request_id "$request_id"; then
    return 1
  fi

  local req_dir="${base_dir}/${request_id}"

  # Check for existing directory
  if [[ -d "$req_dir" ]]; then
    echo "create_request_directory: directory already exists: ${req_dir}" >&2
    return 1
  fi

  # Sanitize inputs
  title="$(sanitize_input "$title" 200)"
  description="$(sanitize_input "$description" 10000)"

  # Create directory structure
  ensure_dir_permissions "$req_dir"
  ensure_dir_permissions "${req_dir}/checkpoint"

  # Construct initial state JSON
  local timestamp
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local branch="autonomous/${request_id}"

  local initial_state
  initial_state="$(jq -n \
    --argjson schema_version 1 \
    --arg id "$request_id" \
    --arg status "intake" \
    --argjson priority "$priority" \
    --arg title "$title" \
    --arg description "$description" \
    --arg repository "$repository" \
    --arg branch "$branch" \
    --arg created_at "$timestamp" \
    --arg updated_at "$timestamp" \
    --argjson blocked_by "$blocked_by_json" \
    --argjson tags "$tags_json" \
    '{
      schema_version: $schema_version,
      id: $id,
      status: $status,
      priority: $priority,
      title: $title,
      description: $description,
      repository: $repository,
      branch: $branch,
      worktree_path: null,
      created_at: $created_at,
      updated_at: $updated_at,
      cost_accrued_usd: 0,
      turn_count: 0,
      escalation_count: 0,
      blocked_by: $blocked_by,
      phase_history: [{
        state: "intake",
        entered_at: $created_at,
        exited_at: null,
        session_id: null,
        turns_used: 0,
        cost_usd: 0,
        retry_count: 0,
        exit_reason: null
      }],
      current_phase_metadata: {},
      error: null,
      last_checkpoint: null,
      paused_from: null,
      paused_reason: null,
      failure_reason: null,
      generation: 0,
      tags: $tags
    }')"

  # Write state file atomically
  if ! state_write_atomic "$req_dir" "$initial_state"; then
    echo "create_request_directory: failed to write initial state" >&2
    rm -rf "$req_dir"
    return 1
  fi

  # Create empty events file
  touch "${req_dir}/events.jsonl"
  ensure_file_permissions "${req_dir}/events.jsonl"

  # Append initial request_created event
  local event
  event="$(jq -n \
    --arg timestamp "$timestamp" \
    --arg request_id "$request_id" \
    --arg title "$title" \
    --arg repository "$repository" \
    --argjson priority "$priority" \
    '{
      timestamp: $timestamp,
      event_type: "request_created",
      request_id: $request_id,
      from_state: null,
      to_state: "intake",
      session_id: null,
      metadata: {
        title: $title,
        repository: $repository,
        priority: $priority,
        submitted_by: "cli"
      }
    }')"

  event_append "${req_dir}/events.jsonl" "$event"

  return 0
}
