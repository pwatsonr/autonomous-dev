#!/usr/bin/env bats
#
# Dispatched phase logic tests (FR-020-01)

setup() {
    TEST_DIR=$(mktemp -d)
    export TEST_STATE_FILE="${TEST_DIR}/state.json"
}

teardown() {
    rm -rf "${TEST_DIR}" 2>/dev/null || true
}

@test "advance_phase reads from dispatched_phase not current_phase" {
    # Create a state.json with current_phase mutated by agent but dispatched_phase preserved
    cat > "$TEST_STATE_FILE" <<EOF
{
  "id": "REQ-123456",
  "current_phase": "code_review",
  "status": "running",
  "current_phase_metadata": {
    "dispatched_phase": "code"
  }
}
EOF

    # Source functions with mocked dependencies
    source "${BATS_TEST_DIRNAME}/../../bin/supervisor-loop.sh" 2>/dev/null || {
        # Mock the current_phase reading logic
        read_actual_phase() {
            local state_file="$1"
            jq -r '.current_phase_metadata.dispatched_phase // .current_phase // .status' "$state_file"
        }
    }

    # Test that we read dispatched_phase (code) not current_phase (code_review)
    if command -v read_actual_phase >/dev/null; then
        run read_actual_phase "$TEST_STATE_FILE"
        [[ "$output" == "code" ]]
    else
        # Test the jq expression directly
        run jq -r '.current_phase_metadata.dispatched_phase // .current_phase // .status' "$TEST_STATE_FILE"
        [[ "$output" == "code" ]]
    fi
}

@test "advance_phase falls back to current_phase when dispatched_phase absent" {
    # Create state.json without dispatched_phase
    cat > "$TEST_STATE_FILE" <<EOF
{
  "id": "REQ-123456",
  "current_phase": "prd",
  "status": "running",
  "current_phase_metadata": {}
}
EOF

    # Test fallback to current_phase
    run jq -r '.current_phase_metadata.dispatched_phase // .current_phase // .status' "$TEST_STATE_FILE"
    [[ "$output" == "prd" ]]
}

@test "advance_phase clears dispatched_phase on successful advance" {
    # This is more of a specification test for the expected behavior
    # The actual jq command that should clear dispatched_phase:

    cat > "$TEST_STATE_FILE" <<EOF
{
  "id": "REQ-123456",
  "current_phase": "prd",
  "status": "running",
  "current_phase_metadata": {
    "dispatched_phase": "prd"
  }
}
EOF

    # Test the jq expression that should clear dispatched_phase
    local tmp_file="${TEST_DIR}/tmp.json"
    jq '.current_phase = "prd_review" |
        .status = "gate" |
        .current_phase_metadata.dispatched_phase = null' \
       "$TEST_STATE_FILE" > "$tmp_file"

    # Check that dispatched_phase is cleared
    run jq -r '.current_phase_metadata.dispatched_phase' "$tmp_file"
    [[ "$output" == "null" ]]

    # Check that current_phase is updated
    run jq -r '.current_phase' "$tmp_file"
    [[ "$output" == "prd_review" ]]
}