#!/usr/bin/env bats
###############################################################################
# install_daemon_race_safe.bats — #550 regression guard
#
# install-daemon.sh is run by BOTH the operator (`install-daemon --force`) and
# the daemon's auto-upgrader (and the rollback path). With no serialization,
# concurrent bootout/bootstrap of the same launchd label produced
# `Bootstrap failed: 5: Input/output error` + a restart loop. The fix adds:
#   - a deploy lock (acquire/release, stale-reclaim, fail-open),
#   - confirmed-down wait after bootout,
#   - bootstrap retry on transient EIO/busy-domain failures.
#
# These tests source install-daemon.sh (its sourcing guard suppresses main) and
# exercise the helpers with a stubbed launchctl + no-op sleep.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    TMP_HOME="$(mktemp -d -t advinstall)"
    export HOME="${TMP_HOME}"
    mkdir -p "${TMP_HOME}/.autonomous-dev"

    STATE_DIR="${TMP_HOME}/state"
    mkdir -p "${STATE_DIR}"
    ATTEMPTS_FILE="${STATE_DIR}/bootstrap-attempts"
    LOADED_FILE="${STATE_DIR}/label-loaded"
    : > "${ATTEMPTS_FILE}"

    # Source the script — the `BASH_SOURCE == $0` guard keeps main() from running.
    # shellcheck source=/dev/null
    source "${PLUGIN_DIR}/bin/install-daemon.sh"

    # No-op sleep so retry/backoff doesn't slow the suite.
    sleep() { :; }
}

teardown() {
    rm -rf "${TMP_HOME}"
}

# Stub launchctl. Behavior is driven by STATE_DIR files set per-test.
# BOOTSTRAP_FAIL_UNTIL: fail (rc=$BOOTSTRAP_FAIL_RC) for attempts < this, then
# mark loaded and succeed. BOOTSTRAP_ALWAYS_RC: if set, always return it.
launchctl() {
    case "$1" in
        bootstrap)
            local n
            n=$(( $(cat "${ATTEMPTS_FILE}") + 1 )); echo "${n}" > "${ATTEMPTS_FILE}"
            if [[ -n "${BOOTSTRAP_ALWAYS_RC:-}" ]]; then return "${BOOTSTRAP_ALWAYS_RC}"; fi
            if (( n < ${BOOTSTRAP_FAIL_UNTIL:-1} )); then return "${BOOTSTRAP_FAIL_RC:-5}"; fi
            echo loaded > "${LOADED_FILE}"; return 0
            ;;
        print)
            [[ -f "${LOADED_FILE}" ]] && return 0 || return 1
            ;;
        bootout)
            rm -f "${LOADED_FILE}"; return 0
            ;;
        *) return 0 ;;
    esac
}

@test "550: bootstrap_with_retry retries past a transient EIO then succeeds" {
    export BOOTSTRAP_FAIL_UNTIL=2 BOOTSTRAP_FAIL_RC=5   # attempt 1 → EIO, attempt 2 → ok
    run bootstrap_with_retry "gui/0" "/tmp/plist" "com.autonomous-dev.daemon"
    [ "$status" -eq 0 ]
    [ "$(cat "${ATTEMPTS_FILE}")" -eq 2 ]
}

@test "550: bootstrap_with_retry treats a present label as success even on non-zero rc (EALREADY)" {
    echo loaded > "${LOADED_FILE}"        # label already loaded
    export BOOTSTRAP_ALWAYS_RC=37         # bootstrap keeps returning EALREADY
    run bootstrap_with_retry "gui/0" "/tmp/plist" "com.autonomous-dev.daemon"
    [ "$status" -eq 0 ]
}

@test "550: bootstrap_with_retry gives up (non-zero) after exhausting retries" {
    export BOOTSTRAP_ALWAYS_RC=5          # never succeeds, label never loads
    run bootstrap_with_retry "gui/0" "/tmp/plist" "com.autonomous-dev.daemon"
    [ "$status" -ne 0 ]
}

@test "550: wait_for_label_down returns 0 immediately when the label is absent" {
    rm -f "${LOADED_FILE}"
    run wait_for_label_down "com.autonomous-dev.daemon" 3
    [ "$status" -eq 0 ]
}

@test "550: wait_for_label_down returns 1 when the label never goes down" {
    echo loaded > "${LOADED_FILE}"
    run wait_for_label_down "com.autonomous-dev.daemon" 2
    [ "$status" -eq 1 ]
}

@test "550: deploy lock — acquire then release is exclusive" {
    acquire_deploy_lock 2
    [ "${DEPLOY_LOCK_HELD}" = "true" ]
    [ -d "${DEPLOY_LOCK_DIR}" ]
    release_deploy_lock
    [ "${DEPLOY_LOCK_HELD}" = "false" ]
    [ ! -d "${DEPLOY_LOCK_DIR}" ]
}

@test "550: deploy lock — busy lock fails OPEN (never wedges the install)" {
    mkdir -p "${DEPLOY_LOCK_DIR}"          # someone else holds it (fresh, not stale)
    # Called directly (not `run`) so the global DEPLOY_LOCK_HELD it sets is
    # visible here; acquire always returns 0 (fail-open) so it can't abort.
    acquire_deploy_lock 1                  # bounded wait → proceed without it
    [ "${DEPLOY_LOCK_HELD}" = "false" ]    # we did NOT claim someone else's lock
    [ -d "${DEPLOY_LOCK_DIR}" ]            # and left it in place
}

@test "550: deploy lock — a stale lock is reclaimed" {
    mkdir -p "${DEPLOY_LOCK_DIR}"
    touch -t 200001010000 "${DEPLOY_LOCK_DIR}"   # year 2000 → far older than the stale threshold
    acquire_deploy_lock 2
    [ "${DEPLOY_LOCK_HELD}" = "true" ]            # reclaimed + acquired
    release_deploy_lock
}

@test "550: release only removes a lock we own (held=false is a no-op)" {
    mkdir -p "${DEPLOY_LOCK_DIR}"          # owned by someone else
    DEPLOY_LOCK_HELD=false
    release_deploy_lock
    [ -d "${DEPLOY_LOCK_DIR}" ]            # untouched
}
