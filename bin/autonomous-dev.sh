#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# autonomous-dev.sh - CLI Dispatcher for the autonomous-dev plugin
#
# Single entry point that routes all subcommands to their implementations.
#
# Usage: autonomous-dev <command> [options]
#
# Commands:
#   install-daemon           Install the daemon as an OS service
#   daemon start|stop|status Manage the daemon service
#   kill-switch              Engage the kill switch (stop all processing)
#   kill-switch reset        Disengage the kill switch
#   circuit-breaker reset    Reset the circuit breaker
#   config init|show|validate  Configuration management
#   --help, -h               Show this help message
#   --version                Show version
###############################################################################

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_BIN_DIR="${PLUGIN_DIR}/bin"

# Source shared utilities (logging, etc.) if available
DAEMON_HOME="${HOME}/.autonomous-dev"
KILL_SWITCH_FILE="${DAEMON_HOME}/kill-switch.flag"
CRASH_STATE_FILE="${DAEMON_HOME}/crash-state.json"

# ---------------------------------------------------------------------------
# usage() -> void
#   Prints help text to stdout.
# ---------------------------------------------------------------------------
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
  config init          Initialize configuration
  config show          Show current configuration
  config validate      Validate configuration

Options:
  --help, -h           Show this help message
  --version            Show version

EOF
}

# ---------------------------------------------------------------------------
# version() -> void
#   Prints version string to stdout.
# ---------------------------------------------------------------------------
version() {
    echo "autonomous-dev v0.1.0"
}

# ---------------------------------------------------------------------------
# detect_os() -> string
#   Prints "macos" or "linux".
# ---------------------------------------------------------------------------
detect_os() {
    case "$(uname -s)" in
        Darwin) echo "macos" ;;
        Linux)  echo "linux" ;;
        *)      echo "unknown" ;;
    esac
}

# ---------------------------------------------------------------------------
# cmd_daemon_start() -> void
#   Starts the daemon service via the OS service manager.
# ---------------------------------------------------------------------------
cmd_daemon_start() {
    local os
    os=$(detect_os)
    case "${os}" in
        macos)
            local plist="${HOME}/Library/LaunchAgents/com.autonomous-dev.daemon.plist"
            if [[ ! -f "${plist}" ]]; then
                echo "ERROR: Daemon not installed. Run 'autonomous-dev install-daemon' first." >&2
                exit 1
            fi
            # Bootstrap if not already loaded
            if ! launchctl print "gui/$(id -u)/com.autonomous-dev.daemon" >/dev/null 2>&1; then
                launchctl bootstrap "gui/$(id -u)" "${plist}"
                echo "Daemon started (macOS/launchd)."
            else
                echo "Daemon is already running."
            fi
            ;;
        linux)
            if ! systemctl --user is-enabled autonomous-dev.service >/dev/null 2>&1; then
                echo "ERROR: Daemon not installed. Run 'autonomous-dev install-daemon' first." >&2
                exit 1
            fi
            systemctl --user start autonomous-dev.service
            echo "Daemon started (Linux/systemd)."
            ;;
        *)
            echo "ERROR: Unsupported OS for daemon management." >&2
            exit 1
            ;;
    esac
}

# ---------------------------------------------------------------------------
# cmd_daemon_stop() -> void
#   Stops the daemon service via the OS service manager.
# ---------------------------------------------------------------------------
cmd_daemon_stop() {
    local os
    os=$(detect_os)
    case "${os}" in
        macos)
            if launchctl print "gui/$(id -u)/com.autonomous-dev.daemon" >/dev/null 2>&1; then
                launchctl bootout "gui/$(id -u)/com.autonomous-dev.daemon" 2>/dev/null || true
                echo "Daemon stopped (macOS/launchd)."
            else
                echo "Daemon is not running."
            fi
            ;;
        linux)
            systemctl --user stop autonomous-dev.service 2>/dev/null || true
            echo "Daemon stopped (Linux/systemd)."
            ;;
        *)
            echo "ERROR: Unsupported OS for daemon management." >&2
            exit 1
            ;;
    esac
}

# ---------------------------------------------------------------------------
# cmd_daemon_status() -> void
#   Shows daemon status via the OS service manager plus local state files.
# ---------------------------------------------------------------------------
cmd_daemon_status() {
    local os
    os=$(detect_os)

    echo "=== autonomous-dev daemon status ==="
    echo ""

    # OS service status
    case "${os}" in
        macos)
            if launchctl print "gui/$(id -u)/com.autonomous-dev.daemon" >/dev/null 2>&1; then
                echo "Service: running (macOS/launchd)"
            else
                echo "Service: stopped (macOS/launchd)"
            fi
            ;;
        linux)
            if systemctl --user is-active autonomous-dev.service >/dev/null 2>&1; then
                echo "Service: running (Linux/systemd)"
            else
                echo "Service: stopped (Linux/systemd)"
            fi
            ;;
        *)
            echo "Service: unknown OS"
            ;;
    esac

    # Kill switch status
    if [[ -f "${KILL_SWITCH_FILE}" ]]; then
        echo "Kill switch: ENGAGED"
    else
        echo "Kill switch: disengaged"
    fi

    # Circuit breaker status
    if [[ -f "${CRASH_STATE_FILE}" ]]; then
        local tripped
        tripped=$(jq -r '.circuit_breaker_tripped // false' "${CRASH_STATE_FILE}" 2>/dev/null || echo "false")
        local crashes
        crashes=$(jq -r '.consecutive_crashes // 0' "${CRASH_STATE_FILE}" 2>/dev/null || echo "0")
        if [[ "${tripped}" == "true" ]]; then
            echo "Circuit breaker: TRIPPED (${crashes} consecutive crashes)"
        else
            echo "Circuit breaker: OK (${crashes} consecutive crashes)"
        fi
    else
        echo "Circuit breaker: OK (no crash state)"
    fi

    # Heartbeat
    local heartbeat_file="${DAEMON_HOME}/heartbeat.json"
    if [[ -f "${heartbeat_file}" ]]; then
        local last_heartbeat
        last_heartbeat=$(jq -r '.timestamp // "unknown"' "${heartbeat_file}" 2>/dev/null || echo "unknown")
        echo "Last heartbeat: ${last_heartbeat}"
    else
        echo "Last heartbeat: none"
    fi

    # Lock file
    local lock_file="${DAEMON_HOME}/daemon.lock"
    if [[ -f "${lock_file}" ]]; then
        local lock_pid
        lock_pid=$(cat "${lock_file}" 2>/dev/null || echo "unknown")
        if [[ "${lock_pid}" != "unknown" ]] && kill -0 "${lock_pid}" 2>/dev/null; then
            echo "Lock: held by PID ${lock_pid} (alive)"
        else
            echo "Lock: stale (PID ${lock_pid})"
        fi
    else
        echo "Lock: none"
    fi
}

# ---------------------------------------------------------------------------
# cmd_kill_switch() -> void
#   Engages the kill switch by creating the kill-switch flag file.
# ---------------------------------------------------------------------------
cmd_kill_switch() {
    mkdir -p "${DAEMON_HOME}"

    if [[ -f "${KILL_SWITCH_FILE}" ]]; then
        echo "Kill switch is already engaged."
        return 0
    fi

    # Write timestamp and invoker info
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    echo "${timestamp}" > "${KILL_SWITCH_FILE}"
    chmod 600 "${KILL_SWITCH_FILE}"

    echo "Kill switch ENGAGED at ${timestamp}."
    echo "All daemon processing will halt."
    echo "To resume, run: autonomous-dev kill-switch reset"
}

# ---------------------------------------------------------------------------
# cmd_kill_switch_reset() -> void
#   Disengages the kill switch by removing the flag file.
# ---------------------------------------------------------------------------
cmd_kill_switch_reset() {
    if [[ ! -f "${KILL_SWITCH_FILE}" ]]; then
        echo "Kill switch is not engaged."
        return 0
    fi

    rm -f "${KILL_SWITCH_FILE}"
    echo "Kill switch disengaged. Daemon will resume processing on next iteration."
}

# ---------------------------------------------------------------------------
# cmd_circuit_breaker_reset() -> void
#   Resets the circuit breaker by clearing crash state.
# ---------------------------------------------------------------------------
cmd_circuit_breaker_reset() {
    if [[ ! -f "${CRASH_STATE_FILE}" ]]; then
        echo "No crash state to reset."
        return 0
    fi

    local tripped
    tripped=$(jq -r '.circuit_breaker_tripped // false' "${CRASH_STATE_FILE}" 2>/dev/null || echo "false")

    # Reset the crash state
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    jq --arg ts "${timestamp}" \
        '.consecutive_crashes = 0 | .circuit_breaker_tripped = false | .last_reset = $ts' \
        "${CRASH_STATE_FILE}" > "${CRASH_STATE_FILE}.tmp" \
        && mv "${CRASH_STATE_FILE}.tmp" "${CRASH_STATE_FILE}"
    chmod 600 "${CRASH_STATE_FILE}"

    if [[ "${tripped}" == "true" ]]; then
        echo "Circuit breaker reset. Was tripped; now cleared."
    else
        echo "Circuit breaker reset. Crash counter cleared."
    fi
    echo "Daemon will resume normal operation on next iteration."
}

# ---------------------------------------------------------------------------
# Command routing
# ---------------------------------------------------------------------------
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
    config)
        if [[ $# -eq 0 ]]; then
            echo "ERROR: config requires a subcommand (init, show, validate)" >&2
            exit 1
        fi
        SUBCOMMAND="$1"
        shift
        case "${SUBCOMMAND}" in
            init)     exec bash "${PLUGIN_DIR}/commands/config_init.sh" "$@" ;;
            show)     exec bash "${PLUGIN_DIR}/commands/config_show.sh" "$@" ;;
            validate) exec bash "${PLUGIN_DIR}/commands/config_validate.sh" "$@" ;;
            *)
                echo "ERROR: Unknown config subcommand: ${SUBCOMMAND}" >&2
                exit 1
                ;;
        esac
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
