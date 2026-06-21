#!/usr/bin/env bats
###############################################################################
# heartbeat_start_time.bats — #356 regression guard
#
# The daemon's write_heartbeat() must emit `start_time` (set once at startup)
# alongside iteration_count + active_request_id, so the portal can derive uptime
# (FR-404). Extracts write_heartbeat from supervisor-loop.sh and exercises it.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    TMP="$(mktemp -d -t adv-hb-XXXXXX)"
    HEARTBEAT_FILE="${TMP}/heartbeat.json"

    # Extract just write_heartbeat() so we don't run supervisor-loop's top-level.
    eval "$(awk '/^write_heartbeat\(\) \{/{f=1} f{print} f&&/^\}$/{exit}' \
        "${PLUGIN_DIR}/bin/supervisor-loop.sh")"
}

teardown() {
    rm -rf "${TMP}"
}

@test "356: write_heartbeat emits start_time, iteration_count, active_request_id" {
    ITERATION_COUNT=12
    DAEMON_START_TIME="2026-06-21T00:00:00Z"
    write_heartbeat "REQ-000042"

    [ -f "${HEARTBEAT_FILE}" ]
    [ "$(jq -r '.start_time' "${HEARTBEAT_FILE}")" = "2026-06-21T00:00:00Z" ]
    [ "$(jq -r '.iteration_count' "${HEARTBEAT_FILE}")" = "12" ]
    [ "$(jq -r '.active_request_id' "${HEARTBEAT_FILE}")" = "REQ-000042" ]
}

@test "356: start_time is null when DAEMON_START_TIME is unset (pre-startup safety)" {
    ITERATION_COUNT=0
    DAEMON_START_TIME=""
    write_heartbeat

    [ "$(jq -r '.start_time' "${HEARTBEAT_FILE}")" = "null" ]
    [ "$(jq -r '.active_request_id' "${HEARTBEAT_FILE}")" = "null" ]
}
