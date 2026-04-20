#!/usr/bin/env bash
# state_file_manager.sh -- Atomic state file operations with schema validation
# Part of TDD-002: State Machine & Request Lifecycle
#
# Dependencies: jq (1.6+), python3 (optional, for fsync)
# Sourced by: event_logger.sh, request_tracker.sh, lifecycle_engine.sh,
#             supervisor_interface.sh, recovery.sh

set -euo pipefail

# Source guard — prevent re-declaration of readonly variables
if [[ -n "${_STATE_FILE_MANAGER_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
_STATE_FILE_MANAGER_LOADED=1

# Resolve the directory this script lives in (for finding schema files)
_SFM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_SCHEMA_DIR="${_SFM_DIR}/schema"

# Current schema version constant
readonly STATE_SCHEMA_VERSION=1

# Status enum (pipeline order)
readonly -a PIPELINE_ORDER=(
  intake prd prd_review tdd tdd_review plan plan_review
  spec spec_review code code_review integration deploy monitor
)

# All valid statuses including meta-states
readonly -a ALL_STATUSES=(
  "${PIPELINE_ORDER[@]}" paused failed cancelled
)

# Exit code constants for state_read consumers
readonly STATE_READ_OK=0
readonly STATE_READ_NOT_FOUND=2
readonly STATE_READ_PARSE_ERROR=3
readonly STATE_READ_VALIDATION_ERROR=4

# ensure_file_permissions -- Set file permissions to 0600 if not already set
#
# Arguments:
#   $1 -- filepath: Path to the file to set permissions on
#
# Side effects:
#   Sets file permissions to 0600
ensure_file_permissions() {
  local filepath="$1"
  chmod 0600 "$filepath"
}

# _check_file_permissions -- Warn if file permissions are more permissive than 0600
#
# Arguments:
#   $1 -- filepath: Path to the file to check
#
# Side effects:
#   Logs warning to stderr if permissions are too open
_check_file_permissions() {
  local filepath="$1"
  local perms=""
  # macOS: stat -f '%Lp', Linux: stat -c '%a'
  if [[ "$(uname)" == "Darwin" ]]; then
    perms="$(stat -f '%Lp' "$filepath" 2>/dev/null)" || true
  else
    perms="$(stat -c '%a' "$filepath" 2>/dev/null)" || true
  fi
  if [[ -n "$perms" && "$perms" != "600" ]]; then
    echo "WARNING: ${filepath} has permissions ${perms} (expected 600)" >&2
  fi
}

# _validate_state_schema -- Validate state JSON against v1 schema constraints
#
# Arguments:
#   $1 -- json: State JSON string
#
# Stdout:
#   Validation error messages (one per line) if validation fails
#
# Returns:
#   0 if valid
#   1 if invalid (errors on stdout)
_validate_state_schema() {
  local json="$1"
  local errors=""
  local exit_code=0

  # --- Required fields ---
  local -a required_fields=(
    schema_version id status priority title repository branch
    created_at updated_at cost_accrued_usd turn_count
    escalation_count blocked_by phase_history
    current_phase_metadata error last_checkpoint
  )
  for field in "${required_fields[@]}"; do
    if ! echo "$json" | jq -e "has(\"$field\")" > /dev/null 2>&1; then
      errors+="Missing required field: ${field}\n"
      exit_code=1
    fi
  done

  # Early return if critical fields missing (can't validate further)
  if [[ $exit_code -ne 0 ]]; then
    printf '%b' "$errors"
    return 1
  fi

  # --- schema_version ---
  local sv
  sv="$(echo "$json" | jq -r '.schema_version')"
  if [[ "$sv" != "1" ]]; then
    errors+="Unrecognized schema_version: ${sv} (expected: 1)\n"
    exit_code=1
  fi

  # --- id format ---
  local id_val
  id_val="$(echo "$json" | jq -r '.id')"
  if [[ ! "$id_val" =~ ^REQ-[0-9]{8}-[0-9a-f]{4}$ ]]; then
    errors+="Invalid id format: ${id_val} (expected: REQ-YYYYMMDD-XXXX)\n"
    exit_code=1
  fi

  # --- status enum ---
  local status_val
  status_val="$(echo "$json" | jq -r '.status')"
  local status_valid=false
  for s in "${ALL_STATUSES[@]}"; do
    if [[ "$status_val" == "$s" ]]; then
      status_valid=true
      break
    fi
  done
  if [[ "$status_valid" == "false" ]]; then
    errors+="Invalid status: ${status_val}\n"
    exit_code=1
  fi

  # --- priority range ---
  local priority_val
  priority_val="$(echo "$json" | jq '.priority')"
  if ! echo "$json" | jq -e '.priority >= 0 and .priority <= 9' > /dev/null 2>&1; then
    errors+="Invalid priority: ${priority_val} (must be 0-9)\n"
    exit_code=1
  fi

  # --- title length ---
  local title_len
  title_len="$(echo "$json" | jq -r '.title | length')"
  if [[ "$title_len" -lt 1 || "$title_len" -gt 200 ]]; then
    errors+="Invalid title length: ${title_len} (must be 1-200)\n"
    exit_code=1
  fi

  # --- repository absolute path ---
  local repo_val
  repo_val="$(echo "$json" | jq -r '.repository')"
  if [[ ! "$repo_val" =~ ^/ ]]; then
    errors+="Repository must be absolute path: ${repo_val}\n"
    exit_code=1
  fi

  # --- branch format ---
  local branch_val
  branch_val="$(echo "$json" | jq -r '.branch')"
  if [[ ! "$branch_val" =~ ^autonomous/REQ-[0-9]{8}-[0-9a-f]{4}$ ]]; then
    errors+="Invalid branch format: ${branch_val}\n"
    exit_code=1
  fi

  # --- temporal consistency: updated_at >= created_at (warning only) ---
  local created updated
  created="$(echo "$json" | jq -r '.created_at')"
  updated="$(echo "$json" | jq -r '.updated_at')"
  if [[ "$updated" < "$created" ]]; then
    echo "state_read: WARNING: updated_at (${updated}) < created_at (${created}) — may be stale" >&2
    # Not a hard failure — timestamps may be set by different clocks or test fixtures
  fi

  # --- type checks for numeric fields ---
  if ! echo "$json" | jq -e '.cost_accrued_usd | type == "number"' > /dev/null 2>&1; then
    errors+="cost_accrued_usd must be a number\n"
    exit_code=1
  fi
  if ! echo "$json" | jq -e '.turn_count | type == "number"' > /dev/null 2>&1; then
    errors+="turn_count must be a number\n"
    exit_code=1
  fi
  if ! echo "$json" | jq -e '.escalation_count | type == "number"' > /dev/null 2>&1; then
    errors+="escalation_count must be a number\n"
    exit_code=1
  fi

  # --- blocked_by is array ---
  if ! echo "$json" | jq -e '.blocked_by | type == "array"' > /dev/null 2>&1; then
    errors+="blocked_by must be an array\n"
    exit_code=1
  fi

  # --- phase_history is array ---
  if ! echo "$json" | jq -e '.phase_history | type == "array"' > /dev/null 2>&1; then
    errors+="phase_history must be an array\n"
    exit_code=1
  fi

  # --- Validate each PhaseHistoryEntry ---
  local entry_count
  entry_count="$(echo "$json" | jq '.phase_history | length')"
  local i
  for ((i=0; i<entry_count; i++)); do
    local entry
    entry="$(echo "$json" | jq ".phase_history[$i]")"
    for ef in state entered_at exited_at session_id turns_used cost_usd; do
      if ! echo "$entry" | jq -e "has(\"$ef\")" > /dev/null 2>&1; then
        errors+="phase_history[$i] missing required field: ${ef}\n"
        exit_code=1
      fi
    done
    # Validate exit_reason enum if present and non-null
    local er
    er="$(echo "$entry" | jq -r '.exit_reason // empty')"
    if [[ -n "$er" && "$er" != "null" ]]; then
      case "$er" in
        completed|review_pass|review_fail|timeout|error|paused|cancelled) ;;
        *) errors+="phase_history[$i] invalid exit_reason: ${er}\n"; exit_code=1 ;;
      esac
    fi
  done

  # --- error object validation (when non-null) ---
  local error_type
  error_type="$(echo "$json" | jq -r '.error | type')"
  if [[ "$error_type" == "object" ]]; then
    for ef in message code phase timestamp; do
      if ! echo "$json" | jq -e ".error | has(\"$ef\")" > /dev/null 2>&1; then
        errors+="error object missing required field: ${ef}\n"
        exit_code=1
      fi
    done
  fi

  if [[ $exit_code -ne 0 ]]; then
    printf '%b' "$errors"
  fi
  return $exit_code
}

# state_write_atomic -- Write state JSON atomically via tmp-fsync-mv protocol
#
# Arguments:
#   $1 -- dir:  Absolute path to the request directory (containing state.json)
#   $2 -- json: The complete state JSON string to write
#
# Returns:
#   0 on success
#   1 on failure (write error, fsync error, mv error)
#
# Side effects:
#   - Creates/overwrites {dir}/state.json
#   - Temporary file {dir}/state.json.tmp exists only during write
#   - File permissions set to 0600
#
# Protocol:
#   1. Write JSON to state.json.tmp
#   2. fsync via python3 (fallback: sync)
#   3. mv -f state.json.tmp -> state.json (atomic rename)
state_write_atomic() {
  local dir="$1"
  local json="$2"
  local tmp="${dir}/state.json.tmp"
  local target="${dir}/state.json"

  # Validate inputs
  if [[ -z "$dir" || -z "$json" ]]; then
    echo "state_write_atomic: dir and json arguments required" >&2
    return 1
  fi

  if [[ ! -d "$dir" ]]; then
    echo "state_write_atomic: directory does not exist: ${dir}" >&2
    return 1
  fi

  # Validate that json is actually valid JSON before writing
  if ! echo "$json" | jq empty 2>/dev/null; then
    echo "state_write_atomic: invalid JSON provided" >&2
    return 1
  fi

  # Step 1: Write to tmp file
  if ! printf '%s\n' "$json" > "$tmp"; then
    echo "state_write_atomic: failed to write tmp file: ${tmp}" >&2
    rm -f "$tmp"
    return 1
  fi

  # Set permissions on tmp file
  chmod 0600 "$tmp"

  # Step 2: fsync
  if ! python3 -c "import os; fd=os.open('${tmp}',os.O_RDONLY); os.fsync(fd); os.close(fd)" 2>/dev/null; then
    # Fallback: sync all filesystems (coarser but correct)
    sync
  fi

  # Step 3: Atomic rename
  if ! mv -f "$tmp" "$target"; then
    echo "state_write_atomic: failed to rename tmp to target" >&2
    return 1
  fi

  return 0
}

# state_read -- Read and validate state.json from a request directory
#
# Arguments:
#   $1 -- dir: Absolute path to the request directory
#
# Stdout:
#   The validated state JSON (pretty-printed) on success
#
# Stderr:
#   Error messages on failure
#
# Returns:
#   0 on success (valid state JSON on stdout)
#   2 if state.json does not exist ("not found")
#   3 if JSON parse fails ("parse error")
#   4 if schema validation fails ("validation error")
#
# Behavior:
#   1. Check file exists
#   2. Parse JSON with jq
#   3. Validate against schema (call _validate_state_schema)
#   4. Check file permissions, warn if too open
#   5. Return validated JSON
state_read() {
  local dir="$1"
  local target="${dir}/state.json"

  if [[ ! -f "$target" ]]; then
    echo "state_read: state file not found: ${target}" >&2
    return 2
  fi

  # Check permissions and warn
  _check_file_permissions "$target"

  # Parse JSON
  local json
  if ! json="$(jq '.' "$target" 2>/dev/null)"; then
    # Parse failure -- attempt checkpoint fallback (SPEC-002-4-01)
    echo "WARNING: JSON parse failed for ${target}, attempting checkpoint fallback" >&2
    if _attempt_checkpoint_fallback "$dir"; then
      # Re-read after successful restore
      if json="$(jq '.' "$target" 2>/dev/null)"; then
        if _validate_state_schema "$json" > /dev/null 2>&1; then
          echo "$json"
          return 0
        fi
      fi
    fi
    echo "state_read: JSON parse failed and checkpoint fallback unsuccessful: ${target}" >&2
    return 3
  fi

  # Validate schema
  local validation_errors
  if ! validation_errors="$(_validate_state_schema "$json")"; then
    echo "state_read: schema validation failed for: ${target}" >&2
    echo "$validation_errors" >&2
    return 4
  fi

  # Output validated JSON
  echo "$json"
  return 0
}

# _attempt_checkpoint_fallback -- Try to restore from the most recent valid checkpoint
#
# Arguments:
#   $1 -- dir: Request directory
#
# Returns:
#   0 if checkpoint was successfully restored
#   1 if no valid checkpoint found
#
# Behavior (SPEC-002-4-01):
#   1. Look for checkpoint directory
#   2. Try checkpoints from most recent to oldest
#   3. If valid: move corrupt state.json to corrupt/, restore checkpoint
#   4. If no valid checkpoint: move corrupt state.json to corrupt/, return 1
_attempt_checkpoint_fallback() {
  local dir="$1"
  local checkpoint_dir="${dir}/checkpoint"
  local corrupt_dir="${dir}/corrupt"

  if [[ ! -d "$checkpoint_dir" ]]; then
    return 1
  fi

  # Try checkpoints from most recent to oldest
  local -a checkpoints
  while IFS= read -r f; do
    checkpoints+=("$f")
  done < <(ls -1 "${checkpoint_dir}"/state.json.* 2>/dev/null | sort -r)

  if [[ ${#checkpoints[@]} -eq 0 ]]; then
    return 1
  fi

  for cp in "${checkpoints[@]}"; do
    local cp_json
    if cp_json="$(jq '.' "$cp" 2>/dev/null)" && _validate_state_schema "$cp_json" > /dev/null 2>&1; then
      # Valid checkpoint found -- restore it
      echo "INFO: Restoring from checkpoint: ${cp}" >&2

      # Move corrupt state.json to corrupt/ for forensics
      mkdir -p "$corrupt_dir"
      chmod 0700 "$corrupt_dir"
      local ts
      ts="$(date -u +%Y%m%dT%H%M%SZ)"
      mv -f "${dir}/state.json" "${corrupt_dir}/state.json.corrupt.${ts}" 2>/dev/null || true

      # Restore checkpoint via atomic write
      state_write_atomic "$dir" "$cp_json"
      return 0
    fi
  done

  # No valid checkpoint found
  echo "ERROR: No valid checkpoint found for: ${dir}" >&2

  # Move corrupt files to corrupt/
  mkdir -p "$corrupt_dir"
  chmod 0700 "$corrupt_dir"
  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  mv -f "${dir}/state.json" "${corrupt_dir}/state.json.corrupt.${ts}" 2>/dev/null || true

  return 1
}

# =============================================================================
# SPEC-002-1-03: Orphaned Tmp Recovery, Checkpointing, and File Permissions
# =============================================================================

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
