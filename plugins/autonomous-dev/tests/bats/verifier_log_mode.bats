#!/usr/bin/env bats
###############################################################################
# verifier_log_mode.bats — PLAN-042 Phase B
#
# Tests the daemon-side evidence verifier in LOG MODE (no enforcement).
# Phase B's job is to produce verification-report.jsonl describing what
# WOULD have failed under refuse mode (Phase C), without actually
# overriding the envelope.
#
# 8 cases per PLAN-042 Phase B brief:
#   1. presence pass: command in claim is in audit log
#   2. presence fail: command in claim is NOT in audit log
#   3. exit-code mismatch (idempotent re-exec path)
#   4. output-tail mismatch (idempotent re-exec path)
#   5. classification → idempotent triggers re-exec
#   6. classification → non-idempotent stays on audit-log-only path
#   7. classification → unclassifiable becomes would_have_failed in log mode
#   8. end-to-end report shape
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    VERIFIER="${PLUGIN_DIR}/lib/verification/verifier.sh"
    TMP="$(mktemp -d -t adv-verb-XXXXXX)"
    REQ_DIR="${TMP}/.autonomous-dev/requests/REQ-TEST"
    mkdir -p "${REQ_DIR}"
    WORKTREE="${REQ_DIR}/worktree"
    mkdir -p "${WORKTREE}"

    # Disable real re-execution by default; individual tests opt in by
    # exporting VERIFICATION_REEXEC=1 AND stubbing the command.
    export VERIFICATION_REEXEC=0
    export VERIFICATION_TAIL_THRESHOLD=0.5

    # Source the verifier so its functions are in scope.
    # shellcheck source=/dev/null
    source "${VERIFIER}"
}

teardown() {
    rm -rf "${TMP}"
    unset VERIFICATION_REEXEC VERIFICATION_TAIL_THRESHOLD VERIFICATION_MODE
}

# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

# write_envelope phase status evidence_json
write_envelope() {
    local phase="$1" status="$2" evidence="${3:-[]}"
    jq -n --arg s "${status}" --arg p "${phase}" --argjson e "${evidence}" '{
        status: $s, phase: $p, feedback: "agent-written", evidence: $e
    }' > "${REQ_DIR}/phase-result-${phase}.json"
}

# write_audit_log phase commands...
# Writes one JSONL row per command with exit_code=null (matches Phase A).
write_audit_log() {
    local phase="$1"; shift
    local log="${REQ_DIR}/command-audit.jsonl"
    : > "${log}"
    for cmd in "$@"; do
        jq -nc --arg phase "${phase}" --arg cmd "${cmd}" --arg ft "$(echo "${cmd}" | awk '{print $1}')" '{
            ts: "2026-05-19T12:00:00Z", phase: $phase, command: $cmd,
            argv: [$ft], cwd: "/tmp/wt", exit_code: null,
            duration_ms: null, output_tail: null, source: "sdk_hook"
        }' >> "${log}"
    done
    chmod 0600 "${log}"
}

# Read a JSONL row from the verification report by index (0-based).
report_row() {
    local idx="${1:-0}"
    awk -v i="${idx}" 'NR == (i+1) {print; exit}' "${REQ_DIR}/verification-report.jsonl"
}

# ─────────────────────────────────────────────────────────────────────
# Case 1: presence pass — command in claim is present in audit log
# ─────────────────────────────────────────────────────────────────────
@test "phase-b: presence — command in claim is in audit log → verified" {
    write_envelope "integration" "pass" \
        '[{"command":"bun test","exit_code":0,"output_tail":"1559 pass"}]'
    write_audit_log "integration" "bun test"
    run verify_envelope "${REQ_DIR}" "integration" "log"
    [[ "${status}" -eq 0 ]]
    [[ -f "${REQ_DIR}/verification-report.jsonl" ]]
    local row; row=$(report_row 0)
    [[ "$(printf '%s' "${row}" | jq -r .checks.presence)" == "pass" ]]
    # Re-exec disabled by setup, so verdict can still be "verified".
    [[ "$(printf '%s' "${row}" | jq -r .verdict)" == "verified" ]]
}

# ─────────────────────────────────────────────────────────────────────
# Case 2: presence fail — command NOT in audit log
# ─────────────────────────────────────────────────────────────────────
@test "phase-b: presence — command NOT in audit log → would_have_failed" {
    write_envelope "integration" "pass" \
        '[{"command":"bun test","exit_code":0,"output_tail":"1559 pass"}]'
    # Audit log lists a DIFFERENT command.
    write_audit_log "integration" "git status"
    run verify_envelope "${REQ_DIR}" "integration" "log"
    [[ "${status}" -eq 0 ]]
    local row; row=$(report_row 0)
    [[ "$(printf '%s' "${row}" | jq -r .checks.presence)" == "fail" ]]
    [[ "$(printf '%s' "${row}" | jq -r .verdict)" == "would_have_failed" ]]
    [[ "$(printf '%s' "${row}" | jq -r .reason)" =~ command_not_in_audit_log ]]
    # And the original envelope is UNCHANGED (log mode does not enforce).
    [[ "$(jq -r .status "${REQ_DIR}/phase-result-integration.json")" == "pass" ]]
}

# ─────────────────────────────────────────────────────────────────────
# Case 3: exit-code mismatch (idempotent re-exec path)
# ─────────────────────────────────────────────────────────────────────
@test "phase-b: idempotent re-exec — exit_code mismatch → would_have_failed" {
    # Claim: bun test pass, exit 0.
    write_envelope "integration" "pass" \
        '[{"command":"bun test","exit_code":0,"output_tail":"1559 pass / 0 fail"}]'
    write_audit_log "integration" "bun test"

    # Stub: override reexecute_command to return a DIFFERENT exit_code.
    reexecute_command() {
        jq -nc '{exit_code: 1, output_tail: "1559 pass / 0 fail", duration_ms: 100, error: ""}'
    }
    export VERIFICATION_REEXEC=1

    run verify_envelope "${REQ_DIR}" "integration" "log"
    [[ "${status}" -eq 0 ]]
    local row; row=$(report_row 0)
    [[ "$(printf '%s' "${row}" | jq -r .classification)" == "idempotent" ]]
    [[ "$(printf '%s' "${row}" | jq -r .checks.exit_code)" == "fail" ]]
    [[ "$(printf '%s' "${row}" | jq -r .verdict)" == "would_have_failed" ]]
}

# ─────────────────────────────────────────────────────────────────────
# Case 4: output-tail mismatch (idempotent re-exec path)
# ─────────────────────────────────────────────────────────────────────
@test "phase-b: idempotent re-exec — output_tail mismatch → would_have_failed" {
    write_envelope "integration" "pass" \
        '[{"command":"bun test","exit_code":0,"output_tail":"1559 pass / 0 fail\nsuite passed"}]'
    write_audit_log "integration" "bun test"

    # Stub re-exec returning matching exit but UNRELATED tail.
    reexecute_command() {
        jq -nc '{exit_code: 0, output_tail: "docker push complete\nsha256:abc", duration_ms: 100, error: ""}'
    }
    export VERIFICATION_REEXEC=1

    run verify_envelope "${REQ_DIR}" "integration" "log"
    [[ "${status}" -eq 0 ]]
    local row; row=$(report_row 0)
    [[ "$(printf '%s' "${row}" | jq -r .checks.exit_code)" == "pass" ]]
    [[ "$(printf '%s' "${row}" | jq -r .checks.output_tail)" == "fail" ]]
    [[ "$(printf '%s' "${row}" | jq -r .verdict)" == "would_have_failed" ]]
    [[ "$(printf '%s' "${row}" | jq -r .reason)" =~ output_tail_mismatch ]]
}

# ─────────────────────────────────────────────────────────────────────
# Case 5: classification — idempotent → re-exec path is entered
# ─────────────────────────────────────────────────────────────────────
@test "phase-b: idempotent command triggers re-exec path" {
    write_envelope "integration" "pass" \
        '[{"command":"pytest -k foo","exit_code":0,"output_tail":"collected 5 items\n5 passed in 1.2s"}]'
    write_audit_log "integration" "pytest -k foo"

    # Stub re-exec to record that we were called AND return a match.
    # output_tail differs only in the duration string (legitimate flake-
    # ish output normalization should match).
    REEXEC_CALLED_FILE="${TMP}/reexec.called"
    reexecute_command() {
        : > "${REEXEC_CALLED_FILE}"
        jq -nc '{exit_code: 0, output_tail: "collected 5 items\n5 passed in 0.9s", duration_ms: 50, error: ""}'
    }
    export VERIFICATION_REEXEC=1

    run verify_envelope "${REQ_DIR}" "integration" "log"
    [[ "${status}" -eq 0 ]]
    [[ -f "${REEXEC_CALLED_FILE}" ]]   # stub was hit
    local row; row=$(report_row 0)
    [[ "$(printf '%s' "${row}" | jq -r .classification)" == "idempotent" ]]
    [[ "$(printf '%s' "${row}" | jq -r .checks.re_execution)" == "pass" ]]
}

# ─────────────────────────────────────────────────────────────────────
# Case 6: classification — non-idempotent → audit-log-only (no re-exec)
# ─────────────────────────────────────────────────────────────────────
@test "phase-b: non-idempotent command stays on audit-log-only path" {
    write_envelope "deploy" "pass" \
        '[{"command":"git push origin main","exit_code":0,"output_tail":"ok"}]'
    write_audit_log "deploy" "git push origin main"

    # Tripwire: if the verifier calls reexecute_command for a
    # non-idempotent command, this fails the test loudly.
    REEXEC_CALLED_FILE="${TMP}/reexec.called"
    reexecute_command() {
        : > "${REEXEC_CALLED_FILE}"
        jq -nc '{exit_code: 0, output_tail: "", duration_ms: 0, error: ""}'
    }
    export VERIFICATION_REEXEC=1

    run verify_envelope "${REQ_DIR}" "deploy" "log"
    [[ "${status}" -eq 0 ]]
    [[ ! -f "${REEXEC_CALLED_FILE}" ]]  # re-exec NOT hit
    local row; row=$(report_row 0)
    [[ "$(printf '%s' "${row}" | jq -r .classification)" == "non_idempotent" ]]
    [[ "$(printf '%s' "${row}" | jq -r .checks.presence)" == "pass" ]]
    [[ "$(printf '%s' "${row}" | jq -r .checks.re_execution)" == "skipped" ]]
    [[ "$(printf '%s' "${row}" | jq -r .verdict)" == "verified" ]]
}

# ─────────────────────────────────────────────────────────────────────
# Case 7: classification — unclassifiable → would-deny log line
# (in log mode this is a would_have_failed row, NOT a phase-result change)
# ─────────────────────────────────────────────────────────────────────
@test "phase-b: unclassifiable command logs would_have_failed (no envelope change)" {
    write_envelope "integration" "pass" \
        '[{"command":"some-bespoke-tool --check","exit_code":0,"output_tail":"ok"}]'
    write_audit_log "integration" "some-bespoke-tool --check"

    run verify_envelope "${REQ_DIR}" "integration" "log"
    [[ "${status}" -eq 0 ]]
    local row; row=$(report_row 0)
    [[ "$(printf '%s' "${row}" | jq -r .classification)" == "unclassifiable" ]]
    [[ "$(printf '%s' "${row}" | jq -r .verdict)" == "would_have_failed" ]]
    [[ "$(printf '%s' "${row}" | jq -r .reason)" =~ unclassifiable ]]
    # Envelope unchanged.
    [[ "$(jq -r .status "${REQ_DIR}/phase-result-integration.json")" == "pass" ]]
}

# ─────────────────────────────────────────────────────────────────────
# Case 8: end-to-end shape — multi-evidence envelope + audit log, the
# generated verification-report.jsonl has one row per evidence entry,
# mode 0600, and the calibration summary is emitted to stderr.
# ─────────────────────────────────────────────────────────────────────
@test "phase-b: end-to-end produces JSONL report (mode 0600, one row per evidence, summary on stderr)" {
    write_envelope "integration" "pass" '[
      {"command":"bun test","exit_code":0,"output_tail":"1559 pass"},
      {"command":"tsc --noEmit","exit_code":0,"output_tail":"no errors"},
      {"command":"some-bespoke --x","exit_code":0,"output_tail":"ok"}
    ]'
    write_audit_log "integration" "bun test" "tsc --noEmit" "some-bespoke --x"

    # Capture stderr to inspect the summary line.
    local err_file="${TMP}/verifier.err"
    verify_envelope "${REQ_DIR}" "integration" "log" 2>"${err_file}"

    [[ -f "${REQ_DIR}/verification-report.jsonl" ]]
    # Three evidence entries → three JSONL rows.
    local rows; rows=$(wc -l < "${REQ_DIR}/verification-report.jsonl" | tr -d ' ')
    [[ "${rows}" == "3" ]]

    # Each row well-formed and has the right top-level fields.
    while IFS= read -r row; do
        for f in ts phase command classification checks verdict reason; do
            local v; v=$(printf '%s' "${row}" | jq "has(\"${f}\")")
            [[ "${v}" == "true" ]] || {
                echo "row missing ${f}: ${row}" >&2; false; return
            }
        done
        # checks substructure too.
        for f in presence exit_code output_tail re_execution; do
            local v; v=$(printf '%s' "${row}" | jq ".checks | has(\"${f}\")")
            [[ "${v}" == "true" ]] || {
                echo "row.checks missing ${f}: ${row}" >&2; false; return
            }
        done
    done < "${REQ_DIR}/verification-report.jsonl"

    # File mode is 0600.
    local mode
    mode=$(stat -f '%Lp' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null \
        || stat -c '%a' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)
    [[ "${mode}" == "600" ]]

    # Summary on stderr.
    grep -q "verification_summary: phase=integration" "${err_file}"
}
