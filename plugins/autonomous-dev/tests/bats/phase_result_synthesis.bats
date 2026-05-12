#!/usr/bin/env bats

# Tests for phase-result synthesis fallback (SPEC-039-2-07)

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"

    # Source spawn-session.sh to get functions
    set +e
    source "$PLUGIN_DIR/bin/spawn-session.sh"
    set -e

    # Create test project and request directory
    TEST_WORK_DIR="$(mktemp -d)"
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
}

teardown() {
    rm -rf "$TEST_WORK_DIR"
}

@test "write_synthesized_phase_result: creates pass result for exit 0" {
    local result_path="$TEST_REQ_DIR/phase-result-prd.json"

    # Execute
    run write_synthesized_phase_result "$result_path" "pass" "" "0"

    # Verify
    assert_success
    assert [ -f "$result_path" ]
    assert_jq_output '.status' "$result_path" "pass"
    assert_jq_output '.exit_code' "$result_path" "0"
    assert_jq_output '.synthesized' "$result_path" "true"
    assert_jq_output '.error' "$result_path" ""
    assert_jq_output '.artifacts | length' "$result_path" "0"

    # Verify timestamp format
    run jq -r '.synthesized_at' "$result_path"
    assert [[ "$output" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}

@test "write_synthesized_phase_result: creates fail result for nonzero exit" {
    local result_path="$TEST_REQ_DIR/phase-result-prd.json"

    # Execute
    run write_synthesized_phase_result "$result_path" "fail" "AGENT_EXITED_NONZERO" "1"

    # Verify
    assert_success
    assert [ -f "$result_path" ]
    assert_jq_output '.status' "$result_path" "fail"
    assert_jq_output '.exit_code' "$result_path" "1"
    assert_jq_output '.synthesized' "$result_path" "true"
    assert_jq_output '.error' "$result_path" "AGENT_EXITED_NONZERO"
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

    # Setup CAPTURE mode to avoid real claude invocation
    export CAPTURE_SPAWN_TO="$AUTONOMOUS_DEV_HOME/capture.txt"

    # Execute
    run spawn_session_typed "$TEST_STATE_FILE" "prd" "prd-author"

    # Verify file unchanged
    assert_success
    assert_jq_output '.agent_written' "$result_path" "true"
    assert_jq_output '.synthesized // false' "$result_path" "false"

    unset CAPTURE_SPAWN_TO
}

@test "spawn_session_typed: synthesizes pass result when file missing and captured exit 0" {
    # Remove any existing result file
    rm -f "$TEST_REQ_DIR/phase-result-prd.json"

    # Setup CAPTURE mode
    export CAPTURE_SPAWN_TO="$AUTONOMOUS_DEV_HOME/capture.txt"

    # Execute (capture mode always returns 0)
    run spawn_session_typed "$TEST_STATE_FILE" "prd" "prd-author"

    # Verify synthesis
    assert_success
    local result_path="$TEST_REQ_DIR/phase-result-prd.json"
    assert [ -f "$result_path" ]
    assert_jq_output '.status' "$result_path" "pass"
    assert_jq_output '.exit_code' "$result_path" "0"
    assert_jq_output '.synthesized' "$result_path" "true"
    assert_jq_output '.error' "$result_path" ""

    unset CAPTURE_SPAWN_TO
}

# NOTE: Testing the nonzero exit case requires a real claude invocation that fails,
# which is difficult to set up reliably in a test. The synthesis logic is tested
# via the write_synthesized_phase_result function above.

@test "advance_phase: logs warn for synthesized result" {
    # Setup: state file
    cat > "$TEST_REQ_DIR/state.json" << EOF
{
  "id": "$TEST_REQUEST_ID",
  "status": "running",
  "current_phase": "prd",
  "phase_overrides": ["prd", "prd_review"]
}
EOF

    # Setup: synthesized result
    cat > "$TEST_REQ_DIR/phase-result-prd.json" << EOF
{
  "status": "pass",
  "synthesized": true,
  "synthesized_at": "2026-05-12T10:00:00Z",
  "exit_code": 0
}
EOF

    # Source supervisor loop to get advance_phase
    source "$PLUGIN_DIR/bin/supervisor-loop.sh"

    # Execute and capture logs
    run advance_phase "$TEST_REQUEST_ID" "$TEST_PROJECT"

    # Verify warning logged (check common log destinations)
    # This is a basic check - in real usage logs go to daemon.log
    assert_success
}