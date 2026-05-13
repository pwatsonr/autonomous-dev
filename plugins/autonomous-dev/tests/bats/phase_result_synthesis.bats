#!/usr/bin/env bats

# Tests for phase-result synthesis fallback (SPEC-039-2-07)

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"

    # Create test project and request directory
    TEST_WORK_DIR="${BATS_TEST_TMPDIR}"
    TEST_PROJECT="$TEST_WORK_DIR/test-project"
    TEST_REQUEST_ID="REQ-260512-test$$"
    TEST_REQ_DIR="$TEST_PROJECT/.autonomous-dev/requests/$TEST_REQUEST_ID"
    mkdir -p "$TEST_REQ_DIR"

    TEST_STATE_FILE="$TEST_REQ_DIR/state.json"
    cat > "$TEST_STATE_FILE" << EOF
{
  "id": "$TEST_REQUEST_ID",
  "status": "running",
  "current_phase": "prd",
  "type": "feature",
  "expedited_reviews": false
}
EOF

    # Set up minimal mock claude in PATH
    MOCK_DIR="${BATS_TEST_TMPDIR}/mock-bin"
    mkdir -p "$MOCK_DIR"
    cat > "$MOCK_DIR/claude" << 'EOF'
#!/bin/bash
echo '{"total_cost_usd":0.01}'
exit ${MOCK_CLAUDE_EXIT:-0}
EOF
    chmod +x "$MOCK_DIR/claude"
    export PATH="$MOCK_DIR:$PATH"

    # Source spawn-session.sh to get functions
    set +e
    source "$PLUGIN_DIR/bin/spawn-session.sh"
    set +e
}

teardown() {
    rm -rf "$TEST_WORK_DIR"
}

@test "write_synthesized_phase_result: creates pass result for exit 0" {
    local result_path="$TEST_REQ_DIR/phase-result-prd.json"

    # Execute with phase parameter
    run write_synthesized_phase_result "$result_path" "pass" "" "0" "prd"

    # Verify
    [ "$status" -eq 0 ]
    [ -f "$result_path" ]

    local status_val
    status_val=$(jq -r '.status' "$result_path")
    [ "$status_val" = "pass" ]

    local phase_val
    phase_val=$(jq -r '.phase' "$result_path")
    [ "$phase_val" = "prd" ]

    local feedback_val
    feedback_val=$(jq -r '.feedback' "$result_path")
    [ "$feedback_val" = "synthesized from exit code 0" ]

    local exit_code_val
    exit_code_val=$(jq -r '.exit_code' "$result_path")
    [ "$exit_code_val" = "0" ]

    local synthesized_val
    synthesized_val=$(jq -r '.synthesized' "$result_path")
    [ "$synthesized_val" = "true" ]

    local artifacts_len
    artifacts_len=$(jq '.artifacts | length' "$result_path")
    [ "$artifacts_len" = "0" ]

    # Verify timestamp format (now completed_at instead of synthesized_at)
    local ts
    ts=$(jq -r '.completed_at' "$result_path")
    [[ "$ts" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}

@test "write_synthesized_phase_result: creates fail result for nonzero exit" {
    local result_path="$TEST_REQ_DIR/phase-result-prd.json"

    # Execute with phase parameter
    run write_synthesized_phase_result "$result_path" "fail" "AGENT_EXITED_NONZERO" "1" "prd"

    # Verify
    [ "$status" -eq 0 ]
    [ -f "$result_path" ]

    local status_val
    status_val=$(jq -r '.status' "$result_path")
    [ "$status_val" = "fail" ]

    local phase_val
    phase_val=$(jq -r '.phase' "$result_path")
    [ "$phase_val" = "prd" ]

    local feedback_val
    feedback_val=$(jq -r '.feedback' "$result_path")
    [ "$feedback_val" = "synthesized from exit code 1 (AGENT_EXITED_NONZERO)" ]

    local exit_code_val
    exit_code_val=$(jq -r '.exit_code' "$result_path")
    [ "$exit_code_val" = "1" ]

    local synthesized_val
    synthesized_val=$(jq -r '.synthesized' "$result_path")
    [ "$synthesized_val" = "true" ]
}

@test "spawn_session_typed: synthesizes pass result when mock claude exits 0" {
    # Remove any existing result file
    rm -f "$TEST_REQ_DIR/phase-result-prd.json"

    # Execute (mock claude exits 0 by default)
    run spawn_session_typed "$TEST_STATE_FILE" "prd" "prd-author"

    # Verify synthesis
    [ "$status" -eq 0 ]
    local result_path="$TEST_REQ_DIR/phase-result-prd.json"
    [ -f "$result_path" ]

    local status_val
    status_val=$(jq -r '.status' "$result_path")
    [ "$status_val" = "pass" ]

    local phase_val
    phase_val=$(jq -r '.phase' "$result_path")
    [ "$phase_val" = "prd" ]

    local feedback_val
    feedback_val=$(jq -r '.feedback' "$result_path")
    [ "$feedback_val" = "synthesized from exit code 0" ]

    local exit_code_val
    exit_code_val=$(jq -r '.exit_code' "$result_path")
    [ "$exit_code_val" = "0" ]

    local synthesized_val
    synthesized_val=$(jq -r '.synthesized' "$result_path")
    [ "$synthesized_val" = "true" ]
}

@test "spawn_session_typed: synthesizes fail result when mock claude exits 1" {
    # Remove any existing result file
    rm -f "$TEST_REQ_DIR/phase-result-prd.json"

    # Make mock claude exit with 1
    export MOCK_CLAUDE_EXIT=1

    # Execute
    run spawn_session_typed "$TEST_STATE_FILE" "prd" "prd-author"

    # Verify synthesis
    [ "$status" -eq 1 ]
    local result_path="$TEST_REQ_DIR/phase-result-prd.json"
    [ -f "$result_path" ]

    local status_val
    status_val=$(jq -r '.status' "$result_path")
    [ "$status_val" = "fail" ]

    local phase_val
    phase_val=$(jq -r '.phase' "$result_path")
    [ "$phase_val" = "prd" ]

    local feedback_val
    feedback_val=$(jq -r '.feedback' "$result_path")
    [ "$feedback_val" = "synthesized from exit code 1 (AGENT_EXITED_NONZERO)" ]

    local exit_code_val
    exit_code_val=$(jq -r '.exit_code' "$result_path")
    [ "$exit_code_val" = "1" ]

    local synthesized_val
    synthesized_val=$(jq -r '.synthesized' "$result_path")
    [ "$synthesized_val" = "true" ]

    unset MOCK_CLAUDE_EXIT
}

@test "spawn_session_typed: preserves existing phase-result file" {
    # Setup: agent already wrote phase-result
    local result_path="$TEST_REQ_DIR/phase-result-prd.json"
    cat > "$result_path" << EOF
{
  "status": "pass",
  "artifacts": ["docs/prd/feature.md"],
  "agent_written": true
}
EOF

    # Execute
    run spawn_session_typed "$TEST_STATE_FILE" "prd" "prd-author"

    # Verify file unchanged
    [ "$status" -eq 0 ]

    local agent_written_val
    agent_written_val=$(jq -r '.agent_written' "$result_path")
    [ "$agent_written_val" = "true" ]

    local synthesized_val
    synthesized_val=$(jq -r '.synthesized // false' "$result_path")
    [ "$synthesized_val" = "false" ]
}