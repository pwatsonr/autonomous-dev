# SPEC-001-1-04: Signal Handlers and Configuration Loading

## Metadata
- **Parent Plan**: PLAN-001-1
- **Tasks Covered**: Task 8 (Signal handlers), Task 9 (Configuration loading)
- **Estimated effort**: 4.5 hours

## Description
Implement SIGTERM and SIGINT signal handlers that initiate graceful shutdown by setting a flag, and implement configuration loading that merges shipped defaults with optional user overrides to produce an effective runtime configuration.

## Files to Create/Modify

- **Path**: `bin/supervisor-loop.sh`
  - **Action**: Modify
  - **Description**: Add `handle_shutdown()`, `load_config()` functions and signal trap registrations.

- **Path**: `config/defaults.json`
  - **Action**: Create
  - **Description**: Default daemon configuration with all fields from TDD Section 4.5.

## Implementation Details

### Task 8: Signal Handlers

#### `handle_shutdown(signal: string) -> void`

- **Parameters**: `signal` -- the name of the received signal (e.g., "SIGTERM", "SIGINT").
- **Algorithm**:
  1. `log_info "Received ${signal}, initiating graceful shutdown..."`.
  2. Set `SHUTDOWN_REQUESTED=true`.
  3. If `CURRENT_CHILD_PID` is non-empty:
     - `log_info "Waiting for child process ${CURRENT_CHILD_PID} to finish current turn..."`.
     - Do NOT kill the child. The main loop's `wait` call will be interrupted by the signal, but the child continues. Plan 3 adds timeout escalation.
  4. Return (do not exit). The main loop detects `SHUTDOWN_REQUESTED=true` and breaks.

#### Trap Registration

Register the traps after function definition, before `main()` calls:

```bash
trap 'handle_shutdown SIGTERM' SIGTERM
trap 'handle_shutdown SIGINT' SIGINT
```

The EXIT trap for `release_lock` (from SPEC-001-1-02) must coexist with these signal traps. The flow is:
1. Signal arrives -> signal handler runs (sets flag) -> returns to interrupted code.
2. Main loop detects `SHUTDOWN_REQUESTED=true` -> breaks -> `main()` returns -> EXIT trap fires -> `release_lock()`.
3. Final log: `log_info "Daemon exiting cleanly"` (written just before `main()` returns, before the EXIT trap).

#### Signal Handler Behavior During `wait`

When the daemon is `wait`ing on a child process (Plan 2), SIGTERM delivery to the supervisor interrupts `wait`. The `wait` call returns with exit code 143 (128 + 15 for SIGTERM). The main loop must handle this:
- After `wait`, check if `SHUTDOWN_REQUESTED=true`.
- If so, do NOT treat the interrupted wait as a child crash. The child may still be running.
- Plan 3's graceful shutdown escalation handles the child process.

### Task 9: Configuration Loading

#### `load_config() -> void`

Reads defaults from `$DEFAULTS_FILE`, optionally merges with user config from `$CONFIG_FILE`, writes the effective config to a temp file, and populates shell variables.

- **Algorithm**:
  1. Validate that `$DEFAULTS_FILE` exists and is valid JSON:
     ```bash
     if [[ ! -f "${DEFAULTS_FILE}" ]]; then
         log_error "Defaults config not found: ${DEFAULTS_FILE}"
         exit 1
     fi
     if ! jq empty "${DEFAULTS_FILE}" 2>/dev/null; then
         log_error "Defaults config is invalid JSON: ${DEFAULTS_FILE}"
         exit 1
     fi
     ```
  2. If `$CONFIG_FILE` exists:
     - Validate it is valid JSON:
       ```bash
       if ! jq empty "${CONFIG_FILE}" 2>/dev/null; then
           log_error "User config is invalid JSON: ${CONFIG_FILE}"
           exit 1
       fi
       ```
     - Merge defaults with user config using `jq`'s recursive merge (`*` operator):
       ```bash
       EFFECTIVE_CONFIG=$(mktemp "${DAEMON_HOME}/effective-config.XXXXXX.json")
       jq -s '.[0] * .[1]' "${DEFAULTS_FILE}" "${CONFIG_FILE}" > "${EFFECTIVE_CONFIG}"
       ```
     - The `*` operator performs deep recursive merge: user values override defaults at the leaf level, but unspecified keys retain their defaults.
  3. If `$CONFIG_FILE` does not exist:
     - Use defaults as-is:
       ```bash
       EFFECTIVE_CONFIG=$(mktemp "${DAEMON_HOME}/effective-config.XXXXXX.json")
       cp "${DEFAULTS_FILE}" "${EFFECTIVE_CONFIG}"
       ```
     - `log_info "No user config found at ${CONFIG_FILE}. Using defaults."`
  4. Populate shell variables from effective config:
     ```bash
     POLL_INTERVAL=$(jq -r '.daemon.poll_interval_seconds // 30' "${EFFECTIVE_CONFIG}")
     CIRCUIT_BREAKER_THRESHOLD=$(jq -r '.daemon.circuit_breaker_threshold // 3' "${EFFECTIVE_CONFIG}")
     HEARTBEAT_INTERVAL=$(jq -r '.daemon.heartbeat_interval_seconds // 30' "${EFFECTIVE_CONFIG}")
     IDLE_BACKOFF_MAX=$(jq -r '.daemon.idle_backoff_max_seconds // 900' "${EFFECTIVE_CONFIG}")
     GRACEFUL_SHUTDOWN_TIMEOUT=$(jq -r '.daemon.graceful_shutdown_timeout_seconds // 300' "${EFFECTIVE_CONFIG}")
     ERROR_BACKOFF_BASE=$(jq -r '.daemon.error_backoff_base_seconds // 30' "${EFFECTIVE_CONFIG}")
     ERROR_BACKOFF_MAX=$(jq -r '.daemon.error_backoff_max_seconds // 900' "${EFFECTIVE_CONFIG}")
     MAX_RETRIES_PER_PHASE=$(jq -r '.daemon.max_retries_per_phase // 3' "${EFFECTIVE_CONFIG}")
     LOG_MAX_SIZE_MB=$(jq -r '.daemon.log_max_size_mb // 50' "${EFFECTIVE_CONFIG}")
     LOG_RETENTION_DAYS=$(jq -r '.daemon.log_retention_days // 7' "${EFFECTIVE_CONFIG}")
     DAILY_COST_CAP=$(jq -r '.daemon.daily_cost_cap_usd // 50.00' "${EFFECTIVE_CONFIG}")
     MONTHLY_COST_CAP=$(jq -r '.daemon.monthly_cost_cap_usd // 500.00' "${EFFECTIVE_CONFIG}")
     ```
  5. Update idle backoff variables:
     ```bash
     IDLE_BACKOFF_CURRENT=${POLL_INTERVAL}
     IDLE_BACKOFF_BASE=${POLL_INTERVAL}
     ```
  6. Log the effective config summary:
     ```bash
     log_info "Config loaded: poll_interval=${POLL_INTERVAL}s, circuit_breaker_threshold=${CIRCUIT_BREAKER_THRESHOLD}, heartbeat_interval=${HEARTBEAT_INTERVAL}s"
     ```
  7. Register a cleanup trap to remove the temp effective config on exit. This can be appended to the existing EXIT trap or handled in a cleanup function.

#### `config/defaults.json` Schema

```json
{
  "daemon": {
    "poll_interval_seconds": 30,
    "heartbeat_interval_seconds": 30,
    "circuit_breaker_threshold": 3,
    "idle_backoff_max_seconds": 900,
    "graceful_shutdown_timeout_seconds": 300,
    "error_backoff_base_seconds": 30,
    "error_backoff_max_seconds": 900,
    "max_retries_per_phase": 3,
    "daily_cost_cap_usd": 50.00,
    "monthly_cost_cap_usd": 500.00,
    "log_max_size_mb": 50,
    "log_retention_days": 7,
    "max_turns_by_phase": {
      "intake": 10,
      "prd": 50,
      "tdd": 50,
      "plan": 50,
      "spec": 50,
      "prd_review": 30,
      "tdd_review": 30,
      "plan_review": 30,
      "spec_review": 30,
      "code_review": 30,
      "code": 200,
      "integration": 100,
      "deploy": 30
    }
  },
  "repositories": {
    "allowlist": []
  }
}
```

All fields are documented. The `repositories.allowlist` is an array of absolute paths to Git repositories that the daemon should scan for requests.

### Edge Cases
- User config is a partial override (e.g., only sets `daemon.poll_interval_seconds`): The `jq -s '.[0] * .[1]'` merge preserves all other default fields.
- User config has extra keys not in defaults: These are preserved in the effective config (no validation of unknown keys).
- User config file exists but is empty (0 bytes): `jq empty` on an empty file fails -- treated as invalid JSON, exit 1.
- `$DEFAULTS_FILE` path resolution with symlinks: `$(cd "$(dirname "$0")/.." && pwd)` resolves symlinks. This is correct behavior.
- Signal received during `load_config` (before lock is acquired): Since `load_config` is called after `acquire_lock` in `main()`, the lock is already held. EXIT trap handles cleanup.
- mktemp creates a file that must be cleaned up. Add to EXIT trap or use a fixed path like `${DAEMON_HOME}/effective-config.json`.

## Acceptance Criteria
1. [ ] SIGTERM to the supervisor process causes a clean exit (exit 0)
2. [ ] Lock file is removed after SIGTERM-triggered exit
3. [ ] Log contains "Received SIGTERM, initiating graceful shutdown..." on SIGTERM
4. [ ] Log contains "Daemon exiting cleanly" as the last substantive log entry
5. [ ] SIGINT produces the same behavior as SIGTERM (with "SIGINT" in the message)
6. [ ] `SHUTDOWN_REQUESTED` is set to `true` by the signal handler
7. [ ] Signal handler does NOT kill `CURRENT_CHILD_PID` (just logs and sets flag)
8. [ ] `config/defaults.json` exists and is valid JSON
9. [ ] `config/defaults.json` contains all fields listed in the schema above
10. [ ] With no user config file, effective config equals defaults
11. [ ] With a user config that overrides `daemon.poll_interval_seconds` to 60, effective config has 60 for that field and defaults for all others
12. [ ] Invalid JSON in user config causes exit 1 with a clear error message
13. [ ] Missing user config file is not an error (defaults used, info logged)
14. [ ] Shell variables (`POLL_INTERVAL`, `CIRCUIT_BREAKER_THRESHOLD`, etc.) are populated from effective config
15. [ ] No shellcheck warnings at `--severity=warning` level

## Test Cases
1. **test_sigterm_clean_exit** -- Start the script in a background subshell (with `--once` disabled but a short sleep). Send SIGTERM. Assert exit code 0. Assert lock file removed. Assert log contains "Received SIGTERM".
2. **test_sigint_clean_exit** -- Same as above but with SIGINT. Assert log contains "Received SIGINT".
3. **test_shutdown_flag_set** -- Source the script functions. Call `handle_shutdown "SIGTERM"`. Assert `SHUTDOWN_REQUESTED == "true"`.
4. **test_shutdown_no_child_kill** -- Set `CURRENT_CHILD_PID` to a running background process PID. Call `handle_shutdown "SIGTERM"`. Assert the process is still running (not killed). Clean up.
5. **test_config_defaults_valid_json** -- Run `jq empty config/defaults.json`. Assert exit code 0.
6. **test_config_defaults_has_all_fields** -- Parse `config/defaults.json` with `jq`. Assert `.daemon.poll_interval_seconds`, `.daemon.circuit_breaker_threshold`, `.daemon.heartbeat_interval_seconds`, `.daemon.idle_backoff_max_seconds`, `.daemon.graceful_shutdown_timeout_seconds`, `.daemon.daily_cost_cap_usd`, `.daemon.monthly_cost_cap_usd`, `.repositories.allowlist` all exist and are non-null.
7. **test_load_config_defaults_only** -- Ensure no user config exists. Call `load_config`. Assert `POLL_INTERVAL == 30`. Assert `CIRCUIT_BREAKER_THRESHOLD == 3`.
8. **test_load_config_user_override** -- Create a user config: `{"daemon": {"poll_interval_seconds": 60}}`. Call `load_config`. Assert `POLL_INTERVAL == 60`. Assert `CIRCUIT_BREAKER_THRESHOLD == 3` (unchanged default).
9. **test_load_config_invalid_user_json** -- Write "not json" to the user config path. Call `load_config` in a subshell. Assert exit code 1. Assert log contains "invalid JSON".
10. **test_load_config_missing_defaults** -- Point `DEFAULTS_FILE` to a non-existent path. Call `load_config` in a subshell. Assert exit code 1.
11. **test_load_config_deep_merge** -- Create a user config that overrides `daemon.max_turns_by_phase.code` to 300. Call `load_config`. Read the effective config. Assert `.daemon.max_turns_by_phase.code == 300`. Assert `.daemon.max_turns_by_phase.intake == 10` (unchanged).
12. **test_idle_backoff_vars_from_config** -- Call `load_config`. Assert `IDLE_BACKOFF_CURRENT == POLL_INTERVAL`. Assert `IDLE_BACKOFF_BASE == POLL_INTERVAL`.
