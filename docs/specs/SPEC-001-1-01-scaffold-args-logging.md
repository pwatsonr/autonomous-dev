# SPEC-001-1-01: Script Scaffold, Argument Parsing, and Structured Logging

## Metadata
- **Parent Plan**: PLAN-001-1
- **Tasks Covered**: Task 1 (Scaffold supervisor-loop.sh), Task 2 (Argument parsing), Task 3 (Structured JSON logging)
- **Estimated effort**: 3 hours

## Description
Create the foundational `supervisor-loop.sh` script with its shebang, strict mode settings, constants block, and runtime state variables. Implement CLI argument parsing for the `--once` flag with unknown-argument rejection. Implement structured JSONL logging functions that write timestamped, leveled log entries to `daemon.log`.

## Files to Create/Modify

- **Path**: `bin/supervisor-loop.sh`
  - **Action**: Create
  - **Description**: The main daemon supervisor script. This spec establishes the file with its scaffold, argument parsing, and logging functions. Subsequent specs will add more functions to this file.

## Implementation Details

### Task 1: Script Scaffold

The script must begin with:
```bash
#!/usr/bin/env bash
set -euo pipefail
```

Define the following readonly constants (all paths derived from `$HOME` and the script's own location):

| Constant | Value |
|----------|-------|
| `DAEMON_HOME` | `${HOME}/.autonomous-dev` |
| `LOCK_FILE` | `${DAEMON_HOME}/daemon.lock` |
| `HEARTBEAT_FILE` | `${DAEMON_HOME}/heartbeat.json` |
| `CRASH_STATE_FILE` | `${DAEMON_HOME}/crash-state.json` |
| `KILL_SWITCH_FILE` | `${DAEMON_HOME}/kill-switch.flag` |
| `COST_LEDGER_FILE` | `${DAEMON_HOME}/cost-ledger.json` |
| `LOG_DIR` | `${DAEMON_HOME}/logs` |
| `LOG_FILE` | `${LOG_DIR}/daemon.log` |
| `CONFIG_FILE` | `${HOME}/.claude/autonomous-dev.json` |
| `DEFAULTS_FILE` | `$(cd "$(dirname "$0")/.." && pwd)/config/defaults.json` |
| `ALERTS_DIR` | `${DAEMON_HOME}/alerts` |

Define the following mutable runtime state variables:

| Variable | Initial Value | Purpose |
|----------|---------------|---------|
| `POLL_INTERVAL` | `30` | Seconds between idle polls (overridden by config) |
| `CIRCUIT_BREAKER_THRESHOLD` | `3` | Consecutive crashes before trip (overridden by config) |
| `HEARTBEAT_INTERVAL` | `30` | Seconds between heartbeat writes (overridden by config) |
| `ONCE_MODE` | `false` | Whether to run a single iteration |
| `SHUTDOWN_REQUESTED` | `false` | Set to `true` by signal handlers |
| `CURRENT_CHILD_PID` | `""` | PID of active claude child process |
| `ITERATION_COUNT` | `0` | Loop iteration counter |
| `EFFECTIVE_CONFIG` | `""` | Path to the merged effective config temp file |

`PLUGIN_DIR` should be resolved as the absolute path to the plugin root:
```bash
readonly PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
```

The script must be made executable (`chmod +x`).

### Task 2: Argument Parsing

Implement `parse_args()`:

```
parse_args(args: string[]) -> void
```

- **Parameters**: Accepts positional arguments from `$@`.
- **Behavior**:
  - `--once`: Sets `ONCE_MODE=true`, shifts.
  - Any other argument: Calls `log_error "Unknown argument: $1"` (if logging is initialized) or writes to stderr, then `exit 1`.
  - No arguments: `ONCE_MODE` remains `false`.
- **Return**: None (sets global variable).

Note: Because `parse_args` is called before logging is fully initialized (before `LOG_DIR` is created), unknown argument errors must write to stderr directly in addition to attempting log output:
```bash
echo "ERROR: Unknown argument: $1" >&2
```

### Task 3: Structured JSON Logging

Implement four functions:

#### `log_json(level: string, message: string) -> void`
- Generates an ISO-8601 UTC timestamp via `date -u +"%Y-%m-%dT%H:%M:%SZ"`.
- Writes a single JSON line to `$LOG_FILE` using `printf`.
- JSON schema per line:
  ```json
  {
    "timestamp": "2026-04-08T14:30:00Z",
    "level": "INFO",
    "pid": 12345,
    "iteration": 0,
    "message": "Daemon starting"
  }
  ```
- The `message` field must be JSON-escaped. Use `jq -R -s '.' <<< "$message"` to escape special characters (quotes, backslashes, newlines), then strip the outer quotes for embedding. Alternatively, use `jq -n --arg msg "$message" --arg lvl "$level" --argjson pid "$$" --argjson iter "$ITERATION_COUNT" --arg ts "$ts" '{timestamp:$ts,level:$lvl,pid:$pid,iteration:$iter,message:$msg}'` for safe JSON construction.
- Appends to `$LOG_FILE` (do not overwrite).
- If `$LOG_FILE` directory does not exist, the function should not fail silently -- the caller is responsible for ensuring `LOG_DIR` exists before logging begins.

#### `log_info(message: string) -> void`
- Calls `log_json "INFO" "$1"`.

#### `log_warn(message: string) -> void`
- Calls `log_json "WARN" "$1"`.

#### `log_error(message: string) -> void`
- Calls `log_json "ERROR" "$1"`.

### Edge Cases
- Messages containing double quotes, backslashes, or newlines must not break JSON validity.
- The `PID` field must be numeric (use `$$`).
- `ITERATION_COUNT` is `0` during init-phase logging (before the loop starts).
- If `date` fails (extremely unlikely), the timestamp should fall back to `"unknown"`.

## Acceptance Criteria
1. [ ] `bin/supervisor-loop.sh` exists and has `chmod +x` permissions
2. [ ] Script begins with `#!/usr/bin/env bash` and `set -euo pipefail`
3. [ ] All constants from the table above are defined as `readonly`
4. [ ] All runtime state variables are defined with their initial values
5. [ ] `PLUGIN_DIR` resolves to the correct absolute path regardless of how the script is invoked
6. [ ] `supervisor-loop.sh --once` sets `ONCE_MODE=true`
7. [ ] `supervisor-loop.sh --unknown` exits with code 1 and writes an error to stderr
8. [ ] `supervisor-loop.sh` with no arguments leaves `ONCE_MODE=false`
9. [ ] Running the script produces valid JSONL in `daemon.log` (every line parses with `jq .`)
10. [ ] Each log line contains `timestamp` (ISO-8601 UTC), `level`, `pid` (number), `iteration` (number), and `message` (string)
11. [ ] Log messages with special characters (quotes, backslashes) produce valid JSON
12. [ ] Script can be sourced without error (for unit testing individual functions)
13. [ ] No shellcheck warnings at `--severity=warning` level

## Test Cases
1. **test_scaffold_constants_defined** -- Source the script in a subshell with `ONCE_MODE` check disabled. Assert `DAEMON_HOME`, `LOCK_FILE`, `HEARTBEAT_FILE`, `LOG_FILE` are all non-empty strings. Assert `PLUGIN_DIR` ends with `autonomous-dev` or is a valid directory.
2. **test_parse_args_once_flag** -- Call `parse_args --once`. Assert `ONCE_MODE == "true"`.
3. **test_parse_args_no_args** -- Call `parse_args` with no arguments. Assert `ONCE_MODE == "false"`.
4. **test_parse_args_unknown_flag** -- Call `parse_args --bogus` in a subshell. Assert exit code is 1. Assert stderr contains "Unknown argument".
5. **test_log_info_valid_jsonl** -- Create a temp LOG_FILE. Call `log_info "test message"`. Read the file and parse with `jq`. Assert `.level == "INFO"` and `.message == "test message"`.
6. **test_log_warn_level** -- Call `log_warn "warning"`. Assert the JSONL line has `.level == "WARN"`.
7. **test_log_error_level** -- Call `log_error "failure"`. Assert the JSONL line has `.level == "ERROR"`.
8. **test_log_special_characters** -- Call `log_info 'message with "quotes" and \backslash'`. Parse the JSONL output with `jq`. Assert it parses successfully and `.message` contains the special characters.
9. **test_log_iteration_count** -- Set `ITERATION_COUNT=5`, call `log_info "iter test"`. Assert `.iteration == 5` in the output.
10. **test_log_pid_is_numeric** -- Call `log_info "pid test"`. Assert `.pid` is a number (not a string).
