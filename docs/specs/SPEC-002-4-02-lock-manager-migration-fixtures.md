# SPEC-002-4-02: Lock Manager, Schema Migration Framework, and V1 Test Fixtures

## Metadata
- **Parent Plan**: PLAN-002-4
- **Tasks Covered**: Task 5 (Split-brain prevention), Task 6 (Schema migration framework), Task 7 (V1 test fixtures)
- **Estimated effort**: 7 hours

## Description
Implement three supporting infrastructure components: (1) the daemon lock manager that prevents multiple supervisor instances via PID-based lock file validation, (2) the schema migration framework that detects state file versions and applies sequential migrations, and (3) a set of v1 test fixtures at key lifecycle positions for validating the migration infrastructure. These components close the operational maturity gap -- lock management prevents split-brain corruption, migration enables schema evolution, and fixtures ensure migration correctness.

## Files to Create/Modify
- **Path**: `lib/state/lock_manager.sh`
- **Action**: Create
- **Description**: Lock file management for daemon singleton enforcement. Contains `acquire_lock()`, `release_lock()`, `is_lock_held()`, and signal trap setup.

- **Path**: `lib/state/migration.sh`
- **Action**: Create
- **Description**: Schema migration framework. Contains `migrate_state()`, the migration registry, and version comparison logic.

- **Path**: `tests/fixtures/state_v1_intake.json`
- **Action**: Create
- **Description**: V1 fixture: request at `intake` state (freshly created).

- **Path**: `tests/fixtures/state_v1_prd_review.json`
- **Action**: Create
- **Description**: V1 fixture: request at `prd_review` state (mid-pipeline).

- **Path**: `tests/fixtures/state_v1_failed.json`
- **Action**: Create
- **Description**: V1 fixture: request in `failed` state with error object.

- **Path**: `tests/fixtures/state_v1_complete.json`
- **Action**: Create
- **Description**: V1 fixture: request at `monitor` state (pipeline complete).

## Implementation Details

### Lock Manager (`lock_manager.sh`)

```bash
#!/usr/bin/env bash
# lock_manager.sh -- Daemon lock file management (split-brain prevention)
# Part of TDD-002: State Machine & Request Lifecycle
set -euo pipefail

# Lock file location
readonly DAEMON_LOCK_FILE="${HOME}/.autonomous-dev/daemon.lock"

# acquire_lock -- Acquire the daemon lock
#
# Returns:
#   0 on success (lock acquired)
#   1 on failure (another live instance holds the lock)
#
# Behavior:
#   1. If lock file does not exist: create it with our PID, return 0
#   2. If lock file exists:
#      a. Read PID from file
#      b. If PID is not a valid integer: delete lock (corrupt), re-acquire
#      c. If PID is alive (kill -0): return 1 (another instance running)
#      d. If PID is dead: steal lock with warning, write our PID, return 0
#   3. Set up SIGTERM/SIGINT traps to release lock on shutdown
acquire_lock() {
  local lock_dir
  lock_dir="$(dirname "$DAEMON_LOCK_FILE")"

  # Ensure lock directory exists
  if [[ ! -d "$lock_dir" ]]; then
    mkdir -p "$lock_dir"
    chmod 0700 "$lock_dir"
  fi

  if [[ -f "$DAEMON_LOCK_FILE" ]]; then
    local existing_pid
    existing_pid="$(cat "$DAEMON_LOCK_FILE" 2>/dev/null)"

    # Check if PID is valid integer
    if [[ ! "$existing_pid" =~ ^[0-9]+$ ]]; then
      echo "WARNING: Corrupt lock file (not a valid PID: '${existing_pid}'), removing" >&2
      rm -f "$DAEMON_LOCK_FILE"
    elif kill -0 "$existing_pid" 2>/dev/null; then
      # Process is alive
      echo "ERROR: Another instance is running (PID: ${existing_pid})" >&2
      return 1
    else
      # Process is dead -- steal lock
      echo "WARNING: Stale lock detected (PID ${existing_pid} is dead), stealing lock" >&2
      rm -f "$DAEMON_LOCK_FILE"
    fi
  fi

  # Write our PID
  echo "$$" > "$DAEMON_LOCK_FILE"
  chmod 0600 "$DAEMON_LOCK_FILE"

  # Set up signal traps
  trap 'release_lock' EXIT SIGTERM SIGINT SIGHUP

  return 0
}

# release_lock -- Release the daemon lock
#
# Returns:
#   0 always
#
# Behavior:
#   1. Verify the lock file contains our PID (safety check)
#   2. Remove the lock file
release_lock() {
  if [[ -f "$DAEMON_LOCK_FILE" ]]; then
    local lock_pid
    lock_pid="$(cat "$DAEMON_LOCK_FILE" 2>/dev/null)"
    if [[ "$lock_pid" == "$$" ]]; then
      rm -f "$DAEMON_LOCK_FILE"
    else
      echo "WARNING: Lock file PID (${lock_pid}) does not match our PID ($$), not releasing" >&2
    fi
  fi
}

# is_lock_held -- Check if the daemon lock is currently held by a live process
#
# Returns:
#   0 if held by a live process
#   1 if not held or held by a dead process
is_lock_held() {
  if [[ ! -f "$DAEMON_LOCK_FILE" ]]; then
    return 1
  fi

  local existing_pid
  existing_pid="$(cat "$DAEMON_LOCK_FILE" 2>/dev/null)"

  if [[ ! "$existing_pid" =~ ^[0-9]+$ ]]; then
    return 1
  fi

  if kill -0 "$existing_pid" 2>/dev/null; then
    return 0
  fi

  return 1
}
```

### Schema Migration Framework (`migration.sh`)

```bash
#!/usr/bin/env bash
# migration.sh -- State file schema migration framework
# Part of TDD-002: State Machine & Request Lifecycle
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
```

### V1 Test Fixtures

**`state_v1_intake.json`** -- Freshly created request:
```json
{
  "schema_version": 1,
  "id": "REQ-20260408-0001",
  "status": "intake",
  "priority": 5,
  "title": "V1 fixture: intake state",
  "description": "Test fixture for a request at intake.",
  "repository": "/tmp/test-repo",
  "branch": "autonomous/REQ-20260408-0001",
  "worktree_path": null,
  "created_at": "2026-04-08T09:00:00Z",
  "updated_at": "2026-04-08T09:00:00Z",
  "cost_accrued_usd": 0,
  "turn_count": 0,
  "escalation_count": 0,
  "blocked_by": [],
  "phase_history": [
    {"state":"intake","entered_at":"2026-04-08T09:00:00Z","exited_at":null,"session_id":null,"turns_used":0,"cost_usd":0,"retry_count":0,"exit_reason":null}
  ],
  "current_phase_metadata": {},
  "error": null,
  "last_checkpoint": null,
  "paused_from": null,
  "paused_reason": null,
  "failure_reason": null,
  "generation": 0,
  "tags": []
}
```

**`state_v1_prd_review.json`** -- Mid-pipeline (same as TDD 4.3 example).

**`state_v1_failed.json`** -- Failed request with error object:
```json
{
  "schema_version": 1,
  "id": "REQ-20260408-0003",
  "status": "failed",
  ...
  "error": {
    "message": "Session crashed with exit code 1",
    "code": "session_crash",
    "phase": "code",
    "timestamp": "2026-04-08T14:30:00Z",
    "session_id": "sess_xyz789",
    "details": {"exit_code": 1, "stderr_tail": "Error: out of memory"}
  },
  "failure_reason": "session_crash_retries_exhausted",
  ...
}
```

**`state_v1_complete.json`** -- Completed request at `monitor`:
```json
{
  "schema_version": 1,
  "id": "REQ-20260408-0004",
  "status": "monitor",
  ...
  "phase_history": [ /* all 14 phases completed */ ],
  "last_checkpoint": "deploy",
  ...
}
```

## Acceptance Criteria
1. [ ] `acquire_lock()` creates lock file with current PID
2. [ ] `acquire_lock()` fails with error when another live process holds the lock
3. [ ] `acquire_lock()` steals lock with warning when PID in lock file is dead
4. [ ] `acquire_lock()` handles corrupt lock file (non-integer PID) by deleting and re-acquiring
5. [ ] `release_lock()` removes lock file only if it contains our PID
6. [ ] Lock is released on EXIT, SIGTERM, SIGINT, SIGHUP via trap
7. [ ] `migrate_state()` passes through state at current version unchanged
8. [ ] `migrate_state()` rejects state with version newer than supported (returns 1)
9. [ ] `migrate_state()` applies sequential migrations for older versions (returns 0)
10. [ ] `migrate_state()` writes migrated state atomically when `request_dir` is provided
11. [ ] `migrate_state()` logs `state_migrated` event with `from_version` and `to_version`
12. [ ] Migrations are idempotent (applying twice produces same result)
13. [ ] All 4 v1 fixtures pass schema validation
14. [ ] Fixtures cover: intake (fresh), prd_review (mid-pipeline), failed (with error), monitor (complete)

## Test Cases
1. **Acquire lock (clean)** -- No lock file exists. Assertion: lock acquired, file contains our PID.
2. **Acquire lock (live PID)** -- Lock file with a running PID. Assertion: returns 1.
3. **Acquire lock (dead PID)** -- Lock file with non-running PID. Assertion: lock stolen, warning logged.
4. **Acquire lock (corrupt PID)** -- Lock file with "garbage" content. Assertion: file deleted, lock acquired.
5. **Release lock (our PID)** -- Lock file with our PID. Assertion: file deleted.
6. **Release lock (not our PID)** -- Lock file with different PID. Assertion: file NOT deleted, warning.
7. **Migrate current version** -- State with `schema_version: 1`. Assertion: returned unchanged.
8. **Migrate newer version** -- State with `schema_version: 99`. Assertion: returns 1, error mentions "upgrade".
9. **Migrate with registered migration** -- Register a mock v0->v1 migration, pass v0 state. Assertion: migration applied, state has `schema_version: 1`.
10. **Migration idempotency** -- Apply migration twice. Assertion: second application produces identical output.
11. **Migration writes atomically** -- Provide `request_dir`, verify state file written.
12. **Migration logs event** -- Verify `state_migrated` event appended to events.jsonl.
13. **Fixture v1_intake validates** -- Load fixture, call `_validate_state_schema`. Assertion: returns 0.
14. **Fixture v1_prd_review validates** -- Same for mid-pipeline fixture.
15. **Fixture v1_failed validates** -- Same for failed fixture (with error object).
16. **Fixture v1_complete validates** -- Same for monitor fixture.
