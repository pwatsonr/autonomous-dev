#!/usr/bin/env bats

# Tests for consume_config_changes() — PRD-025 FR-025-05 / #353.
# The daemon validates + applies portal-written config-change markers and
# archives/rejects them; it never trusts a malformed or non-portal marker.

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    TEST_WORK_DIR="$(mktemp -d)"
    export HOME="$TEST_WORK_DIR/home"
    export AUTONOMOUS_DEV_STATE_DIR="$TEST_WORK_DIR/state"
    mkdir -p "$HOME/.autonomous-dev/logs" "$HOME/.claude" "$AUTONOMOUS_DEV_STATE_DIR/config-changes"

    set +e
    source "$PLUGIN_DIR/bin/supervisor-loop.sh"
    set -e

    CC_DIR="$AUTONOMOUS_DEV_STATE_DIR/config-changes"
    CFG="$HOME/.claude/autonomous-dev.json"
    echo '{"governance":{"daily_cost_cap_usd":100}}' > "$CFG"
}

teardown() { rm -rf "$TEST_WORK_DIR"; }

_marker() { # $1=file $2=json
    echo "$2" > "$CC_DIR/$1"
}

@test "valid portal marker is applied to CONFIG_FILE and archived" {
    _marker "c1.json" '{"id":"c1","source":"portal","actor":"op","ts":"2026-06-09T00:00:00Z","summary":"raise cap","proposed":{"governance":{"daily_cost_cap_usd":250}}}'
    consume_config_changes
    run jq -r '.governance.daily_cost_cap_usd' "$CFG"
    [ "$output" = "250" ]
    [ -f "$CC_DIR/applied/c1.json" ]
    [ ! -f "$CC_DIR/c1.json" ]
}

@test "non-portal source is rejected, config untouched" {
    _marker "c2.json" '{"id":"c2","source":"cli","actor":"x","proposed":{"governance":{"daily_cost_cap_usd":999}}}'
    consume_config_changes
    run jq -r '.governance.daily_cost_cap_usd' "$CFG"
    [ "$output" = "100" ]
    [ -f "$CC_DIR/rejected/c2.json" ]
}

@test "corrupt JSON marker is rejected, config untouched" {
    _marker "c3.json" '{not valid json'
    consume_config_changes
    run jq -r '.governance.daily_cost_cap_usd' "$CFG"
    [ "$output" = "100" ]
    [ -f "$CC_DIR/rejected/c3.json" ]
}

@test "marker with non-object proposed is rejected" {
    _marker "c4.json" '{"id":"c4","source":"portal","proposed":"oops"}'
    consume_config_changes
    run jq -r '.governance.daily_cost_cap_usd' "$CFG"
    [ "$output" = "100" ]
    [ -f "$CC_DIR/rejected/c4.json" ]
}

@test "no markers: no-op, config untouched" {
    consume_config_changes
    run jq -r '.governance.daily_cost_cap_usd' "$CFG"
    [ "$output" = "100" ]
}
