# SPEC-002-1-03: Orphaned Tmp Recovery, Checkpointing, and File Permissions

## Metadata
- **Parent Plan**: PLAN-002-1
- **Tasks Covered**: Task 5 (Orphaned `.tmp` recovery), Task 6 (Checkpointing), Task 7 (File permission enforcement)
- **Estimated effort**: 6 hours

## Description
Implement three closely related operational safety features in the State File Manager: (1) orphaned `.tmp` file detection and recovery on startup, (2) checkpoint creation/restore/pruning for crash recovery, and (3) file permission enforcement on all created directories and files. These three tasks share a file (`state_file_manager.sh`) and collaborate to ensure the system is crash-safe, recoverable, and secure.

## Files to Create/Modify
- **Path**: `lib/state/state_file_manager.sh`
- **Action**: Modify (append to file created in SPEC-002-1-02)
- **Description**: Add `recover_orphaned_tmp()`, `state_checkpoint()`, `state_restore_checkpoint()`, `state_prune_checkpoints()`, `ensure_dir_permissions()`, and `ensure_file_permissions()` functions.

## Implementation Details

### Orphaned `.tmp` Recovery

```bash
# recover_orphaned_tmp -- Handle orphaned .tmp files in a request directory
#
# Arguments:
#   $1 -- dir: Absolute path to the request directory
#
# Returns:
#   0 on success (recovery action taken or no action needed)
#   1 on failure (validation failed, file moved to corrupt/)
#
# Behavior (per TDD Section 3.1.2):
#   Case 1: state.json.tmp exists AND state.json exists
#     -> Delete .tmp (incomplete write from crashed process)
#   Case 2: state.json.tmp exists AND state.json does NOT exist
#     -> If .tmp passes schema validation: promote to state.json (mv)
#     -> If .tmp fails validation: move to corrupt/ subdirectory, return 1
#   Case 3: No state.json.tmp
#     -> No-op, return 0
recover_orphaned_tmp() {
  local dir="$1"
  local tmp="${dir}/state.json.tmp"
  local target="${dir}/state.json"

  # Case 3: No tmp file
  if [[ ! -f "$tmp" ]]; then
    return 0
  fi

  # Case 1: Both exist -- delete tmp
  if [[ -f "$target" ]]; then
    echo "INFO: Deleting orphaned .tmp alongside existing state.json in: ${dir}" >&2
    rm -f "$tmp"
    return 0
  fi

  # Case 2: Only tmp exists -- validate and promote or quarantine
  echo "INFO: Found orphaned .tmp without state.json in: ${dir}" >&2

  local json
  if json="$(jq '.' "$tmp" 2>/dev/null)" && _validate_state_schema "$json" > /dev/null 2>&1; then
    # Passes validation: promote
    echo "INFO: Promoting valid .tmp to state.json in: ${dir}" >&2
    mv -f "$tmp" "$target"
    chmod 0600 "$target"
    return 0
  else
    # Fails validation: quarantine
    local corrupt_dir="${dir}/corrupt"
    mkdir -p "$corrupt_dir"
    chmod 0700 "$corrupt_dir"
    local timestamp
    timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
    mv -f "$tmp" "${corrupt_dir}/state.json.tmp.${timestamp}"
    echo "ERROR: Orphaned .tmp failed validation, moved to: ${corrupt_dir}" >&2
    return 1
  fi
}
```

### Checkpointing

```bash
# state_checkpoint -- Create a checkpoint of the current state.json
#
# Arguments:
#   $1 -- dir: Absolute path to the request directory
#
# Returns:
#   0 on success
#   1 on failure (missing state.json, copy failure)
#
# Behavior:
#   1. Verify state.json exists
#   2. Create checkpoint/ directory if needed (0700)
#   3. Copy state.json to checkpoint/state.json.{ISO-8601-timestamp}
#   4. Set checkpoint file permissions to 0600
#   5. Prune checkpoints to retain only 5 most recent
#
# Timestamp format: YYYY-MM-DDTHH-MM-SSZ (hyphens replace colons for filename safety)
state_checkpoint() {
  local dir="$1"
  local target="${dir}/state.json"
  local checkpoint_dir="${dir}/checkpoint"

  if [[ ! -f "$target" ]]; then
    echo "state_checkpoint: no state.json to checkpoint in: ${dir}" >&2
    return 1
  fi

  # Create checkpoint directory if needed
  if [[ ! -d "$checkpoint_dir" ]]; then
    mkdir -p "$checkpoint_dir"
    chmod 0700 "$checkpoint_dir"
  fi

  # Generate timestamp for filename
  local timestamp
  timestamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"

  local checkpoint_file="${checkpoint_dir}/state.json.${timestamp}"

  if ! cp -p "$target" "$checkpoint_file"; then
    echo "state_checkpoint: failed to create checkpoint: ${checkpoint_file}" >&2
    return 1
  fi

  chmod 0600 "$checkpoint_file"

  # Prune old checkpoints
  _prune_checkpoints "$checkpoint_dir"

  return 0
}

# state_restore_checkpoint -- Restore state.json from a checkpoint file
#
# Arguments:
#   $1 -- dir: Absolute path to the request directory
#   $2 -- checkpoint_file: (Optional) Specific checkpoint file to restore.
#          If omitted, restores from the most recent checkpoint.
#
# Returns:
#   0 on success
#   1 on failure (no checkpoints, restore failed)
#
# Behavior:
#   1. Find the target checkpoint (most recent or specified)
#   2. Read and validate the checkpoint
#   3. Write it as the new state.json via state_write_atomic()
state_restore_checkpoint() {
  local dir="$1"
  local checkpoint_file="${2:-}"
  local checkpoint_dir="${dir}/checkpoint"

  if [[ ! -d "$checkpoint_dir" ]]; then
    echo "state_restore_checkpoint: no checkpoint directory in: ${dir}" >&2
    return 1
  fi

  # Find checkpoint file
  if [[ -z "$checkpoint_file" ]]; then
    # Get most recent checkpoint (sorted lexicographically -- ISO-8601 sorts correctly)
    checkpoint_file="$(ls -1 "${checkpoint_dir}"/state.json.* 2>/dev/null | sort | tail -1)"
    if [[ -z "$checkpoint_file" ]]; then
      echo "state_restore_checkpoint: no checkpoints found in: ${checkpoint_dir}" >&2
      return 1
    fi
  fi

  if [[ ! -f "$checkpoint_file" ]]; then
    echo "state_restore_checkpoint: checkpoint file not found: ${checkpoint_file}" >&2
    return 1
  fi

  # Read and validate
  local json
  if ! json="$(jq '.' "$checkpoint_file" 2>/dev/null)"; then
    echo "state_restore_checkpoint: checkpoint is not valid JSON: ${checkpoint_file}" >&2
    return 1
  fi

  if ! _validate_state_schema "$json" > /dev/null 2>&1; then
    echo "state_restore_checkpoint: checkpoint fails schema validation: ${checkpoint_file}" >&2
    return 1
  fi

  # Write atomically
  state_write_atomic "$dir" "$json"
}

# _prune_checkpoints -- Keep only the 5 most recent checkpoints, delete the rest
#
# Arguments:
#   $1 -- checkpoint_dir: Absolute path to the checkpoint/ directory
_prune_checkpoints() {
  local checkpoint_dir="$1"
  local max_checkpoints=5

  local -a all_checkpoints
  # Populate array with sorted checkpoint files (oldest first)
  while IFS= read -r f; do
    all_checkpoints+=("$f")
  done < <(ls -1 "${checkpoint_dir}"/state.json.* 2>/dev/null | sort)

  local count=${#all_checkpoints[@]}
  if (( count > max_checkpoints )); then
    local to_delete=$(( count - max_checkpoints ))
    local i
    for ((i=0; i<to_delete; i++)); do
      rm -f "${all_checkpoints[$i]}"
    done
  fi
}
```

### File Permission Enforcement

```bash
# ensure_dir_permissions -- Create directory with 0700 permissions
#
# Arguments:
#   $1 -- path: Absolute path to the directory
#
# Behavior:
#   Creates the directory (with parents) if it does not exist.
#   Sets permissions to 0700 on the target directory.
ensure_dir_permissions() {
  local path="$1"
  if [[ ! -d "$path" ]]; then
    mkdir -p "$path"
  fi
  chmod 0700 "$path"
}

# ensure_file_permissions -- Set file permissions to 0600
#
# Arguments:
#   $1 -- path: Absolute path to the file
#
# Behavior:
#   Sets permissions to 0600. File must exist.
ensure_file_permissions() {
  local path="$1"
  if [[ -f "$path" ]]; then
    chmod 0600 "$path"
  fi
}
```

### Integration with `state_write_atomic()`

The `state_write_atomic()` function (from SPEC-002-1-02) already calls `chmod 0600 "$tmp"` before rename. The `ensure_file_permissions()` helper is for use by other modules (event_logger, request_tracker) and for retroactive permission fixes.

### Integration with `state_read()`

The `_check_file_permissions()` function (from SPEC-002-1-02) already warns on read if permissions are too open. No modification needed here -- the behavior is already specified.

## Acceptance Criteria
1. [ ] Orphaned `.tmp` alongside valid `state.json` is deleted silently (with INFO log)
2. [ ] Orphaned `.tmp` alone that passes validation is promoted to `state.json`
3. [ ] Orphaned `.tmp` alone that fails validation is moved to `corrupt/` subdirectory with timestamp
4. [ ] No-op when no `.tmp` file exists (returns 0)
5. [ ] `state_checkpoint()` creates checkpoint file at `checkpoint/state.json.{timestamp}`
6. [ ] Checkpoint timestamp format is `YYYY-MM-DDTHH-MM-SSZ` (filename-safe ISO-8601)
7. [ ] After creating 6 checkpoints, only 5 remain (oldest is deleted)
8. [ ] `state_restore_checkpoint()` restores the most recent checkpoint by default
9. [ ] `state_restore_checkpoint()` can restore a specific checkpoint file by path
10. [ ] Restored checkpoint is written via `state_write_atomic()` (crash-safe)
11. [ ] `state_restore_checkpoint()` validates the checkpoint before restoring it
12. [ ] `state_restore_checkpoint()` returns error if no checkpoints exist
13. [ ] Checkpoint directory is created with `0700` permissions if it does not exist
14. [ ] All newly created directories have `0700` permissions
15. [ ] All newly created files have `0600` permissions
16. [ ] `_check_file_permissions()` logs warning to stderr for files with permissions other than `0600`

## Test Cases
1. **Orphaned tmp with state.json** -- Create both `state.json` and `state.json.tmp`, call `recover_orphaned_tmp()`. Assertion: `.tmp` deleted, `state.json` unchanged.
2. **Orphaned tmp without state.json (valid)** -- Create only `state.json.tmp` with valid state JSON, call `recover_orphaned_tmp()`. Assertion: `state.json` exists with the tmp content, `.tmp` gone.
3. **Orphaned tmp without state.json (invalid)** -- Create only `state.json.tmp` with invalid JSON, call `recover_orphaned_tmp()`. Assertion: `corrupt/` directory created, `.tmp` moved there with timestamp, returns 1.
4. **No orphaned tmp** -- Call `recover_orphaned_tmp()` on a directory with only `state.json`. Assertion: returns 0, no changes.
5. **Checkpoint creation** -- Write valid `state.json`, call `state_checkpoint()`. Assertion: `checkpoint/` directory exists, contains one file matching `state.json.*`.
6. **Checkpoint pruning at boundary** -- Create 6 checkpoints (with 1-second sleeps or different timestamps). Assertion: only 5 files remain in `checkpoint/`, the oldest is gone.
7. **Checkpoint restore (most recent)** -- Create 3 checkpoints with different state content, corrupt `state.json`, call `state_restore_checkpoint()`. Assertion: `state.json` now matches the most recent checkpoint content.
8. **Checkpoint restore (specific file)** -- Create 3 checkpoints, call `state_restore_checkpoint(dir, path_to_second)`. Assertion: `state.json` matches the second checkpoint.
9. **Checkpoint restore with no checkpoints** -- Call `state_restore_checkpoint()` on directory with no `checkpoint/` dir. Assertion: returns 1, error message on stderr.
10. **Checkpoint restore invalid checkpoint** -- Create a checkpoint file with corrupt JSON. Assertion: `state_restore_checkpoint()` returns 1 with parse error.
11. **Directory permissions** -- Call `ensure_dir_permissions()` on a new path. Assertion: directory exists with `0700`.
12. **File permissions** -- Call `ensure_file_permissions()` on a file. Assertion: file has `0600`.
13. **Checkpoint dir created with correct permissions** -- Call `state_checkpoint()` when `checkpoint/` does not exist. Assertion: `checkpoint/` created with `0700`.
14. **Promoted tmp gets correct permissions** -- Orphaned `.tmp` promoted to `state.json`. Assertion: `state.json` has `0600` permissions.
