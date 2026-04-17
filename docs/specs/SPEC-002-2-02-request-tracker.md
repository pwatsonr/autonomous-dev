# SPEC-002-2-02: Request Tracker (ID Generation, Discovery, Scaffolding)

## Metadata
- **Parent Plan**: PLAN-002-2
- **Tasks Covered**: Task 4 (Implement `generate_request_id()`), Task 5 (Implement `discover_requests()`), Task 6 (Implement request directory scaffolding)
- **Estimated effort**: 7 hours

## Description
Implement the Request Tracker: the component responsible for creating new request identities, discovering existing requests across repositories, and scaffolding the full directory structure for new requests. These three functions form the request lifecycle boundary -- they manage how requests come into existence and how the system finds them.

## Files to Create/Modify
- **Path**: `lib/state/request_tracker.sh`
- **Action**: Create
- **Description**: Request Tracker library. Contains `generate_request_id()`, `discover_requests()`, `create_request_directory()`, and supporting functions. Sources `state_file_manager.sh` and `event_logger.sh`.

## Implementation Details

### File Header

```bash
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
```

### `generate_request_id(base_dir)`

```bash
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
```

### `discover_requests(allowlist_array)`

```bash
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
```

### `create_request_directory(base_dir, request_id, title, description, repository, priority, blocked_by_json, tags_json)`

```bash
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
```

### Request Directory Layout

After successful scaffolding, the directory looks like:

```
{base_dir}/{request_id}/          # 0700
  state.json                      # 0600, status: "intake"
  events.jsonl                    # 0600, 1 line: request_created
  checkpoint/                     # 0700, empty
```

## Acceptance Criteria
1. [ ] `generate_request_id()` produces IDs matching `^REQ-[0-9]{8}-[0-9a-f]{4}$`
2. [ ] `generate_request_id()` hex part is lowercase
3. [ ] `generate_request_id()` retries on directory collision (up to 5 times)
4. [ ] `generate_request_id()` returns error after 5 collisions
5. [ ] `generate_request_id()` falls back to `/dev/urandom` when `openssl` is unavailable
6. [ ] `discover_requests()` finds all request directories with `state.json` across multiple repos
7. [ ] `discover_requests()` skips directories without `state.json`
8. [ ] `discover_requests()` skips repos without `.autonomous-dev/requests/` directory
9. [ ] `discover_requests()` returns empty output (not error) when no requests exist
10. [ ] `create_request_directory()` creates the full directory structure (`state.json`, `events.jsonl`, `checkpoint/`)
11. [ ] Initial `state.json` passes schema validation from SPEC-002-1-02
12. [ ] Initial `state.json` has `status: "intake"` and correct phase history entry
13. [ ] Initial `events.jsonl` contains one `request_created` event
14. [ ] Directories are `0700`, files are `0600`
15. [ ] `create_request_directory()` uses `state_write_atomic()` for the initial state file
16. [ ] `create_request_directory()` cleans up on failure (removes partial directory)

## Test Cases
1. **Generate ID format** -- Call `generate_request_id` with empty base_dir. Assertion: output matches `^REQ-[0-9]{8}-[0-9a-f]{4}$`.
2. **Generate ID uniqueness** -- Generate 10 IDs in rapid succession. Assertion: all are distinct.
3. **Generate ID collision retry** -- Pre-create a directory matching the first generated ID (mock by creating REQ-* dirs). Assertion: function retries and produces a different ID.
4. **Generate ID exhaustion** -- Pre-create directories for all possible IDs (impractical) or mock the retry. Assertion: returns 1 after 5 attempts. (Test this by creating 5 colliding dirs in sequence with a known date.)
5. **Discover across multiple repos** -- Create 3 mock repos with 2 requests each. Assertion: `discover_requests` returns 6 paths.
6. **Discover skips missing state.json** -- Create request dir without `state.json`. Assertion: that dir is not in output.
7. **Discover skips missing requests dir** -- Add a repo with no `.autonomous-dev/requests/`. Assertion: no error, that repo is silently skipped.
8. **Discover empty result** -- Call on repos with no requests. Assertion: empty output, return 0.
9. **Scaffold creates structure** -- Call `create_request_directory`. Assertion: `state.json`, `events.jsonl`, `checkpoint/` all exist.
10. **Scaffold initial state valid** -- Read the created `state.json` with `state_read()`. Assertion: passes validation.
11. **Scaffold initial event** -- Read `events.jsonl`. Assertion: one line, `event_type: "request_created"`.
12. **Scaffold permissions** -- Check all created dirs and files. Assertion: dirs `0700`, files `0600`.
13. **Scaffold existing directory fails** -- Call twice with same ID. Assertion: second call returns 1.
14. **Scaffold uses atomic write** -- Verify `state.json.tmp` does not exist after successful scaffold.
