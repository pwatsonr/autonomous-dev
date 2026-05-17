#!/usr/bin/env bats
###############################################################################
# stage_upgrade.bats — Phase 2 marketplace auto-update tests.
#
# Exercises the gates that `stage_upgrade()` enforces before kicking off
# the detached install-daemon helper:
#
#   • Active-request guard — heartbeat with `active_request_id` set
#     should block the upgrade so we don't kill the daemon mid-phase.
#   • Throttle — `.upgrade-throttle` mtime within UPGRADE_THROTTLE_SECONDS
#     blocks repeat attempts (avoid bouncing if cache churns).
#   • Missing installer — won't try to upgrade to a version whose
#     install-daemon.sh isn't on disk.
#
# We don't exercise the launchctl bootstrap path here — that needs a
# real session and is covered by manual smoke. These tests stand the
# guard logic up in isolation by sourcing version-helpers + the gate
# functions and stubbing the daemon-state files.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    TMP_HOME="$(mktemp -d -t advstage)"
    # Anchor HOME inside the temp dir so the installer lookup
    # (`$HOME/.claude/plugins/cache/...`) can't see the real cache.
    export HOME="${TMP_HOME}"
    export DAEMON_HOME="${TMP_HOME}/.autonomous-dev"
    mkdir -p "${DAEMON_HOME}/logs"
    HEARTBEAT_FILE="${DAEMON_HOME}/heartbeat.json"
    UPGRADE_THROTTLE_FILE="${DAEMON_HOME}/.upgrade-throttle"
    LAST_GOOD_VERSION_FILE="${DAEMON_HOME}/.last-good-version"
    LOG_DIR="${DAEMON_HOME}/logs"
    UPGRADE_THROTTLE_SECONDS=3600
    SHUTDOWN_REQUESTED=false
    # Stub the loggers — we only care about return codes / side effects.
    log_info() { :; }
    log_warn() { :; }
    # Source the two gate functions we want to test. They're at the
    # bottom of supervisor-loop.sh, but the whole file is too big to
    # source — extract just upgrade_throttled and stage_upgrade.
    extract_fn() {
        local fn_name="$1"
        local src="${PLUGIN_DIR}/bin/supervisor-loop.sh"
        awk -v fn="${fn_name}" '
            $0 ~ "^"fn"\\(\\) \\{" { in_fn = 1; depth = 1; print; next }
            in_fn { print }
            in_fn && $0 ~ "^\\}$" { in_fn = 0; depth = 0 }
        ' "${src}"
    }
    eval "$(extract_fn upgrade_throttled)"
    eval "$(extract_fn stage_upgrade)"
}

teardown() {
    rm -rf "${TMP_HOME}"
}

write_heartbeat_with_active() {
    local active="${1}"
    printf '{"timestamp":"2026-05-17T18:00:00Z","pid":1234,"iteration_count":1,"active_request_id":%s}\n' "${active}" \
        > "${HEARTBEAT_FILE}"
}

make_fake_installer() {
    local version="$1"
    local cache_root="${TMP_HOME}/cache/autonomous-dev/autonomous-dev"
    mkdir -p "${cache_root}/${version}/bin"
    cat > "${cache_root}/${version}/bin/install-daemon.sh" <<'EOF'
#!/usr/bin/env bash
echo "fake-installer ran" > /tmp/.advstage-installer-marker
EOF
    chmod +x "${cache_root}/${version}/bin/install-daemon.sh"
    HOME="${TMP_HOME}"   # so $HOME/.claude/... maps here — symlink it.
    mkdir -p "${TMP_HOME}/.claude/plugins"
    ln -sfn "${TMP_HOME}/cache" "${TMP_HOME}/.claude/plugins/cache"
}

# --- upgrade_throttled -------------------------------------------------------

@test "upgrade_throttled: no file -> not throttled" {
    run upgrade_throttled
    [[ "${status}" -ne 0 ]]
}

@test "upgrade_throttled: fresh touch -> throttled" {
    touch "${UPGRADE_THROTTLE_FILE}"
    run upgrade_throttled
    [[ "${status}" -eq 0 ]]
}

@test "upgrade_throttled: stale mtime past window -> not throttled" {
    touch "${UPGRADE_THROTTLE_FILE}"
    # Backdate the file two hours.
    local past
    past=$(( $(date +%s) - 7200 ))
    touch -t "$(date -r ${past} +%Y%m%d%H%M.%S 2>/dev/null || date -d @${past} +%Y%m%d%H%M.%S)" \
        "${UPGRADE_THROTTLE_FILE}"
    run upgrade_throttled
    [[ "${status}" -ne 0 ]]
}

# --- stage_upgrade guards ----------------------------------------------------

@test "stage_upgrade: skips when active_request_id is set" {
    write_heartbeat_with_active '"REQ-000001"'
    make_fake_installer "0.2.0"
    run stage_upgrade "0.1.0" "0.2.0"
    [[ "${status}" -ne 0 ]]
    # No throttle should have been written (we skipped before touching).
    [[ ! -f "${UPGRADE_THROTTLE_FILE}" ]]
    # Shutdown should NOT be requested.
    [[ "${SHUTDOWN_REQUESTED}" == "false" ]]
}

@test "stage_upgrade: skips when same version" {
    write_heartbeat_with_active 'null'
    run stage_upgrade "0.2.0" "0.2.0"
    [[ "${status}" -ne 0 ]]
}

@test "stage_upgrade: skips when throttle file is fresh" {
    write_heartbeat_with_active 'null'
    make_fake_installer "0.2.0"
    touch "${UPGRADE_THROTTLE_FILE}"
    run stage_upgrade "0.1.0" "0.2.0"
    [[ "${status}" -ne 0 ]]
}

@test "stage_upgrade: skips when installer is missing" {
    write_heartbeat_with_active 'null'
    run stage_upgrade "0.1.0" "0.2.0"
    [[ "${status}" -ne 0 ]]
}
