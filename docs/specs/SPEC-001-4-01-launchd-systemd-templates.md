# SPEC-001-4-01: launchd and systemd Templates

## Metadata
- **Parent Plan**: PLAN-001-4
- **Tasks Covered**: Task 1 (launchd plist template), Task 2 (systemd unit file template)
- **Estimated effort**: 2.5 hours

## Description
Create the OS supervisor configuration templates for macOS (launchd plist) and Linux (systemd user unit file). These templates contain placeholders that the `install-daemon` command substitutes with resolved paths at install time.

## Files to Create/Modify

- **Path**: `templates/com.autonomous-dev.daemon.plist.template`
  - **Action**: Create
  - **Description**: launchd plist XML template for macOS with all TDD Section 3.2.1 settings.

- **Path**: `templates/autonomous-dev.service.template`
  - **Action**: Create
  - **Description**: systemd user unit file template for Linux with all TDD Section 3.2.2 settings.

## Implementation Details

### Task 1: launchd Plist Template

#### File: `templates/com.autonomous-dev.daemon.plist.template`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.autonomous-dev.daemon</string>

    <key>ProgramArguments</key>
    <array>
        <string>{{BASH_PATH}}</string>
        <string>{{PLUGIN_BIN_DIR}}/supervisor-loop.sh</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>{{DAEMON_HOME}}/logs/launchd-stdout.log</string>

    <key>StandardErrorPath</key>
    <string>{{DAEMON_HOME}}/logs/launchd-stderr.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{{EXTRA_PATH_DIRS}}/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>HOME</key>
        <string>{{USER_HOME}}</string>
    </dict>

    <key>ProcessType</key>
    <string>Background</string>

    <key>LowPriorityBackgroundIO</key>
    <true/>
</dict>
</plist>
```

#### Placeholder Definitions

| Placeholder | Description | Example Value |
|-------------|-------------|---------------|
| `{{BASH_PATH}}` | Absolute path to bash 4+ binary | `/opt/homebrew/bin/bash` or `/usr/local/bin/bash` |
| `{{PLUGIN_BIN_DIR}}` | Absolute path to the plugin's `bin/` directory | `/Users/pwatson/.claude/plugins/autonomous-dev/bin` |
| `{{DAEMON_HOME}}` | Absolute path to `~/.autonomous-dev` | `/Users/pwatson/.autonomous-dev` |
| `{{USER_HOME}}` | User's home directory | `/Users/pwatson` |
| `{{EXTRA_PATH_DIRS}}` | Additional PATH entries for dependencies (with trailing colon if non-empty) | `/opt/homebrew/bin:` or `` |

#### Key Settings and Rationale

| Setting | Value | Rationale |
|---------|-------|-----------|
| `Label` | `com.autonomous-dev.daemon` | Standard reverse-DNS naming for launchd |
| `ProgramArguments` | `[bash, supervisor-loop.sh]` | Explicit bash path avoids `/bin/bash` (macOS stock bash 3.2) |
| `RunAtLoad` | `true` | Auto-start on login/boot |
| `KeepAlive.SuccessfulExit` | `false` | Only restart on non-zero exit. Clean exit (SIGTERM) = no restart |
| `ThrottleInterval` | `10` | Minimum 10s between restarts, prevents restart storms |
| `ProcessType` | `Background` | Low CPU scheduling priority |
| `LowPriorityBackgroundIO` | `true` | Deprioritize disk I/O |
| `StandardOutPath` | `logs/launchd-stdout.log` | Captures stdout from launchd's perspective |
| `StandardErrorPath` | `logs/launchd-stderr.log` | Captures stderr |

### Task 2: systemd Unit File Template

#### File: `templates/autonomous-dev.service.template`

```ini
[Unit]
Description=autonomous-dev Daemon Engine
After=network.target

[Service]
Type=simple
ExecStart={{BASH_PATH}} {{PLUGIN_BIN_DIR}}/supervisor-loop.sh
Restart=on-failure
RestartSec=10
Environment=PATH={{EXTRA_PATH_DIRS}}/usr/local/bin:/usr/bin:/bin
Environment=HOME={{USER_HOME}}

# Resource limits
MemoryMax=512M
CPUQuota=50%

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=autonomous-dev

[Install]
WantedBy=default.target
```

#### Placeholder Definitions

| Placeholder | Description | Example Value |
|-------------|-------------|---------------|
| `{{BASH_PATH}}` | Absolute path to bash 4+ binary | `/usr/bin/bash` |
| `{{PLUGIN_BIN_DIR}}` | Absolute path to the plugin's `bin/` directory | `/home/user/.claude/plugins/autonomous-dev/bin` |
| `{{USER_HOME}}` | User's home directory | `/home/user` |
| `{{EXTRA_PATH_DIRS}}` | Additional PATH entries (with trailing colon if non-empty) | `` |

#### Key Settings and Rationale

| Setting | Value | Rationale |
|---------|-------|-----------|
| `Type` | `simple` | The script runs as the main process |
| `Restart` | `on-failure` | Only restart on non-zero exit, not on clean stop |
| `RestartSec` | `10` | 10s delay between restarts |
| `MemoryMax` | `512M` | Prevent runaway memory usage |
| `CPUQuota` | `50%` | Limit CPU usage to not interfere with interactive use |
| `StandardOutput/Error` | `journal` | Log to systemd journal (viewable via `journalctl`) |
| `SyslogIdentifier` | `autonomous-dev` | Filter journal: `journalctl --user -u autonomous-dev` |
| `WantedBy` | `default.target` | Start with user's default session |

### Validation Notes

- The plist template must be valid XML when all placeholders are replaced with real paths. Test by performing substitution and validating with `plutil -lint`.
- The systemd template must be valid when placeholders are replaced. Test by substitution and `systemd-analyze verify` (on Linux).
- Placeholders use `{{...}}` syntax (double curly braces) to avoid conflict with XML entities and shell variables.

### Edge Cases
- `{{EXTRA_PATH_DIRS}}` may be empty (if all dependencies are in standard paths). The template handles this by having the standard paths after the placeholder. An empty placeholder produces a leading colon in PATH (e.g., `:/usr/local/bin:...`). This is benign on both macOS and Linux (an empty path entry is treated as `.`).
- To avoid the leading colon, `install-daemon` should only include `{{EXTRA_PATH_DIRS}}` if non-empty, or the substitution logic should strip a leading colon.
- Paths containing spaces: XML and INI formats handle spaces in values natively (XML uses string elements, INI uses everything after `=`). No quoting needed in templates.

## Acceptance Criteria
1. [ ] `templates/com.autonomous-dev.daemon.plist.template` exists and contains valid XML structure
2. [ ] Plist template contains: Label, ProgramArguments, RunAtLoad=true, KeepAlive.SuccessfulExit=false, ThrottleInterval=10, StandardOutPath, StandardErrorPath, EnvironmentVariables (PATH, HOME), ProcessType=Background, LowPriorityBackgroundIO=true
3. [ ] All placeholders use `{{...}}` syntax
4. [ ] Plist is valid XML when placeholders are replaced with real paths (validated by `plutil -lint` on macOS)
5. [ ] `templates/autonomous-dev.service.template` exists and contains valid systemd unit file structure
6. [ ] Unit file contains: Type=simple, ExecStart, Restart=on-failure, RestartSec=10, Environment (PATH, HOME), MemoryMax=512M, CPUQuota=50%, StandardOutput=journal, StandardError=journal, SyslogIdentifier=autonomous-dev, WantedBy=default.target
7. [ ] Unit file has [Unit], [Service], and [Install] sections
8. [ ] No shellcheck warnings in the template files (they are not shell scripts, but should be lint-clean for their respective formats)

## Test Cases
1. **test_plist_template_exists** -- Assert `templates/com.autonomous-dev.daemon.plist.template` exists.
2. **test_plist_template_valid_xml** -- Replace all `{{...}}` placeholders with sample values (e.g., `/usr/bin/bash`, `/tmp/plugin/bin`, `/tmp/home`). Run `plutil -lint` on the result. Assert valid.
3. **test_plist_has_label** -- Grep the template. Assert it contains `<string>com.autonomous-dev.daemon</string>`.
4. **test_plist_has_run_at_load** -- Assert template contains `<key>RunAtLoad</key>` followed by `<true/>`.
5. **test_plist_has_keep_alive** -- Assert template contains `SuccessfulExit` key with `<false/>`.
6. **test_plist_has_throttle** -- Assert template contains `ThrottleInterval` with `<integer>10</integer>`.
7. **test_plist_has_process_type** -- Assert template contains `ProcessType` with `Background`.
8. **test_plist_has_low_priority_io** -- Assert template contains `LowPriorityBackgroundIO` with `<true/>`.
9. **test_systemd_template_exists** -- Assert `templates/autonomous-dev.service.template` exists.
10. **test_systemd_has_type_simple** -- Assert template contains `Type=simple`.
11. **test_systemd_has_restart_on_failure** -- Assert template contains `Restart=on-failure`.
12. **test_systemd_has_restart_sec** -- Assert template contains `RestartSec=10`.
13. **test_systemd_has_memory_max** -- Assert template contains `MemoryMax=512M`.
14. **test_systemd_has_cpu_quota** -- Assert template contains `CPUQuota=50%`.
15. **test_systemd_has_journal** -- Assert template contains `StandardOutput=journal`.
16. **test_systemd_has_wanted_by** -- Assert template contains `WantedBy=default.target`.
17. **test_systemd_has_all_sections** -- Assert template contains `[Unit]`, `[Service]`, and `[Install]`.
