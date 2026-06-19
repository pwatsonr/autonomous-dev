#!/usr/bin/env bats

# #500 — tests for consume_revise_markers().
#
# When the operator leaves comments on a rendered artifact and clicks
# "revise", the portal writes a feedback artifact into the request's repo dir
# AND a marker into <state>/revise-requests. The daemon's
# consume_revise_markers() validates each marker and resets state.json's
# current_phase back to the author phase (the same loopback the *_review-fail
# path uses) so the supervisor re-dispatches the author with the feedback.

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    TEST_WORK_DIR="$(mktemp -d)"
    export HOME="$TEST_WORK_DIR/home"
    export AUTONOMOUS_DEV_STATE_DIR="$TEST_WORK_DIR/state"
    mkdir -p "$HOME/.autonomous-dev/logs" \
             "$AUTONOMOUS_DEV_STATE_DIR/revise-requests" \
             "$AUTONOMOUS_DEV_STATE_DIR/request-actions"

    set +e
    source "$PLUGIN_DIR/bin/supervisor-loop.sh"
    set -e

    REPO="$TEST_WORK_DIR/repo-a"
    EFFECTIVE_CONFIG="$TEST_WORK_DIR/effective.json"
    echo "{\"repositories\":{\"allowlist\":[\"$REPO\"]}}" > "$EFFECTIVE_CONFIG"

    MARKERS="$AUTONOMOUS_DEV_STATE_DIR/revise-requests"
}

teardown() { rm -rf "$TEST_WORK_DIR"; }

# $1=req $2=status $3=current_phase
_state() {
    mkdir -p "$REPO/.autonomous-dev/requests/$1"
    cat > "$REPO/.autonomous-dev/requests/$1/state.json" <<JSON
{"id":"$1","status":"$2","current_phase":"$3","priority":2,
 "created_at":"2026-06-18T20:00:00Z","updated_at":"2026-06-18T20:30:00Z",
 "title":"t","cost_accrued":1.0,"turn_count":3}
JSON
}

# $1=req $2=phase  — write the feedback artifact the daemon requires.
_feedback() {
    mkdir -p "$REPO/.autonomous-dev/requests/$1/artifact-feedback"
    cat > "$REPO/.autonomous-dev/requests/$1/artifact-feedback/$2.json" <<JSON
{"v":1,"id":"$1","repo":"repo-a","phase":"$2","feedback":"please revise X"}
JSON
}

# $1=req $2=phase  — write the revise marker.
_marker() {
    cat > "$MARKERS/repo-a__$1.json" <<JSON
{"v":1,"id":"$1","repo":"repo-a","phase":"$2","source":"portal","actor":"operator","ts":"2026-06-18T21:00:00Z"}
JSON
}

@test "gate-state request is reset to the author phase + marker archived" {
    _state "REQ-000500" "gate" "prd_review"
    _feedback "REQ-000500" "prd"
    _marker "REQ-000500" "prd"

    consume_revise_markers

    run jq -r '.current_phase' "$REPO/.autonomous-dev/requests/REQ-000500/state.json"
    [ "$output" = "prd" ]
    run jq -r '.status' "$REPO/.autonomous-dev/requests/REQ-000500/state.json"
    [ "$output" = "running" ]
    # marker archived, not left in place
    [ ! -f "$MARKERS/repo-a__REQ-000500.json" ]
    [ -f "$MARKERS/applied/repo-a__REQ-000500.json" ]
}

@test "request already settled on the target phase is reset (re-run)" {
    _state "REQ-000501" "gate" "spec"
    _feedback "REQ-000501" "spec"
    _marker "REQ-000501" "spec"

    consume_revise_markers

    run jq -r '.current_phase' "$REPO/.autonomous-dev/requests/REQ-000501/state.json"
    [ "$output" = "spec" ]
    run jq -r '.status' "$REPO/.autonomous-dev/requests/REQ-000501/state.json"
    [ "$output" = "running" ]
}

@test "terminal request: marker discarded, state untouched" {
    _state "REQ-000502" "done" "observe"
    _feedback "REQ-000502" "prd"
    _marker "REQ-000502" "prd"

    consume_revise_markers

    run jq -r '.current_phase' "$REPO/.autonomous-dev/requests/REQ-000502/state.json"
    [ "$output" = "observe" ]   # unchanged
    [ ! -f "$MARKERS/repo-a__REQ-000502.json" ]
    [ -f "$MARKERS/applied/repo-a__REQ-000502.json" ]
}

@test "request running a DIFFERENT phase: marker deferred (left in place)" {
    _state "REQ-000503" "running" "code"
    _feedback "REQ-000503" "prd"
    _marker "REQ-000503" "prd"

    consume_revise_markers

    # current_phase not yanked from under the live agent
    run jq -r '.current_phase' "$REPO/.autonomous-dev/requests/REQ-000503/state.json"
    [ "$output" = "code" ]
    # marker left for a later poll
    [ -f "$MARKERS/repo-a__REQ-000503.json" ]
}

@test "missing feedback artifact: marker rejected" {
    _state "REQ-000504" "gate" "prd_review"
    # no _feedback written
    _marker "REQ-000504" "prd"

    consume_revise_markers

    run jq -r '.current_phase' "$REPO/.autonomous-dev/requests/REQ-000504/state.json"
    [ "$output" = "prd_review" ]   # not reset
    [ ! -f "$MARKERS/repo-a__REQ-000504.json" ]
    [ -f "$MARKERS/rejected/repo-a__REQ-000504.json" ]
}

@test "non-portal source: marker rejected" {
    _state "REQ-000505" "gate" "prd_review"
    _feedback "REQ-000505" "prd"
    cat > "$MARKERS/repo-a__REQ-000505.json" <<'JSON'
{"v":1,"id":"REQ-000505","repo":"repo-a","phase":"prd","source":"evil","actor":"x"}
JSON

    consume_revise_markers

    run jq -r '.current_phase' "$REPO/.autonomous-dev/requests/REQ-000505/state.json"
    [ "$output" = "prd_review" ]
    [ -f "$MARKERS/rejected/repo-a__REQ-000505.json" ]
}

@test "corrupt JSON marker: rejected" {
    echo 'not json {' > "$MARKERS/repo-a__REQ-000506.json"
    consume_revise_markers
    [ -f "$MARKERS/rejected/repo-a__REQ-000506.json" ]
}

@test "malformed phase (path traversal attempt): rejected" {
    _state "REQ-000507" "gate" "prd_review"
    cat > "$MARKERS/repo-a__REQ-000507.json" <<'JSON'
{"v":1,"id":"REQ-000507","repo":"repo-a","phase":"../escape","source":"portal","actor":"x"}
JSON

    consume_revise_markers

    run jq -r '.current_phase' "$REPO/.autonomous-dev/requests/REQ-000507/state.json"
    [ "$output" = "prd_review" ]
    [ -f "$MARKERS/rejected/repo-a__REQ-000507.json" ]
}

@test "request with no state.json anywhere: marker left for later" {
    _marker "REQ-099999" "prd"
    consume_revise_markers
    [ -f "$MARKERS/repo-a__REQ-099999.json" ]
}

@test "empty revise-requests dir is a no-op" {
    run consume_revise_markers
    [ "$status" -eq 0 ]
}
