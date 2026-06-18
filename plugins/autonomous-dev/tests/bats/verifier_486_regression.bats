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

# ── guard: a fabricated CLASSIFIABLE command (absent from audit log) is STILL
# refused. This is the core anti-fabrication property — claiming a real,
# runnable command (test/build/git/gh) that was never run is caught. Per #494
# an *unclassifiable* prose claim is NOT the refusal mechanism (next test).
@test "486-guard: fabricated CLASSIFIABLE command (absent from audit log) is still refused" {
    _envelope "git push origin smoke" 0 "pushed"   # classifiable (non-idempotent) claim
    _audit "ls"                                     # but only ls actually ran

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

# ── #494: an unclassifiable/prose claim absent from the audit log does NOT
# refuse. Agents write prose into evidence (e.g. "consolidated TC-1 … test
# run"); that is not a verbatim command, so a presence miss there is not a
# fabrication signal. The agent's real, classifiable work carries verification.
@test "494: unclassifiable prose claim absent from audit log does NOT refuse" {
    _envelope "consolidated TC-1 through TC-9 test run" 0 "all pass"
    _audit "ls"

    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e

    [[ "${rc}" -eq 0 ]]
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

# ── #494: tolerate the exit-code-capture wrapper the agent appends when running
# but omits when reporting (e.g. `&& echo "EXIT:$?"`, `2>&1; echo "EXIT:$?"`) —
# the dominant claim/audit mismatch observed in REQ-000020.
@test "494: presence tolerant to exit-capture wrapper" {
    source "${PLUGIN_DIR}/lib/verification/audit-log-reader.sh"
    local d="${BATS_TEST_TMPDIR}/al2"; mkdir -p "${d}"
    printf '%s\n' '{"phase":"integration","command":"wc -l < README.md && echo \"EXIT:$?\"","exit_code":0}' >  "${d}/command-audit.jsonl"
    printf '%s\n' '{"phase":"integration","command":"git diff --numstat HEAD~1 HEAD -- README.md 2>&1; echo \"EXIT:$?\"","exit_code":0}' >> "${d}/command-audit.jsonl"

    run audit_log_has_command "${d}" "wc -l < README.md"
    [ "$status" -eq 0 ]
    run audit_log_has_command "${d}" "git diff --numstat HEAD~1 HEAD -- README.md"
    [ "$status" -eq 0 ]
}

# ── #496: a compound &&-chained claim verifies when its parts actually ran —
# even when the audit grouped them into different compounds. Atoms-subset:
# both sides are split on &&/||/; and every claim atom must be an audit atom.
@test "496: compound claim verifies via atoms-subset; chain with a fake part refused" {
    source "${PLUGIN_DIR}/lib/verification/audit-log-reader.sh"
    local d="${BATS_TEST_TMPDIR}/alc"; mkdir -p "${d}"
    # the agent ran the parts grouped its own way (different compounds)
    printf '%s\n' '{"phase":"integration","command":"cd /r && git status && git log --oneline -5","exit_code":0}' >  "${d}/command-audit.jsonl"
    printf '%s\n' '{"phase":"integration","command":"cat -n README.md && echo \"---\"","exit_code":0}'              >> "${d}/command-audit.jsonl"

    # claim chains them in yet another grouping — all parts ran → PRESENT
    run audit_log_has_command "${d}" "git log --oneline -5 && git status && cat -n README.md"
    [ "$status" -eq 0 ]
    # a chain containing a never-run command is still refused (fabrication)
    run audit_log_has_command "${d}" "git status && bun test"
    [ "$status" -ne 0 ]
}
