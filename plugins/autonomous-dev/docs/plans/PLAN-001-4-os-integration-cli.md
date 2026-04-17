# PLAN-001-4: OS Integration and CLI Commands

## Metadata
- **Parent TDD**: TDD-001-daemon-engine
- **Estimated effort**: 3 days
- **Dependencies**: [PLAN-001-1-supervisor-core, PLAN-001-2-loop-engine, PLAN-001-3-resilience]
- **Blocked by**: [PLAN-001-3]
- **Priority**: P1

## Objective
Deliver the complete operator interface for the daemon engine: OS-level process supervision (launchd on macOS, systemd on Linux), the `install-daemon` command that templates and installs supervisor configs, and all daemon management CLI commands (`daemon start/stop/status`, `kill-switch`, `kill-switch reset`, `circuit-breaker reset`). After this plan, an operator can install the daemon as a system service, manage its lifecycle through CLI commands, monitor its health, and use kill-switch and circuit breaker controls -- completing the full TDD-001 scope.

## Scope
### In Scope
- launchd plist template with all settings from TDD Section 3.2.1 (KeepAlive.SuccessfulExit=false, ThrottleInterval=10, RunAtLoad=true, ProcessType=Background, LowPriorityBackgroundIO=true)
- systemd user unit file template with all settings from TDD Section 3.2.2 (Restart=on-failure, RestartSec=10, MemoryMax=512M, CPUQuota=50%)
- `install-daemon` command: detect OS, template the supervisor config with resolved paths (PLUGIN_BIN_DIR, DAEMON_HOME, USER_HOME), write to correct location, enable and start the service, verify installation
- `install-daemon --force` to overwrite existing config
- `daemon start` command: OS-abstracted service start (launchctl kickstart on macOS, systemctl --user start on Linux)
- `daemon stop` command: OS-abstracted service stop with graceful wait messaging
- `daemon status` command: read heartbeat.json, crash-state.json, daemon.lock, OS-level service status; combine into unified human-readable or `--json` report matching TDD Section 5.1
- `kill-switch` command: create kill-switch.flag with optional `--reason`, send SIGTERM to daemon
- `kill-switch reset` command: remove kill-switch.flag
- `circuit-breaker reset` command: write crash-state.json with `consecutive_crashes=0, circuit_breaker_tripped=false`
- File permission enforcement: `install-daemon` sets correct permissions (700 for directories, 600 for files) per TDD Section 8.1, warns if permissions are more permissive
- Config file secret detection: on startup, warn if config files contain patterns that look like API keys

### Out of Scope
- External watchdog cron job (TDD documents this as optional Phase 2)
- Notification channel configuration (webhooks, Slack) -- separate subsystem
- Multi-daemon instance management (only one daemon per user is supported)
- Uninstall command (manual removal documented in README)

## Tasks

1. **Create launchd plist template** -- Template file with placeholders for PLUGIN_BIN_DIR, DAEMON_HOME, USER_HOME. All launchd settings per TDD Section 3.2.1.
   - Files to create: `templates/com.autonomous-dev.daemon.plist.template`
   - Acceptance criteria: Template is valid XML when placeholders are replaced with real paths. All settings from TDD Section 3.2.1 are present: Label, ProgramArguments (bash + supervisor-loop.sh), RunAtLoad=true, KeepAlive.SuccessfulExit=false, ThrottleInterval=10, StandardOutPath, StandardErrorPath, EnvironmentVariables (PATH, HOME), ProcessType=Background, LowPriorityBackgroundIO=true.
   - Estimated effort: 1.5h

2. **Create systemd unit file template** -- Template file with placeholders for PLUGIN_BIN_DIR, USER_HOME. All systemd settings per TDD Section 3.2.2.
   - Files to create: `templates/autonomous-dev.service.template`
   - Acceptance criteria: Template is a valid systemd unit file when placeholders are replaced. All settings from TDD Section 3.2.2 are present: Type=simple, ExecStart, Restart=on-failure, RestartSec=10, Environment (PATH, HOME), MemoryMax=512M, CPUQuota=50%, StandardOutput=journal, StandardError=journal, SyslogIdentifier=autonomous-dev, WantedBy=default.target.
   - Estimated effort: 1h

3. **Implement `install-daemon` command** -- Shell script (or function within a CLI dispatcher) that: (a) detects OS (macOS vs Linux), (b) resolves PLUGIN_BIN_DIR (from script location), DAEMON_HOME, USER_HOME, (c) templates the appropriate config file with `sed` substitution, (d) writes to the correct location (`~/Library/LaunchAgents/` on macOS, `~/.config/systemd/user/` on Linux), (e) checks for existing config and prompts unless `--force`, (f) enables and starts the service, (g) verifies with `launchctl print` or `systemctl --user status`, (h) sets file permissions per TDD Section 8.1.
   - Files to create: `bin/install-daemon.sh`
   - Acceptance criteria: On macOS, running `install-daemon.sh` creates the plist in `~/Library/LaunchAgents/`, bootstraps it with launchctl, and verifies. On Linux, creates the unit file, runs `daemon-reload`, enables and starts the service. `--force` overwrites without prompting. Without `--force` and with existing config, exits with code 2 and a message. Permissions on `~/.autonomous-dev/` are set to 700, files to 600.
   - Estimated effort: 4h

4. **Implement CLI dispatcher** -- A single entry point script `bin/autonomous-dev.sh` that routes subcommands: `daemon start`, `daemon stop`, `daemon status`, `kill-switch`, `kill-switch reset`, `circuit-breaker reset`, `install-daemon`. Each subcommand dispatches to a function or script.
   - Files to create: `bin/autonomous-dev.sh`
   - Acceptance criteria: `autonomous-dev daemon start` calls the start function. Unknown commands print usage and exit 1. `--help` prints available commands. The dispatcher resolves paths relative to its own location (portable).
   - Estimated effort: 2h

5. **Implement `daemon start` command** -- OS-abstracted service start. macOS: `launchctl kickstart -k gui/$(id -u)/com.autonomous-dev.daemon`. Linux: `systemctl --user start autonomous-dev.service`. Verifies service is running after start.
   - Files to modify: `bin/autonomous-dev.sh`
   - Acceptance criteria: On macOS, issues the correct launchctl command. On Linux, issues the correct systemctl command. Exit 0 if daemon starts (or is already running). Exit 1 if start fails, with error message.
   - Estimated effort: 1.5h

6. **Implement `daemon stop` command** -- OS-abstracted service stop. macOS: `launchctl kill SIGTERM gui/$(id -u)/com.autonomous-dev.daemon`. Linux: `systemctl --user stop autonomous-dev.service`. Prints "Waiting for active session to complete..." if daemon has an active request (reads heartbeat.json). Waits for daemon to exit (polls daemon.lock removal or PID absence).
   - Files to modify: `bin/autonomous-dev.sh`
   - Acceptance criteria: Stop sends the correct OS signal. If heartbeat shows an active request, prints wait message. Waits up to `graceful_shutdown_timeout_seconds` for exit. Exit 0 on successful stop. Exit 1 if stop fails after timeout.
   - Estimated effort: 2h

7. **Implement `daemon status` command** -- Reads heartbeat.json, crash-state.json, daemon.lock, cost-ledger.json. Checks OS-level service status. Computes derived fields (uptime, heartbeat age). Outputs human-readable report by default, or JSON with `--json` flag. Schema matches TDD Section 5.1.
   - Files to modify: `bin/autonomous-dev.sh`
   - Acceptance criteria: With daemon running, reports: status=running, PID, uptime, iteration count, crash count, circuit breaker state, active request (if any), heartbeat age, cost today, cost this month. With daemon stopped, reports: status=stopped. `--json` output is valid JSON matching TDD Section 5.1 schema. Exit 0 if daemon running, exit 1 if not running, exit 2 if status cannot be determined.
   - Estimated effort: 3h

8. **Implement `kill-switch` command** -- Creates `kill-switch.flag` with optional `--reason` text. Reads PID from daemon.lock and sends SIGTERM. Prints confirmation.
   - Files to modify: `bin/autonomous-dev.sh`
   - Acceptance criteria: `kill-switch --reason "cost spike"` creates the flag file with the reason text. SIGTERM is sent to the daemon PID. Exit 0 on success. Without daemon running, still creates the flag file (daemon will see it on next start).
   - Estimated effort: 1h

9. **Implement `kill-switch reset` command** -- Removes `kill-switch.flag`. Prints confirmation. Exit 1 if file was not present.
   - Files to modify: `bin/autonomous-dev.sh`
   - Acceptance criteria: With flag present, removes it and exits 0 with "Kill switch cleared". Without flag, exits 1 with "Kill switch was not engaged".
   - Estimated effort: 0.5h

10. **Implement `circuit-breaker reset` command** -- Writes `crash-state.json` with `consecutive_crashes=0` and `circuit_breaker_tripped=false`. Preserves other fields. Prints confirmation. Exit 1 if circuit breaker was not tripped.
    - Files to modify: `bin/autonomous-dev.sh`
    - Acceptance criteria: With circuit breaker tripped, resets and exits 0 with confirmation message. crash-state.json shows `consecutive_crashes: 0` and `circuit_breaker_tripped: false`. Without tripped breaker, exits 1 with "Circuit breaker was not tripped".
    - Estimated effort: 1h

11. **Implement file permission enforcement** -- During `install-daemon` and on supervisor startup, check and set permissions: `~/.autonomous-dev/` = 700, all `.json` and `.flag` files = 600, `logs/` = 700. Warn if any file has more permissive modes. Also check config file for patterns that look like API keys (regex match for common key prefixes like `sk-`, `AKIA`, `ghp_`) and warn.
    - Files to modify: `bin/install-daemon.sh`, `bin/supervisor-loop.sh`
    - Acceptance criteria: After install-daemon, all files and directories have correct permissions (verified with `stat`). If a file has 644 permissions, a warning is logged. If config contains a string matching an API key pattern, a warning is logged on startup.
    - Estimated effort: 2h

12. **Write unit and integration tests** -- Tests for all CLI commands, OS integration logic, and permission enforcement.
    - Files to create: `tests/test_cli_commands.bats`, `tests/test_os_integration.bats`
    - Files to modify: `tests/test_helpers.bash`
    - Acceptance criteria: Tests cover: plist template rendering (valid XML with resolved paths), systemd template rendering (valid unit file), install-daemon (fresh install, existing config without force, force overwrite), daemon start/stop/status on both macOS and Linux (using mocked launchctl/systemctl), kill-switch engage/reset, circuit-breaker reset (tripped/not tripped), status output format (human-readable and JSON), permission checking and enforcement, secret detection warning.
    - Estimated effort: 6h

13. **End-to-end acceptance tests** -- Full lifecycle tests matching TDD Section 9.4 acceptance criteria: (a) submit request, daemon processes through intake with stub, (b) kill -9 child, verify recovery, (c) cost tracked in ledger, (d) daemon status accurate, (e) daemon survives SIGTERM and is restarted by OS supervisor.
    - Files to create: `tests/test_e2e.bats`
    - Acceptance criteria: All five TDD Section 9.4 acceptance criteria pass. Tests use mock-claude for Claude session simulation. Tests verify end-to-end flow from request submission through processing, failure recovery, and status reporting.
    - Estimated effort: 4h

## Dependencies & Integration Points

**Consumes from Plan 1:**
- `supervisor-loop.sh` with working init phase, logging, lock, heartbeat, config
- Lock file and heartbeat file schemas for status command to read

**Consumes from Plan 2:**
- Cost ledger for status command reporting
- Request selection for status command active request display
- Kill switch file contract for kill-switch commands

**Consumes from Plan 3:**
- `crash-state.json` contract for status and circuit-breaker reset commands
- Alert mechanism for permission violation warnings
- Graceful shutdown timeout for stop command wait behavior

**Exposes:**
- Complete operator interface: CLI commands for all daemon management operations
- OS supervisor configs that auto-start the daemon on boot/login and restart on crash
- The `autonomous-dev` CLI entry point used by operators and potentially by the Claude Code plugin's skill/command layer

## Testing Strategy

- **Unit tests (bats):** Each CLI command tested in isolation. OS-specific commands mocked (create mock `launchctl`/`systemctl` scripts in PATH that record invocations). Template rendering tested by substituting known values and validating output format.
- **Integration tests (bats):** Full daemon lifecycle: install -> start -> verify running -> stop -> verify stopped. Kill-switch and circuit-breaker commands tested against a running (mocked) daemon. Status command tested with various states (running, stopped, circuit breaker tripped).
- **E2E tests (bats + mock-claude):** Complete request lifecycle with mock Claude sessions, covering all TDD Section 9.4 acceptance criteria.
- **Platform testing:** macOS tests run on macOS CI runner. Linux tests run on Linux CI runner. Each platform tests its specific OS integration (launchd vs systemd).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| launchd behavior differs between macOS versions (Ventura, Sonoma, Sequoia) | Medium | High -- install or start/stop fails on some macOS versions | Test on the oldest supported macOS version. Use `launchctl bootstrap`/`bootout` which are the modern API (not the deprecated `load`/`unload`). Document minimum macOS version. |
| systemd user services may not be enabled by default on all Linux distros | Medium | Medium -- install-daemon fails on some distros | Check for `loginctl enable-linger $USER` during install and enable it if missing. Log a warning if user linger is not available. |
| `launchctl kickstart -k` behavior (kill and restart) may disrupt an active session | Low | Medium -- session killed unnecessarily | `daemon start` should check if already running first and skip kickstart. Only use `-k` (kill) flag when operator explicitly wants a restart. |
| PATH in plist/unit file may not include the user's custom paths (e.g., Homebrew on Apple Silicon at /opt/homebrew/bin) | High | High -- supervisor-loop.sh cannot find `claude`, `jq`, or bash 4+ | Template includes `/opt/homebrew/bin` in PATH. install-daemon also detects the actual paths of `claude`, `jq`, and `bash` at install time and adds their directories to the PATH in the supervisor config. |
| Stop command may hang if daemon takes longer than expected to shut down | Low | Medium -- operator frustrated, may force kill | Stop command has its own timeout (separate from daemon's internal grace period). After timeout, prints instructions for force-kill. |

## Definition of Done

- [ ] launchd plist template is valid and contains all TDD Section 3.2.1 settings
- [ ] systemd unit file template is valid and contains all TDD Section 3.2.2 settings
- [ ] `install-daemon` works on macOS (creates plist, bootstraps, verifies) and Linux (creates unit file, enables, starts, verifies)
- [ ] `install-daemon --force` overwrites existing config; without `--force`, exits 2 if already installed
- [ ] `daemon start` starts the service on the correct OS
- [ ] `daemon stop` sends SIGTERM and waits for clean exit, with active-session messaging
- [ ] `daemon status` reports all fields from TDD Section 5.1 in both human-readable and JSON formats
- [ ] `daemon status` exit codes: 0=running, 1=not running, 2=undetermined
- [ ] `kill-switch` creates flag file and sends SIGTERM to daemon
- [ ] `kill-switch reset` removes flag file
- [ ] `circuit-breaker reset` resets crash-state.json
- [ ] File permissions are enforced per TDD Section 8.1 (700 dirs, 600 files)
- [ ] Config files are scanned for API key patterns with warnings
- [ ] All CLI commands print clear, actionable error messages on failure
- [ ] All TDD Section 9.4 acceptance criteria pass in E2E tests
- [ ] All unit and integration tests pass
- [ ] No shellcheck warnings at `--severity=warning` level
