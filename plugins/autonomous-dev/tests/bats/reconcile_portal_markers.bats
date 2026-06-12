#!/usr/bin/env bats

# Tests for reconcile_portal_markers() — #390 daemon half.
# Stale portal request-action markers (e.g. after a CLI cancel, which runs
# outside the supervisor) must be refreshed from the canonical state.json,
# and gate-decision files for terminal requests must be removed.

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    TEST_WORK_DIR="$(mktemp -d)"
    export HOME="$TEST_WORK_DIR/home"
    export AUTONOMOUS_DEV_STATE_DIR="$TEST_WORK_DIR/state"
    mkdir -p "$HOME/.autonomous-dev/logs" \
             "$AUTONOMOUS_DEV_STATE_DIR/request-actions" \
             "$AUTONOMOUS_DEV_STATE_DIR/gate-decisions"

    set +e
    source "$PLUGIN_DIR/bin/supervisor-loop.sh"
    set -e

    # Repo with a canonical state.json
    REPO="$TEST_WORK_DIR/repo-a"
    mkdir -p "$REPO/.autonomous-dev/requests/REQ-000016"

    # Effective config with the repo allowlisted
    EFFECTIVE_CONFIG="$TEST_WORK_DIR/effective.json"
    echo "{\"repositories\":{\"allowlist\":[\"$REPO\"]}}" > "$EFFECTIVE_CONFIG"

    MARKERS="$AUTONOMOUS_DEV_STATE_DIR/request-actions"
    GATES="$AUTONOMOUS_DEV_STATE_DIR/gate-decisions"
}

teardown() { rm -rf "$TEST_WORK_DIR"; }

_state() { # $1=req $2=status
    cat > "$REPO/.autonomous-dev/requests/$1/state.json" <<JSON
{"id":"$1","status":"$2","current_phase":"code","priority":2,
 "created_at":"2026-06-10T20:00:00Z","updated_at":"2026-06-10T20:30:00Z",
 "title":"t","cost_accrued":1.0,"turn_count":3}
JSON
}

@test "stale running marker for a cancelled request is refreshed + gate file removed" {
    _state "REQ-000016" "cancelled"
    echo '{"id":"REQ-000016","repo":"repo-a","status":"running"}' > "$MARKERS/REQ-000016.json"
    echo '{"id":"REQ-000016","state":"pending"}' > "$GATES/repo-a__REQ-000016.json"

    reconcile_portal_markers

    run jq -r '.status' "$MARKERS/REQ-000016.json"
    [ "$output" = "cancelled" ]
    [ ! -f "$GATES/repo-a__REQ-000016.json" ]
}

@test "stale marker for a failed request is refreshed" {
    mkdir -p "$REPO/.autonomous-dev/requests/REQ-000017"
    _state "REQ-000017" "failed"
    echo '{"id":"REQ-000017","repo":"repo-a","status":"gate"}' > "$MARKERS/REQ-000017.json"

    reconcile_portal_markers

    run jq -r '.status' "$MARKERS/REQ-000017.json"
    [ "$output" = "failed" ]
}

@test "marker for a live running request is untouched" {
    mkdir -p "$REPO/.autonomous-dev/requests/REQ-000020"
    _state "REQ-000020" "running"
    echo '{"id":"REQ-000020","repo":"repo-a","status":"running","cost":9.9}' > "$MARKERS/REQ-000020.json"
    echo '{"id":"REQ-000020","state":"pending"}' > "$GATES/repo-a__REQ-000020.json"

    reconcile_portal_markers

    run jq -r '.cost' "$MARKERS/REQ-000020.json"
    [ "$output" = "9.9" ]   # not rewritten
    [ -f "$GATES/repo-a__REQ-000020.json" ]  # gate file kept for live request
}

@test "already-terminal marker is left alone (no rewrite)" {
    echo '{"id":"REQ-000012","repo":"repo-a","status":"failed","cost":4.0}' > "$MARKERS/REQ-000012.json"
    # no state.json at all — must not matter, terminal markers are skipped first
    reconcile_portal_markers
    run jq -r '.cost' "$MARKERS/REQ-000012.json"
    [ "$output" = "4.0" ]
}

@test "marker with no matching state.json anywhere is left alone" {
    echo '{"id":"REQ-260512","repo":"ghost","status":"running"}' > "$MARKERS/REQ-260512.json"
    reconcile_portal_markers
    run jq -r '.status' "$MARKERS/REQ-260512.json"
    [ "$output" = "running" ]
}

@test "empty allowlist is a no-op" {
    echo '{"repositories":{"allowlist":[]}}' > "$EFFECTIVE_CONFIG"
    echo '{"id":"REQ-000016","repo":"repo-a","status":"running"}' > "$MARKERS/REQ-000016.json"
    reconcile_portal_markers
    run jq -r '.status' "$MARKERS/REQ-000016.json"
    [ "$output" = "running" ]
}
