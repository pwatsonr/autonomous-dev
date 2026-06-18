#!/usr/bin/env bats
###############################################################################
# daemon_start_stop_race.bats - Regression tests for issue #488
#
# `daemon stop` immediately followed by `daemon start` must leave the daemon
# RUNNING. The original bug: start read launchd registration at a single point
# in time, before the async `launchctl bootout` from the preceding stop had
# completed, saw the still-present process, printed "Daemon is already running"
# and no-opped — leaving the daemon down.
#
# These tests source the dispatcher's pure functions and drive them with a
# stateful launchctl/systemctl shim plus a controllable daemon.lock so we can
# simulate the async-bootout window deterministically without a real daemon.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    DISPATCHER="${PLUGIN_DIR}/bin/autonomous-dev.sh"

    BATS_TMP="$(mktemp -d)"
    export HOME="${BATS_TMP}/home"
    mkdir -p "${HOME}"

    # Shim dir on PATH for launchctl/systemctl/id.
    SHIM_DIR="${BATS_TMP}/bin"
    mkdir -p "${SHIM_DIR}"

    # State dir the shims read/write to simulate launchd.
    export LCTL_STATE="${BATS_TMP}/launchd"
    mkdir -p "${LCTL_STATE}"

    # A PID guaranteed alive for the whole test, for the shim to use as the
    # daemon's "live" lock owner.
    export TEST_ALIVE_PID="$$"

    source_dispatcher_functions

    # DAEMON_HOME resolves under the sandboxed HOME (set in the dispatcher).
    # Export it so the launchctl shim subprocess can read/write the lock.
    export DAEMON_HOME
    mkdir -p "${DAEMON_HOME}"
}

teardown() {
    if [[ -n "${BATS_TMP:-}" && -d "${BATS_TMP}" ]]; then
        rm -rf "${BATS_TMP}"
    fi
}

# Extract function definitions up to the routing block (same technique as
# test_cli_dispatcher.bats) so sourcing does not run main().
source_dispatcher_functions() {
    local tmp
    tmp="$(mktemp)"
    awk '/^# Command routing$/{exit} {print}' "${DISPATCHER}" > "${tmp}"
    # shellcheck disable=SC1090
    source "${tmp}"
    rm -f "${tmp}"
}

# ---------------------------------------------------------------------------
# Stateful launchctl shim.
#   registered marker:  ${LCTL_STATE}/registered
#   bootout countdown:  ${LCTL_STATE}/bootout_countdown
#     When present, each `print` decrements it; on reaching 0 the registered
#     marker is removed — simulating an asynchronous bootout that lingers for
#     a few liveness probes before the process actually disappears.
# ---------------------------------------------------------------------------
install_launchctl_shim() {
    cat > "${SHIM_DIR}/launchctl" <<'EOF'
#!/usr/bin/env bash
state="${LCTL_STATE}"
cmd="$1"
case "${cmd}" in
    print)
        if [[ -f "${state}/bootout_countdown" ]]; then
            n=$(cat "${state}/bootout_countdown" 2>/dev/null || echo 0)
            n=$((n - 1))
            if (( n <= 0 )); then
                # Async shutdown completes: registration AND the live lock
                # both disappear (the daemon process has exited).
                rm -f "${state}/registered" "${state}/bootout_countdown"
                rm -f "${DAEMON_HOME}/daemon.lock"
            else
                echo "${n}" > "${state}/bootout_countdown"
            fi
        fi
        [[ -f "${state}/registered" ]]
        exit $?
        ;;
    bootout)
        # Async: schedule de-registration after a few probes, do NOT remove now.
        echo "${BOOTOUT_DELAY:-2}" > "${state}/bootout_countdown"
        exit 0
        ;;
    bootstrap)
        rm -f "${state}/bootout_countdown"
        : > "${state}/registered"
        # Simulate the daemon writing a live lock. Use a PID known to be alive
        # for the duration of the test (the bats process), not this short-lived
        # shim's own PID.
        echo "${TEST_ALIVE_PID:-$$}" > "${DAEMON_HOME}/daemon.lock"
        exit 0
        ;;
    *)
        exit 0
        ;;
esac
EOF
    chmod +x "${SHIM_DIR}/launchctl"

    # Deterministic uid for the gui/<uid>/ label.
    cat > "${SHIM_DIR}/id" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == "-u" ]] && { echo 501; exit 0; }
exec /usr/bin/id "$@"
EOF
    chmod +x "${SHIM_DIR}/id"
}

# systemctl shim: --user start is synchronous + idempotent; is-enabled true.
install_systemctl_shim() {
    cat > "${SHIM_DIR}/systemctl" <<'EOF'
#!/usr/bin/env bash
state="${LCTL_STATE}"
for a in "$@"; do
    case "$a" in
        is-enabled) exit 0 ;;
        start)      : > "${state}/sd_running"; exit 0 ;;
        stop)       rm -f "${state}/sd_running"; exit 0 ;;
        is-active)  [[ -f "${state}/sd_running" ]]; exit $? ;;
    esac
done
exit 0
EOF
    chmod +x "${SHIM_DIR}/systemctl"
}

# Force the macOS branch and install the launchd plist the start path checks.
setup_macos() {
    install_launchctl_shim
    mkdir -p "${HOME}/Library/LaunchAgents"
    : > "${HOME}/Library/LaunchAgents/com.autonomous-dev.daemon.plist"
    detect_os() { echo "macos"; }
}

setup_linux() {
    install_systemctl_shim
    detect_os() { echo "linux"; }
}

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@test "488 macos: stop waits for confirmed-down" {
    setup_macos
    : > "${LCTL_STATE}/registered"
    echo 99999 > "${DAEMON_HOME}/daemon.lock"   # stale pid (not alive)

    PATH="${SHIM_DIR}:${PATH}" run cmd_daemon_stop
    [ "$status" -eq 0 ]
    [[ "$output" == *"Daemon stopped"* ]]
    # After a confirmed-down stop, the registration is gone.
    PATH="${SHIM_DIR}:${PATH}" run launchctl print "gui/501/com.autonomous-dev.daemon"
    [ "$status" -ne 0 ]
}

@test "488 macos: stop-then-start leaves daemon RUNNING (the bug)" {
    setup_macos
    # Daemon currently up: registered + live lock.
    : > "${LCTL_STATE}/registered"
    echo "$$" > "${DAEMON_HOME}/daemon.lock"

    PATH="${SHIM_DIR}:${PATH}" run cmd_daemon_stop
    [ "$status" -eq 0 ]

    # bootout is async (countdown lingers); start must NOT falsely report
    # "already running" — it must end up bootstrapped.
    PATH="${SHIM_DIR}:${PATH}" run cmd_daemon_start
    [ "$status" -eq 0 ]
    [[ "$output" == *"Daemon started"* ]]
    [[ "$output" != *"already running"* ]]

    # Ground truth: registered after start.
    PATH="${SHIM_DIR}:${PATH}" run launchctl print "gui/501/com.autonomous-dev.daemon"
    [ "$status" -eq 0 ]
}

@test "488 macos: start during an in-flight async bootout still ends up running" {
    # Isolates the START-side fix: simulate the exact race window where the
    # preceding stop's bootout has not yet completed — registration is still
    # present and the (dying) process lock is still alive — and invoke start
    # WITHOUT going through our confirmed-down stop. A point-in-time start
    # check would see "registered" and no-op; the fix must (re)bootstrap.
    setup_macos
    : > "${LCTL_STATE}/registered"
    echo "$$" > "${DAEMON_HOME}/daemon.lock"     # lock looks alive...
    echo 2 > "${LCTL_STATE}/bootout_countdown"   # ...but a bootout is pending

    PATH="${SHIM_DIR}:${PATH}" run cmd_daemon_start
    [ "$status" -eq 0 ]
    [[ "$output" == *"Daemon started"* ]]
    [[ "$output" != *"already running"* ]]

    # Registered after start, and lock points at a live PID.
    PATH="${SHIM_DIR}:${PATH}" run launchctl print "gui/501/com.autonomous-dev.daemon"
    [ "$status" -eq 0 ]
    run cat "${DAEMON_HOME}/daemon.lock"
    [ "$status" -eq 0 ]
    kill -0 "$output" 2>/dev/null
}

@test "488 macos: start is idempotent when daemon genuinely running" {
    setup_macos
    : > "${LCTL_STATE}/registered"
    echo "$$" > "${DAEMON_HOME}/daemon.lock"   # alive
    # No pending bootout countdown -> genuinely up.

    PATH="${SHIM_DIR}:${PATH}" run cmd_daemon_start
    [ "$status" -eq 0 ]
    [[ "$output" == *"already running"* ]]
}

@test "488 macos: start recovers a registered-but-dead daemon" {
    setup_macos
    : > "${LCTL_STATE}/registered"
    echo 99999 > "${DAEMON_HOME}/daemon.lock"   # registered but NOT alive

    PATH="${SHIM_DIR}:${PATH}" run cmd_daemon_start
    [ "$status" -eq 0 ]
    [[ "$output" == *"Daemon started"* ]]
    [[ "$output" != *"already running"* ]]
}

@test "488 macos: restart ends up running" {
    setup_macos
    : > "${LCTL_STATE}/registered"
    echo "$$" > "${DAEMON_HOME}/daemon.lock"

    PATH="${SHIM_DIR}:${PATH}" run cmd_daemon_restart
    [ "$status" -eq 0 ]
    [[ "$output" == *"Daemon started"* ]]
    PATH="${SHIM_DIR}:${PATH}" run launchctl print "gui/501/com.autonomous-dev.daemon"
    [ "$status" -eq 0 ]
}

@test "488 linux: stop-then-start leaves service running" {
    setup_linux
    : > "${LCTL_STATE}/sd_running"

    PATH="${SHIM_DIR}:${PATH}" run cmd_daemon_stop
    [ "$status" -eq 0 ]
    PATH="${SHIM_DIR}:${PATH}" run cmd_daemon_start
    [ "$status" -eq 0 ]
    [[ "$output" == *"Daemon started"* ]]
    PATH="${SHIM_DIR}:${PATH}" run systemctl --user is-active autonomous-dev.service
    [ "$status" -eq 0 ]
}
