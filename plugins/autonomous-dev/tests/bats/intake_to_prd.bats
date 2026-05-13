#!/usr/bin/env bats

# Tests for intake_to_prd_if_needed() function (SPEC-039-2-06)

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"

    # Source the supervisor-loop.sh to get intake_to_prd_if_needed function
    set +e  # Allow non-zero returns from sourced functions
    source "$PLUGIN_DIR/bin/supervisor-loop.sh"
    set -e

    # Create test project and request directory
    TEST_WORK_DIR="$(mktemp -d)"
    TEST_PROJECT="$TEST_WORK_DIR/test-project"
    TEST_REQUEST_ID="REQ-260512"
    TEST_REQ_DIR="$TEST_PROJECT/.autonomous-dev/requests/$TEST_REQUEST_ID"
    mkdir -p "$TEST_REQ_DIR"
}

teardown() {
    rm -rf "$TEST_WORK_DIR"
}

@test "intake_to_prd_if_needed: queued/intake transitions to running/prd" {
    # Setup: queued/intake state
    cat > "$TEST_REQ_DIR/state.json" << EOF
{
  "id": "$TEST_REQUEST_ID",
  "status": "queued",
  "current_phase": "intake",
  "priority": 1,
  "created_at": "2026-05-12T10:00:00Z",
  "updated_at": "2026-05-12T10:00:00Z"
}
EOF

    # Execute
    intake_to_prd_if_needed "$TEST_REQUEST_ID" "$TEST_PROJECT"
    local result=$?

    # Verify transition happened (returns 0)
    [[ $result -eq 0 ]]

    # Verify state updated
    local status current_phase
    status=$(jq -r '.status' "$TEST_REQ_DIR/state.json")
    current_phase=$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")
    [[ "$status" == "running" ]]
    [[ "$current_phase" == "prd" ]]

    # Verify event recorded
    [[ -f "$TEST_REQ_DIR/events.jsonl" ]]
    local event_type from_phase to_phase
    event_type=$(jq -r '.event' "$TEST_REQ_DIR/events.jsonl")
    from_phase=$(jq -r '.from' "$TEST_REQ_DIR/events.jsonl")
    to_phase=$(jq -r '.to' "$TEST_REQ_DIR/events.jsonl")
    [[ "$event_type" == "intake_to_prd" ]]
    [[ "$from_phase" == "intake" ]]
    [[ "$to_phase" == "prd" ]]
}

@test "intake_to_prd_if_needed: already running/prd returns 1" {
    # Setup: already running/prd state
    cat > "$TEST_REQ_DIR/state.json" << EOF
{
  "id": "$TEST_REQUEST_ID",
  "status": "running",
  "current_phase": "prd",
  "priority": 1,
  "created_at": "2026-05-12T10:00:00Z",
  "updated_at": "2026-05-12T10:00:00Z"
}
EOF

    # Execute (expect failure since no transition needed)
    intake_to_prd_if_needed "$TEST_REQUEST_ID" "$TEST_PROJECT" && result=0 || result=1

    # Verify no transition (returns 1)
    [[ $result -eq 1 ]]

    # Verify state unchanged
    local status current_phase
    status=$(jq -r '.status' "$TEST_REQ_DIR/state.json")
    current_phase=$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")
    [[ "$status" == "running" ]]
    [[ "$current_phase" == "prd" ]]

    # Verify no events written
    [[ ! -f "$TEST_REQ_DIR/events.jsonl" ]]
}

@test "intake_to_prd_if_needed: queued but not intake returns 1" {
    # Setup: queued but already in prd phase
    cat > "$TEST_REQ_DIR/state.json" << EOF
{
  "id": "$TEST_REQUEST_ID",
  "status": "queued",
  "current_phase": "prd",
  "priority": 1,
  "created_at": "2026-05-12T10:00:00Z",
  "updated_at": "2026-05-12T10:00:00Z"
}
EOF

    # Execute (expect failure since no transition needed)
    intake_to_prd_if_needed "$TEST_REQUEST_ID" "$TEST_PROJECT" && result=0 || result=1

    # Verify no transition (returns 1)
    [[ $result -eq 1 ]]

    # Verify state unchanged
    local status current_phase
    status=$(jq -r '.status' "$TEST_REQ_DIR/state.json")
    current_phase=$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")
    [[ "$status" == "queued" ]]
    [[ "$current_phase" == "prd" ]]

    # Verify no events written
    [[ ! -f "$TEST_REQ_DIR/events.jsonl" ]]
}