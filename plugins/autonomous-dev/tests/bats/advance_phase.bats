#!/usr/bin/env bats

# Tests for advance_phase() function (SPEC-039-2-05)

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"

    # Source the supervisor-loop.sh to get advance_phase function
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

@test "advance_phase: pass result advances to next phase" {
    # Setup: state in prd phase with phase_overrides to control sequence
    cat > "$TEST_REQ_DIR/state.json" << EOF
{
  "id": "$TEST_REQUEST_ID",
  "status": "running",
  "current_phase": "prd",
  "priority": 1,
  "created_at": "2026-05-12T10:00:00Z",
  "updated_at": "2026-05-12T10:00:00Z",
  "escalation_count": 0,
  "phase_overrides": ["prd", "prd_review", "tdd"]
}
EOF

    # Setup: pass result
    cat > "$TEST_REQ_DIR/phase-result-prd.json" << EOF
{
  "status": "pass",
  "artifacts": ["docs/prd/feature.md"]
}
EOF

    # Execute
    advance_phase "$TEST_REQUEST_ID" "$TEST_PROJECT"

    # Verify state advanced to prd_review with gate status
    local current_phase status
    current_phase=$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")
    status=$(jq -r '.status' "$TEST_REQ_DIR/state.json")
    [[ "$current_phase" == "prd_review" ]]
    [[ "$status" == "gate" ]]

    # Verify gate_entered_at is set
    local gate_entered
    gate_entered=$(jq -r '.current_phase_metadata.gate_entered_at // ""' "$TEST_REQ_DIR/state.json")
    [[ -n "$gate_entered" ]]

    # Verify event written
    [[ -f "$TEST_REQ_DIR/events.jsonl" ]]
    local event_type
    event_type=$(jq -r '.event' "$TEST_REQ_DIR/events.jsonl")
    [[ "$event_type" == "phase_advance" ]]
}

@test "advance_phase: missing phase-result treated as pass" {
    # Setup: state in prd phase, no phase-result file
    cat > "$TEST_REQ_DIR/state.json" << EOF
{
  "id": "$TEST_REQUEST_ID",
  "status": "running",
  "current_phase": "prd",
  "priority": 1,
  "created_at": "2026-05-12T10:00:00Z",
  "updated_at": "2026-05-12T10:00:00Z",
  "escalation_count": 0,
  "phase_overrides": ["prd", "prd_review", "tdd"]
}
EOF
    # No phase-result-prd.json file created

    # Execute
    advance_phase "$TEST_REQUEST_ID" "$TEST_PROJECT"

    # Verify treated as pass - advanced to next phase
    local current_phase
    current_phase=$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")
    [[ "$current_phase" == "prd_review" ]]
}

@test "advance_phase: fail result increments escalation_count" {
    # Setup: state in prd_review phase
    cat > "$TEST_REQ_DIR/state.json" << EOF
{
  "id": "$TEST_REQUEST_ID",
  "status": "gate",
  "current_phase": "prd_review",
  "priority": 1,
  "created_at": "2026-05-12T10:00:00Z",
  "updated_at": "2026-05-12T10:00:00Z",
  "escalation_count": 0,
  "phase_overrides": ["prd", "prd_review", "tdd"]
}
EOF

    # Setup: fail result
    cat > "$TEST_REQ_DIR/phase-result-prd_review.json" << EOF
{
  "status": "fail",
  "feedback": "Missing requirements section"
}
EOF

    # Execute
    advance_phase "$TEST_REQUEST_ID" "$TEST_PROJECT"

    # Verify escalation_count incremented
    local escalation_count
    escalation_count=$(jq -r '.escalation_count' "$TEST_REQ_DIR/state.json")
    [[ "$escalation_count" == "1" ]]

    # Verify phase_failed event written
    [[ -f "$TEST_REQ_DIR/events.jsonl" ]]
    local event_type
    event_type=$(jq -r 'select(.event == "phase_failed") | .event' "$TEST_REQ_DIR/events.jsonl")
    [[ "$event_type" == "phase_failed" ]]

    # Verify review phase reset to author phase
    local current_phase
    current_phase=$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")
    [[ "$current_phase" == "prd" ]]
}