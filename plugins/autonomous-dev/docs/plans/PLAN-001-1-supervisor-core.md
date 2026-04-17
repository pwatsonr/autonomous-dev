# PLAN-001-1: Supervisor Core Skeleton

## Metadata
- **Parent TDD**: TDD-001-daemon-engine
- **Estimated effort**: 3 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0

## Objective
Deliver the foundational `supervisor-loop.sh` script with all initialization-phase capabilities: argument parsing, structured logging, dependency validation, lock file management, heartbeat mechanism, signal handling, and configuration loading. This plan produces a script that can start, acquire its lock, write heartbeats, load configuration, respond to SIGTERM/SIGINT gracefully, and exit -- but does not yet select work or spawn sessions. It is the substrate on which Plans 2-4 build.

## Scope
### In Scope
- Script scaffolding with `set -euo pipefail`, constants, and directory bootstrapping
- CLI argument parsing (`--once` flag)
- Structured JSON logging (`log_info`, `log_warn`, `log_error`) writing JSONL to `daemon.log`
- Dependency validation (`bash`, `jq`, `git`, `claude`)
- Lock file acquisition/release with stale PID detection and cleanup
- Heartbeat file writing (valid JSON with timestamp, PID, iteration count, active request ID)
- Stale heartbeat detection on startup (threshold-based comparison)
- Signal handlers for SIGTERM and SIGINT that set `SHUTDOWN_REQUESTED=true`
- Configuration loading: read defaults from `config/defaults.json`, merge with user config at `~/.claude/autonomous-dev.json`, produce effective config
- `config/defaults.json` file with the daemon configuration schema defaults from TDD Section 4.5
- Main loop shell (while-true with shutdown check) that currently just writes heartbeats and sleeps -- the gate/select/spawn logic is stubbed as no-ops returning "no work"
- Directory creation for `~/.autonomous-dev/`, `~/.autonomous-dev/logs/`

### Out of Scope
- Gate checks (kill switch, circuit breaker, cost cap) -- Plan 2 for basic gates, Plan 3 for circuit breaker
- Request selection and session spawning -- Plan 2
- Crash counter, circuit breaker, error backoff -- Plan 3
- Sleep/wake recovery beyond basic stale heartbeat detection -- Plan 3
- OS supervisor integration (launchd, systemd) -- Plan 4
- CLI commands (`daemon start/stop/status`, `kill-switch`, etc.) -- Plan 4
- Cost ledger -- Plan 2
- Log rotation -- Plan 3

## Tasks

1. **Scaffold `supervisor-loop.sh`** -- Create the script file with shebang, `set -euo pipefail`, constants block, and runtime state variables as defined in TDD Section 3.1.1.
   - Files to create: `bin/supervisor-loop.sh`
   - Acceptance criteria: Script is executable, has correct shebang, all constants from TDD Section 3.1.1 are defined, script can be sourced without error.
   - Estimated effort: 1h

2. **Implement argument parsing** -- Parse `--once` flag and reject unknown arguments with a log message.
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: `--once` sets `ONCE_MODE=true`. Unknown arguments cause exit 1 with an error message to stderr. No arguments leaves `ONCE_MODE=false`.
   - Estimated effort: 0.5h

3. **Implement structured JSON logging** -- `log_json()`, `log_info()`, `log_warn()`, `log_error()` functions writing JSONL to `$LOG_FILE`. Each line includes timestamp (ISO-8601 UTC), level, PID, iteration count, and message.
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: Running the script produces valid JSONL in `daemon.log`. Each line parses with `jq`. Fields match TDD Section 4.6 schema (minus the optional `context` field, which is deferred to Plan 2).
   - Estimated effort: 1.5h

4. **Implement dependency validation** -- `validate_dependencies()` checks for `bash`, `jq`, `git`, `claude` in PATH. Logs Claude CLI version. Exits with code 1 and a clear message if any dependency is missing.
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: With all deps present, function succeeds and logs Claude version. With `jq` removed from PATH (test via PATH manipulation), script exits 1 with "Missing required commands: jq" on stderr.
   - Estimated effort: 1h

5. **Implement lock file management** -- `acquire_lock()` and `release_lock()` per TDD Section 3.1.1. Stale lock detection (PID exists in file but process is dead). EXIT trap releases lock.
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: Lock file created with correct PID on start. Second invocation detects running instance and exits 1. After killing first instance (without clean shutdown), second invocation detects stale lock, removes it, and acquires. Lock file is removed on clean exit.
   - Estimated effort: 2h

6. **Implement heartbeat writing** -- `write_heartbeat()` function using atomic tmp+mv pattern. Writes valid JSON per TDD Section 4.1 schema. Called with optional active_request_id parameter.
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: `heartbeat.json` is valid JSON after every call. Contains correct PID, current timestamp, iteration count. `active_request_id` is null when not provided, set to the argument when provided. File write is atomic (no partial writes observed under concurrent reads).
   - Estimated effort: 1.5h

7. **Implement stale heartbeat detection** -- `detect_stale_heartbeat()` and `recover_from_stale_heartbeat()` stub. On startup, reads existing heartbeat, computes staleness, logs warning if stale. Orphaned process cleanup (SIGTERM then SIGKILL). Full state recovery is a stub that logs "recovery complete" (detailed recovery logic deferred to Plan 3).
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: With a heartbeat.json older than 2x heartbeat interval, startup logs a stale heartbeat warning. With a PID in the heartbeat that matches a running process, that process receives SIGTERM. Without a heartbeat file, startup logs "Fresh start" and proceeds.
   - Estimated effort: 2h

8. **Implement signal handlers** -- SIGTERM and SIGINT traps that call `handle_shutdown()`. Sets `SHUTDOWN_REQUESTED=true`. Does NOT kill the child process (child PID tracking is a variable that Plans 2 will populate).
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: Sending SIGTERM to the supervisor process causes a clean exit (exit 0). Lock file is removed. Log contains "Received SIGTERM, initiating graceful shutdown..." and "Daemon exiting cleanly". Same behavior for SIGINT.
   - Estimated effort: 1.5h

9. **Implement configuration loading** -- `load_config()` function that reads `config/defaults.json` (shipped with the plugin), merges with `~/.claude/autonomous-dev.json` (user config, optional), and writes an effective config to a temp file. Per-key merge using `jq`'s `*` operator (user config overrides defaults at the leaf level). Populates shell variables (`POLL_INTERVAL`, `CIRCUIT_BREAKER_THRESHOLD`, `HEARTBEAT_INTERVAL`, etc.) from effective config.
   - Files to create: `config/defaults.json`
   - Files to modify: `bin/supervisor-loop.sh`
   - Acceptance criteria: With no user config, effective config equals defaults. With a user config that overrides `daemon.poll_interval_seconds` to 60, effective config has 60 for that field and defaults for all others. Invalid JSON in user config causes exit 1 with a clear error. Missing user config file is not an error.
   - Estimated effort: 3h

10. **Implement main loop shell** -- The `main()` function that calls all init functions in order, then enters the while-true loop. The loop increments `ITERATION_COUNT`, writes heartbeat, checks `SHUTDOWN_REQUESTED`, and then hits a stub that always reports "no work" (triggers idle sleep). `--once` mode breaks after one iteration.
    - Files to modify: `bin/supervisor-loop.sh`
    - Acceptance criteria: `supervisor-loop.sh --once` completes one iteration and exits 0. Without `--once`, the script loops and sleeps (can be verified by checking iteration count in heartbeat after a few seconds, then sending SIGTERM). The script creates all required directories on startup.
    - Estimated effort: 2h

11. **Write unit tests for all core components** -- Using `bats` (Bash Automated Testing System). Each function from tasks 2-10 gets at least one positive and one negative test case.
    - Files to create: `tests/test_supervisor_core.bats`, `tests/test_helpers.bash`
    - Acceptance criteria: All tests pass. Coverage includes: argument parsing (valid/invalid), logging (valid JSONL output), dependency check (mock missing dep), lock acquisition (normal, stale, contention), heartbeat (write, stale detection), signal handling (SIGTERM exit behavior), config loading (defaults only, merge, invalid JSON), main loop (--once exits after 1 iteration).
    - Estimated effort: 6h

## Dependencies & Integration Points

**Exposes to other plans:**
- `supervisor-loop.sh` with a working init phase and main loop shell. Plan 2 will add gate checks, request selection, and session spawning into the loop body.
- `config/defaults.json` with the full daemon configuration schema. Plans 2-4 will read values from this.
- Logging functions (`log_info`, `log_warn`, `log_error`) used by all subsequent plans.
- Lock file and heartbeat file contracts used by Plan 4's CLI commands.
- `SHUTDOWN_REQUESTED` flag and `CURRENT_CHILD_PID` variable used by Plan 2's session spawning.

**Consumes from other plans:**
- Nothing. This plan has zero dependencies.

## Testing Strategy

- **Unit tests (bats):** Each function is tested in isolation by sourcing the script and calling the function with controlled inputs. File system is isolated to a temp directory.
- **Manual smoke test:** Run `supervisor-loop.sh --once` and verify: lock acquired, heartbeat written, log contains init messages, lock released on exit. Run without `--once`, verify heartbeat updates, send SIGTERM, verify clean exit.
- **Concurrency test:** Start two instances simultaneously; verify only one acquires the lock and the other exits.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| macOS ships bash 3.2; script may use bash 4+ features inadvertently | Medium | High -- script fails on stock macOS | Dependency validation checks bash version and prints instructions for Homebrew bash. All code avoids associative arrays and `mapfile` until bash 4+ is confirmed. |
| `jq` merge semantics may not handle nested per-key overrides correctly | Low | Medium -- config merge produces unexpected results | Write explicit tests for nested merge behavior. Use `jq`'s `input * .` pattern which does recursive merge. |
| Heartbeat timestamp parsing differs between macOS `date` and GNU `date` | Medium | Medium -- stale detection fails on one platform | Use both `date -j` (macOS) and `date -d` (Linux) with fallback, as shown in TDD. Test on both platforms in CI. |

## Definition of Done

- [ ] `bin/supervisor-loop.sh` exists, is executable (`chmod +x`), and runs without error on macOS with bash 4+ and jq installed
- [ ] `config/defaults.json` exists with all daemon configuration fields from TDD Section 4.5
- [ ] `supervisor-loop.sh --once` completes a full init phase, one loop iteration, and exits 0
- [ ] Lock file prevents concurrent instances; stale locks are cleaned up
- [ ] Heartbeat file is valid JSON matching TDD Section 4.1 schema
- [ ] Stale heartbeat detection logs a warning when heartbeat is older than 2x interval
- [ ] SIGTERM and SIGINT produce a graceful exit (exit 0, lock released, final log entry)
- [ ] Configuration merge works: defaults only, defaults + user override, invalid user config rejected
- [ ] Structured JSON logging produces valid JSONL with all required fields
- [ ] All unit tests pass (`bats tests/test_supervisor_core.bats`)
- [ ] No shellcheck warnings at `--severity=warning` level
