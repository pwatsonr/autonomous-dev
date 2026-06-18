#!/usr/bin/env bats
###############################################################################
# verifier_486_regression.bats — regression guard for #486
#
# #486: refuse-mode verification refused EVERY integration, so no request
# ever reached `done`. Two independent root causes, each covered here with
# a REAL re-execution (not the stubbed reexecute_command used elsewhere):
#
#   (a) Re-execution cwd fell back to ${req_dir} (which is
#       <project>/.autonomous-dev/requests/<id> — never the repo root), so
#       any command with a repo-relative path argument failed there.
#       Fix: fall back to the project repo root.
#
#   (b) `unclassifiable` commands were force-marked would_have_failed
#       ("deny-by-default"), so an agent that ran any unlisted read-only
#       command (file, diff <(..), VAR=$(..)) was refused. Fix: fall back
#       to the presence check alone; presence still catches a command the
#       agent claimed but never ran.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    VERIFIER="${PLUGIN_DIR}/lib/verification/verifier.sh"

    # A real "project" dir with a file at its root. NOTE: we deliberately
    # do NOT create ${REQ_DIR}/worktree, so the single-track fallback path
    # (the one #486 fixed) is exercised.
    PROJ="$(mktemp -d -t adv-486-XXXXXX)"
    printf 'hello\nworld\n' > "${PROJ}/README.md"
    REQ_DIR="${PROJ}/.autonomous-dev/requests/REQ-TEST"
    mkdir -p "${REQ_DIR}"

    export VERIFICATION_TAIL_THRESHOLD=0.5
    export VERIFICATION_REEXEC=1          # we want the REAL reexecute_command
    unset VERIFICATION_MODE
}

teardown() {
    rm -rf "${PROJ}"
    unset VERIFICATION_REEXEC VERIFICATION_TAIL_THRESHOLD VERIFICATION_MODE
}

# Write a one-row audit log so the presence check passes for ${1}.
_audit() {
    local cmd="$1"
    jq -nc --arg c "${cmd}" \
        '{ts:"2026-06-18T00:00:00Z",phase:"integration",command:$c,argv:[],cwd:".",exit_code:null,duration_ms:null,output_tail:null,source:"sdk_hook"}' \
        > "${REQ_DIR}/command-audit.jsonl"
    chmod 0600 "${REQ_DIR}/command-audit.jsonl"
}

_envelope() {  # _envelope <command> <exit_code> <output_tail>
    jq -n --arg c "$1" --argjson ec "$2" --arg t "$3" \
        '{status:"pass",phase:"integration",feedback:"ok",
          evidence:[{command:$c,exit_code:$ec,output_tail:$t}]}' \
        > "${REQ_DIR}/phase-result-integration.json"
}

# ── (a) repo-relative command verifies because re-exec runs in repo root ──
@test "486-a: repo-relative idempotent command verifies (re-exec cwd = project root)" {
    # Claimed exactly what the command produces AT THE REPO ROOT.
    local claim_tail; claim_tail="$(cd "${PROJ}" && wc -l README.md)"
    _envelope "wc -l README.md" 0 "${claim_tail}"
    _audit "wc -l README.md"

    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e

    if [[ "${rc}" -ne 0 ]]; then
        echo "expected rc=0 (verified), got ${rc}; report:" >&2
        cat "${REQ_DIR}/verification-report.jsonl" >&2 || true
    fi
    [[ "${rc}" -eq 0 ]]
    # The row must be verified via real re-execution.
    run jq -r 'select(.command=="wc -l README.md") | "\(.verdict) \(.checks.re_execution)"' \
        "${REQ_DIR}/verification-report.jsonl"
    [[ "${output}" == "verified pass" ]]
}

# ── (b) unclassifiable benign command is NOT refused (presence-only) ──
@test "486-b: unclassifiable command in audit log is verified by presence, not refused" {
    _envelope "file README.md" 0 "README.md: ASCII text"
    _audit "file README.md"          # 'file' is neither idempotent nor denied → unclassifiable

    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e

    [[ "${rc}" -eq 0 ]]
    run jq -r 'select(.classification=="unclassifiable") | "\(.verdict) \(.reason)"' \
        "${REQ_DIR}/verification-report.jsonl"
    [[ "${output}" == "verified unclassifiable_presence_only" ]]
}

# ── guard: an unclassifiable command the agent never ran is STILL refused ──
@test "486-guard: fabricated unclassifiable command (absent from audit log) is still refused" {
    _envelope "file /definitely/not/run" 0 "nope"
    _audit "ls"                       # audit log has a DIFFERENT command

    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e

    [[ "${rc}" -eq 2 ]]
    run jq -r 'select(.verdict=="would_have_failed") | .reason' \
        "${REQ_DIR}/verification-report.jsonl"
    [[ "${output}" == *"command_not_in_audit_log"* ]]
}

# ── presence-match robustness: tolerate cosmetic command differences ──
# The agent's self-reported evidence command rarely byte-matches the audited
# command (trailing redirections, quote style). Exact matching refused whole
# phases; normalization fixes that while still rejecting fabrications.
@test "presence: tolerant to trailing redirection and quote style; rejects fabrication" {
    source "${PLUGIN_DIR}/lib/verification/audit-log-reader.sh"
    local d="${BATS_TEST_TMPDIR}/al"; mkdir -p "${d}"
    printf '%s\n' '{"phase":"deploy","command":"git push origin br 2>&1","exit_code":0}'  >  "${d}/command-audit.jsonl"
    printf '%s\n' '{"phase":"deploy","command":"echo \"hi\"","exit_code":0}'              >> "${d}/command-audit.jsonl"

    run audit_log_has_command "${d}" "git push origin br"   # audited had trailing 2>&1
    [ "$status" -eq 0 ]
    run audit_log_has_command "${d}" "echo 'hi'"            # audited used double quotes
    [ "$status" -eq 0 ]
    run audit_log_has_command "${d}" "pytest -k smoke"      # never ran → still rejected
    [ "$status" -ne 0 ]
}
