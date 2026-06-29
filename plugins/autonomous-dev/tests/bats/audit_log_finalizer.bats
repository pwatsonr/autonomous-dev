#!/usr/bin/env bats
###############################################################################
# audit_log_finalizer.bats — REQ-000052 TASK-013
#
# Tests for the PostToolUse audit-log finalizer hook.
# Tests AF-FIN-01..AF-FIN-05 per spec §4.3.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    PRE_HOOK="${PLUGIN_DIR}/hooks/audit-log-writer.sh"
    POST_HOOK="${PLUGIN_DIR}/hooks/audit-log-finalizer.sh"

    TMP="$(mktemp -d -t adv-fin-XXXXXX)"
    REQ_DIR="${TMP}/.autonomous-dev/requests/REQ-FIN"
    mkdir -p "${REQ_DIR}"

    LOG="${REQ_DIR}/command-audit.jsonl"
    : > "${LOG}"
    chmod 0600 "${LOG}"

    export AUDIT_LOG_PATH="${LOG}"
    export AUDIT_PHASE="integration"
}

teardown() {
    rm -rf "${TMP}"
    unset AUDIT_LOG_PATH AUDIT_PHASE
}

# ── Helper: build a PostToolUse event JSON ────────────────────────────────────
post_event() {
    local tool_use_id="$1" command="$2" exit_code="${3:-0}" stdout_val="${4:-}"
    jq -nc \
        --arg id "${tool_use_id}" \
        --arg cmd "${command}" \
        --argjson ec "${exit_code}" \
        --arg out "${stdout_val}" \
        '{
            hook_event_name: "PostToolUse",
            tool_name: "Bash",
            tool_use_id: $id,
            tool_input: { command: $cmd },
            tool_response: {
                exit_code: $ec,
                stdout: $out,
                stderr: ""
            }
        }'
}

pre_event() {
    local tool_use_id="$1" command="$2"
    jq -nc \
        --arg id "${tool_use_id}" \
        --arg cmd "${command}" \
        '{
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_use_id: $id,
            tool_input: { command: $cmd }
        }'
}

# ── AF-FIN-01: PostToolUse merges existing PreToolUse row ────────────────────
@test "AF-FIN-01: PostToolUse merges exit_code and output_tail into PreToolUse row" {
    # Seed a PreToolUse-style row with tool_use_id.
    printf '%s\n' "$(jq -nc \
        '{ts:"2026-06-29T20:00:00Z",phase:"integration",command:"bun test",
          argv:["bun"],cwd:"/tmp",exit_code:null,duration_ms:null,
          output_tail:null,source:"sdk_hook_pre",tool_use_id:"toolu_X"}')" \
        >> "${LOG}"

    # Fire the PostToolUse hook.
    post_event "toolu_X" "bun test" 0 "Tests: 208 passed, 0 failed" \
        | bash "${POST_HOOK}"

    # Still exactly one row.
    local count
    count="$(wc -l < "${LOG}" | tr -d ' ')"
    [ "${count}" -eq 1 ]

    local row
    row="$(head -n1 "${LOG}")"

    # tool_use_id preserved.
    [ "$(printf '%s' "${row}" | jq -r '.tool_use_id')" = "toolu_X" ]

    # exit_code merged.
    [ "$(printf '%s' "${row}" | jq -r '.exit_code')" = "0" ]

    # output_tail non-empty.
    [ "$(printf '%s' "${row}" | jq -r '.output_tail // ""')" != "" ]

    # source updated.
    local src
    src="$(printf '%s' "${row}" | jq -r '.source')"
    [[ "${src}" == *"sdk_hook_post"* ]]
}

# ── AF-FIN-02: Backfill when no matching PreToolUse row ──────────────────────
@test "AF-FIN-02: PostToolUse appends backfill row when no matching pre-row" {
    # Log is empty — no pre-existing row.
    post_event "toolu_Y" "bun lint" 0 "No lint errors" \
        | bash "${POST_HOOK}"

    local count
    count="$(wc -l < "${LOG}" | tr -d ' ')"
    [ "${count}" -eq 1 ]

    local row
    row="$(head -n1 "${LOG}")"
    [ "$(printf '%s' "${row}" | jq -r '.source')" = "sdk_hook_post" ]
    [ "$(printf '%s' "${row}" | jq -r '.command')" = "bun lint" ]
    [ "$(printf '%s' "${row}" | jq -r '.exit_code')" = "0" ]
}

# ── AF-FIN-03: Non-Bash tool no-op ───────────────────────────────────────────
@test "AF-FIN-03: non-Bash tool event is a no-op" {
    local before_size
    before_size="$(wc -c < "${LOG}" | tr -d ' ')"

    jq -nc '{hook_event_name:"PostToolUse",tool_name:"Read",tool_use_id:"toolu_Z",
             tool_input:{path:"/etc/hosts"},tool_response:{stdout:"",stderr:""}}' \
        | bash "${POST_HOOK}"

    local after_size
    after_size="$(wc -c < "${LOG}" | tr -d ' ')"
    [ "${before_size}" -eq "${after_size}" ]
}

# ── AF-FIN-04: AUDIT_LOG_PATH unset no-op ────────────────────────────────────
@test "AF-FIN-04: unset AUDIT_LOG_PATH is a no-op" {
    unset AUDIT_LOG_PATH
    local rc=0
    post_event "toolu_A" "bun test" 0 "" \
        | bash "${POST_HOOK}" || rc=$?
    [ "${rc}" -eq 0 ]
    # No new file created.
    [ ! -f "${TMP}/unexpected.jsonl" ]
}

# ── AF-FIN-05: Concurrent Pre + Post (flock) ─────────────────────────────────
@test "AF-FIN-05: concurrent appenders produce no torn rows (flock)" {
    command -v flock >/dev/null 2>&1 || skip "flock not available — race test skipped"

    local pre_event_json post_event_json
    pre_event_json="$(jq -nc '{hook_event_name:"PreToolUse",tool_name:"Bash",
        tool_use_id:"",tool_input:{command:"echo concurrent"}}')"
    post_event_json="$(jq -nc '{hook_event_name:"PostToolUse",tool_name:"Bash",
        tool_use_id:"",tool_input:{command:"echo concurrent"},
        tool_response:{exit_code:0,stdout:"ok",stderr:""}}')"

    local i
    for i in {1..50}; do
        printf '%s' "${pre_event_json}"  | bash "${PRE_HOOK}"  &
        printf '%s' "${post_event_json}" | bash "${POST_HOOK}" &
    done
    wait

    local line_count
    line_count="$(wc -l < "${LOG}" | tr -d ' ')"
    [ "${line_count}" -eq 100 ]

    # Every line must parse as valid JSON.
    jq -c . "${LOG}" > /dev/null
}
