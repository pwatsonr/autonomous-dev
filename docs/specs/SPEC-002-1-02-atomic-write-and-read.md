# SPEC-002-1-02: Atomic Write and Schema-Validated Read

## Metadata
- **Parent Plan**: PLAN-002-1
- **Tasks Covered**: Task 3 (Implement `state_write_atomic()`), Task 4 (Implement `state_read()` with schema validation)
- **Estimated effort**: 7 hours

## Description
Implement the two fundamental state file operations: atomic write (write-tmp-fsync-mv protocol ensuring crash safety) and validated read (JSON parse + schema validation on every access). These are the data layer primitives that every other component in TDD-002 depends on. Correctness here is non-negotiable -- a bug in atomic write can cause data loss, and a bug in schema validation can allow corrupt state to propagate.

## Files to Create/Modify
- **Path**: `lib/state/state_file_manager.sh`
- **Action**: Create
- **Description**: Core state file management library. Contains `state_write_atomic()`, `state_read()`, and internal helper functions for schema validation. Sourced by all other state subsystem modules.

## Implementation Details

### File header and sourcing

```bash
#!/usr/bin/env bash
# state_file_manager.sh -- Atomic state file operations with schema validation
# Part of TDD-002: State Machine & Request Lifecycle
#
# Dependencies: jq (1.6+), python3 (optional, for fsync)
# Sourced by: event_logger.sh, request_tracker.sh, lifecycle_engine.sh,
#             supervisor_interface.sh, recovery.sh

set -euo pipefail

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
```

### `state_write_atomic(dir, json)`

```bash
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
```

### `state_read(dir)`

```bash
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
    echo "state_read: JSON parse failed for: ${target}" >&2
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
```

### `_validate_state_schema(json)`

Internal function. Not exported. Performs field-by-field validation since bash has no native JSON Schema library.

```bash
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

  # --- temporal consistency: updated_at >= created_at ---
  local created updated
  created="$(echo "$json" | jq -r '.created_at')"
  updated="$(echo "$json" | jq -r '.updated_at')"
  if [[ "$updated" < "$created" ]]; then
    errors+="Temporal inconsistency: updated_at (${updated}) < created_at (${created})\n"
    exit_code=1
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
```

### `_check_file_permissions(filepath)`

```bash
# _check_file_permissions -- Warn if file permissions are more permissive than 0600
#
# Arguments:
#   $1 -- filepath: Path to the file to check
#
# Side effects:
#   Logs warning to stderr if permissions are too open
_check_file_permissions() {
  local filepath="$1"
  local perms
  perms="$(stat -f '%Lp' "$filepath" 2>/dev/null || stat -c '%a' "$filepath" 2>/dev/null)"
  if [[ -n "$perms" && "$perms" != "600" ]]; then
    echo "WARNING: ${filepath} has permissions ${perms} (expected 600)" >&2
  fi
}
```

### Error codes

Define exit code constants at the top of the file for consumers:

```bash
readonly STATE_READ_OK=0
readonly STATE_READ_NOT_FOUND=2
readonly STATE_READ_PARSE_ERROR=3
readonly STATE_READ_VALIDATION_ERROR=4
```

## Acceptance Criteria
1. [ ] `state_write_atomic()` writes valid JSON and `state.json` contains the expected content after call
2. [ ] `state_write_atomic()` does not leave `.tmp` file after successful write
3. [ ] `state_write_atomic()` rejects invalid JSON input (returns 1, no file modified)
4. [ ] `state_write_atomic()` rejects missing/empty arguments
5. [ ] `state_write_atomic()` preserves previous `state.json` if write to `.tmp` fails
6. [ ] `state_write_atomic()` sets file permissions to `0600` on the written file
7. [ ] `state_read()` returns exit 0 and valid JSON on stdout for a valid state file
8. [ ] `state_read()` returns exit 2 when `state.json` does not exist
9. [ ] `state_read()` returns exit 3 when `state.json` contains invalid JSON (parse error)
10. [ ] `state_read()` returns exit 4 with descriptive errors for: missing required fields, wrong types, invalid enum values, temporal inconsistency (`updated_at < created_at`), unrecognized `schema_version`
11. [ ] `state_read()` logs warning to stderr if file permissions are more permissive than `0600`
12. [ ] `_validate_state_schema()` validates all PhaseHistoryEntry required fields
13. [ ] `_validate_state_schema()` validates error object required fields when error is non-null

## Test Cases
1. **Atomic write roundtrip** -- Write a valid state JSON via `state_write_atomic()`, then read the file with `cat`. Assertion: file content matches input JSON (modulo whitespace).
2. **Atomic write no residual tmp** -- Write via `state_write_atomic()`, then check for `state.json.tmp`. Assertion: tmp file does not exist.
3. **Atomic write rejects invalid JSON** -- Call `state_write_atomic(dir, "not json")`. Assertion: returns 1, no `state.json` created or modified, no `state.json.tmp` left behind.
4. **Atomic write rejects empty args** -- Call `state_write_atomic("", "")`. Assertion: returns 1.
5. **Atomic write sets permissions** -- Write via `state_write_atomic()`, check `stat` on `state.json`. Assertion: permissions are `0600`.
6. **Read valid state file** -- Create a valid `state.json` matching TDD 4.3 example, call `state_read()`. Assertion: exit 0, stdout is valid JSON matching input.
7. **Read missing file** -- Call `state_read()` on empty directory. Assertion: exit 2, stderr contains "not found".
8. **Read corrupt JSON** -- Write `{broken json` to `state.json`, call `state_read()`. Assertion: exit 3, stderr contains "parse failed".
9. **Read missing required field** -- Write state JSON missing `status` field, call `state_read()`. Assertion: exit 4, stderr contains "Missing required field: status".
10. **Read invalid status enum** -- Write state JSON with `"status": "bogus"`, call `state_read()`. Assertion: exit 4, stderr contains "Invalid status".
11. **Read invalid schema_version** -- Write state JSON with `"schema_version": 99`, call `state_read()`. Assertion: exit 4, stderr contains "Unrecognized schema_version".
12. **Read temporal inconsistency** -- Write state JSON where `updated_at` is before `created_at`, call `state_read()`. Assertion: exit 4, stderr contains "Temporal inconsistency".
13. **Read warns on permissive permissions** -- Write valid state file, `chmod 644`, call `state_read()`. Assertion: exit 0 (still succeeds), stderr contains "WARNING" about permissions.
14. **PhaseHistoryEntry missing field** -- Write state JSON with a phase history entry missing `entered_at`. Assertion: exit 4, stderr contains "phase_history[0] missing required field: entered_at".
15. **Error object missing required field** -- Write state JSON with `"error": {"message": "oops"}` (missing `code`, `phase`, `timestamp`). Assertion: exit 4, stderr references missing error fields.
