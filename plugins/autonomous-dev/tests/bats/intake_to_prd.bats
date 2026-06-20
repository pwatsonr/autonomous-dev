#!/usr/bin/env bats

# Tests for intake_to_prd_if_needed() function (SPEC-039-2-06)
# Integration tests I1, R1 for REQ-000013 (intake DB ledger sync) also live here.

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
# Shared DB helpers for REQ-000013 integration / regression tests
# ---------------------------------------------------------------------------

# seed_db_intake() — seed the DB with request in (intake, queued) state
seed_db_intake() {
    mkdir -p "$DAEMON_HOME"
    sqlite3 "$INTAKE_DB" < "$PLUGIN_DIR_PATH/intake/db/schema.sql"
    sqlite3 "$INTAKE_DB" \
        "INSERT INTO requests (request_id,title,description,raw_input,requester_id,source_channel,current_phase,status)
         VALUES ('$TEST_REQUEST_ID','t','d','r','u','claude_app','intake','queued');"
}

# ledger <col> — read a column from the test request's row
ledger() {
    sqlite3 "$INTAKE_DB" "SELECT $1 FROM requests WHERE request_id='$TEST_REQUEST_ID';"
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

@test "#548: queued/intake trivial-docs request transitions to spec (honors phase_overrides, skips prd)" {
    # A lighter-pipeline request (#526) whose override skips prd/prd_review/tdd/
    # tdd_review/plan/plan_review. The first transition must go intake -> spec,
    # NOT the hardcoded intake -> prd.
    cat > "$TEST_REQ_DIR/state.json" << EOF
{
  "id": "$TEST_REQUEST_ID",
  "status": "queued",
  "current_phase": "intake",
  "task_size": "trivial-docs",
  "phase_overrides": ["intake","spec","spec_review","code","code_review","integration","deploy","monitor"],
  "priority": 1,
  "created_at": "2026-05-12T10:00:00Z",
  "updated_at": "2026-05-12T10:00:00Z"
}
EOF

    intake_to_prd_if_needed "$TEST_REQUEST_ID" "$TEST_PROJECT"
    local result=$?
    [[ $result -eq 0 ]]

    local status current_phase to_phase
    status=$(jq -r '.status' "$TEST_REQ_DIR/state.json")
    current_phase=$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")
    to_phase=$(jq -r '.to' "$TEST_REQ_DIR/events.jsonl")
    [[ "$status" == "running" ]]
    [[ "$current_phase" == "spec" ]]   # NOT prd — the override is honored
    [[ "$to_phase" == "spec" ]]
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

# ===========================================================================
# Integration and Regression tests for REQ-000013: intake DB ledger mirroring
# ===========================================================================

# ---------------------------------------------------------------------------
# I1: intake→prd transition mirrors ('prd', 'active') in ledger
# ---------------------------------------------------------------------------
@test "I1: intake_to_prd_if_needed mirrors ledger to (prd, active)" {
    # Seed: DB has (intake, queued); state.json has (intake, queued)
    seed_db_intake

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

    intake_to_prd_if_needed "$TEST_REQUEST_ID" "$TEST_PROJECT"
    local result=$?

    # Function must return 0 (transition happened)
    [[ $result -eq 0 ]]

    # state.json: transition to prd/running
    local state_phase state_status
    state_phase=$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")
    state_status=$(jq -r '.status' "$TEST_REQ_DIR/state.json")
    [[ "$state_phase" == "prd" ]]
    [[ "$state_status" == "running" ]]

    # intake.db: ledger row must reflect ('prd', 'active')
    [[ "$(ledger current_phase)" == "prd" ]]
    [[ "$(ledger status)" == "active" ]]
}

# ---------------------------------------------------------------------------
# R1: Regression test — reproduce REQ-000011 drift scenario
#   Before the fix: ledger stays at ('intake','queued') after the transition.
#   After the fix:  ledger reflects ('prd','active').
# ---------------------------------------------------------------------------
@test "R1: regression — intake DB no longer drifts after intake_to_prd transition" {
    # Seed: ledger starts at (intake, queued) — the drifted state from REQ-000011
    seed_db_intake

    local before_phase before_status
    before_phase=$(ledger current_phase)
    before_status=$(ledger status)
    [[ "$before_phase" == "intake" ]]
    [[ "$before_status" == "queued" ]]

    # state.json also starts at (intake, queued)
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

    # Execute the transition
    intake_to_prd_if_needed "$TEST_REQUEST_ID" "$TEST_PROJECT"

    # After the fix, the ledger must NOT remain ('intake', 'queued').
    # It must reflect the updated ('prd', 'active').
    local after_phase after_status
    after_phase=$(ledger current_phase)
    after_status=$(ledger status)

    # This is the key regression assertion: ledger is no longer stuck at intake/queued
    [[ "$after_phase" == "prd" ]]
    [[ "$after_status" == "active" ]]

    # Double-check: SELECT current_phase,status returns 'prd|active' not 'intake|queued'
    local combined
    combined=$(sqlite3 "$INTAKE_DB" \
        "SELECT current_phase || '|' || status FROM requests WHERE request_id='$TEST_REQUEST_ID';")
    [[ "$combined" == "prd|active" ]]
}