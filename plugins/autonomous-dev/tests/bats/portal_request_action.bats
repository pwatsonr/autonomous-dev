#!/usr/bin/env bats

# Tests for write_portal_request_action function (SPEC-039-3-01, SPEC-039-3-02).
# Uses BATS raw assertions per repo style.

load '../test_helpers.bash'

setup() {
    # Create temp directories for each test
    export TEST_DIR="${BATS_TEST_TMPDIR}/portal-action-test"
    export AUTONOMOUS_DEV_STATE_DIR="${BATS_TEST_TMPDIR}/state"
    export PROJECT_DIR="${TEST_DIR}/test-project"
    export REQUEST_DIR="${PROJECT_DIR}/.autonomous-dev/requests/REQ-123456"

    mkdir -p "$REQUEST_DIR"
    mkdir -p "$AUTONOMOUS_DEV_STATE_DIR/request-actions"

    # Source the supervisor script (has main guard, safe to source)
    set +e  # Don't exit on error after sourcing
    source "${BATS_TEST_DIRNAME}/../../bin/supervisor-loop.sh"
    set +e  # Ensure error handling is off after source
}

@test "write_portal_request_action function is defined" {
    type write_portal_request_action | grep -q "function"
}

@test "write_portal_request_action for running/code state" {
    # Create a state.json for a running request in code phase
    cat > "${REQUEST_DIR}/state.json" <<EOF
{
    "id": "REQ-123456",
    "title": "Add health endpoint",
    "current_phase": "code",
    "status": "running",
    "cost_accrued_usd": 4.25,
    "variant": "feature-default",
    "turn_count": 3,
    "created_at": "2026-05-12T10:00:00Z",
    "updated_at": "2026-05-12T10:15:00Z"
}
EOF

    run write_portal_request_action "REQ-123456" "$PROJECT_DIR"
    [ "$status" -eq 0 ]

    # Check that portal action file was created
    [ -f "${AUTONOMOUS_DEV_STATE_DIR}/request-actions/REQ-123456.json" ]

    local portal_file="${AUTONOMOUS_DEV_STATE_DIR}/request-actions/REQ-123456.json"

    # Verify field values
    [ "$(jq -r '.id' "$portal_file")" = "REQ-123456" ]
    [ "$(jq -r '.repo' "$portal_file")" = "test-project" ]
    [ "$(jq -r '.title' "$portal_file")" = "Add health endpoint" ]
    [ "$(jq -r '.phase' "$portal_file")" = "CODE" ]  # Should be uppercased
    [ "$(jq -r '.status' "$portal_file")" = "running" ]
    [ "$(jq -r '.cost' "$portal_file")" = "4.25" ]
    [ "$(jq -r '.variant' "$portal_file")" = "feature-default" ]
    [ "$(jq -r '.turns' "$portal_file")" = "3" ]
    [ "$(jq -r '.createdAt' "$portal_file")" = "2026-05-12T10:00:00Z" ]
    [ "$(jq -r '.waitedMin' "$portal_file")" = "0" ]

    # completedAt should be absent for non-terminal status
    [ "$(jq '.completedAt' "$portal_file")" = "null" ]
}

@test "write_portal_request_action for gate state with waitedMin computation" {
    # Set gate_entered_at to about 5 minutes ago
    local gate_time
    gate_time=$(date -u -d '5 minutes ago' +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || gdate -u -d '5 minutes ago' +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "2026-05-12T10:00:00Z")

    cat > "${REQUEST_DIR}/state.json" <<EOF
{
    "id": "REQ-123456",
    "title": "Add health endpoint",
    "current_phase": "prd_review",
    "status": "gate",
    "cost_accrued_usd": 8.50,
    "created_at": "2026-05-12T10:00:00Z",
    "updated_at": "2026-05-12T10:10:00Z",
    "current_phase_metadata": {
        "gate_entered_at": "$gate_time"
    }
}
EOF

    run write_portal_request_action "REQ-123456" "$PROJECT_DIR"
    [ "$status" -eq 0 ]

    local portal_file="${AUTONOMOUS_DEV_STATE_DIR}/request-actions/REQ-123456.json"
    [ -f "$portal_file" ]

    [ "$(jq -r '.status' "$portal_file")" = "gate" ]
    [ "$(jq -r '.phase' "$portal_file")" = "PRD_REVIEW" ]

    # waitedMin should be >= 0 and <= 10 (allowing for clock skew)
    local waited_min
    waited_min=$(jq -r '.waitedMin' "$portal_file")
    [ "$waited_min" -ge 0 ]
    [ "$waited_min" -le 10 ]
}

@test "write_portal_request_action for done state with completedAt" {
    cat > "${REQUEST_DIR}/state.json" <<EOF
{
    "id": "REQ-123456",
    "title": "Add health endpoint",
    "current_phase": "deploy",
    "status": "done",
    "cost_accrued_usd": 12.75,
    "created_at": "2026-05-12T10:00:00Z",
    "updated_at": "2026-05-12T11:00:00Z"
}
EOF

    run write_portal_request_action "REQ-123456" "$PROJECT_DIR"
    [ "$status" -eq 0 ]

    local portal_file="${AUTONOMOUS_DEV_STATE_DIR}/request-actions/REQ-123456.json"
    [ -f "$portal_file" ]

    [ "$(jq -r '.status' "$portal_file")" = "done" ]
    [ "$(jq -r '.completedAt' "$portal_file")" = "2026-05-12T11:00:00Z" ]
}

@test "write_portal_request_action uses atomic write pattern" {
    cat > "${REQUEST_DIR}/state.json" <<EOF
{
    "id": "REQ-123456",
    "title": "Test request",
    "current_phase": "code",
    "status": "running",
    "created_at": "2026-05-12T10:00:00Z"
}
EOF

    run write_portal_request_action "REQ-123456" "$PROJECT_DIR"
    [ "$status" -eq 0 ]

    # No .tmp.* files should remain
    ! ls "${AUTONOMOUS_DEV_STATE_DIR}/request-actions/"*.tmp.* 2>/dev/null
}

@test "write_portal_request_action handles missing state.json gracefully" {
    # Don't create state.json file

    run write_portal_request_action "REQ-123456" "$PROJECT_DIR"
    [ "$status" -eq 0 ]  # Should not crash

    local portal_file="${AUTONOMOUS_DEV_STATE_DIR}/request-actions/REQ-123456.json"
    [ -f "$portal_file" ]

    # Should write minimal cancelled action
    [ "$(jq -r '.id' "$portal_file")" = "REQ-123456" ]
    [ "$(jq -r '.status' "$portal_file")" = "cancelled" ]
    [ "$(jq -r '.completedAt' "$portal_file")" != "null" ]
}

@test "write_portal_request_action is idempotent" {
    cat > "${REQUEST_DIR}/state.json" <<EOF
{
    "id": "REQ-123456",
    "title": "Test request",
    "current_phase": "code",
    "status": "running",
    "created_at": "2026-05-12T10:00:00Z"
}
EOF

    # Write twice
    run write_portal_request_action "REQ-123456" "$PROJECT_DIR"
    [ "$status" -eq 0 ]

    # Change status and write again
    jq '.status = "done" | .updated_at = "2026-05-12T11:00:00Z"' "${REQUEST_DIR}/state.json" > "${REQUEST_DIR}/state.json.tmp"
    mv "${REQUEST_DIR}/state.json.tmp" "${REQUEST_DIR}/state.json"

    run write_portal_request_action "REQ-123456" "$PROJECT_DIR"
    [ "$status" -eq 0 ]

    local portal_file="${AUTONOMOUS_DEV_STATE_DIR}/request-actions/REQ-123456.json"

    # Should reflect the latest status
    [ "$(jq -r '.status' "$portal_file")" = "done" ]
    [ "$(jq -r '.completedAt' "$portal_file")" = "2026-05-12T11:00:00Z" ]
}

@test "write_portal_request_action handles gate state without gate_entered_at" {
    cat > "${REQUEST_DIR}/state.json" <<EOF
{
    "id": "REQ-123456",
    "title": "Test request",
    "current_phase": "prd_review",
    "status": "gate",
    "created_at": "2026-05-12T10:00:00Z",
    "updated_at": "2026-05-12T10:10:00Z"
}
EOF

    run write_portal_request_action "REQ-123456" "$PROJECT_DIR"
    [ "$status" -eq 0 ]

    local portal_file="${AUTONOMOUS_DEV_STATE_DIR}/request-actions/REQ-123456.json"
    [ -f "$portal_file" ]

    [ "$(jq -r '.status' "$portal_file")" = "gate" ]
    [ "$(jq -r '.waitedMin' "$portal_file")" = "0" ]
}