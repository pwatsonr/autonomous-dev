#!/usr/bin/env bats

# Tests for check_per_request_cost_cap() — PRD-025 FR-025-11 (#354).
# A request whose accumulated cost_accrued_usd reaches the per-request cap is
# paused + escalated; under-cap and terminal requests are untouched.

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"

    # Isolate HOME so DAEMON_HOME (and emit_alert's writes) land in a tmpdir.
    TEST_WORK_DIR="$(mktemp -d)"
    export HOME="$TEST_WORK_DIR/home"
    mkdir -p "$HOME/.autonomous-dev/logs" "$HOME/.autonomous-dev/alerts"

    set +e
    source "$PLUGIN_DIR/bin/supervisor-loop.sh"
    set -e

    # Pin a small cap for deterministic assertions.
    PER_REQUEST_COST_CAP=10.00

    TEST_PROJECT="$TEST_WORK_DIR/test-project"
    TEST_REQUEST_ID="REQ-260601"
    TEST_REQ_DIR="$TEST_PROJECT/.autonomous-dev/requests/$TEST_REQUEST_ID"
    mkdir -p "$TEST_REQ_DIR"
}

teardown() {
    rm -rf "$TEST_WORK_DIR"
}

_write_state() {
    cat > "$TEST_REQ_DIR/state.json" <<EOF
{
  "id": "$TEST_REQUEST_ID",
  "status": "$1",
  "current_phase": "code",
  "priority": 1,
  "created_at": "2026-06-01T10:00:00Z",
  "updated_at": "2026-06-01T10:00:00Z",
  "cost_accrued_usd": $2
}
EOF
}

@test "under cap: request is left running" {
    _write_state "running" 4.50
    check_per_request_cost_cap "$TEST_REQUEST_ID" "$TEST_PROJECT"
    run jq -r '.status' "$TEST_REQ_DIR/state.json"
    [ "$output" = "running" ]
}

@test "at/over cap: request is paused with a cost reason + event" {
    _write_state "running" 12.34
    check_per_request_cost_cap "$TEST_REQUEST_ID" "$TEST_PROJECT"

    run jq -r '.status' "$TEST_REQ_DIR/state.json"
    [ "$output" = "paused" ]

    run jq -r '.current_phase_metadata.paused_reason' "$TEST_REQ_DIR/state.json"
    [[ "$output" == *"cost cap"* ]]

    # A cost_cap_exceeded event was appended.
    run jq -r '.type' "$TEST_REQ_DIR/events.jsonl"
    [ "$output" = "cost_cap_exceeded" ]
    run jq -r '.details.scope' "$TEST_REQ_DIR/events.jsonl"
    [ "$output" = "per_request" ]
}

@test "exactly at cap: paused (>= boundary)" {
    _write_state "running" 10.00
    check_per_request_cost_cap "$TEST_REQUEST_ID" "$TEST_PROJECT"
    run jq -r '.status' "$TEST_REQ_DIR/state.json"
    [ "$output" = "paused" ]
}

@test "terminal request over cap: not modified" {
    _write_state "done" 99.00
    check_per_request_cost_cap "$TEST_REQUEST_ID" "$TEST_PROJECT"
    run jq -r '.status' "$TEST_REQ_DIR/state.json"
    [ "$output" = "done" ]
}

@test "missing state file: no-op, no error" {
    rm -f "$TEST_REQ_DIR/state.json"
    run check_per_request_cost_cap "$TEST_REQUEST_ID" "$TEST_PROJECT"
    [ "$status" -eq 0 ]
}
