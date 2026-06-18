#!/usr/bin/env bats

# Tests for advance_phase() function (SPEC-039-2-05)
# Integration tests I2-I5 for REQ-000013 (intake DB ledger sync) also live here.

PLUGIN_DIR_PATH=""

setup() {
    PLUGIN_DIR_PATH="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"

    # Create temp home dir and set HOME BEFORE sourcing so all readonly vars
    # (DAEMON_HOME, INTAKE_DB, LOG_DIR, LOG_FILE) resolve under the temp tree.
    # This is required by REQ-000013 spec IN-1.
    TEST_WORK_DIR="$(mktemp -d)"
    export HOME="$TEST_WORK_DIR"

    # Pre-create the log directory so log_json can write to LOG_FILE
    mkdir -p "$TEST_WORK_DIR/.autonomous-dev/logs"

    # Source the script after HOME is set
    set +e  # Allow non-zero returns from sourced functions
    source "$PLUGIN_DIR_PATH/bin/supervisor-loop.sh"
    set -e

    # Create test project and request directory
    TEST_PROJECT="$TEST_WORK_DIR/test-project"
    TEST_REQUEST_ID="REQ-260512"
    TEST_REQ_DIR="$TEST_PROJECT/.autonomous-dev/requests/$TEST_REQUEST_ID"
    mkdir -p "$TEST_REQ_DIR"
}

teardown() {
    rm -rf "$TEST_WORK_DIR"
}

# ---------------------------------------------------------------------------
# Shared DB helpers for REQ-000013 integration tests
# ---------------------------------------------------------------------------

# seed_db() — create intake DB schema and insert a test row
seed_db() {
    mkdir -p "$DAEMON_HOME"
    sqlite3 "$INTAKE_DB" < "$PLUGIN_DIR_PATH/intake/db/schema.sql"
    sqlite3 "$INTAKE_DB" \
        "INSERT INTO requests (request_id,title,description,raw_input,requester_id,source_channel,current_phase,status)
         VALUES ('$TEST_REQUEST_ID','t','d','r','u','claude_app','prd','active');"
}

# ledger <col> — read a column from the test request's row
ledger() {
    sqlite3 "$INTAKE_DB" "SELECT $1 FROM requests WHERE request_id='$TEST_REQUEST_ID';"
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

# ===========================================================================
# Integration tests for REQ-000013: intake DB ledger mirroring via advance_phase
# ===========================================================================

# ---------------------------------------------------------------------------
# I2: prd→prd_review advance mirrors (prd_review, active) in ledger
# ---------------------------------------------------------------------------
@test "I2: advance_phase prd->prd_review mirrors ledger to (prd_review, active)" {
    seed_db  # seeds with current_phase='prd', status='active'

    # State: prd/running, with prd_review as next gate phase
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
    cat > "$TEST_REQ_DIR/phase-result-prd.json" << EOF
{"status": "pass"}
EOF

    advance_phase "$TEST_REQUEST_ID" "$TEST_PROJECT"

    # state.json should be at prd_review/gate
    local state_phase state_status
    state_phase=$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")
    state_status=$(jq -r '.status' "$TEST_REQ_DIR/state.json")
    [[ "$state_phase" == "prd_review" ]]
    [[ "$state_status" == "gate" ]]

    # intake.db ledger should mirror: current_phase=prd_review, status=active
    [[ "$(ledger current_phase)" == "prd_review" ]]
    [[ "$(ledger status)" == "active" ]]
}

# ---------------------------------------------------------------------------
# I3: terminal done transition mirrors (<final_phase>, done) in ledger
# ---------------------------------------------------------------------------
@test "I3: advance_phase terminal done mirrors ledger to (deploy, done)" {
    seed_db  # seeds with current_phase='prd', status='active'
    # Update seed to have current_phase=deploy (our "final" phase)
    sqlite3 "$INTAKE_DB" \
        "UPDATE requests SET current_phase='deploy', status='active' WHERE request_id='$TEST_REQUEST_ID';"

    # State: deploy/running, with deploy as the ONLY phase in overrides (no next phase)
    cat > "$TEST_REQ_DIR/state.json" << EOF
{
  "id": "$TEST_REQUEST_ID",
  "status": "running",
  "current_phase": "deploy",
  "priority": 1,
  "created_at": "2026-05-12T10:00:00Z",
  "updated_at": "2026-05-12T10:00:00Z",
  "escalation_count": 0,
  "phase_overrides": ["deploy"]
}
EOF
    cat > "$TEST_REQ_DIR/phase-result-deploy.json" << EOF
{"status": "pass"}
EOF

    advance_phase "$TEST_REQUEST_ID" "$TEST_PROJECT"

    # state.json should be done
    local state_status
    state_status=$(jq -r '.status' "$TEST_REQ_DIR/state.json")
    [[ "$state_status" == "done" ]]

    # intake.db ledger should mirror: current_phase=deploy, status=done
    [[ "$(ledger current_phase)" == "deploy" ]]
    [[ "$(ledger status)" == "done" ]]
}

# ---------------------------------------------------------------------------
# I4: review-fail reset mirrors (<author_phase>, active) in ledger
# ---------------------------------------------------------------------------
@test "I4: advance_phase review-fail reset mirrors ledger to (prd, active)" {
    seed_db
    # Update seed to have current_phase=prd_review (a review phase)
    sqlite3 "$INTAKE_DB" \
        "UPDATE requests SET current_phase='prd_review', status='active' WHERE request_id='$TEST_REQUEST_ID';"

    # State: prd_review/gate, escalation_count=0 (below MAX_RETRIES_PER_PHASE=3)
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
    cat > "$TEST_REQ_DIR/phase-result-prd_review.json" << EOF
{"status": "fail", "feedback": "review failed"}
EOF

    advance_phase "$TEST_REQUEST_ID" "$TEST_PROJECT"

    # state.json should be reset to author phase (prd)
    local state_phase
    state_phase=$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")
    [[ "$state_phase" == "prd" ]]

    # intake.db ledger should mirror: current_phase=prd, status=active
    [[ "$(ledger current_phase)" == "prd" ]]
    [[ "$(ledger status)" == "active" ]]
}

# ---------------------------------------------------------------------------
# I5: retry-exhausted mirrors (<phase>, failed) in ledger
# ---------------------------------------------------------------------------
@test "I5: advance_phase retry-exhausted mirrors ledger to (tdd, failed)" {
    seed_db
    # Update seed to have current_phase=tdd
    sqlite3 "$INTAKE_DB" \
        "UPDATE requests SET current_phase='tdd', status='active' WHERE request_id='$TEST_REQUEST_ID';"

    # State: tdd/running, escalation_count = MAX_RETRIES_PER_PHASE - 1 = 2
    # The increment in advance_phase will bring it to 3, exhausting retries.
    local max_retries
    max_retries="${MAX_RETRIES_PER_PHASE:-3}"
    local seed_count=$(( max_retries - 1 ))

    cat > "$TEST_REQ_DIR/state.json" << EOF
{
  "id": "$TEST_REQUEST_ID",
  "status": "running",
  "current_phase": "tdd",
  "priority": 1,
  "created_at": "2026-05-12T10:00:00Z",
  "updated_at": "2026-05-12T10:00:00Z",
  "escalation_count": ${seed_count},
  "phase_overrides": ["prd", "prd_review", "tdd", "tdd_review"]
}
EOF
    cat > "$TEST_REQ_DIR/phase-result-tdd.json" << EOF
{"status": "fail", "feedback": "tests failed"}
EOF

    advance_phase "$TEST_REQUEST_ID" "$TEST_PROJECT"

    # state.json should be failed
    local state_status
    state_status=$(jq -r '.status' "$TEST_REQ_DIR/state.json")
    [[ "$state_status" == "failed" ]]

    # intake.db ledger should mirror: current_phase=tdd, status=failed
    [[ "$(ledger current_phase)" == "tdd" ]]
    [[ "$(ledger status)" == "failed" ]]
}

# ===========================================================================
# Issue #489: advance_phase must accumulate phase_history (was stuck at seed)
# ===========================================================================

@test "advance_phase: pass appends completed phase to phase_history" {
    cat > "$TEST_REQ_DIR/state.json" << EOF
{
  "id": "$TEST_REQUEST_ID",
  "status": "running",
  "current_phase": "prd",
  "priority": 1,
  "created_at": "2026-05-12T10:00:00Z",
  "updated_at": "2026-05-12T10:00:00Z",
  "escalation_count": 0,
  "phase_history": [],
  "phase_overrides": ["prd", "prd_review", "tdd"]
}
EOF
    cat > "$TEST_REQ_DIR/phase-result-prd.json" << EOF
{ "status": "pass" }
EOF

    advance_phase "$TEST_REQUEST_ID" "$TEST_PROJECT"

    # The completed phase (prd) must now be recorded and closed, and the
    # phase being entered (prd_review) must be open.
    local hist_len completed_state completed_exit next_state next_exit
    hist_len=$(jq -r '.phase_history | length' "$TEST_REQ_DIR/state.json")
    [[ "$hist_len" == "2" ]]
    completed_state=$(jq -r '.phase_history[0].state' "$TEST_REQ_DIR/state.json")
    completed_exit=$(jq -r '.phase_history[0].exited_at' "$TEST_REQ_DIR/state.json")
    next_state=$(jq -r '.phase_history[1].state' "$TEST_REQ_DIR/state.json")
    next_exit=$(jq -r '.phase_history[1].exited_at' "$TEST_REQ_DIR/state.json")
    [[ "$completed_state" == "prd" ]]
    [[ "$completed_exit" != "null" && -n "$completed_exit" ]]
    [[ "$next_state" == "prd_review" ]]
    [[ "$next_exit" == "null" ]]
}

@test "advance_phase: phase_history accumulates across multiple advances" {
    cat > "$TEST_REQ_DIR/state.json" << EOF
{
  "id": "$TEST_REQUEST_ID",
  "status": "running",
  "current_phase": "prd",
  "priority": 1,
  "created_at": "2026-05-12T10:00:00Z",
  "updated_at": "2026-05-12T10:00:00Z",
  "escalation_count": 0,
  "phase_history": [],
  "phase_overrides": ["prd", "tdd", "plan"]
}
EOF
    # Advance prd -> tdd
    echo '{ "status": "pass" }' > "$TEST_REQ_DIR/phase-result-prd.json"
    advance_phase "$TEST_REQUEST_ID" "$TEST_PROJECT"
    # Advance tdd -> plan
    echo '{ "status": "pass" }' > "$TEST_REQ_DIR/phase-result-tdd.json"
    advance_phase "$TEST_REQUEST_ID" "$TEST_PROJECT"

    # Every completed phase must appear, not just the first (the bug was
    # phase_history staying at its seed value).
    local states
    states=$(jq -r '[.phase_history[].state] | join(",")' "$TEST_REQ_DIR/state.json")
    [[ "$states" == "prd,tdd,plan" ]]

    # prd and tdd should be closed; plan (current) still open.
    [[ "$(jq -r '.phase_history[0].exited_at' "$TEST_REQ_DIR/state.json")" != "null" ]]
    [[ "$(jq -r '.phase_history[1].exited_at' "$TEST_REQ_DIR/state.json")" != "null" ]]
    [[ "$(jq -r '.phase_history[2].exited_at' "$TEST_REQ_DIR/state.json")" == "null" ]]
}

@test "advance_phase: terminal completion records final phase in phase_history" {
    cat > "$TEST_REQ_DIR/state.json" << EOF
{
  "id": "$TEST_REQUEST_ID",
  "status": "running",
  "current_phase": "deploy",
  "priority": 1,
  "created_at": "2026-05-12T10:00:00Z",
  "updated_at": "2026-05-12T10:00:00Z",
  "escalation_count": 0,
  "phase_history": [
    {"state":"deploy","entered_at":"2026-05-12T10:00:00Z","exited_at":null,"session_id":null,"turns_used":0,"cost_usd":0,"retry_count":0,"exit_reason":null}
  ],
  "phase_overrides": ["deploy"]
}
EOF
    echo '{ "status": "pass" }' > "$TEST_REQ_DIR/phase-result-deploy.json"

    advance_phase "$TEST_REQUEST_ID" "$TEST_PROJECT"

    # Request is terminal/done and the final phase entry is closed.
    [[ "$(jq -r '.status' "$TEST_REQ_DIR/state.json")" == "done" ]]
    [[ "$(jq -r '.phase_history | length' "$TEST_REQ_DIR/state.json")" == "1" ]]
    [[ "$(jq -r '.phase_history[-1].state' "$TEST_REQ_DIR/state.json")" == "deploy" ]]
    [[ "$(jq -r '.phase_history[-1].exited_at' "$TEST_REQ_DIR/state.json")" != "null" ]]
}