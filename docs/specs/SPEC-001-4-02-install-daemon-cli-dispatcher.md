# SPEC-001-4-02: Install Daemon Command and CLI Dispatcher

## Metadata
- **Parent Plan**: PLAN-001-4
- **Tasks Covered**: Task 3 (Install daemon command), Task 4 (CLI dispatcher)
- **Estimated effort**: 6 hours

## Description
Implement the `install-daemon` command that detects the OS, resolves paths, templates the appropriate supervisor configuration, installs it, and starts the service. Implement the CLI dispatcher script that routes all subcommands through a single entry point.

## Files to Create/Modify

- **Path**: `bin/install-daemon.sh`
  - **Action**: Create
  - **Description**: Standalone script for daemon installation. Handles OS detection, template rendering, file installation, service enablement, and permission enforcement.

- **Path**: `bin/autonomous-dev.sh`
  - **Action**: Create
  - **Description**: CLI dispatcher that routes subcommands to their implementations.

## Implementation Details

### Task 3: Install Daemon Command

#### `bin/install-daemon.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DAEMON_HOME="${HOME}/.autonomous-dev"
```

#### `detect_os() -> string`

```bash
detect_os() {
    case "$(uname -s)" in
        Darwin) echo "macos" ;;
        Linux)  echo "linux" ;;
        *)
            echo "ERROR: Unsupported OS: $(uname -s)" >&2
            exit 1
            ;;
    esac
}
```

#### `resolve_paths() -> void`

Sets global variables with resolved paths:

```bash
resolve_paths() {
    PLUGIN_BIN_DIR="${PLUGIN_DIR}/bin"
    USER_HOME="${HOME}"

    # Find bash 4+
    BASH_PATH=""
    for candidate in /opt/homebrew/bin/bash /usr/local/bin/bash /usr/bin/bash /bin/bash; do
        if [[ -x "${candidate}" ]]; then
            local version
            version=$("${candidate}" -c 'echo ${BASH_VERSINFO[0]}' 2>/dev/null || echo "0")
            if [[ ${version} -ge 4 ]]; then
                BASH_PATH="${candidate}"
                break
            fi
        fi
    done

    if [[ -z "${BASH_PATH}" ]]; then
        echo "ERROR: bash 4+ not found. Install via: brew install bash (macOS) or apt install bash (Linux)" >&2
        exit 1
    fi

    # Build extra PATH entries for dependencies
    EXTRA_PATH_DIRS=""
    for cmd in claude jq git; do
        local cmd_path
        cmd_path=$(command -v "${cmd}" 2>/dev/null || echo "")
        if [[ -n "${cmd_path}" ]]; then
            local cmd_dir
            cmd_dir=$(dirname "${cmd_path}")
            # Add to EXTRA_PATH_DIRS if not already a standard path
            case "${cmd_dir}" in
                /usr/local/bin|/usr/bin|/bin|/opt/homebrew/bin) ;;  # Already in template
                *)
                    if [[ -n "${EXTRA_PATH_DIRS}" ]]; then
                        EXTRA_PATH_DIRS="${EXTRA_PATH_DIRS}:${cmd_dir}"
                    else
                        EXTRA_PATH_DIRS="${cmd_dir}"
                    fi
                    ;;
            esac
        fi
    done
    # Add trailing colon if non-empty for PATH concatenation
    if [[ -n "${EXTRA_PATH_DIRS}" ]]; then
        EXTRA_PATH_DIRS="${EXTRA_PATH_DIRS}:"
    fi
}
```

#### `render_template(template_file: string, output_file: string) -> void`

```bash
render_template() {
    local template_file="$1"
    local output_file="$2"

    sed \
        -e "s|{{BASH_PATH}}|${BASH_PATH}|g" \
        -e "s|{{PLUGIN_BIN_DIR}}|${PLUGIN_BIN_DIR}|g" \
        -e "s|{{DAEMON_HOME}}|${DAEMON_HOME}|g" \
        -e "s|{{USER_HOME}}|${USER_HOME}|g" \
        -e "s|{{EXTRA_PATH_DIRS}}|${EXTRA_PATH_DIRS}|g" \
        "${template_file}" > "${output_file}"
}
```

Note: Uses `|` as the `sed` delimiter to avoid conflicts with `/` in file paths.

#### `install_macos() -> void`

```bash
install_macos() {
    local template="${PLUGIN_DIR}/templates/com.autonomous-dev.daemon.plist.template"
    local target_dir="${HOME}/Library/LaunchAgents"
    local target_file="${target_dir}/com.autonomous-dev.daemon.plist"

    mkdir -p "${target_dir}"

    # Check for existing installation
    if [[ -f "${target_file}" && "${FORCE}" != "true" ]]; then
        echo "ERROR: Daemon already installed at ${target_file}." >&2
        echo "Use --force to overwrite." >&2
        exit 2
    fi

    # If already loaded, bootout first
    if launchctl print "gui/$(id -u)/com.autonomous-dev.daemon" >/dev/null 2>&1; then
        echo "Removing existing service..."
        launchctl bootout "gui/$(id -u)/com.autonomous-dev.daemon" 2>/dev/null || true
    fi

    # Render template
    render_template "${template}" "${target_file}"

    # Validate the rendered plist
    if ! plutil -lint "${target_file}" >/dev/null 2>&1; then
        echo "ERROR: Rendered plist is invalid XML. Check template." >&2
        rm -f "${target_file}"
        exit 1
    fi

    # Bootstrap the service
    launchctl bootstrap "gui/$(id -u)" "${target_file}"

    # Verify
    if launchctl print "gui/$(id -u)/com.autonomous-dev.daemon" >/dev/null 2>&1; then
        echo "Daemon installed and started successfully (macOS/launchd)."
        echo "  Plist: ${target_file}"
        echo "  Logs:  ${DAEMON_HOME}/logs/"
    else
        echo "WARNING: Daemon may not have started. Check: launchctl print gui/$(id -u)/com.autonomous-dev.daemon" >&2
    fi
}
```

#### `install_linux() -> void`

```bash
install_linux() {
    local template="${PLUGIN_DIR}/templates/autonomous-dev.service.template"
    local target_dir="${HOME}/.config/systemd/user"
    local target_file="${target_dir}/autonomous-dev.service"

    mkdir -p "${target_dir}"

    # Check for existing installation
    if [[ -f "${target_file}" && "${FORCE}" != "true" ]]; then
        echo "ERROR: Daemon already installed at ${target_file}." >&2
        echo "Use --force to overwrite." >&2
        exit 2
    fi

    # Render template
    render_template "${template}" "${target_file}"

    # Enable lingering (required for user services to run without login session)
    if command -v loginctl >/dev/null 2>&1; then
        if ! loginctl show-user "$(whoami)" -p Linger 2>/dev/null | grep -q "yes"; then
            echo "Enabling lingering for user $(whoami)..."
            loginctl enable-linger "$(whoami)" 2>/dev/null || \
                echo "WARNING: Could not enable linger. Service may not run after logout." >&2
        fi
    fi

    # Reload, enable, and start
    systemctl --user daemon-reload
    systemctl --user enable autonomous-dev.service
    systemctl --user start autonomous-dev.service

    # Verify
    if systemctl --user is-active autonomous-dev.service >/dev/null 2>&1; then
        echo "Daemon installed and started successfully (Linux/systemd)."
        echo "  Unit file: ${target_file}"
        echo "  Logs:      journalctl --user -u autonomous-dev"
    else
        echo "WARNING: Daemon may not have started. Check: systemctl --user status autonomous-dev.service" >&2
    fi
}
```

#### `enforce_permissions() -> void`

```bash
enforce_permissions() {
    # Create daemon home if needed
    mkdir -p "${DAEMON_HOME}" "${DAEMON_HOME}/logs" "${DAEMON_HOME}/alerts"

    # Set directory permissions to 700
    chmod 700 "${DAEMON_HOME}"
    chmod 700 "${DAEMON_HOME}/logs"
    chmod 700 "${DAEMON_HOME}/alerts"

    # Set file permissions to 600 for any existing files
    find "${DAEMON_HOME}" -maxdepth 1 -type f \( -name "*.json" -o -name "*.flag" -o -name "*.lock" \) -exec chmod 600 {} \; 2>/dev/null || true
}
```

#### Main Flow

```bash
FORCE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --force) FORCE=true; shift ;;
        --help|-h)
            echo "Usage: install-daemon.sh [--force]"
            echo "  --force  Overwrite existing daemon configuration"
            exit 0
            ;;
        *)
            echo "ERROR: Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

resolve_paths
enforce_permissions

OS=$(detect_os)
case "${OS}" in
    macos) install_macos ;;
    linux) install_linux ;;
esac
```

### Task 4: CLI Dispatcher

#### `bin/autonomous-dev.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_BIN_DIR="${PLUGIN_DIR}/bin"

# Source shared utilities (logging, etc.) if available
DAEMON_HOME="${HOME}/.autonomous-dev"

usage() {
    cat <<EOF
Usage: autonomous-dev <command> [options]

Commands:
  install-daemon       Install the daemon as an OS service
  daemon start         Start the daemon service
  daemon stop          Stop the daemon service
  daemon status        Show daemon status
  kill-switch          Engage the kill switch (stop all processing)
  kill-switch reset    Disengage the kill switch
  circuit-breaker reset  Reset the circuit breaker

Options:
  --help, -h           Show this help message
  --version            Show version

EOF
}

version() {
    echo "autonomous-dev v0.1.0"
}

# Command routing
if [[ $# -eq 0 ]]; then
    usage
    exit 1
fi

COMMAND="$1"
shift

case "${COMMAND}" in
    install-daemon)
        exec bash "${PLUGIN_BIN_DIR}/install-daemon.sh" "$@"
        ;;
    daemon)
        if [[ $# -eq 0 ]]; then
            echo "ERROR: daemon requires a subcommand (start, stop, status)" >&2
            exit 1
        fi
        SUBCOMMAND="$1"
        shift
        case "${SUBCOMMAND}" in
            start)   cmd_daemon_start "$@" ;;
            stop)    cmd_daemon_stop "$@" ;;
            status)  cmd_daemon_status "$@" ;;
            *)
                echo "ERROR: Unknown daemon subcommand: ${SUBCOMMAND}" >&2
                exit 1
                ;;
        esac
        ;;
    kill-switch)
        if [[ "${1:-}" == "reset" ]]; then
            shift
            cmd_kill_switch_reset "$@"
        else
            cmd_kill_switch "$@"
        fi
        ;;
    circuit-breaker)
        if [[ "${1:-}" == "reset" ]]; then
            shift
            cmd_circuit_breaker_reset "$@"
        else
            echo "ERROR: circuit-breaker requires 'reset' subcommand" >&2
            exit 1
        fi
        ;;
    --help|-h)
        usage
        exit 0
        ;;
    --version)
        version
        exit 0
        ;;
    *)
        echo "ERROR: Unknown command: ${COMMAND}" >&2
        usage
        exit 1
        ;;
esac
```

The `cmd_daemon_start`, `cmd_daemon_stop`, `cmd_daemon_status`, `cmd_kill_switch`, `cmd_kill_switch_reset`, and `cmd_circuit_breaker_reset` functions are defined in the same file (or sourced from separate files). They are implemented in SPEC-001-4-03 and SPEC-001-4-04.

#### Path Resolution

The dispatcher resolves `PLUGIN_DIR` from its own location. All paths are relative to the plugin root:
```bash
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
```

This ensures the CLI works regardless of the user's current working directory.

### Edge Cases
- `install-daemon` run on an unsupported OS (e.g., Windows via WSL): `uname -s` returns "Linux" on WSL, which is fine. True Windows is unsupported.
- `--force` without existing installation: Proceeds normally (no-op for the overwrite check).
- `launchctl bootstrap` fails (permission issues, macOS version differences): Error message includes the failed command and suggests manual steps.
- `systemctl --user` not available (e.g., running as root, or systemd not in user mode): Error from `systemctl` is visible. The `loginctl enable-linger` check provides an early warning.
- `bash 4+` not found anywhere: Clear error with installation instructions for the user's platform.
- Dispatcher called with no arguments: Shows usage and exits 1.
- Unknown command: Shows error and usage.

## Acceptance Criteria
1. [ ] On macOS, `install-daemon.sh` creates the plist in `~/Library/LaunchAgents/`
2. [ ] On macOS, the service is bootstrapped with `launchctl bootstrap`
3. [ ] On macOS, installation is verified with `launchctl print`
4. [ ] On Linux, `install-daemon.sh` creates the unit file in `~/.config/systemd/user/`
5. [ ] On Linux, `daemon-reload`, `enable`, and `start` are executed
6. [ ] `--force` overwrites existing config without prompting
7. [ ] Without `--force` and with existing config, exits with code 2
8. [ ] Permissions on `~/.autonomous-dev/` are set to 700, files to 600
9. [ ] Bash 4+ is detected and used in the template
10. [ ] Extra PATH entries for non-standard dependency locations are included
11. [ ] `autonomous-dev daemon start` calls the start function
12. [ ] `autonomous-dev daemon stop` calls the stop function
13. [ ] `autonomous-dev daemon status` calls the status function
14. [ ] `autonomous-dev kill-switch` calls the kill switch function
15. [ ] `autonomous-dev kill-switch reset` calls the reset function
16. [ ] `autonomous-dev circuit-breaker reset` calls the reset function
17. [ ] Unknown commands print usage and exit 1
18. [ ] `--help` prints available commands
19. [ ] The dispatcher resolves paths relative to its own location (portable)
20. [ ] No shellcheck warnings at `--severity=warning` level

## Test Cases
1. **test_detect_os_macos** -- On macOS, assert `detect_os` outputs "macos".
2. **test_detect_os_linux** -- On Linux, assert `detect_os` outputs "linux". (Skip on macOS.)
3. **test_resolve_paths_bash** -- Call `resolve_paths`. Assert `BASH_PATH` is non-empty and points to bash 4+.
4. **test_resolve_paths_extra** -- Mock a non-standard `claude` location (e.g., `/custom/bin/claude`). Call `resolve_paths`. Assert `EXTRA_PATH_DIRS` contains `/custom/bin`.
5. **test_render_template** -- Create a template with `{{BASH_PATH}}` and `{{PLUGIN_BIN_DIR}}`. Call `render_template`. Assert output has resolved values, no `{{` remaining.
6. **test_install_macos_fresh** -- Mock `launchctl` commands. Run `install_macos`. Assert the plist file is created. Assert `launchctl bootstrap` was called.
7. **test_install_macos_existing_no_force** -- Create an existing plist. Run `install-daemon.sh` without `--force`. Assert exit code 2.
8. **test_install_macos_existing_force** -- Create an existing plist. Run with `--force`. Assert the plist is overwritten.
9. **test_install_linux_fresh** -- Mock `systemctl` commands. Run `install_linux`. Assert the unit file is created. Assert `daemon-reload`, `enable`, and `start` were called.
10. **test_install_linux_existing_no_force** -- Create an existing unit file. Assert exit code 2.
11. **test_enforce_permissions** -- Call `enforce_permissions`. Assert `~/.autonomous-dev/` has mode 700. Assert any `.json` files have mode 600.
12. **test_cli_dispatcher_help** -- Run `autonomous-dev.sh --help`. Assert output contains "Usage" and lists commands.
13. **test_cli_dispatcher_unknown** -- Run `autonomous-dev.sh bogus`. Assert exit code 1. Assert output contains "Unknown command".
14. **test_cli_dispatcher_no_args** -- Run `autonomous-dev.sh`. Assert exit code 1. Assert usage printed.
15. **test_cli_dispatcher_version** -- Run `autonomous-dev.sh --version`. Assert output contains "v0.1.0".
16. **test_cli_daemon_no_subcommand** -- Run `autonomous-dev.sh daemon`. Assert exit code 1. Assert error mentions subcommand.
