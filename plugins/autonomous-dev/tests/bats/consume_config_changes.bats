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

# --- #507: a partial proposal must preserve NESTED sibling keys --------------
# The earlier shallow `+` merge only protected TOP-LEVEL keys, so a trust-level
# change that proposed `{trust:{system_default_level:N}}` silently dropped the
# sibling `trust.per_repo_overrides`. The deep `*` merge keeps it.

@test "trust-level-only change preserves trust.per_repo_overrides (#507)" {
    echo '{"trust":{"system_default_level":1,"per_repo_overrides":{"repoA":"L3"}},"governance":{"daily_cost_cap_usd":100}}' > "$CFG"
    _marker "t1.json" '{"id":"t1","source":"portal","actor":"op","ts":"2026-06-18T00:00:00Z","summary":"trust level","proposed":{"trust":{"system_default_level":2}}}'
    consume_config_changes
    # the trust level IS applied...
    run jq -r '.trust.system_default_level' "$CFG"
    [ "$output" = "2" ]
    # ...and the sibling per-repo overrides survive (the shallow `+` wiped them)
    run jq -c '.trust.per_repo_overrides' "$CFG"
    [ "$output" = '{"repoA":"L3"}' ]
    # ...and an unrelated top-level key is still preserved
    run jq -r '.governance.daily_cost_cap_usd' "$CFG"
    [ "$output" = "100" ]
    [ -f "$CC_DIR/applied/t1.json" ]
}

@test "trust round-trips: full-document trust proposal applies both fields (#507)" {
    # Mirrors what the portal's FileSettingsStore actually emits: it spreads the
    # current config, so proposed.trust carries both the new level and the
    # existing overrides. Either way (partial or full), both must survive.
    echo '{"trust":{"system_default_level":1,"per_repo_overrides":{"repoA":"L3"}}}' > "$CFG"
    _marker "t2.json" '{"id":"t2","source":"portal","actor":"op","ts":"2026-06-18T00:00:00Z","summary":"settings: trust level","proposed":{"trust":{"system_default_level":3,"per_repo_overrides":{"repoA":"L3"}}}}'
    consume_config_changes
    run jq -r '.trust.system_default_level' "$CFG"
    [ "$output" = "3" ]
    run jq -c '.trust.per_repo_overrides' "$CFG"
    [ "$output" = '{"repoA":"L3"}' ]
    [ -f "$CC_DIR/applied/t2.json" ]
}

@test "deep merge preserves a nested notifications sibling while clearing a webhook (#507)" {
    # A webhook CLEAR (scalar -> "") must still replace the secret, while a
    # sibling nested key the proposal didn't mention (default_method) survives.
    echo '{"notifications":{"delivery":{"discord":{"webhook_url":"https://discord.com/api/webhooks/1/SECRET"},"default_method":"discord"}}}' > "$CFG"
    _marker "t3.json" '{"id":"t3","source":"portal","actor":"op","ts":"2026-06-18T00:00:00Z","summary":"clear discord","proposed":{"notifications":{"delivery":{"discord":{"webhook_url":""}}}}}'
    consume_config_changes
    # scalar replace: the secret is cleared
    run jq -r '.notifications.delivery.discord.webhook_url' "$CFG"
    [ "$output" = "" ]
    # nested sibling under delivery is preserved (shallow `+` on delivery would
    # have dropped default_method)
    run jq -r '.notifications.delivery.default_method' "$CFG"
    [ "$output" = "discord" ]
    [ -f "$CC_DIR/applied/t3.json" ]
}
