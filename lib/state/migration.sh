#!/usr/bin/env bash
# migration.sh -- State file schema migration framework
# Part of TDD-002: State Machine & Request Lifecycle
#
# Dependencies: jq (1.6+), state_file_manager.sh, event_logger.sh
# Sourced by: request_tracker.sh, lifecycle_engine.sh, recovery.sh
#
# Provides version-aware state file reading with sequential migration
# application. When a state file has an older schema_version than the
# current codebase supports, registered migration functions are applied
# in order (v1->v2, v2->v3, etc.) to bring the state up to date.

set -euo pipefail

_MIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${_MIG_DIR}/state_file_manager.sh"
source "${_MIG_DIR}/event_logger.sh"

# Current schema version supported by this codebase
readonly CURRENT_SCHEMA_VERSION=1

# Migration registry
# Format: associative array mapping "from_version" to "migration_function_name"
# Example (for future use):
#   MIGRATIONS[1]="migrate_v1_to_v2"
#   MIGRATIONS[2]="migrate_v2_to_v3"
declare -A MIGRATIONS=(
  # No migrations yet -- v1 is the first and only version
  # When v2 is introduced, add: [1]="migrate_v1_to_v2"
)

# migrate_state -- Check schema version and apply migrations if needed
#
# Arguments:
#   $1 -- state_json: The state JSON string
#   $2 -- request_dir: (Optional) Directory for writing migrated state.
#          If provided, migrated state is written atomically.
#
# Stdout:
#   The (possibly migrated) state JSON
#
# Returns:
#   0 if state is current version or successfully migrated
#   1 if state version is newer than supported (upgrade required)
#   2 if migration failed
migrate_state() {
  local state_json="$1"
  local request_dir="${2:-}"

  local schema_version
  schema_version="$(echo "$state_json" | jq '.schema_version // 0')"

  # Case 1: Current version -- pass through
  if (( schema_version == CURRENT_SCHEMA_VERSION )); then
    echo "$state_json"
    return 0
  fi

  # Case 2: Newer than supported -- refuse
  if (( schema_version > CURRENT_SCHEMA_VERSION )); then
    echo "migrate_state: state version ${schema_version} is newer than supported version ${CURRENT_SCHEMA_VERSION}. Upgrade the plugin." >&2
    return 1
  fi

  # Case 3: Older version -- apply sequential migrations
  local current_version=$schema_version
  local migrated_json="$state_json"

  while (( current_version < CURRENT_SCHEMA_VERSION )); do
    local migration_func="${MIGRATIONS[$current_version]:-}"

    if [[ -z "$migration_func" ]]; then
      echo "migrate_state: no migration registered for version ${current_version}" >&2
      return 2
    fi

    echo "INFO: Applying migration: v${current_version} -> v$((current_version + 1))" >&2

    if ! migrated_json="$("$migration_func" "$migrated_json")"; then
      echo "migrate_state: migration function '${migration_func}' failed" >&2
      return 2
    fi

    (( current_version++ ))
  done

  # Verify migrated state has correct version
  local new_version
  new_version="$(echo "$migrated_json" | jq '.schema_version')"
  if (( new_version != CURRENT_SCHEMA_VERSION )); then
    echo "migrate_state: migration did not produce expected version (got ${new_version}, expected ${CURRENT_SCHEMA_VERSION})" >&2
    return 2
  fi

  # Write migrated state if directory provided
  if [[ -n "$request_dir" ]]; then
    state_write_atomic "$request_dir" "$migrated_json"

    # Log migration event
    local request_id
    request_id="$(echo "$migrated_json" | jq -r '.id')"
    local timestamp
    timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    local event
    event="$(jq -n \
      --arg ts "$timestamp" \
      --arg rid "$request_id" \
      --argjson from_v "$schema_version" \
      --argjson to_v "$CURRENT_SCHEMA_VERSION" \
      '{timestamp: $ts, event_type: "state_transition", request_id: $rid, from_state: null, to_state: null, session_id: null, metadata: {trigger: "state_migrated", from_version: $from_v, to_version: $to_v}}')"
    event_append "${request_dir}/events.jsonl" "$event" 2>/dev/null || true
  fi

  echo "$migrated_json"
  return 0
}

# Example migration function (template for future use)
# migrate_v1_to_v2() {
#   local state_json="$1"
#   echo "$state_json" | jq '. + {new_field: "default_value", schema_version: 2}'
# }
