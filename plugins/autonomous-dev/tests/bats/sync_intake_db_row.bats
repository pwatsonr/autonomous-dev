#!/usr/bin/env bats

# Tests for map_state_status_to_intake() and sync_intake_db_row() functions (REQ-000013)
#
# Implements test cases U1–U9 from the spec.
#
# IMPORTANT: HOME must be set to a temp dir BEFORE sourcing supervisor-loop.sh,
# because INTAKE_DB="${DAEMON_HOME}/intake.db" is readonly and is evaluated at
# source time. Reassigning INTAKE_DB after sourcing fails with "readonly variable".

PLUGIN_DIR_PATH=""

setup() {
    PLUGIN_DIR_PATH="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"

    # Create temp home dir and set HOME BEFORE sourcing so that all readonly vars
    # (DAEMON_HOME, INTAKE_DB, LOG_DIR, LOG_FILE) resolve under the temp tree.
    TEST_WORK_DIR="$(mktemp -d)"
    export HOME="$TEST_WORK_DIR"

    # Pre-create the log directory so log_json can write to LOG_FILE at source time
    mkdir -p "$TEST_WORK_DIR/.autonomous-dev/logs"

    # Source the script so DAEMON_HOME and INTAKE_DB use the temp HOME
    set +e
    source "$PLUGIN_DIR_PATH/bin/supervisor-loop.sh"
    set -e

    TEST_PROJECT="$TEST_WORK_DIR/test-project"
    TEST_REQUEST_ID="REQ-260512"
    TEST_REQ_DIR="$TEST_PROJECT/.autonomous-dev/requests/$TEST_REQUEST_ID"
    mkdir -p "$TEST_REQ_DIR"
}

teardown() {
    rm -rf "$TEST_WORK_DIR"
}

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

# seed_db() — create the intake DB schema and insert a test row
seed_db() {
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

# ---------------------------------------------------------------------------
# U1: Every valid status maps to the right intake token
# ---------------------------------------------------------------------------
@test "map_state_status_to_intake: queued -> queued" {
    result=$(map_state_status_to_intake "queued")
    [ "$result" = "queued" ]
    [ $? -eq 0 ]
}

@test "map_state_status_to_intake: running -> active" {
    result=$(map_state_status_to_intake "running")
    [ "$result" = "active" ]
}

@test "map_state_status_to_intake: gate -> active" {
    result=$(map_state_status_to_intake "gate")
    [ "$result" = "active" ]
}

@test "map_state_status_to_intake: paused -> paused" {
    result=$(map_state_status_to_intake "paused")
    [ "$result" = "paused" ]
}

@test "map_state_status_to_intake: done -> done" {
    result=$(map_state_status_to_intake "done")
    [ "$result" = "done" ]
}

@test "map_state_status_to_intake: failed -> failed" {
    result=$(map_state_status_to_intake "failed")
    [ "$result" = "failed" ]
}

# ---------------------------------------------------------------------------
# U2: Unmapped input → empty stdout + rc 1
# ---------------------------------------------------------------------------
@test "map_state_status_to_intake: unmapped input returns empty and rc 1" {
    result=$(map_state_status_to_intake "bogus") || rc=$?
    [ -z "$result" ]
    [ "${rc:-0}" -eq 1 ]
}

@test "map_state_status_to_intake: cancelled is not producible" {
    result=$(map_state_status_to_intake "cancelled") || rc=$?
    [ -z "$result" ]
    [ "${rc:-0}" -eq 1 ]
}

# ---------------------------------------------------------------------------
# U3: Happy path — updates all three columns, rc 0, INFO logged
# ---------------------------------------------------------------------------
@test "sync_intake_db_row: happy path updates current_phase, status, and updated_at" {
    seed_db

    sync_intake_db_row "$TEST_REQUEST_ID" "prd" "running" "2026-05-20T00:00:00Z"
    local rc=$?

    [ $rc -eq 0 ]

    local phase status updated_at
    phase=$(ledger "current_phase")
    status=$(ledger "status")
    updated_at=$(ledger "updated_at")

    [ "$phase" = "prd" ]
    [ "$status" = "active" ]
    [ "$updated_at" = "2026-05-20T00:00:00Z" ]

    # INFO line should be in the log
    grep -q "ledger updated ${TEST_REQUEST_ID}" "$LOG_FILE"
}

# ---------------------------------------------------------------------------
# U4: gate maps to active, no CHECK violation
# ---------------------------------------------------------------------------
@test "sync_intake_db_row: gate maps to active with no CHECK violation" {
    seed_db

    sync_intake_db_row "$TEST_REQUEST_ID" "prd_review" "gate" "2026-05-20T01:00:00Z"
    local rc=$?

    [ $rc -eq 0 ]
    [ "$(ledger status)" = "active" ]
    # No sqlite error in log
    ! grep -q "sqlite3 UPDATE failed" "$LOG_FILE" || true
}

# ---------------------------------------------------------------------------
# U5: Zero-row match → WARN, rc 0, no INSERT
# ---------------------------------------------------------------------------
@test "sync_intake_db_row: unknown request_id logs WARN, rc 0, no INSERT" {
    seed_db

    sync_intake_db_row "REQ-NOPE" "prd" "running" "2026-05-20T00:00:00Z"
    local rc=$?

    [ $rc -eq 0 ]

    # WARN about 0 rows
    grep -q "0 rows updated for REQ-NOPE" "$LOG_FILE"

    # No row inserted for REQ-NOPE
    local cnt
    cnt=$(sqlite3 "$INTAKE_DB" "SELECT COUNT(*) FROM requests WHERE request_id='REQ-NOPE';")
    [ "$cnt" = "0" ]
}

# ---------------------------------------------------------------------------
# U6: sqlite3 failure → ERROR, rc 0, non-fatal
# ---------------------------------------------------------------------------
@test "sync_intake_db_row: corrupt DB file logs ERROR, rc 0, non-fatal" {
    seed_db
    # Overwrite the DB with garbage to trigger sqlite3 error
    echo "not a database" > "$INTAKE_DB"

    sync_intake_db_row "$TEST_REQUEST_ID" "prd" "running" "2026-05-20T00:00:00Z"
    local rc=$?

    [ $rc -eq 0 ]
    grep -q "sqlite3 UPDATE failed" "$LOG_FILE"
}

# ---------------------------------------------------------------------------
# U7: sqlite3 absent → ERROR, rc 0
# ---------------------------------------------------------------------------
@test "sync_intake_db_row: sqlite3 absent logs ERROR, rc 0" {
    # NOTE: Do NOT call seed_db — we test the "sqlite3 not found" branch,
    # which is checked BEFORE the DB-existence guard. Keeping INTAKE_DB absent
    # avoids triggering the "DB missing" WARN branch instead.

    # Build a minimal PATH that contains essential tools (jq, date, etc.) but
    # NOT sqlite3. Because jq and sqlite3 may share a directory (e.g. /usr/bin),
    # we create a temp bin dir with only the tools we know are needed.
    local safe_bin_dir
    safe_bin_dir="$(mktemp -d)"

    # Symlink essential tools that log_json and related helpers need
    for tool in jq date basename dirname; do
        local tp
        tp="$(which "$tool" 2>/dev/null || true)"
        [[ -n "$tp" && -x "$tp" ]] && ln -sf "$tp" "$safe_bin_dir/$tool" 2>/dev/null || true
    done

    # Clear bash's path hash so command -v uses the restricted PATH (not the
    # cache that remembers where sqlite3 was found during seed_db).
    hash -r 2>/dev/null || true

    PATH="$safe_bin_dir" sync_intake_db_row "$TEST_REQUEST_ID" "prd" "running" "2026-05-20T00:00:00Z"
    local rc=$?

    # Restore full PATH via hash rebuild
    hash -r 2>/dev/null || true

    rm -rf "$safe_bin_dir"

    [ $rc -eq 0 ]
    grep -q "sqlite3 CLI not found" "$LOG_FILE"
}

# ---------------------------------------------------------------------------
# U8: Apostrophe in request_id binds safely — row updated, no SQL injection
# ---------------------------------------------------------------------------
@test "sync_intake_db_row: apostrophe in request_id is escaped and row updates safely" {
    # Seed a row with an apostrophe-containing ID (SQL-escaped '' for direct insert).
    # The sync function uses double-quoted .parameter set values which handle
    # apostrophes without needing SQL escaping.
    mkdir -p "$DAEMON_HOME"
    sqlite3 "$INTAKE_DB" < "$PLUGIN_DIR_PATH/intake/db/schema.sql"
    sqlite3 "$INTAKE_DB" \
        "INSERT INTO requests (request_id,title,description,raw_input,requester_id,source_channel,current_phase,status)
         VALUES ('REQ-O''BRIEN','t','d','r','u','claude_app','intake','queued');"

    sync_intake_db_row "REQ-O'BRIEN" "prd" "running" "2026-05-20T00:00:00Z"
    local rc=$?

    # Function must always return 0 (non-fatal)
    [ $rc -eq 0 ]

    # The row should be updated successfully (double-quoted .parameter set handles apostrophes)
    local phase status
    phase=$(sqlite3 "$INTAKE_DB" "SELECT current_phase FROM requests WHERE request_id='REQ-O''BRIEN';")
    status=$(sqlite3 "$INTAKE_DB" "SELECT status FROM requests WHERE request_id='REQ-O''BRIEN';")

    [ "$phase" = "prd" ]
    [ "$status" = "active" ]

    # No unexpected rows should have been inserted (no SQL injection)
    local cnt
    cnt=$(sqlite3 "$INTAKE_DB" "SELECT COUNT(*) FROM requests;")
    [ "$cnt" = "1" ]
}

# ---------------------------------------------------------------------------
# U9: DB file missing → WARN, rc 0
# ---------------------------------------------------------------------------
@test "sync_intake_db_row: missing DB file logs WARN, rc 0" {
    # Do NOT call seed_db — leave INTAKE_DB non-existent
    [ ! -f "$INTAKE_DB" ]

    sync_intake_db_row "$TEST_REQUEST_ID" "prd" "running" "2026-05-20T00:00:00Z"
    local rc=$?

    [ $rc -eq 0 ]
    grep -q "not present; skipping ledger update" "$LOG_FILE"
}
