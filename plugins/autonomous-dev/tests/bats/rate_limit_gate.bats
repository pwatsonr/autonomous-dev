#!/usr/bin/env bats

# Integration test for the rate-limit backoff gate wired into check_gates()
# (PRD-025 FR-025-12 / #354). Verifies that an active backoff window — or the
# persistent kill-switch state after the ladder maxes out — blocks an iteration,
# while a cleared/expired state allows work.

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"

    TEST_WORK_DIR="$(mktemp -d)"
    export HOME="$TEST_WORK_DIR/home"
    mkdir -p "$HOME/.autonomous-dev/logs"
    RL_STATE="$HOME/.autonomous-dev/rate-limit-state.json"

    set +e
    # supervisor-loop.sh sources the handler only inside its run-as-main guard,
    # so source both explicitly for the unit context.
    source "$PLUGIN_DIR/bin/supervisor-loop.sh"
    source "$PLUGIN_DIR/lib/rate_limit_handler.sh"
    set -e

    # Neutralize the other gates so we isolate the rate-limit gate.
    CIRCUIT_BREAKER_TRIPPED=false
    rm -f "$HOME/.autonomous-dev/kill-switch.flag"
}

teardown() {
    rm -rf "$TEST_WORK_DIR"
}

@test "check_gates passes when there is no rate-limit state" {
    rm -f "$RL_STATE"
    run check_gates
    [ "$status" -eq 0 ]
}

@test "check_gates blocks while a backoff window is active (retry_at in future)" {
    local future
    if [[ "$(uname)" == "Darwin" ]]; then
        future=$(date -u -v "+300S" +"%Y-%m-%dT%H:%M:%SZ")
    else
        future=$(date -u -d "+300 seconds" +"%Y-%m-%dT%H:%M:%SZ")
    fi
    write_rate_limit_state "$RL_STATE" true 2 60 false "$future"
    run check_gates
    [ "$status" -eq 1 ]
}

@test "check_gates passes once the backoff window has expired" {
    local past
    if [[ "$(uname)" == "Darwin" ]]; then
        past=$(date -u -v "-300S" +"%Y-%m-%dT%H:%M:%SZ")
    else
        past=$(date -u -d "-300 seconds" +"%Y-%m-%dT%H:%M:%SZ")
    fi
    write_rate_limit_state "$RL_STATE" true 2 60 false "$past"
    run check_gates
    [ "$status" -eq 0 ]
}

@test "check_gates blocks while the rate-limit kill switch is set" {
    write_rate_limit_state "$RL_STATE" true 6 900 true
    run check_gates
    [ "$status" -eq 1 ]
}

@test "clear_rate_limit_state lets check_gates pass again" {
    write_rate_limit_state "$RL_STATE" true 6 900 true
    clear_rate_limit_state
    run check_gates
    [ "$status" -eq 0 ]
}
