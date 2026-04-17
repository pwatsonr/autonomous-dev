# SPEC-002-2-03: ID Validation, Path Traversal Prevention, and Input Sanitization

## Metadata
- **Parent Plan**: PLAN-002-2
- **Tasks Covered**: Task 7 (ID format validation and path traversal prevention), Task 8 (Input sanitization)
- **Estimated effort**: 2 hours

## Description
Implement two defensive security functions: (1) request ID format validation that prevents path traversal attacks by ensuring IDs conform to the strict `REQ-YYYYMMDD-XXXX` pattern before use in filesystem paths, and (2) input sanitization that safely encodes user-provided strings (title, description, tags) through `jq` to prevent shell injection and enforce length limits. These are small but critical functions that guard the boundary between user input and filesystem operations.

## Files to Create/Modify
- **Path**: `lib/state/request_tracker.sh`
- **Action**: Modify (append to file created in SPEC-002-2-02)
- **Description**: Add `validate_request_id()` and `sanitize_input()` functions. Ensure all path-constructing functions in the module call `validate_request_id()` before proceeding.

## Implementation Details

### `validate_request_id(request_id)`

```bash
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
  local request_id="$1"

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
```

### `sanitize_input(input_string, max_length)`

```bash
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
```

### Path-constructing functions that must call `validate_request_id()`

The following functions in `request_tracker.sh` (and other modules) must call `validate_request_id()` before constructing any filesystem path from a request ID:

1. `create_request_directory()` -- validates `request_id` argument before creating `${base_dir}/${request_id}/`
2. `discover_requests()` -- does NOT need explicit validation because it reads existing directories via glob (no user-controlled path construction)
3. Any future function that accepts a request ID and builds a path from it

In `state_file_manager.sh`:
- `state_read()` and `state_write_atomic()` accept a directory path, not a request ID, so validation happens at the caller level (request_tracker).

### Integration point

Add validation call at the top of `create_request_directory()` (already shown in SPEC-002-2-02):

```bash
  # Validate request ID (defense against path traversal)
  if ! validate_request_id "$request_id"; then
    return 1
  fi
```

## Acceptance Criteria
1. [ ] `validate_request_id()` accepts valid IDs like `REQ-20260408-a3f1`
2. [ ] `validate_request_id()` rejects IDs containing `..` with explicit "path traversal" error
3. [ ] `validate_request_id()` rejects IDs containing `/` with explicit "path separator" error
4. [ ] `validate_request_id()` rejects IDs containing spaces
5. [ ] `validate_request_id()` rejects IDs not matching `^REQ-[0-9]{8}-[0-9a-f]{4}$`
6. [ ] `validate_request_id()` rejects empty strings
7. [ ] `validate_request_id()` rejects uppercase hex (e.g., `REQ-20260408-A3F1`)
8. [ ] `sanitize_input()` safely encodes shell metacharacters (`$`, backtick, `!`, `&&`, `|`, `;`)
9. [ ] `sanitize_input()` safely encodes JSON-special characters (quotes, backslashes, control chars)
10. [ ] `sanitize_input()` truncates strings exceeding `max_length` with warning on stderr
11. [ ] `sanitize_input()` output is safe for use with `jq --arg`
12. [ ] All path-constructing functions call `validate_request_id()` before building filesystem paths

## Test Cases
1. **Valid ID accepted** -- `validate_request_id "REQ-20260408-a3f1"`. Assertion: returns 0.
2. **Path traversal rejected** -- `validate_request_id "REQ-20260408-../../etc"`. Assertion: returns 1, stderr contains "path traversal".
3. **Slash rejected** -- `validate_request_id "REQ-20260408/a3f1"`. Assertion: returns 1, stderr contains "path separator".
4. **Space rejected** -- `validate_request_id "REQ 20260408 a3f1"`. Assertion: returns 1.
5. **Wrong format rejected** -- `validate_request_id "INVALID-ID"`. Assertion: returns 1, stderr contains "invalid format".
6. **Empty string rejected** -- `validate_request_id ""`. Assertion: returns 1.
7. **Uppercase hex rejected** -- `validate_request_id "REQ-20260408-A3F1"`. Assertion: returns 1 (regex requires lowercase).
8. **Too short hex rejected** -- `validate_request_id "REQ-20260408-a3f"`. Assertion: returns 1.
9. **Too long hex rejected** -- `validate_request_id "REQ-20260408-a3f1a"`. Assertion: returns 1.
10. **Sanitize shell metacharacters** -- `sanitize_input '$(rm -rf /)'`. Assertion: output does not execute command, contains the literal text safely encoded.
11. **Sanitize quotes and backslashes** -- `sanitize_input 'He said "hello" and C:\path'`. Assertion: output has escaped quotes and backslashes.
12. **Sanitize truncation** -- `sanitize_input "$(printf 'x%.0s' {1..300})" 200`. Assertion: output is 200 chars, stderr contains "WARNING" about truncation.
13. **Sanitize within limit** -- `sanitize_input "short string" 200`. Assertion: output is "short string", no warning.
14. **Sanitize control characters** -- `sanitize_input "$(printf 'hello\x00world')" 100`. Assertion: null byte is safely handled.
15. **Path construction uses validation** -- Call `create_request_directory` with ID `"../../../etc"`. Assertion: returns 1, no directory created.
