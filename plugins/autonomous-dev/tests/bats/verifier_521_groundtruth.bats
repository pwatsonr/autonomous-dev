#!/usr/bin/env bats
###############################################################################
# verifier_521_groundtruth.bats — regression guard for #521
#
# #521: refuse-mode integration verification flaked on most runs because it
# matched the agent's SELF-REPORTED evidence command strings against the audit
# log. Agents paraphrase READ-ONLY INSPECTION commands every run (grep flag
# order, `head -n3` vs `head -3`, `git diff a..b` with different refs), so an
# auxiliary presence/re-exec miss falsely refused whole phases even though the
# real test/build verification passed.
#
# The fix is ground-truth-first: per-row verdicts are unchanged, but the
# PHASE-refusal decision now treats command ROLE:
#   • SUBSTANTIVE failure (test/build/lint/type runner, git push, gh pr create)
#     → ALWAYS fatal (anti-fabrication floor; preserves every red-team fixture).
#   • AUXILIARY failure (read-only inspection drift) → fatal ONLY when there is
#     no ground truth the phase did real work (no substantive command verified
#     AND no mergeable PR artifact).
#
# These tests pin that behavior so a future refactor can't silently regress it.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    VERIFIER="${PLUGIN_DIR}/lib/verification/verifier.sh"

    # req_dir under mktemp → project root (req_dir/../../..) is NOT a git work
    # tree, so the ground-truth PR check is inert (no network) and the only
    # ground-truth signal in play is substantive_verified.
    PROJ="$(mktemp -d -t adv-521-XXXXXX)"
    REQ_DIR="${PROJ}/.autonomous-dev/requests/REQ-TEST"
    mkdir -p "${REQ_DIR}"

    export VERIFICATION_TAIL_THRESHOLD=0.5
    export VERIFICATION_REEXEC=0     # presence-only; substantive commands verify by presence
    unset VERIFICATION_MODE
}

teardown() {
    rm -rf "${PROJ}"
    unset VERIFICATION_REEXEC VERIFICATION_TAIL_THRESHOLD VERIFICATION_MODE
}

# _audit cmd...  — write one audit-log row per command (exit_code=null).
_audit() {
    : > "${REQ_DIR}/command-audit.jsonl"
    local c
    for c in "$@"; do
        jq -nc --arg c "${c}" \
            '{ts:"2026-06-19T00:00:00Z",phase:"integration",command:$c,argv:[],cwd:".",exit_code:null,duration_ms:null,output_tail:null,source:"sdk_hook"}' \
            >> "${REQ_DIR}/command-audit.jsonl"
    done
    chmod 0600 "${REQ_DIR}/command-audit.jsonl"
}

# _envelope evidence_json  — write a claimed-pass integration envelope.
_envelope() {
    jq -n --argjson e "$1" \
        '{status:"pass",phase:"integration",feedback:"all checks pass — agent claimed",evidence:$e}' \
        > "${REQ_DIR}/phase-result-integration.json"
}

# ─────────────────────────────────────────────────────────────────────
# 521-a: THE FIX. Auxiliary inspection drift does NOT refuse when a
# substantive command actually verified.
# ─────────────────────────────────────────────────────────────────────
@test "521-a: auxiliary drift does not refuse when a substantive command verified" {
    # Substantive command (gh pr create) actually ran → present in audit.
    # Auxiliary command (git diff) the agent mis-quoted → absent (different refs).
    _envelope '[
        {"command":"gh pr create --fill","exit_code":0,"output_tail":"https://github.com/o/r/pull/9"},
        {"command":"git diff abc123..def456 -- README.md","exit_code":0,"output_tail":"+hello"}
    ]'
    _audit "gh pr create --fill" "git diff HEAD~1 HEAD"

    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e

    if [[ "${rc}" -ne 0 ]]; then
        echo "expected rc=0 (auxiliary drift rescued by ground truth), got ${rc}" >&2
        cat "${REQ_DIR}/verification-report.jsonl" >&2 || true
    fi
    [[ "${rc}" -eq 0 ]]

    # Observability preserved: the auxiliary command is STILL recorded as
    # would_have_failed (operators see the drift) — it just isn't fatal.
    run jq -r 'select(.role=="auxiliary") | "\(.verdict) \(.reason)"' \
        "${REQ_DIR}/verification-report.jsonl"
    [[ "${output}" == *"would_have_failed"* ]]
    [[ "${output}" == *"command_not_in_audit_log"* ]]
    # And the substantive command verified.
    run jq -r 'select(.role=="substantive") | .verdict' \
        "${REQ_DIR}/verification-report.jsonl"
    [[ "${output}" == "verified" ]]
}

# ─────────────────────────────────────────────────────────────────────
# 521-b: auxiliary drift STILL refuses when NOTHING substantive verified
# and there is no PR artifact (the f10 property, held in a real dir).
# ─────────────────────────────────────────────────────────────────────
@test "521-b: auxiliary drift still refuses with no ground truth (no substantive, no PR)" {
    _envelope '[
        {"command":"git diff abc123..def456 -- README.md","exit_code":0,"output_tail":"+hello"}
    ]'
    _audit "git log --oneline -5"   # only an unrelated read-only command ran

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

# ─────────────────────────────────────────────────────────────────────
# 521-c: a SUBSTANTIVE failure is never masked by other verified work.
# Ground truth can rescue auxiliary drift, NOT a real test/build lie.
# ─────────────────────────────────────────────────────────────────────
@test "521-c: substantive failure refuses even when another substantive command verified" {
    _envelope '[
        {"command":"pytest -k smoke","exit_code":0,"output_tail":"5 passed"},
        {"command":"bun test","exit_code":0,"output_tail":"1559 pass / 0 fail"}
    ]'
    _audit "pytest -k smoke"        # pytest ran; bun test did NOT → fabrication

    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e

    [[ "${rc}" -eq 2 ]]
    # The fabricated substantive command is the one flagged.
    run jq -r 'select(.verdict=="would_have_failed") | "\(.command) \(.role)"' \
        "${REQ_DIR}/verification-report.jsonl"
    [[ "${output}" == *"bun test substantive"* ]]
}

# ─────────────────────────────────────────────────────────────────────
# 521-d: the ground-truth PR helper is confirm-only and inert outside a
# git work tree (so it can never add a flake in unit/test contexts).
# ─────────────────────────────────────────────────────────────────────
@test "521-d: ground-truth PR check returns unavailable outside a git work tree" {
    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verification_ground_truth_pr_ok "${REQ_DIR}" "integration"
    local rc=$?
    set -e
    [[ "${rc}" -ne 0 ]]    # unavailable → never confirms in a non-repo
}
