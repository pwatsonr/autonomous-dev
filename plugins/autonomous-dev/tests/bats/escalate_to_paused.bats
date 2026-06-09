#!/usr/bin/env bats

# Tests for escalate_to_paused() — REQ-000014 pause-path SQLite mirror fix.
#
# Test cases:
#   P1 — happy path: ledger row updated to (current_phase, 'paused')
#   P2 — phase preservation: correct current_phase written to ledger
#   P3 — resilience: pause completes even when sqlite3 UPDATE fails
#   P4 — negative: update_state_cost does NOT call sync_intake_db_row
#   P5 — negative: update_request_state success path does NOT call sync_intake_db_row
#   P6 — documentation presence: audit doc and AUDIT REFERENCE comment exist
#
# IMPORTANT: HOME must be set to a temp dir BEFORE sourcing supervisor-loop.sh,
# because INTAKE_DB="${DAEMON_HOME}/intake.db" is readonly and evaluated at
# source time. Reassigning INTAKE_DB after sourcing fails with "readonly variable".

PLUGIN_DIR_PATH=""

setup() {
    PLUGIN_DIR_PATH="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"

    # Create temp home dir and set HOME BEFORE sourcing so all readonly vars
    # (DAEMON_HOME, INTAKE_DB, LOG_DIR, LOG_FILE) resolve under the temp tree.
    TEST_WORK_DIR="$(mktemp -d)"
    export HOME="$TEST_WORK_DIR"

    # Pre-create the log directory so log_json can write to LOG_FILE at source time
    mkdir -p "$TEST_WORK_DIR/.autonomous-dev/logs"

    # Source the script after HOME is set; set +e guards against early-exit branches
    set +e
    source "$PLUGIN_DIR_PATH/bin/supervisor-loop.sh"
    set -e

    # Test project and request identifiers
    TEST_PROJECT="$TEST_WORK_DIR/test-project"
    TEST_REQUEST_ID="REQ-260608"
    TEST_REQ_DIR="$TEST_PROJECT/.autonomous-dev/requests/$TEST_REQUEST_ID"
    mkdir -p "$TEST_REQ_DIR"
}

teardown() {
    rm -rf "$TEST_WORK_DIR"
}

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

# seed_db(current_phase, status) — create intake DB schema and insert a test row
seed_db() {
    local phase="${1:-code}"
    local status_val="${2:-active}"
    mkdir -p "$DAEMON_HOME"
    sqlite3 "$INTAKE_DB" < "$PLUGIN_DIR_PATH/intake/db/schema.sql"
    sqlite3 "$INTAKE_DB" \
        "INSERT INTO requests (request_id,title,description,raw_input,requester_id,source_channel,current_phase,status)
         VALUES ('$TEST_REQUEST_ID','t','d','r','u','claude_app','${phase}','${status_val}');"
}

# ledger <col> — read a column from the test request's row
ledger() {
    sqlite3 "$INTAKE_DB" "SELECT $1 FROM requests WHERE request_id='$TEST_REQUEST_ID';"
}

# seed_state(current_phase, status) — write a minimal state.json
seed_state() {
    local phase="${1:-code}"
    local status_val="${2:-active}"
    cat > "$TEST_REQ_DIR/state.json" << JSON
{
  "id": "$TEST_REQUEST_ID",
  "current_phase": "${phase}",
  "status": "${status_val}",
  "updated_at": "2026-06-08T00:00:00Z",
  "current_phase_metadata": {}
}
JSON
    # Create empty events.jsonl
    touch "$TEST_REQ_DIR/events.jsonl"
}

# ---------------------------------------------------------------------------
# P1 — happy path: pause mirrors (current_phase, 'paused') to ledger
# ---------------------------------------------------------------------------
@test "P1: escalate_to_paused mirrors status=paused and current_phase to ledger" {
    seed_db "code" "active"
    seed_state "code" "active"

    # Call the function (code phase, 3 retries exhausted)
    escalate_to_paused "$TEST_REQUEST_ID" "$TEST_PROJECT" "code" "3"
    local rc=$?

    # Function must always return 0 (non-fatal contract)
    [ $rc -eq 0 ]

    # state.json: status must be paused
    local state_status
    state_status=$(jq -r '.status' "$TEST_REQ_DIR/state.json")
    [ "$state_status" = "paused" ]

    # state.json: paused_reason must be set
    local paused_reason
    paused_reason=$(jq -r '.current_phase_metadata.paused_reason' "$TEST_REQ_DIR/state.json")
    [ "$paused_reason" = "Retry exhaustion in phase code" ]

    # intake.db: ledger row must reflect (current_phase=code, status=paused)
    local combined
    combined=$(sqlite3 "$INTAKE_DB" \
        "SELECT current_phase || '|' || status FROM requests WHERE request_id='$TEST_REQUEST_ID';")
    [ "$combined" = "code|paused" ]

    # Log must contain success line
    grep -q "ledger updated $TEST_REQUEST_ID" "$LOG_FILE"

    # state.json.updated_at must match the ledger's updated_at
    local state_ts ledger_ts
    state_ts=$(jq -r '.updated_at' "$TEST_REQ_DIR/state.json")
    ledger_ts=$(ledger "updated_at")
    [ "$state_ts" = "$ledger_ts" ]
}

# ---------------------------------------------------------------------------
# P2 — phase preservation: current_phase in ledger reflects the paused phase
# ---------------------------------------------------------------------------
@test "P2: escalate_to_paused preserves current_phase value in ledger" {
    # Seed with tdd phase (different from the default 'code')
    seed_db "tdd" "active"
    seed_state "tdd" "active"

    escalate_to_paused "$TEST_REQUEST_ID" "$TEST_PROJECT" "tdd" "3"
    local rc=$?

    [ $rc -eq 0 ]

    # state.json: current_phase must remain 'tdd' (jq filter does not change it)
    local state_phase
    state_phase=$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")
    [ "$state_phase" = "tdd" ]

    # intake.db: ledger must show (tdd, paused)
    local combined
    combined=$(sqlite3 "$INTAKE_DB" \
        "SELECT current_phase || '|' || status FROM requests WHERE request_id='$TEST_REQUEST_ID';")
    [ "$combined" = "tdd|paused" ]
}

# ---------------------------------------------------------------------------
# P3 — resilience: pause completes even when sqlite3 UPDATE fails
# ---------------------------------------------------------------------------
@test "P3: escalate_to_paused completes pause even when sqlite3 UPDATE fails" {
    # Seed DB and state BEFORE installing shim (so schema INSERT uses real sqlite3)
    seed_db "code" "active"
    seed_state "code" "active"

    # Install a sqlite3 shim that intercepts UPDATE requests and exits 1.
    # All other sqlite3 invocations are passed through to the real binary.
    local shim_dir
    shim_dir="$(mktemp -d)"
    local real_sqlite3
    real_sqlite3="$(command -v sqlite3)"

    cat > "$shim_dir/sqlite3" << SHIM
#!/usr/bin/env bash
# Read heredoc input into buffer
input="\$(cat)"
if printf '%s\n' "\$input" | grep -q 'UPDATE requests'; then
    echo "shim: simulated UPDATE failure" >&2
    exit 1
fi
# Pass through to real sqlite3
printf '%s\n' "\$input" | '${real_sqlite3}' "\$@"
SHIM
    chmod +x "$shim_dir/sqlite3"
    export PATH="$shim_dir:$PATH"
    hash -r 2>/dev/null || true

    # Call the function with the shim active
    escalate_to_paused "$TEST_REQUEST_ID" "$TEST_PROJECT" "code" "3"
    local rc=$?

    # Restore real PATH immediately
    export PATH="${PATH#"$shim_dir:"}"
    hash -r 2>/dev/null || true
    rm -rf "$shim_dir"

    # Function must still return 0 (non-fatal)
    [ $rc -eq 0 ]

    # state.json: pause must have completed
    local state_status
    state_status=$(jq -r '.status' "$TEST_REQ_DIR/state.json")
    [ "$state_status" = "paused" ]

    # Log must contain the sqlite3 failure message
    grep -q "sqlite3 UPDATE failed for $TEST_REQUEST_ID" "$LOG_FILE"

    # events.jsonl must contain exactly one retry_exhaustion event
    local event_count
    event_count=$(jq -r '.type' "$TEST_REQ_DIR/events.jsonl" | grep -c "retry_exhaustion" || true)
    [ "$event_count" -eq 1 ]
}

# ---------------------------------------------------------------------------
# P4 — negative: update_state_cost does NOT call sync_intake_db_row
# ---------------------------------------------------------------------------
@test "P4: update_state_cost does not mirror to intake.db ledger" {
    seed_db "code" "active"
    seed_state "code" "active"

    # Truncate log so assertions are scoped to this test only
    : > "$LOG_FILE"

    # Call update_state_cost
    update_state_cost "$TEST_REQUEST_ID" "$TEST_PROJECT" "0.12"

    # No sync_intake_db_row log line must have been emitted
    if grep -q "sync_intake_db_row:" "$LOG_FILE" 2>/dev/null; then
        echo "FAIL: sync_intake_db_row was called by update_state_cost" >&2
        false
    fi

    # Ledger row must be unchanged: still (code, active)
    local combined
    combined=$(sqlite3 "$INTAKE_DB" \
        "SELECT current_phase || '|' || status FROM requests WHERE request_id='$TEST_REQUEST_ID';")
    [ "$combined" = "code|active" ]

    # cost_accrued_usd must be updated in state.json
    local cost
    cost=$(jq -r '.cost_accrued_usd // 0' "$TEST_REQ_DIR/state.json")
    # verify cost changed (from 0 to 0.12)
    [ "$cost" = "0.12" ]
}

# ---------------------------------------------------------------------------
# P5 — negative: update_request_state success path does NOT mirror to ledger
# ---------------------------------------------------------------------------
@test "P5: update_request_state success path does not mirror to intake.db ledger" {
    seed_db "code" "active"
    seed_state "code" "active"

    # Truncate log so assertions are scoped to this test only
    : > "$LOG_FILE"

    # Call update_request_state in success path (outcome=success, cost=0.05)
    update_request_state "$TEST_REQUEST_ID" "$TEST_PROJECT" "success" "0.05"

    # No sync_intake_db_row log line must have been emitted
    if grep -q "sync_intake_db_row:" "$LOG_FILE" 2>/dev/null; then
        echo "FAIL: sync_intake_db_row was called by update_request_state" >&2
        false
    fi

    # Ledger row must be unchanged: still (code, active)
    local combined
    combined=$(sqlite3 "$INTAKE_DB" \
        "SELECT current_phase || '|' || status FROM requests WHERE request_id='$TEST_REQUEST_ID';")
    [ "$combined" = "code|active" ]
}

# ---------------------------------------------------------------------------
# P6 — documentation presence (FR-B1, FR-B2)
# ---------------------------------------------------------------------------
@test "P6: docs/triage/state-json-writers.md exists and AUDIT REFERENCE comment is present" {
    # Verify audit document exists
    local audit_doc="$PLUGIN_DIR_PATH/../../docs/triage/state-json-writers.md"
    test -f "$audit_doc"

    # Verify AUDIT REFERENCE comment is in supervisor-loop.sh
    grep -q "AUDIT REFERENCE" "$PLUGIN_DIR_PATH/bin/supervisor-loop.sh"

    # Verify the comment block also references the audit doc path
    grep -q "docs/triage/state-json-writers.md" "$PLUGIN_DIR_PATH/bin/supervisor-loop.sh"
}
