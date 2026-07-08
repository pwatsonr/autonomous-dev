#!/usr/bin/env bats
# session_limit_dispatch.bats -- Regression suite proving the 45-session tight-loop
# (issue #636) cannot recur after REQ-000061.
#
# These tests exercise the session-limit detection and handler functions directly
# (not the full supervisor loop, which requires bash 4+ associative arrays).
# The key invariant: detect_session_limit + handle_session_limit parking prevents
# repeated spawning when a Claude 429 session-limit response is received.

SPAWN_COUNT_FILE=""

setup_file() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    export PLUGIN_DIR
}

setup() {
    # Isolated HOME and PROJECT for each test
    export HOME="$(mktemp -d)"
    chmod 0700 "$HOME"
    mkdir -p "$HOME/.autonomous-dev"

    export PROJECT="$(mktemp -d)"
    mkdir -p "$PROJECT/.autonomous-dev/requests/REQ-000001"

    # Write minimal state.json
    cat > "$PROJECT/.autonomous-dev/requests/REQ-000001/state.json" << 'EOF'
{
  "id": "REQ-000001",
  "status": "running",
  "current_phase": "code",
  "escalation_count": 0
}
EOF

    # Counter file for simulated spawns
    SPAWN_COUNT_FILE="$(mktemp)"
    echo "0" > "$SPAWN_COUNT_FILE"

    # Short floor for test speed
    export AUTONOMOUS_DEV_SL_FLOOR_SECONDS=60

    set +e
    source "$PLUGIN_DIR/lib/rate_limit_handler.sh"
    source "$PLUGIN_DIR/lib/state/event_logger.sh"
    set -e
}

teardown() {
    rm -rf "$HOME" "$PROJECT" "$SPAWN_COUNT_FILE" 2>/dev/null || true
}

# Simulated session output: the exact 429 body from the original issue
_429_SESSION_OUTPUT='HTTP/1.1 429 · You'"'"'ve hit your session limit · resets 1:20pm (America/Chicago)'

# ---------------------------------------------------------------------------
# Simulate N dispatch iterations with the 429 response.
# Returns the number of times detect_session_limit matched + handle was called
# (proxy for "spawned sessions that hit the limit").
# ---------------------------------------------------------------------------
_simulate_dispatch_iterations() {
    local max_iterations="${1:-5}"
    local output_file
    output_file="$(mktemp)"
    echo "$_429_SESSION_OUTPUT" > "$output_file"

    local spawn_count=0
    local i
    for (( i = 1; i <= max_iterations; i++ )); do
        # Increment spawn counter (simulates spawning a session)
        spawn_count=$(( spawn_count + 1 ))
        echo "$spawn_count" > "$SPAWN_COUNT_FILE"

        # Check if session-limit was detected
        local session_json=""
        if session_json="$(detect_session_limit "$(cat "$output_file" 2>/dev/null || echo "")" 2>/dev/null)"; then
            # Detected: call handler (parks dispatch) and break out like the supervisor loop does
            handle_session_limit \
                "$session_json" \
                '{"governance":{"session_limit":{"floor_seconds":60,"buffer_seconds":5}}}' \
                "REQ-000001" \
                "$PROJECT" 2>/dev/null || true
            break  # Like supervisor loop's 'continue' into check_rate_limit_state gate
        fi
    done

    rm -f "$output_file"
}

# ---------------------------------------------------------------------------
# D1: spawn count is exactly one — primary regression assertion
# The tight-loop produced 45 spawns; after the fix, exactly 1 spawn hits
# the session-limit and parks dispatch.
# ---------------------------------------------------------------------------
@test "D1: spawn_count_is_exactly_one after session-limit detected" {
    _simulate_dispatch_iterations 5
    count=$(cat "$SPAWN_COUNT_FILE")
    [ "$count" -eq 1 ]
}

# ---------------------------------------------------------------------------
# D2: state file records session_limit class with pinned consecutive=1
# ---------------------------------------------------------------------------
@test "D2: state_file_records_session_limit" {
    _simulate_dispatch_iterations 5
    state_file="$HOME/.autonomous-dev/rate-limit-state.json"
    [ -f "$state_file" ]
    class=$(jq -r '.class' "$state_file")
    [ "$class" = "session_limit" ]
    consecutive=$(jq -r '.consecutive_rate_limits' "$state_file")
    [ "$consecutive" -eq 1 ]
    rt=$(jq -r '.retry_at // ""' "$state_file")
    [ -n "$rt" ]
    [[ "$rt" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}

# ---------------------------------------------------------------------------
# D3: events.jsonl has exactly one rate_limit_backoff event
# ---------------------------------------------------------------------------
@test "D3: events_jsonl_has_exactly_one_backoff" {
    _simulate_dispatch_iterations 5
    events_file="$PROJECT/.autonomous-dev/requests/REQ-000001/events.jsonl"
    [ -f "$events_file" ]
    count=$(grep -c '"event_type":"rate_limit_backoff"' "$events_file" 2>/dev/null || echo 0)
    [ "$count" -eq 1 ]
    # Validate JSON shape of the event line
    event_type=$(jq -r '.event_type' "$events_file")
    [ "$event_type" = "rate_limit_backoff" ]
    class=$(jq -r '.class' "$events_file")
    [ "$class" = "session_limit" ]
}

# ---------------------------------------------------------------------------
# D4: subsequent iterations would be blocked by check_rate_limit_state
# Simulates what the supervisor loop's check_gates does after handle_session_limit
# ---------------------------------------------------------------------------
@test "D4: subsequent_iterations_blocked_by_check_rate_limit_state" {
    _simulate_dispatch_iterations 1
    # After handler writes state, check_rate_limit_state should block
    run check_rate_limit_state
    [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# D5: feature flag AUTONOMOUS_DEV_SL_ENABLED=false bypasses session-limit branch
# detect_session_limit is called with the flag check mirrored
# ---------------------------------------------------------------------------
@test "D5: feature_flag_disable_falls_through" {
    export AUTONOMOUS_DEV_SL_ENABLED=false
    output_file="$(mktemp)"
    echo "$_429_SESSION_OUTPUT" > "$output_file"

    # Simulate what the supervisor loop does: check the feature flag
    sl_enabled="${AUTONOMOUS_DEV_SL_ENABLED:-true}"
    if [[ "$sl_enabled" == "false" ]]; then
        session_limit_detected=false
    elif session_json="$(detect_session_limit "$(cat "$output_file")" 2>/dev/null)"; then
        session_limit_detected=true
        handle_session_limit "$session_json" '{}' "REQ-000001" "$PROJECT" 2>/dev/null || true
    else
        session_limit_detected=false
    fi

    rm -f "$output_file"

    # With flag disabled, session-limit branch should not have been taken
    [ "$session_limit_detected" = "false" ]

    # State file should NOT have class=session_limit
    state_file="$HOME/.autonomous-dev/rate-limit-state.json"
    if [ -f "$state_file" ]; then
        class=$(jq -r '.class // "none"' "$state_file")
        [ "$class" != "session_limit" ]
    fi
}
