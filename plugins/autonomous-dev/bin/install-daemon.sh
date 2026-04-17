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

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DAEMON_HOME="${HOME}/.autonomous-dev"

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
