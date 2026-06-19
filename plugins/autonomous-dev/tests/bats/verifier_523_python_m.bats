#!/usr/bin/env bats
###############################################################################
# verifier_523_python_m.bats — regression guard for #523
#
# #523: `classify_command` keyed off the first token, so the idiomatic
# `python -m pytest` / `python -m mypy` form classified `unclassifiable`
# (first token `python3` isn't in the idempotent allowlist). Two consequences:
#   (a) no idempotent re-exec → the mismatched/stale result check was skipped;
#   (b) no `substantive_verified` credit → the #521 ground-truth rescue could
#       not fire for module-runner repos.
#
# Fix: unwrap `python[3] -m <module>` so classification keys off the module.
# These tests pin both consequences.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    VERIFIER="${PLUGIN_DIR}/lib/verification/verifier.sh"
    PROJ="$(mktemp -d -t adv-523-XXXXXX)"
    REQ_DIR="${PROJ}/.autonomous-dev/requests/REQ-TEST"
    mkdir -p "${REQ_DIR}"
    export VERIFICATION_TAIL_THRESHOLD=0.5
    unset VERIFICATION_MODE
}
teardown() {
    rm -rf "${PROJ}"
    unset VERIFICATION_REEXEC VERIFICATION_TAIL_THRESHOLD VERIFICATION_MODE
}

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
_envelope() {  # _envelope <evidence_json>
    jq -n --argjson e "$1" \
        '{status:"pass",phase:"integration",feedback:"ok",evidence:$e}' \
        > "${REQ_DIR}/phase-result-integration.json"
}

# ─────────────────────────────────────────────────────────────────────
# Unit: classify_command unwraps the launcher
# ─────────────────────────────────────────────────────────────────────
@test "523-unit: classify_command unwraps python -m <module> to the module" {
    # shellcheck source=/dev/null
    source "${VERIFIER}"
    [ "$(classify_command 'python3 -m pytest test_hello.py -v')" = "idempotent" ]
    [ "$(classify_command 'python -m mypy src')" = "idempotent" ]
    [ "$(classify_command 'python3 -m ruff check .')" = "idempotent" ]
    [ "$(classify_command 'python -m unittest -v')" = "idempotent" ]
    [ "$(classify_command 'python3.12 -m pytest')" = "idempotent" ]
    # env-prefix + launcher together still unwraps
    [ "$(classify_command 'PYTHONPATH=src python3 -m pytest')" = "idempotent" ]
    # a bare script is NOT a known idempotent runner → untouched
    [ "$(classify_command 'python hello.py')" = "unclassifiable" ]
    # python -m pip is not an idempotent runner
    [ "$(classify_command 'python3 -m pip install x')" = "unclassifiable" ]
    # guard branches: bare `-m` (no module) and non-`-m` python invocations
    [ "$(classify_command 'python3 -m')" = "unclassifiable" ]
    [ "$(classify_command 'python3 --version')" = "unclassifiable" ]
}

# ─────────────────────────────────────────────────────────────────────
# (a) re-exec now runs for `python -m pytest`: a mismatched result refuses
# ─────────────────────────────────────────────────────────────────────
@test "523-a: python -m pytest is re-executed (idempotent) — mismatched exit refuses" {
    export VERIFICATION_REEXEC=1
    _envelope '[{"command":"python3 -m pytest test_hello.py -v","exit_code":0,"output_tail":"3 passed"}]'
    _audit "python3 -m pytest test_hello.py -v"
    # shellcheck source=/dev/null
    source "${VERIFIER}"
    # stub re-exec to return a DIFFERENT exit code (the lie/stale case)
    reexecute_command() { jq -nc '{exit_code:1,output_tail:"1 failed, 2 passed",duration_ms:10,error:""}'; }

    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e
    [[ "${rc}" -eq 2 ]]
    run jq -r '.[0].classification + " " + .[0].checks.exit_code' <(jq -s '.' "${REQ_DIR}/verification-report.jsonl")
    [[ "${output}" == "idempotent fail" ]]
}

# ─────────────────────────────────────────────────────────────────────
# (b) a verified `python -m pytest` counts as substantive_verified, so it
# rescues auxiliary inspection-drift (the #521 ground-truth path).
# ─────────────────────────────────────────────────────────────────────
@test "523-b: verified python -m pytest grants substantive credit → rescues auxiliary drift" {
    export VERIFICATION_REEXEC=0   # presence-only; classification still computed
    _envelope '[
        {"command":"python3 -m pytest -v","exit_code":0,"output_tail":"3 passed"},
        {"command":"git diff abc123..def456 -- hello.py","exit_code":0,"output_tail":"+x"}
    ]'
    # pytest ran; the inspection git-diff was phrased differently (drift)
    _audit "python3 -m pytest -v" "git diff HEAD~1 HEAD"
    # shellcheck source=/dev/null
    source "${VERIFIER}"

    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e
    [[ "${rc}" -eq 0 ]]
    # pytest verified as a substantive command
    run jq -r 'select(.command|test("pytest")) | .role + " " + .verdict' "${REQ_DIR}/verification-report.jsonl"
    [[ "${output}" == "substantive verified" ]]
    # the auxiliary drift is still recorded (observability) but not fatal
    run jq -r 'select(.command|test("git diff")) | .role + " " + .verdict' "${REQ_DIR}/verification-report.jsonl"
    [[ "${output}" == "auxiliary would_have_failed" ]]
}
