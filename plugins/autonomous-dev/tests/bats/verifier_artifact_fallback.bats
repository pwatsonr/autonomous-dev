#!/usr/bin/env bats
###############################################################################
# verifier_artifact_fallback.bats — REQ-000052 TASK-011
#
# Unit tests for the artifact-as-proof fallback in verify_envelope.
# Tests AF-01..AF-10 per the spec §4.1.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    VERIFIER="${PLUGIN_DIR}/lib/verification/verifier.sh"

    PROJ="$(mktemp -d -t adv-af-XXXXXX)"
    REQ_DIR="${PROJ}/.autonomous-dev/requests/REQ-TEST"
    mkdir -p "${REQ_DIR}"

    # Disable re-execution so only the artifact path is exercised.
    export VERIFICATION_REEXEC=0
    export VERIFICATION_ARTIFACT_FALLBACK=1
    export VERIFICATION_ARTIFACT_FRESHNESS_REQUIRED=1
    unset VERIFICATION_MODE

    # Default: dispatch was 1 hour ago so fresh artifacts (mtime=now) pass.
    _dispatched_at="$(date -u -v-1H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
        || date -u -d '1 hour ago' +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
        || date -u +"%Y-%m-%dT%H:%M:%SZ")"
}

teardown() {
    rm -rf "${PROJ}"
    unset VERIFICATION_REEXEC VERIFICATION_ARTIFACT_FALLBACK
    unset VERIFICATION_ARTIFACT_FRESHNESS_REQUIRED VERIFICATION_MODE
}

# ── Fixture helpers ───────────────────────────────────────────────────────────

mk_state_json() {
    local req_dir="$1" dispatched_at="$2"
    mkdir -p "${req_dir}"
    cat > "${req_dir}/state.json" <<EOF
{ "id":"REQ-TEST", "status":"running", "current_phase":"integration",
  "current_phase_metadata": { "dispatched_at": "${dispatched_at}" },
  "updated_at": "${dispatched_at}" }
EOF
}

mk_junit_xml() {
    local path="$1" tests="${2:-208}" failures="${3:-0}"
    cat > "${path}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="${tests}" failures="${failures}" errors="0">
  <testsuite name="suite1" tests="${tests}" failures="${failures}" errors="0">
    <testcase classname="A" name="t1"/>
    <testcase classname="A" name="t2"/>
  </testsuite>
</testsuites>
EOF
}

mk_lcov_info() {
    local path="$1"
    cat > "${path}" <<'EOF'
TN:
SF:/repo/src/index.ts
DA:1,1
DA:2,1
end_of_record
EOF
}

mk_vitest_json() {
    local path="$1"
    cat > "${path}" <<'EOF'
{"numTotalTests":208,"numTotalTestSuites":12,"numFailedTests":0}
EOF
}

mk_pytest_tail_log() {
    local path="$1"
    cat > "${path}" <<'EOF'
collected 50 items
test_foo.py ............................                              [ 56%]
test_bar.py ......................                                    [100%]
50 passed, 0 failed in 0.42s
EOF
}

mk_phase_result() {
    local req_dir="$1" phase="$2" arts="$3" cmd="${4:-bun test}"
    cat > "${req_dir}/phase-result-${phase}.json" <<EOF
{ "phase": "${phase}", "status": "pass",
  "evidence": [{ "command": "${cmd}", "status": "pass", "exit_code": 0,
                 "output_tail": "" }],
  "artifacts": ${arts} }
EOF
}

mk_empty_audit() {
    local req_dir="$1"
    : > "${req_dir}/command-audit.jsonl"
    chmod 0600 "${req_dir}/command-audit.jsonl"
}

# ── AF-01: JUnit rescue (js claim, JUnit XML in artifacts[]) ─────────────────
@test "AF-01: JUnit XML in artifacts[] rescues bun-test presence miss" {
    mk_state_json "${REQ_DIR}" "${_dispatched_at}"
    mk_empty_audit "${REQ_DIR}"
    local junit_path="${REQ_DIR}/junit.xml"
    mk_junit_xml "${junit_path}" 208 0
    mk_phase_result "${REQ_DIR}" "integration" \
        '[{"kind":"test-results-junit","path":"'"${junit_path}"'","title":"junit"}]'

    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e

    [ "${rc}" -eq 0 ]
    local verdict
    verdict="$(jq -r '.verdict' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${verdict}" = "verified_by_artifact" ]
    local reason
    reason="$(jq -r '.reason' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [[ "${reason}" == "artifact_proof=junit:"* ]]
    local tests
    tests="$(jq -r '.artifact_proof.tests // "MISSING"' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${tests}" = "208" ]
}

# ── AF-02: lcov rescue (vitest claim, well-known lcov path) ──────────────────
@test "AF-02: lcov.info on disk rescues vitest-run presence miss" {
    mk_state_json "${REQ_DIR}" "${_dispatched_at}"
    mk_empty_audit "${REQ_DIR}"
    # Put lcov.info inside the project root (PROJECT_ROOT = PROJ).
    mkdir -p "${PROJ}/coverage"
    local lcov_path="${PROJ}/coverage/lcov.info"
    mk_lcov_info "${lcov_path}"
    mk_phase_result "${REQ_DIR}" "integration" '[]' "vitest run --coverage"

    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e

    [ "${rc}" -eq 0 ]
    local verdict
    verdict="$(jq -r '.verdict' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${verdict}" = "verified_by_artifact" ]
    local kind
    kind="$(jq -r '.artifact_proof.kind // "MISSING"' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${kind}" = "lcov" ]
}

# ── AF-03: Vitest JSON rescue ─────────────────────────────────────────────────
@test "AF-03: vitest-results.json in artifacts[] rescues bun-test presence miss" {
    mk_state_json "${REQ_DIR}" "${_dispatched_at}"
    mk_empty_audit "${REQ_DIR}"
    local vj="${REQ_DIR}/vitest-results.json"
    mk_vitest_json "${vj}"
    mk_phase_result "${REQ_DIR}" "integration" \
        '[{"kind":"test-results-vitest","path":"'"${vj}"'","title":"vitest"}]'

    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e

    [ "${rc}" -eq 0 ]
    local verdict
    verdict="$(jq -r '.verdict' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${verdict}" = "verified_by_artifact" ]
    local tests
    tests="$(jq -r '.artifact_proof.tests // "MISSING"' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${tests}" = "208" ]
}

# ── AF-04: Executor-tail rescue (pytest summary) ─────────────────────────────
@test "AF-04: pytest executor-tail log in artifacts[] rescues presence miss" {
    mk_state_json "${REQ_DIR}" "${_dispatched_at}"
    mk_empty_audit "${REQ_DIR}"
    mkdir -p "${REQ_DIR}/test-output"
    local log_path="${REQ_DIR}/test-output/pytest.log"
    mk_pytest_tail_log "${log_path}"
    mk_phase_result "${REQ_DIR}" "integration" \
        '[{"kind":"executor-tail","path":"'"${log_path}"'","title":"pytest log"}]' \
        "pytest -q"

    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e

    [ "${rc}" -eq 0 ]
    local verdict
    verdict="$(jq -r '.verdict' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${verdict}" = "verified_by_artifact" ]
}

# ── AF-05: Ecosystem mismatch refuses (pytest claim + only lcov.info) ─────────
@test "AF-05: lcov.info does not rescue pytest claim (ecosystem mismatch)" {
    mk_state_json "${REQ_DIR}" "${_dispatched_at}"
    mk_empty_audit "${REQ_DIR}"
    mkdir -p "${PROJ}/coverage"
    mk_lcov_info "${PROJ}/coverage/lcov.info"
    # No artifacts[], just the well-known lcov path. pytest → python ecosystem,
    # but lcov is js-only → no match.
    mk_phase_result "${REQ_DIR}" "integration" '[]' "pytest -q"

    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e

    [ "${rc}" -eq 2 ]
    local verdict
    verdict="$(jq -r '.verdict' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${verdict}" = "would_have_failed" ]
    local reason
    reason="$(jq -r '.reason' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${reason}" = "command_not_in_audit_log" ]
    local has_proof
    has_proof="$(jq 'has("artifact_proof")' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${has_proof}" = "false" ]
}

# ── AF-06: Stale artifact refuses ────────────────────────────────────────────
@test "AF-06: backdated artifact refuses due to freshness gate" {
    # dispatched_at = NOW (not 1 hour ago)
    local now_ts
    now_ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    mk_state_json "${REQ_DIR}" "${now_ts}"
    mk_empty_audit "${REQ_DIR}"
    local junit_path="${REQ_DIR}/junit.xml"
    mk_junit_xml "${junit_path}"

    # Backdate the artifact file to 1 day ago.
    if touch -d "1 day ago" "${junit_path}" 2>/dev/null; then
        : # GNU touch
    else
        local old_ts
        old_ts="$(date -u -v-1d +%Y%m%d%H%M 2>/dev/null || date -u +%Y%m%d%H%M)"
        touch -t "${old_ts}" "${junit_path}" 2>/dev/null || true
    fi

    mk_phase_result "${REQ_DIR}" "integration" \
        '[{"kind":"test-results-junit","path":"'"${junit_path}"'","title":"junit"}]'

    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e

    [ "${rc}" -eq 2 ]
    local verdict
    verdict="$(jq -r '.verdict' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${verdict}" = "would_have_failed" ]
}

# ── AF-07: Corrupt/empty JUnit XML refuses ───────────────────────────────────
@test "AF-07: empty JUnit XML fails content validation" {
    mk_state_json "${REQ_DIR}" "${_dispatched_at}"
    mk_empty_audit "${REQ_DIR}"
    local junit_path="${REQ_DIR}/junit.xml"
    : > "${junit_path}"  # empty file
    mk_phase_result "${REQ_DIR}" "integration" \
        '[{"kind":"test-results-junit","path":"'"${junit_path}"'","title":"junit"}]'

    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e

    [ "${rc}" -eq 2 ]
    local verdict
    verdict="$(jq -r '.verdict' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${verdict}" = "would_have_failed" ]
}

# ── AF-08: Auxiliary command still refuses without ground truth ───────────────
@test "AF-08: auxiliary claim miss is still refused when no ground truth" {
    mk_state_json "${REQ_DIR}" "${_dispatched_at}"
    mk_empty_audit "${REQ_DIR}"
    # Use a purely auxiliary command (gh pr view); no substantive work done.
    cat > "${REQ_DIR}/phase-result-integration.json" <<'EOF'
{ "phase": "integration", "status": "pass",
  "evidence": [{ "command": "gh pr view 42", "status": "pass",
                 "exit_code": 0, "output_tail": "" }],
  "artifacts": [] }
EOF

    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e

    # No ground truth (auxiliary only, no PR) → should refuse.
    [ "${rc}" -eq 2 ]
    local verdict
    verdict="$(jq -r '.verdict' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${verdict}" = "would_have_failed" ]
}

# ── AF-09: Kill switch (FALLBACK=0) refuses despite valid artifact ────────────
@test "AF-09: VERIFICATION_ARTIFACT_FALLBACK=0 disables rescue" {
    mk_state_json "${REQ_DIR}" "${_dispatched_at}"
    mk_empty_audit "${REQ_DIR}"
    local junit_path="${REQ_DIR}/junit.xml"
    mk_junit_xml "${junit_path}" 208 0
    mk_phase_result "${REQ_DIR}" "integration" \
        '[{"kind":"test-results-junit","path":"'"${junit_path}"'","title":"junit"}]'

    export VERIFICATION_ARTIFACT_FALLBACK=0

    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e

    [ "${rc}" -eq 2 ]
    local verdict
    verdict="$(jq -r '.verdict' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${verdict}" = "would_have_failed" ]
    local has_proof
    has_proof="$(jq 'has("artifact_proof")' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${has_proof}" = "false" ]
}

# ── AF-10: artifact_proof field is present and well-formed ───────────────────
@test "AF-10: artifact_proof object is well-formed on verified_by_artifact row" {
    mk_state_json "${REQ_DIR}" "${_dispatched_at}"
    mk_empty_audit "${REQ_DIR}"
    local junit_path="${REQ_DIR}/junit.xml"
    mk_junit_xml "${junit_path}" 208 0
    mk_phase_result "${REQ_DIR}" "integration" \
        '[{"kind":"test-results-junit","path":"'"${junit_path}"'","title":"junit"}]'

    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e

    [ "${rc}" -eq 0 ]

    local proof
    proof="$(jq '.artifact_proof' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${proof}" != "null" ] && [ -n "${proof}" ]

    local kind
    kind="$(jq -r '.artifact_proof.kind' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${kind}" = "junit" ]

    local proof_path
    proof_path="$(jq -r '.artifact_proof.path' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ -f "${proof_path}" ]
    # Path must be absolute.
    [[ "${proof_path}" == /* ]]

    local tests
    tests="$(jq -r '.artifact_proof.tests' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${tests}" = "208" ]

    local mtime
    mtime="$(jq -r '.artifact_proof.mtime' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    # Must be a non-empty ISO8601 timestamp.
    [[ "${mtime}" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}T ]]
}
