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

# --- #386: a partial proposal must not destroy unmentioned config keys -------

@test "partial proposed (notifications-only) preserves repositories.allowlist (#386)" {
    echo '{"repositories":{"allowlist":["/repo/a","/repo/b"]},"notifications":{"dndEnabled":false}}' > "$CFG"
    _marker "c6.json" '{"id":"c6","source":"portal","actor":"op","ts":"2026-06-09T00:00:00Z","summary":"toggle dnd","proposed":{"notifications":{"dndEnabled":true}}}'
    consume_config_changes
    # the notifications edit IS applied...
    run jq -r '.notifications.dndEnabled' "$CFG"
    [ "$output" = "true" ]
    # ...and the allowlist survives (the bug wiped it to null)
    run jq -c '.repositories.allowlist' "$CFG"
    [ "$output" = '["/repo/a","/repo/b"]' ]
    [ -f "$CC_DIR/applied/c6.json" ]
}

@test "proposed that includes repositories still replaces the allowlist (#386)" {
    echo '{"repositories":{"allowlist":["/repo/a"]},"notifications":{"dndEnabled":false}}' > "$CFG"
    _marker "c7.json" '{"id":"c7","source":"portal","actor":"op","ts":"2026-06-09T00:00:00Z","summary":"set allowlist","proposed":{"repositories":{"allowlist":["/repo/x","/repo/y"]}}}'
    consume_config_changes
    run jq -c '.repositories.allowlist' "$CFG"
    [ "$output" = '["/repo/x","/repo/y"]' ]
    # an unmentioned key (notifications) is still preserved
    run jq -r '.notifications.dndEnabled' "$CFG"
    [ "$output" = "false" ]
}

# --- apply ORDER: chronological by .ts, never filename/glob order ----------

@test "markers apply in ts order — newer save wins over older despite filenames (#chrono)" {
    # Filename order (aaa < zzz) is the REVERSE of ts order here.
    _marker "aaa-newer.json" '{"id":"n1","source":"portal","actor":"op","ts":"2026-06-12T15:20:00Z","summary":"newer","proposed":{"notifications":{"delivery":{"discord":{"webhook_url":"https://discord.com/api/webhooks/1/NEW"}}}}}'
    _marker "zzz-older.json" '{"id":"o1","source":"portal","actor":"op","ts":"2026-06-12T15:14:00Z","summary":"older","proposed":{"notifications":{"delivery":{"discord":{"webhook_url":""}},"dndEnabled":true}}}'
    consume_config_changes
    # newer (15:20) must apply LAST → webhook present
    run jq -r '.notifications.delivery.discord.webhook_url' "$CFG"
    [ "$output" = "https://discord.com/api/webhooks/1/NEW" ]
    [ -f "$CC_DIR/applied/aaa-newer.json" ]
    [ -f "$CC_DIR/applied/zzz-older.json" ]
}
