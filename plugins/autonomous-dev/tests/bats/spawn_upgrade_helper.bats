#!/usr/bin/env bats
###############################################################################
# spawn_upgrade_helper.bats — tests for the OS-aware upgrade-helper spawn.
#
# The 2026-05-18 v0.3.0 → v0.3.1 first live trial proved that
# nohup+disown doesn't survive launchd's job reap. The fix in
# supervisor-loop.sh dispatches on OS:
#
#   Darwin → render upgrader plist + launchctl bootstrap a SEPARATE job
#   Linux  → systemd-run --user --no-block transient unit
#   other  → fall back to old nohup pattern (best-effort)
#
# These tests stub launchctl/systemd-run/uname and verify the right
# command shape gets emitted for each platform. We don't actually
# bootstrap real launchd jobs in tests — the unit-level concern is the
# dispatch + command-construction logic.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    TMP_HOME="$(mktemp -d -t advspawn)"
    export HOME="${TMP_HOME}"
    export DAEMON_HOME="${TMP_HOME}/.autonomous-dev"
    mkdir -p "${DAEMON_HOME}/logs" "${TMP_HOME}/Library/LaunchAgents"
    LOG_DIR="${DAEMON_HOME}/logs"
    SPAWN_INVOCATIONS="${TMP_HOME}/.spawn-invocations"
    : > "${SPAWN_INVOCATIONS}"

    # Silence the loggers
    log_info() { :; }
    log_warn() { :; }
    log_error() { :; }

    extract_fn() {
        local fn_name="$1"
        local src="${PLUGIN_DIR}/bin/supervisor-loop.sh"
        awk -v fn="${fn_name}" '
            $0 ~ "^"fn"\\(\\) \\{" { in_fn = 1; print; next }
            in_fn { print }
            in_fn && $0 ~ "^\\}$" { in_fn = 0 }
        ' "${src}"
    }
    eval "$(extract_fn _spawn_upgrade_helper)"
    eval "$(extract_fn _spawn_upgrade_helper_macos)"
    eval "$(extract_fn _spawn_upgrade_helper_linux)"
    eval "$(extract_fn _spawn_upgrade_helper_fallback)"
}

teardown() {
    rm -rf "${TMP_HOME}"
}

# --- _spawn_upgrade_helper_macos --------------------------------------------

@test "macos spawn renders the upgrader plist with the right installer path" {
    # Stub launchctl + plutil + uname
    launchctl() {
        echo "launchctl $*" >> "${SPAWN_INVOCATIONS}"
        # Fail the print-check so the bootout branch is skipped
        if [[ "$1" == "print" ]]; then return 1; fi
        return 0
    }
    plutil() { return 0; }
    export -f launchctl plutil

    _spawn_upgrade_helper_macos "/fake/cache/0.5.0/bin/install-daemon.sh"
    [[ "${status:-0}" -eq 0 ]]

    # Plist should have been rendered into the LaunchAgents dir
    local plist="${HOME}/Library/LaunchAgents/com.autonomous-dev.daemon.upgrader.plist"
    [[ -f "${plist}" ]]
    grep -q "/fake/cache/0.5.0/bin/install-daemon.sh" "${plist}"

    # launchctl bootstrap should have been called
    grep -q "launchctl bootstrap" "${SPAWN_INVOCATIONS}"
}

@test "macos spawn bootouts any leftover upgrader job before bootstrapping" {
    launchctl() {
        echo "launchctl $*" >> "${SPAWN_INVOCATIONS}"
        # Pretend a previous upgrader is loaded
        if [[ "$1" == "print" ]]; then return 0; fi
        return 0
    }
    plutil() { return 0; }
    export -f launchctl plutil

    _spawn_upgrade_helper_macos "/fake/install-daemon.sh"
    grep -q "launchctl bootout" "${SPAWN_INVOCATIONS}"
    grep -q "launchctl bootstrap" "${SPAWN_INVOCATIONS}"
}

@test "macos spawn falls back to nohup when launchctl bootstrap fails" {
    launchctl() {
        if [[ "$1" == "print" ]]; then return 1; fi
        if [[ "$1" == "bootstrap" ]]; then return 1; fi
        return 0
    }
    plutil() { return 0; }
    export -f launchctl plutil
    # nohup is real; we just need to make sure the path is reachable.
    # The fallback writes to LOG_DIR/upgrade-helper.log — confirm.
    run _spawn_upgrade_helper_macos "/fake/install-daemon.sh"
    [[ "${status}" -eq 0 ]]
    # Helper log should exist (created by the redirection, even if 0 bytes)
    [[ -f "${LOG_DIR}/upgrade-helper.log" ]]
}

@test "macos spawn falls back to nohup when plutil rejects the rendered plist" {
    launchctl() { :; }
    plutil() { return 1; }   # always reject
    export -f launchctl plutil
    run _spawn_upgrade_helper_macos "/fake/install-daemon.sh"
    [[ "${status}" -eq 0 ]]
    [[ -f "${LOG_DIR}/upgrade-helper.log" ]]
    # The rejected plist should have been removed
    [[ ! -f "${HOME}/Library/LaunchAgents/com.autonomous-dev.daemon.upgrader.plist" ]]
}

# --- _spawn_upgrade_helper_linux --------------------------------------------

@test "linux spawn calls systemd-run with the installer path" {
    systemd_run_invocations="${TMP_HOME}/.systemd-run-args"
    systemd-run() {
        echo "$@" >> "${systemd_run_invocations}"
        return 0
    }
    command() {
        # Make our `command -v systemd-run` resolve
        if [[ "$1" == "-v" && "$2" == "systemd-run" ]]; then echo "/usr/bin/systemd-run"; return 0; fi
        builtin command "$@"
    }
    export -f systemd-run command

    _spawn_upgrade_helper_linux "/some/install-daemon.sh"
    grep -q "/some/install-daemon.sh" "${systemd_run_invocations}"
    grep -q -- "--user" "${systemd_run_invocations}"
    grep -q -- "--no-block" "${systemd_run_invocations}"
}

@test "linux spawn falls back when systemd-run is missing" {
    command() {
        if [[ "$1" == "-v" && "$2" == "systemd-run" ]]; then return 1; fi
        builtin command "$@"
    }
    export -f command
    run _spawn_upgrade_helper_linux "/some/install-daemon.sh"
    [[ "${status}" -eq 0 ]]
    [[ -f "${LOG_DIR}/upgrade-helper.log" ]]
}

# --- _spawn_upgrade_helper (dispatcher) -------------------------------------

@test "dispatcher routes Darwin to macos path" {
    uname() { echo "Darwin"; }
    _spawn_upgrade_helper_macos() { echo "macos called: $1" > "${TMP_HOME}/.dispatched"; return 0; }
    export -f uname _spawn_upgrade_helper_macos
    _spawn_upgrade_helper "/some/installer.sh"
    grep -q "macos called: /some/installer.sh" "${TMP_HOME}/.dispatched"
}

@test "dispatcher routes Linux to linux path" {
    uname() { echo "Linux"; }
    _spawn_upgrade_helper_linux() { echo "linux called: $1" > "${TMP_HOME}/.dispatched"; return 0; }
    export -f uname _spawn_upgrade_helper_linux
    _spawn_upgrade_helper "/some/installer.sh"
    grep -q "linux called: /some/installer.sh" "${TMP_HOME}/.dispatched"
}

@test "dispatcher routes unknown OS to fallback" {
    uname() { echo "FreeBSD"; }
    _spawn_upgrade_helper_fallback() { echo "fallback called: $1" > "${TMP_HOME}/.dispatched"; return 0; }
    export -f uname _spawn_upgrade_helper_fallback
    _spawn_upgrade_helper "/some/installer.sh"
    grep -q "fallback called: /some/installer.sh" "${TMP_HOME}/.dispatched"
}
