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
#   request <subcommand>     Manage autonomous-dev request lifecycle
#                            (submit, status, list, cancel, pause, resume,
#                             priority, logs, feedback, kill)
#   reconcile                Detect and (optionally) repair drift between the
#                            intake-router SQLite store and per-request
#                            state.json files (SPEC-012-3-03).
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
  request <subcmd>     Manage request lifecycle (run 'request --help' for list)
  reconcile            Detect/repair drift (run 'reconcile --help' for options)

Options:
  --help, -h           Show this help message
  --version            Show version

EOF
}

# ---------------------------------------------------------------------------
# print_request_help() -> void
#   Prints the request subcommand help text to stdout.
#   Spec: SPEC-011-1-01 Task 1 (verbatim, ≤80 columns per line).
# ---------------------------------------------------------------------------
print_request_help() {
    cat <<'EOF'
Usage: autonomous-dev request <subcommand> [args]

Manage autonomous-dev request lifecycle.

Subcommands:
  submit <description>    Submit a new request (returns REQ-NNNNNN)
  status <REQ-id>         Show current status of a request
  list [--state <state>]  List recent requests (default: active only)
  cancel <REQ-id>         Cancel a request
  pause <REQ-id>          Pause a request
  resume <REQ-id>         Resume a paused request
  priority <REQ-id> <p>   Change priority (high|normal|low)
  logs <REQ-id>           Tail logs for a request
  feedback <REQ-id> <msg> Submit clarifying feedback
  kill <REQ-id>           Force-terminate a request

Run 'autonomous-dev request <subcommand> --help' for subcommand-specific options.
EOF
}

# ---------------------------------------------------------------------------
# validate_request_id(id) -> void
#   Strict regex check: ^REQ-[0-9]{6}$.
#   Spec: SPEC-011-1-01 Task 2.
#   Exits 1 with diagnostic on mismatch; returns 0 on match (no output).
# ---------------------------------------------------------------------------
validate_request_id() {
    local id="${1:-}"
    if [[ -z "$id" ]]; then
        echo "ERROR: request ID is required" >&2
        exit 1
    fi
    if [[ ! "$id" =~ ^REQ-[0-9]{6}$ ]]; then
        echo "ERROR: invalid request ID '$id'. Format: REQ-NNNNNN (6 digits)" >&2
        exit 1
    fi
    return 0
}

# ---------------------------------------------------------------------------
# validate_priority(value) -> void
#   Allowlist membership check against {high, normal, low}.
#   Spec: SPEC-011-1-01 Task 3.
#   Exits 1 with diagnostic on mismatch; returns 0 on match (no output).
# ---------------------------------------------------------------------------
validate_priority() {
    local value="${1:-}"
    if [[ -z "$value" ]]; then
        echo "ERROR: priority value is required" >&2
        exit 1
    fi
    local valid_priorities="high normal low"
    if [[ ! " $valid_priorities " == *" $value "* ]]; then
        echo "ERROR: invalid priority '$value'. Valid: high, normal, low" >&2
        exit 1
    fi
    return 0
}

# ---------------------------------------------------------------------------
# detect_color(args...) -> string ("0" or "1")
#   Decision tree (Unix conventions): NO_COLOR > --no-color > !TTY > TERM > on.
#   Spec: SPEC-011-1-02 Task 4.
#   Read-only: does NOT consume the --no-color arg.
# ---------------------------------------------------------------------------
detect_color() {
    # 1. NO_COLOR env var (per https://no-color.org) — any value disables color.
    if [[ -n "${NO_COLOR:-}" ]]; then
        echo "0"
        return 0
    fi
    # 2. Explicit --no-color flag in args.
    local arg
    for arg in "$@"; do
        if [[ "$arg" == "--no-color" ]]; then
            echo "0"
            return 0
        fi
    done
    # 3. stdout is not a TTY (piped or redirected).
    if [[ ! -t 1 ]]; then
        echo "0"
        return 0
    fi
    # 4. TERM is dumb or empty.
    if [[ -z "${TERM:-}" || "${TERM:-}" == "dumb" ]]; then
        echo "0"
        return 0
    fi
    # 5. Color enabled.
    echo "1"
    return 0
}

# ---------------------------------------------------------------------------
# exec_node_cli(subcmd, args...) -> exec
#   Securely invokes the TS CLI adapter via `exec node` with an argv array.
#   Shell metacharacters in arguments are passed as literal strings.
#   Spec: SPEC-011-1-02 Task 5.
#
#   Exit codes:
#     0  success
#     1  user error (validation, not found, etc.) — from node
#     2  system error (missing file, missing node, etc.)
# ---------------------------------------------------------------------------
exec_node_cli() {
    local subcmd="$1"
    shift
    local cli_path="${PLUGIN_DIR}/intake/adapters/cli_adapter.js"

    if [[ ! -f "$cli_path" ]]; then
        echo "ERROR: CLI adapter not found at $cli_path. Run plugin install or rebuild." >&2
        exit 2
    fi
    if ! command -v node >/dev/null 2>&1; then
        echo "ERROR: node command not found. Install Node.js 18+ to use request subcommands." >&2
        exit 2
    fi

    # exec replaces this bash process with node; child's exit code propagates.
    # "$@" expands to one quoted token per arg — no shell interpolation.
    exec node "$cli_path" "$subcmd" "$@"
}

# ---------------------------------------------------------------------------
# cmd_request_delegate(args...) -> void
#   Routes the `request` command: validates the subcommand and ID/priority,
#   then exec_node_cli's into the TS adapter.
#   Spec: SPEC-011-1-01 Task 1.
# ---------------------------------------------------------------------------
cmd_request_delegate() {
    if [[ $# -eq 0 ]] || [[ "$1" == "--help" ]] || [[ "$1" == "-h" ]]; then
        print_request_help
        exit 0
    fi

    local subcmd="$1"
    shift

    case "$subcmd" in
        submit|status|list|cancel|pause|resume|priority|logs|feedback|kill)
            ;;
        *)
            echo "ERROR: Unknown request subcommand: $subcmd. Run 'autonomous-dev request --help'" >&2
            exit 1
            ;;
    esac

    # Subcommands whose first positional arg is a request ID get bash-layer
    # regex validation BEFORE any subprocess spawn. Also pass-through --help.
    case "$subcmd" in
        status|cancel|pause|resume|priority|logs|feedback|kill)
            if [[ "${1:-}" != "--help" && "${1:-}" != "-h" ]]; then
                validate_request_id "${1:-}"
            fi
            ;;
    esac

    # priority also requires a valid level as its second positional arg.
    if [[ "$subcmd" == "priority" ]]; then
        if [[ "${1:-}" != "--help" && "${1:-}" != "-h" ]]; then
            validate_priority "${2:-}"
        fi
    fi

    # Detect color preference and export for the Node subprocess. The
    # --no-color flag is intentionally passed through to node as well so
    # libraries that read the flag (not the env) also honor it.
    local color
    color=$(detect_color "$@")
    export AUTONOMOUS_DEV_COLOR="$color"

    exec_node_cli "$subcmd" "$@"
}

# ---------------------------------------------------------------------------
# print_reconcile_help() -> void
#   Prints the reconcile subcommand help text to stdout.
#   Spec: SPEC-012-3-03 (verbatim, ≤80 columns per line).
# ---------------------------------------------------------------------------
print_reconcile_help() {
    cat <<'EOF'
Usage: autonomous-dev reconcile --repo <path> [options]

Detect and (optionally) repair drift between the intake-router SQLite
store and per-request state.json files. Defaults to detect-only.

Required:
  --repo <path>        Repository root (must be an existing directory)

Optional:
  --dry-run            Report what would change without mutating anything
  --auto-repair        Apply repair strategies for resolvable drift
  --cleanup-temps      Remove orphaned state.json.tmp.* files after detect
  --out <path>         Write JSON audit log to <path> (default: stdout)
  --help, -h           Show this help message

Exit codes:
  0  no inconsistencies (or all auto-repaired successfully)
  1  inconsistencies detected (detect-only or partial repair)
  2  system error (DB open failure, IO error, lock contention, etc.)

Examples:
  autonomous-dev reconcile --repo /path/to/repo
  autonomous-dev reconcile --repo /path/to/repo --auto-repair
  autonomous-dev reconcile --repo /path/to/repo --cleanup-temps --dry-run
  autonomous-dev reconcile --repo /path/to/repo --out /tmp/audit.json
EOF
}

# ---------------------------------------------------------------------------
# validate_reconcile_repo(path) -> string
#   Validates that the supplied repo path is non-empty AND points at an
#   existing directory. On success, prints the realpath-resolved canonical
#   path on stdout (callers capture via $(...)). On failure, exits 1 with
#   the documented diagnostic on stderr.
#   Spec: SPEC-012-3-03 §validate_repo_path.
# ---------------------------------------------------------------------------
validate_reconcile_repo() {
    local repo_path="${1:-}"
    if [[ -z "$repo_path" ]]; then
        echo "ERROR: --repo requires a path" >&2
        exit 1
    fi
    if [[ ! -d "$repo_path" ]]; then
        echo "ERROR: repo path '$repo_path' does not exist or is not a directory" >&2
        exit 1
    fi
    # Resolve to absolute canonical path so the Node child sees a stable
    # value regardless of how the operator typed the flag.
    local resolved
    if ! resolved=$(cd "$repo_path" 2>/dev/null && pwd -P); then
        echo "ERROR: failed to resolve repo path '$repo_path'" >&2
        exit 1
    fi
    echo "$resolved"
}

# ---------------------------------------------------------------------------
# validate_reconcile_out(path) -> void
#   Validates that the --out path's parent directory exists and is
#   writable. Returns 0 on success; exits 1 with diagnostic otherwise.
#   Spec: SPEC-012-3-03 §validate_output_path.
# ---------------------------------------------------------------------------
validate_reconcile_out() {
    local out_path="${1:-}"
    if [[ -z "$out_path" ]]; then
        echo "ERROR: --out requires a path" >&2
        exit 1
    fi
    local parent
    parent=$(dirname "$out_path")
    if [[ ! -d "$parent" ]]; then
        echo "ERROR: --out parent dir does not exist: $parent" >&2
        exit 1
    fi
    if [[ ! -w "$parent" ]]; then
        echo "ERROR: --out parent dir not writable: $parent" >&2
        exit 1
    fi
    return 0
}

# ---------------------------------------------------------------------------
# exec_node_reconcile_cli(args...) -> exec
#   Securely invokes the reconcile TS orchestrator via `exec node`.
#   Mirrors exec_node_cli's pattern but targets intake/cli/reconcile_command.js
#   instead of the request adapter. Shell metacharacters are passed as
#   literal strings (argv array, no string interpolation).
#   Spec: SPEC-012-3-03.
#
#   Exit codes (propagated from node):
#     0  no drift / all repairs succeeded
#     1  drift detected (detect-only or partial repair)
#     2  system error
# ---------------------------------------------------------------------------
exec_node_reconcile_cli() {
    local cli_path="${PLUGIN_DIR}/intake/cli/reconcile_command.js"

    if [[ ! -f "$cli_path" ]]; then
        echo "ERROR: reconcile CLI not found at $cli_path. Run plugin install or rebuild." >&2
        exit 2
    fi
    if ! command -v node >/dev/null 2>&1; then
        echo "ERROR: node command not found. Install Node.js 18+ to use reconcile." >&2
        exit 2
    fi

    # exec replaces this bash process with node; child's exit code propagates.
    exec node "$cli_path" "$@"
}

# ---------------------------------------------------------------------------
# cmd_reconcile_delegate(args...) -> void
#   Routes the `reconcile` command: parses --repo / --out flags, validates
#   them in bash BEFORE spawning node, then exec_node_reconcile_cli's into
#   the TS orchestrator with the canonicalized arg list.
#   Spec: SPEC-012-3-03.
#
#   Unknown flags are rejected here (so the operator gets a fast, well-
#   localized error rather than commander's terser output).
# ---------------------------------------------------------------------------
cmd_reconcile_delegate() {
    if [[ $# -eq 0 ]] || [[ "${1:-}" == "--help" ]] || [[ "${1:-}" == "-h" ]]; then
        print_reconcile_help
        exit 0
    fi

    local repo_path=""
    local out_path=""
    local pass_args=()

    # Parse known flags. Capture --repo / --out for bash-side validation;
    # forward boolean flags verbatim. Reject unknown flags up-front.
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --help|-h)
                print_reconcile_help
                exit 0
                ;;
            --repo)
                if [[ $# -lt 2 ]]; then
                    echo "ERROR: --repo requires a path" >&2
                    exit 1
                fi
                repo_path="$2"
                shift 2
                ;;
            --repo=*)
                repo_path="${1#--repo=}"
                shift
                ;;
            --out)
                if [[ $# -lt 2 ]]; then
                    echo "ERROR: --out requires a path" >&2
                    exit 1
                fi
                out_path="$2"
                shift 2
                ;;
            --out=*)
                out_path="${1#--out=}"
                shift
                ;;
            --dry-run|--auto-repair|--cleanup-temps)
                pass_args+=("$1")
                shift
                ;;
            --*)
                echo "ERROR: unknown flag '$1'. Run 'autonomous-dev reconcile --help'" >&2
                exit 1
                ;;
            *)
                echo "ERROR: unexpected positional argument '$1'. Run 'autonomous-dev reconcile --help'" >&2
                exit 1
                ;;
        esac
    done

    # --repo is mandatory; validate + canonicalize.
    local resolved_repo
    resolved_repo=$(validate_reconcile_repo "$repo_path")

    # --out (when present) must have a writable parent dir.
    if [[ -n "$out_path" ]]; then
        validate_reconcile_out "$out_path"
        pass_args+=("--out" "$out_path")
    fi

    # Always pass the canonical --repo to the Node child so it sees the
    # same path the validator approved (no race on cwd or symlinks).
    pass_args=("--repo" "$resolved_repo" "${pass_args[@]}")

    exec_node_reconcile_cli "${pass_args[@]}"
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
    request)
        cmd_request_delegate "$@"
        ;;
    reconcile)
        cmd_reconcile_delegate "$@"
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
