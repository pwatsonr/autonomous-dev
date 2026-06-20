#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# install-daemon.sh - Install the autonomous-dev daemon as an OS service
#
# Detects the OS (macOS / Linux), resolves paths, templates the appropriate
# supervisor configuration (launchd plist or systemd unit), installs it, and
# starts the service.
#
# Usage:
#   install-daemon.sh [--force]
#     --force   Overwrite existing daemon configuration
###############################################################################

# Resolve our own path. BASH_SOURCE[0] (not $0) so this works when sourced (e.g.
# tests); fall back to $0 under `set -u` if BASH_SOURCE is somehow unset.
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
DAEMON_HOME="${HOME}/.autonomous-dev"

# ---------------------------------------------------------------------------
# Deploy serialization (#550)
#
# Both the operator (`autonomous-dev install-daemon --force`) and the daemon's
# auto-upgrader (the `com.autonomous-dev.daemon.upgrader` launchd job) — and the
# rollback path — converge on THIS script. With no serialization, two installs
# can interleave their launchctl bootout/bootstrap of the same label, leaving
# launchd's domain mid-transition → `Bootstrap failed: 5: Input/output error`
# and a restart loop. A single mkdir-based lock here serializes all of them.
#
# Everything below FAILS OPEN: the daemon's only path back up is this script, so
# a lock we cannot acquire, or a bootstrap that keeps failing, must never leave
# the script wedged — it logs and proceeds.
# ---------------------------------------------------------------------------
DEPLOY_LOCK_DIR="${DAEMON_HOME}/.deploy.lock"
# Stale threshold kept below UPGRADE_TRIAL_DEADLINE_SECONDS (180s in
# supervisor-loop.sh) so a dead lock holder can never block the rollback install.
DEPLOY_LOCK_STALE_SECONDS=120
DEPLOY_LOCK_HELD=false

# _lock_mtime_epoch(path) -> epoch seconds (BSD stat then GNU stat).
_lock_mtime_epoch() {
    stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

# acquire_deploy_lock([max_wait_seconds]) -> 0 (always; fail-open)
#   Sets DEPLOY_LOCK_HELD=true if we own the lock, false if we proceeded without
#   it after the timeout. Reclaims a stale lock (older than the threshold).
acquire_deploy_lock() {
    local max_wait="${1:-30}" waited=0
    mkdir -p "${DAEMON_HOME}" 2>/dev/null || true
    while true; do
        if mkdir "${DEPLOY_LOCK_DIR}" 2>/dev/null; then
            echo "$$" > "${DEPLOY_LOCK_DIR}/pid" 2>/dev/null || true
            DEPLOY_LOCK_HELD=true
            return 0
        fi
        # Lock exists — reclaim if stale.
        if [[ -d "${DEPLOY_LOCK_DIR}" ]]; then
            local now age
            now=$(date +%s 2>/dev/null || echo 0)
            age=$(( now - $(_lock_mtime_epoch "${DEPLOY_LOCK_DIR}") ))
            if (( age > DEPLOY_LOCK_STALE_SECONDS )); then
                echo "Reclaiming stale deploy lock (age ${age}s)..." >&2
                rm -rf "${DEPLOY_LOCK_DIR}" 2>/dev/null || true
                continue
            fi
        fi
        if (( waited >= max_wait )); then
            echo "WARNING: deploy lock busy after ${waited}s; proceeding without it (#550 fail-open)." >&2
            DEPLOY_LOCK_HELD=false
            return 0
        fi
        sleep 1
        waited=$(( waited + 1 ))
    done
}

# release_deploy_lock() -> void  (only removes a lock we own)
release_deploy_lock() {
    if [[ "${DEPLOY_LOCK_HELD}" == "true" ]]; then
        rm -rf "${DEPLOY_LOCK_DIR}" 2>/dev/null || true
        DEPLOY_LOCK_HELD=false
    fi
}

# wait_for_label_down(label[, max_tries]) -> 0 if gone, 1 if still present
#   Polls launchctl until the label is no longer registered. launchctl bootout
#   is asynchronous, so bootstrapping immediately after can hit a half-torn-down
#   domain (the EIO source). Bounded; returns 1 on timeout (caller proceeds).
wait_for_label_down() {
    local label="$1" max_tries="${2:-12}" i=0
    while launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1; do
        (( i >= max_tries )) && return 1
        sleep 1
        i=$(( i + 1 ))
    done
    return 0
}

# bootstrap_with_retry(domain, plist, label) -> bootstrap exit code
#   launchctl bootstrap, retried on a transient failure (EIO/5 / busy domain)
#   after re-confirming the label is down. Captures the exit code so `set -e`
#   never aborts mid-retry. Returns 0 on success, the last failing code otherwise.
bootstrap_with_retry() {
    local domain="$1" plist="$2" label="$3" tries=4 i=1 rc=0
    while (( i <= tries )); do
        rc=0
        launchctl bootstrap "${domain}" "${plist}" 2>/dev/null || rc=$?
        if (( rc == 0 )); then
            return 0
        fi
        # Already-bootstrapped (rc 37 "Operation already in progress" / EALREADY)
        # counts as success — the label is loaded.
        if launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1; then
            return 0
        fi
        if (( i < tries )); then
            echo "bootstrap attempt ${i}/${tries} failed (rc=${rc}); re-confirming down + retrying..." >&2
            wait_for_label_down "${label}" 6 || true
            sleep "${i}"   # linear backoff: 1s, 2s, 3s
        fi
        i=$(( i + 1 ))
    done
    return "${rc}"
}

# ---------------------------------------------------------------------------
# detect_os() -> string
#   Prints "macos" or "linux". Exits 1 on unsupported platforms.
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# resolve_paths() -> void
#   Sets global variables: PLUGIN_BIN_DIR, USER_HOME, BASH_PATH,
#   EXTRA_PATH_DIRS.
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# render_template(template_file, output_file) -> void
#   Substitutes placeholders in template_file and writes to output_file.
#   Uses | as the sed delimiter to avoid conflicts with / in file paths.
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# install_macos() -> void
#   Templates the launchd plist, validates it, bootstraps the service.
# ---------------------------------------------------------------------------
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

    local label="com.autonomous-dev.daemon"

    # #550: serialize the whole bootout→bootstrap critical section so a
    # concurrent operator install + auto-upgrader install can't interleave their
    # launchctl calls on the same label. Released by the EXIT trap (set in main)
    # and explicitly at the end.
    acquire_deploy_lock 30

    # If already loaded, bootout first, then WAIT for confirmed-down — launchctl
    # bootout is async, and bootstrapping into a half-torn-down domain is the
    # `Bootstrap failed: 5` source (#550).
    if launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1; then
        echo "Removing existing service..."
        launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null || true
        if ! wait_for_label_down "${label}" 12; then
            echo "WARNING: existing service still present after bootout; proceeding (will retry bootstrap)." >&2
        fi
    fi

    # Render template
    render_template "${template}" "${target_file}"

    # Validate the rendered plist
    if ! plutil -lint "${target_file}" >/dev/null 2>&1; then
        echo "ERROR: Rendered plist is invalid XML. Check template." >&2
        rm -f "${target_file}"
        release_deploy_lock
        exit 1
    fi

    # Bootstrap the service, retrying on a transient EIO/busy-domain failure.
    local boot_rc=0
    bootstrap_with_retry "gui/$(id -u)" "${target_file}" "${label}" || boot_rc=$?

    release_deploy_lock

    # Verify
    if launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1; then
        echo "Daemon installed and started successfully (macOS/launchd)."
        echo "  Plist: ${target_file}"
        echo "  Logs:  ${DAEMON_HOME}/logs/"
    else
        echo "WARNING: Daemon may not have started (bootstrap rc=${boot_rc}). Check: launchctl print gui/$(id -u)/${label}" >&2
        exit 1
    fi
}

# ---------------------------------------------------------------------------
# install_linux() -> void
#   Templates the systemd unit file, enables lingering, starts the service.
# ---------------------------------------------------------------------------
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

    # Reload, enable, and start — serialized (#550) for symmetry with macOS so a
    # concurrent operator + upgrader install don't fight over the unit.
    acquire_deploy_lock 30
    systemctl --user daemon-reload
    systemctl --user enable autonomous-dev.service
    systemctl --user start autonomous-dev.service
    release_deploy_lock

    # Verify
    if systemctl --user is-active autonomous-dev.service >/dev/null 2>&1; then
        echo "Daemon installed and started successfully (Linux/systemd)."
        echo "  Unit file: ${target_file}"
        echo "  Logs:      journalctl --user -u autonomous-dev"
    else
        echo "WARNING: Daemon may not have started. Check: systemctl --user status autonomous-dev.service" >&2
    fi
}

# ---------------------------------------------------------------------------
# enforce_permissions() -> void
#   Creates DAEMON_HOME dirs and sets restrictive permissions.
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
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

    # Safety net: always release a held deploy lock on exit (#550), so an
    # aborted install never wedges the next one (which is the daemon's only
    # path back up).
    trap 'release_deploy_lock' EXIT INT TERM

    resolve_paths
    enforce_permissions

    OS=$(detect_os)
    case "${OS}" in
        macos) install_macos ;;
        linux) install_linux ;;
    esac
}

# Run main only when executed directly; allow sourcing for tests.
if [[ "${BASH_SOURCE[0]:-$0}" == "${0}" ]]; then
    main "$@"
fi
