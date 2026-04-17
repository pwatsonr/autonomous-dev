# SPEC-001-1-02: Dependency Validation and Lock File Management

## Metadata
- **Parent Plan**: PLAN-001-1
- **Tasks Covered**: Task 4 (Dependency validation), Task 5 (Lock file management)
- **Estimated effort**: 3 hours

## Description
Implement dependency validation that checks for required commands (`bash`, `jq`, `git`, `claude`) and logs the Claude CLI version. Implement lock file acquisition and release with stale PID detection, ensuring only one daemon instance runs at a time.

## Files to Create/Modify

- **Path**: `bin/supervisor-loop.sh`
  - **Action**: Modify
  - **Description**: Add `validate_dependencies()`, `acquire_lock()`, and `release_lock()` functions.

## Implementation Details

### Task 4: Dependency Validation

#### `validate_dependencies() -> void`

- **Required commands**: `bash`, `jq`, `git`, `claude`
- **Algorithm**:
  1. Initialize an empty array: `local missing=()`.
  2. For each command in the list, run `command -v "${cmd}" >/dev/null 2>&1`. If it fails, append to `missing`.
  3. If `missing` is non-empty:
     - Write to stderr: `"FATAL: Missing required commands: ${missing[*]}"`.
     - Call `log_error` with the same message (if log infrastructure is available).
     - `exit 1`.
  4. If all present, capture Claude CLI version:
     ```bash
     local claude_version
     claude_version=$(claude --version 2>/dev/null || echo "unknown")
     log_info "Claude CLI version: ${claude_version}"
     ```
  5. Optionally check bash version. If `${BASH_VERSINFO[0]}` < 4, log a warning:
     ```
     "WARNING: bash ${BASH_VERSION} detected. bash 4+ is recommended. Install via Homebrew: brew install bash"
     ```
     Do NOT exit on bash 3.x -- the script should try to run but warn.

- **Error handling**: If `claude --version` hangs or takes too long, the `2>/dev/null` and `|| echo "unknown"` fallback handles it. No explicit timeout is required for this check.

### Task 5: Lock File Management

#### `acquire_lock() -> void`

- **Lock file path**: `$LOCK_FILE` (`~/.autonomous-dev/daemon.lock`)
- **Algorithm**:
  1. Check if `$LOCK_FILE` exists.
  2. If it exists:
     a. Read the PID from the file: `local existing_pid; existing_pid=$(cat "${LOCK_FILE}" 2>/dev/null || echo "")`.
     b. If PID is non-empty and the process is running (`kill -0 "${existing_pid}" 2>/dev/null` succeeds):
        - `log_error "Another instance is running (PID ${existing_pid}). Exiting."`
        - `exit 1`
     c. If PID is empty or process is not running (stale lock):
        - `log_warn "Stale lock file found (PID ${existing_pid} not running). Removing."`
        - `rm -f "${LOCK_FILE}"`
  3. Write the current PID to the lock file: `echo "$$" > "${LOCK_FILE}"`.
  4. `log_info "Lock acquired (PID $$)"`.

- **Race condition note**: There is a TOCTOU window between checking the lock and writing it. This is acceptable because:
  - launchd/systemd only spawns one instance at a time.
  - The window is extremely small.
  - A more robust approach (e.g., `flock`) is not portable to macOS without additional dependencies.

#### `release_lock() -> void`

- **Algorithm**:
  1. `rm -f "${LOCK_FILE}"`
  2. `log_info "Lock released"`

- **EXIT trap**: Register an EXIT trap that calls `release_lock`:
  ```bash
  trap 'release_lock' EXIT
  ```
  This must be registered immediately after `acquire_lock()` succeeds (or at the top of `main()` after lock acquisition). The EXIT trap ensures the lock is released on:
  - Normal exit (exit 0)
  - Error exit (set -e triggered)
  - Signal-caused exit (after signal handler runs)

- **Important**: The EXIT trap must not conflict with signal handlers. Signal handlers set `SHUTDOWN_REQUESTED=true` and return; the main loop then breaks and exits normally, triggering the EXIT trap.

### Edge Cases
- Lock file exists but is empty (no PID inside): Treat as stale, remove it.
- Lock file exists with a PID that belongs to a different user's process: `kill -0` will fail with permission denied, which is caught by `2>/dev/null`. Treat as stale (conservative but safe -- the other user's daemon would have its own `$HOME`).
- Lock file directory does not exist: The caller (`main()`) must `mkdir -p "${DAEMON_HOME}"` before calling `acquire_lock()`.
- `validate_dependencies` is called before `acquire_lock` -- if a dependency is missing, no lock file is left behind.

## Acceptance Criteria
1. [ ] `validate_dependencies()` succeeds when `bash`, `jq`, `git`, and `claude` are all in PATH
2. [ ] `validate_dependencies()` exits with code 1 when any dependency is missing, with a message listing the missing commands on stderr
3. [ ] Claude CLI version is logged on successful validation
4. [ ] Bash version < 4 produces a warning but does not exit
5. [ ] `acquire_lock()` creates `daemon.lock` containing the current PID
6. [ ] Second invocation detects the running instance and exits with code 1
7. [ ] After killing the first instance (without clean shutdown), second invocation detects stale lock, removes it, and acquires successfully
8. [ ] Lock file with empty content is treated as stale and removed
9. [ ] `release_lock()` removes the lock file
10. [ ] EXIT trap releases the lock on both normal and abnormal exits
11. [ ] No shellcheck warnings at `--severity=warning` level

## Test Cases
1. **test_validate_deps_all_present** -- With all four commands in PATH, call `validate_dependencies()`. Assert exit code 0. Assert log contains "Claude CLI version".
2. **test_validate_deps_missing_jq** -- Create a temp PATH that excludes `jq`. Call `validate_dependencies()` in a subshell. Assert exit code 1. Assert stderr contains "Missing required commands: jq".
3. **test_validate_deps_missing_multiple** -- Remove both `jq` and `git` from PATH. Assert stderr contains both "jq" and "git".
4. **test_validate_deps_claude_version_unknown** -- Replace `claude` in PATH with a script that exits 1. Assert log contains "Claude CLI version: unknown".
5. **test_acquire_lock_fresh** -- Ensure no lock file exists. Call `acquire_lock()`. Assert `daemon.lock` exists and contains `$$`.
6. **test_acquire_lock_stale** -- Write a fake PID (99999999) to the lock file (a PID that is not running). Call `acquire_lock()`. Assert the old lock is removed, new lock has current PID. Assert log contains "Stale lock file".
7. **test_acquire_lock_contention** -- Start a background sleep process, write its PID to the lock file. Call `acquire_lock()` in a subshell. Assert exit code 1. Assert log contains "Another instance is running". Kill the background process afterward.
8. **test_acquire_lock_empty_file** -- Create an empty lock file. Call `acquire_lock()`. Assert success (treated as stale).
9. **test_release_lock** -- Create a lock file. Call `release_lock()`. Assert the lock file no longer exists.
10. **test_exit_trap_releases_lock** -- Run the script in a subshell that acquires the lock then exits. Assert lock file is gone after the subshell exits.
