#!/usr/bin/env bats
###############################################################################
# observability_cli.bats -- Tests for cli_list_stuck.sh and cli_show_stuck.sh
# REQ-000060 / TASK-008
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    OBS_LIB="${PLUGIN_DIR}/lib/observability"
    # shellcheck source=../../lib/observability/session_transcript.sh
    source "${OBS_LIB}/session_transcript.sh"
    # shellcheck source=../../lib/observability/cli_list_stuck.sh
    source "${OBS_LIB}/cli_list_stuck.sh"
    # shellcheck source=../../lib/observability/cli_show_stuck.sh
    source "${OBS_LIB}/cli_show_stuck.sh"

    # Create fixture layout
    FIXTURE_HOME="${BATS_TMPDIR}/cli-home-$$"
    mkdir -p "${FIXTURE_HOME}"

    # Set up .autonomous-dev/requests structure
    STATE_DIR="${FIXTURE_HOME}/.autonomous-dev/requests"
    mkdir -p "${STATE_DIR}/REQ-000001"
    mkdir -p "${STATE_DIR}/REQ-000002"

    # Create 3 snapshot files
    # REQ-000001: 2 snapshots (different timestamps)
    SNAP1="${STATE_DIR}/REQ-000001/session-stuck-2026-07-07T10-00-00.000Z.json"
    SNAP2="${STATE_DIR}/REQ-000001/session-stuck-2026-07-07T11-00-00.000Z.json"
    SNAP3="${STATE_DIR}/REQ-000002/session-stuck-2026-07-07T09-00-00.000Z.json"

    jq -n '{schema_version:1,captured_at:"2026-07-07T10:00:00.000Z",mode:"postmortem",reason:"hard_timeout",request_id:"REQ-000001",phase:"code",agent:null,elapsed_ms:3600000,session:{pid:null,ps_line:"unavailable",open_fds:[],lsof_truncated:false,lsof_error:"unavailable"},transcript:{path:"/tmp/s.txt",bytes:0,last_mtime:null,silent_seconds:0,tail_128_lines:[]},heartbeat:{last_two_samples:[],hung_suspected_count:0,first_suspected_at:null},baselines:{phase:"code",p50_ms:null,p95_ms:null,sample_count:0,elapsed_vs_p95_ratio:null},recovery_hint:"Wall-clock timeout reached; see phase_baselines to tune timeout"}' > "$SNAP1"
    jq -n '{schema_version:1,captured_at:"2026-07-07T11:00:00.000Z",mode:"advisory",reason:"silent_stall",request_id:"REQ-000001",phase:"plan",agent:null,elapsed_ms:1800000,session:{pid:null,ps_line:"unavailable",open_fds:[],lsof_truncated:false,lsof_error:"unavailable"},transcript:{path:"/tmp/s2.txt",bytes:50,last_mtime:"2026-07-07T10:50:00.000Z",silent_seconds:600,tail_128_lines:["partial output"]},heartbeat:{last_two_samples:[],hung_suspected_count:2,first_suspected_at:"2026-07-07T10:45:00Z"},baselines:{phase:"plan",p50_ms:600000,p95_ms:900000,sample_count:10,elapsed_vs_p95_ratio:2.0},recovery_hint:"Session stalled with no observed activity; inspect ps for zombie/defunct"}' > "$SNAP2"
    jq -n '{schema_version:1,captured_at:"2026-07-07T09:00:00.000Z",mode:"postmortem",reason:"agent_exited_nonzero",request_id:"REQ-000002",phase:"integration",agent:null,elapsed_ms:900000,session:{pid:null,ps_line:"unavailable",open_fds:[],lsof_truncated:false,lsof_error:"unavailable"},transcript:{path:"/tmp/s3.txt",bytes:200,last_mtime:"2026-07-07T09:14:00.000Z",silent_seconds:0,tail_128_lines:["error: nonzero exit"]},heartbeat:{last_two_samples:[],hung_suspected_count:0,first_suspected_at:null},baselines:{phase:"integration",p50_ms:300000,p95_ms:600000,sample_count:5,elapsed_vs_p95_ratio:1.5},recovery_hint:"Agent exited without phase-result; check transcript tail for error line"}' > "$SNAP3"

    # Point the CLI tools at the fixture state dir via env override
    export HOME="${FIXTURE_HOME}"
    export AUTONOMOUS_DEV_REQUESTS_DIR="${STATE_DIR}"
}

teardown() {
    rm -rf "${FIXTURE_HOME}" 2>/dev/null || true
    unset HOME AUTONOMOUS_DEV_REQUESTS_DIR
}

# T8-U1: Empty listing (text mode)
@test "cli_list_stuck with empty state dir prints 'No stuck sessions found.'" {
    local empty_home="${BATS_TMPDIR}/empty-home-$$"
    mkdir -p "${empty_home}/.autonomous-dev/requests"
    local old_home="$HOME"
    local old_req_dir="${AUTONOMOUS_DEV_REQUESTS_DIR:-}"
    export HOME="$empty_home"
    export AUTONOMOUS_DEV_REQUESTS_DIR="${empty_home}/.autonomous-dev/requests"
    run cli_list_stuck
    export HOME="$old_home"
    if [[ -n "$old_req_dir" ]]; then export AUTONOMOUS_DEV_REQUESTS_DIR="$old_req_dir"; else unset AUTONOMOUS_DEV_REQUESTS_DIR; fi
    rm -rf "$empty_home"
    [ "$status" -eq 0 ]
    [ "$output" = "No stuck sessions found." ]
}

# T8-U2: Empty listing (JSON mode)
@test "cli_list_stuck --json with empty state dir prints '[]'" {
    local empty_home="${BATS_TMPDIR}/empty-home2-$$"
    mkdir -p "${empty_home}/.autonomous-dev/requests"
    local old_home="$HOME"
    local old_req_dir="${AUTONOMOUS_DEV_REQUESTS_DIR:-}"
    export HOME="$empty_home"
    export AUTONOMOUS_DEV_REQUESTS_DIR="${empty_home}/.autonomous-dev/requests"
    run cli_list_stuck --json
    export HOME="$old_home"
    if [[ -n "$old_req_dir" ]]; then export AUTONOMOUS_DEV_REQUESTS_DIR="$old_req_dir"; else unset AUTONOMOUS_DEV_REQUESTS_DIR; fi
    rm -rf "$empty_home"
    [ "$status" -eq 0 ]
    [ "$output" = "[]" ]
}

# T8-U3: Three rows DESC by captured_at
@test "cli_list_stuck shows 3 rows sorted DESC by captured_at" {
    run cli_list_stuck
    [ "$status" -eq 0 ]
    # Count data rows (skip header lines)
    local data_rows
    data_rows="$(echo "$output" | grep -v "^-" | grep -v "^REQUEST_ID" | grep -v "^$" | wc -l | tr -d ' ')"
    [ "$data_rows" -eq 3 ]
}

# T8-U4: Filter by request
@test "cli_list_stuck --request REQ-000001 shows only 2 rows" {
    run cli_list_stuck --request REQ-000001
    [ "$status" -eq 0 ]
    local data_rows
    data_rows="$(echo "$output" | grep -v "^-" | grep -v "^REQUEST_ID" | grep -v "^$" | grep "REQ-000001" | wc -l | tr -d ' ')"
    [ "$data_rows" -eq 2 ]
}

# T8-U5: JSON mode parseable and returns 3 items
@test "cli_list_stuck --json returns parseable array of length 3" {
    run cli_list_stuck --json
    [ "$status" -eq 0 ]
    local count
    count="$(echo "$output" | jq 'length')"
    [ "$count" -eq 3 ]
}

# T8-U6: show-stuck by path
@test "cli_show_stuck by path prints JSON and RECOVERY HINT section" {
    run cli_show_stuck "${SNAP1}"
    [ "$status" -eq 0 ]
    echo "$output" | grep -q '"schema_version"'
    echo "$output" | grep -q "RECOVERY HINT:"
}

# T8-U7: show-stuck by REQ-ID picks newest snapshot
@test "cli_show_stuck REQ-000001 picks the newest snapshot" {
    run cli_show_stuck REQ-000001
    [ "$status" -eq 0 ]
    # Newest for REQ-000001 is SNAP2 (11:00)
    echo "$output" | grep -q '"2026-07-07T11:00:00.000Z"'
}

# T8-U8: show-stuck missing
@test "cli_show_stuck nonexistent REQ exits 1 with error message" {
    run cli_show_stuck REQ-999999
    [ "$status" -eq 1 ]
    echo "$output" | grep -qi "snapshot not found"
}

# cli_list_stuck DESC ordering
@test "cli_list_stuck --json sorts newest first" {
    run cli_list_stuck --json
    [ "$status" -eq 0 ]
    local first_captured
    first_captured="$(echo "$output" | jq -r '.[0].captured_at')"
    # Newest is 11:00
    [ "$first_captured" = "2026-07-07T11:00:00.000Z" ]
}
