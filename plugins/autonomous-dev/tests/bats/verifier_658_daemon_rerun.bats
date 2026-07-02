#!/usr/bin/env bats
###############################################################################
# verifier_658_daemon_rerun.bats — REQ-000058
#
# Regression suite covering:
#   R658-01..R658-08  — integration tests for canonical daemon test re-run
#   U-01..U-20        — unit tests for _is_test_runner_command classifier
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    VERIFIER="${PLUGIN_DIR}/lib/verification/verifier.sh"
    DAEMON_RERUN="${PLUGIN_DIR}/lib/verification/daemon-run-tests.sh"

    PROJ="$(mktemp -d -t adv-658-XXXXXX)"
    REQ_DIR="${PROJ}/.autonomous-dev/requests/REQ-658"
    mkdir -p "${REQ_DIR}/test-output"

    export VERIFICATION_REEXEC=0
    export VERIFICATION_ARTIFACT_FALLBACK=1
    export VERIFICATION_DAEMON_RERUN=1
    unset VERIFICATION_MODE
    unset VERIFICATION_DAEMON_RERUN_TIMEOUT_S

    # Phase started at (30 minutes ago, so fresh artifacts win).
    _phase_started_at="$(date -u -v-30M +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
        || date -u -d '30 minutes ago' +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
        || date -u +"%Y-%m-%dT%H:%M:%SZ")"
}

teardown() {
    rm -rf "${PROJ}"
    unset VERIFICATION_REEXEC VERIFICATION_ARTIFACT_FALLBACK
    unset VERIFICATION_DAEMON_RERUN VERIFICATION_DAEMON_RERUN_TIMEOUT_S
    unset VERIFICATION_MODE
    # Restore PATH if modified by tests
    if [[ -n "${_ORIG_PATH:-}" ]]; then
        export PATH="${_ORIG_PATH}"
        unset _ORIG_PATH
    fi
}

# ── Fixture helpers ───────────────────────────────────────────────────────────

_mk_vitest_mock() {
    local bin_dir="$1" exit_code="${2:-0}" failures="${3:-0}"
    mkdir -p "${bin_dir}"
    local passed=$(( 3 - failures ))
    [[ "${passed}" -lt 0 ]] && passed=0
    cat > "${bin_dir}/vitest" <<EOF
#!/usr/bin/env bash
# Mock vitest for bats tests
out=""
for a in "\$@"; do
    case "\$a" in --outputFile=*) out="\${a#--outputFile=}" ;; esac
done
if [[ -n "\$out" ]]; then
    cat > "\$out" <<'JSON'
{"numTotalTests":3,"numPassedTests":${passed},"numFailedTests":${failures},"numPendingTests":0,"testResults":[]}
JSON
fi
echo "Tests:  ${passed} passed, 3 total"
exit ${exit_code}
EOF
    chmod +x "${bin_dir}/vitest"
}

_mk_jest_mock() {
    local bin_dir="$1" exit_code="${2:-0}" failures="${3:-0}"
    mkdir -p "${bin_dir}"
    local passed=$(( 5 - failures ))
    [[ "${passed}" -lt 0 ]] && passed=0
    cat > "${bin_dir}/jest" <<EOF
#!/usr/bin/env bash
# Mock jest for bats tests
out=""
for a in "\$@"; do
    case "\$a" in --outputFile=*) out="\${a#--outputFile=}" ;; esac
done
if [[ -n "\$out" ]]; then
    cat > "\$out" <<'JSON'
{"numTotalTests":5,"numPassedTests":${passed},"numFailedTests":${failures},"numPendingTests":0,"testResults":[]}
JSON
fi
echo "Tests:  ${passed} passed, 5 total"
exit ${exit_code}
EOF
    chmod +x "${bin_dir}/jest"
}

_mk_phase_result() {
    local req_dir="$1" cmd="${2:-npm test}" phase_started_at="${3:-}"
    cat > "${req_dir}/phase-result-integration.json" <<EOF
{
  "phase": "integration",
  "status": "pass",
  "feedback": "tests passed",
  "phase_started_at": "${phase_started_at}",
  "evidence": [{
    "command": "${cmd}",
    "status": "pass",
    "exit_code": 0,
    "output_tail": "Tests: 3 passed, 0 failed"
  }],
  "artifacts": []
}
EOF
}

_mk_empty_audit() {
    local req_dir="$1"
    : > "${req_dir}/command-audit.jsonl"
    chmod 0600 "${req_dir}/command-audit.jsonl"
}

_mk_vitest_project() {
    local proj="$1"
    cat > "${proj}/package.json" <<'EOF'
{"name":"test-project","scripts":{"test":"vitest run"}}
EOF
    _mk_vitest_mock "${proj}/node_modules/.bin"
}

# ─────────────────────────────────────────────────────────────────────────────
# R658-01: Passing vitest w/ empty audit log → verified_by_artifact via daemon-rerun
# ─────────────────────────────────────────────────────────────────────────────
@test "R658-01: passing vitest with empty audit log verified by daemon-rerun artifact" {
    _mk_vitest_project "${PROJ}"
    _ORIG_PATH="${PATH}"
    export PATH="${PROJ}/node_modules/.bin:${PATH}"
    _mk_phase_result "${REQ_DIR}" "npm test" "${_phase_started_at}"
    _mk_empty_audit "${REQ_DIR}"

    # shellcheck source=/dev/null
    source "${DAEMON_RERUN}"
    daemon_run_tests "${REQ_DIR}" "${PROJ}" "integration"
    local drt_rc=$?

    # Artifact must exist and be schema_version=1, status=pass, failures=0
    [ -f "${REQ_DIR}/test-results.json" ]
    local schema status failures source_type
    schema="$(jq -r '.schema_version' "${REQ_DIR}/test-results.json")"
    status="$(jq -r '.status' "${REQ_DIR}/test-results.json")"
    failures="$(jq -r '.failures' "${REQ_DIR}/test-results.json")"
    source_type="$(jq -r '.source' "${REQ_DIR}/test-results.json")"

    [ "${schema}" = "1" ]
    [ "${status}" = "pass" ]
    [ "${failures}" = "0" ]
    [ "${source_type}" = "native_json" ]

    # Artifact mode 0600
    local mode
    mode="$(stat -f '%Lp' "${REQ_DIR}/test-results.json" 2>/dev/null \
        || stat -c '%a' "${REQ_DIR}/test-results.json" 2>/dev/null || echo "000")"
    [ "${mode}" = "600" ]

    # Now verify_envelope must see verified_by_artifact
    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local ve_rc=$?
    set -e

    [ "${ve_rc}" -eq 0 ]
    local verdict reason
    verdict="$(jq -r '.verdict' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    reason="$(jq -r '.reason' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    [ "${verdict}" = "verified_by_artifact" ]
    [[ "${reason}" == artifact_proof=daemon_rerun:* ]]
}

# ─────────────────────────────────────────────────────────────────────────────
# R658-02: Genuinely failing vitest → would_have_failed
# ─────────────────────────────────────────────────────────────────────────────
@test "R658-02: genuinely failing vitest is refused" {
    mkdir -p "${PROJ}/node_modules/.bin"
    cat > "${PROJ}/package.json" <<'EOF'
{"name":"test-project","scripts":{"test":"vitest run"}}
EOF
    _mk_vitest_mock "${PROJ}/node_modules/.bin" 1 1   # exit 1, 1 failure
    _ORIG_PATH="${PATH}"
    export PATH="${PROJ}/node_modules/.bin:${PATH}"
    _mk_phase_result "${REQ_DIR}" "npm test" "${_phase_started_at}"
    _mk_empty_audit "${REQ_DIR}"

    # shellcheck source=/dev/null
    source "${DAEMON_RERUN}"
    daemon_run_tests "${REQ_DIR}" "${PROJ}" "integration"

    local failures status
    failures="$(jq -r '.failures' "${REQ_DIR}/test-results.json")"
    status="$(jq -r '.status' "${REQ_DIR}/test-results.json")"
    [ "${failures}" = "1" ]
    [ "${status}" = "fail" ]

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

# ─────────────────────────────────────────────────────────────────────────────
# R658-03: Jest project detection
# ─────────────────────────────────────────────────────────────────────────────
@test "R658-03: jest project is detected and invoked with json reporter" {
    mkdir -p "${PROJ}/node_modules/.bin"
    cat > "${PROJ}/package.json" <<'EOF'
{"name":"test-project","scripts":{"test":"jest"}}
EOF
    _mk_jest_mock "${PROJ}/node_modules/.bin" 0 0
    _ORIG_PATH="${PATH}"
    export PATH="${PROJ}/node_modules/.bin:${PATH}"

    # shellcheck source=/dev/null
    source "${DAEMON_RERUN}"
    local runner_info
    runner_info="$(_daemon_detect_runner "${PROJ}")"

    # scripts.test wins over binary probe → npm_script with sub_runner=jest
    local runner sub_runner
    runner="$(printf '%s' "${runner_info}" | jq -r '.runner')"
    sub_runner="$(printf '%s' "${runner_info}" | jq -r '.sub_runner')"
    [ "${runner}" = "npm_script" ]
    [ "${sub_runner}" = "jest" ]

    # Run daemon_run_tests; invoked_command must contain --json
    daemon_run_tests "${REQ_DIR}" "${PROJ}" "integration"
    local invoked
    invoked="$(jq -r '.invoked_command' "${REQ_DIR}/test-results.json" 2>/dev/null)"
    [[ "${invoked}" == *"--json"* ]]
    [[ "${invoked}" == *"--outputFile="* ]]

    local status
    status="$(jq -r '.status' "${REQ_DIR}/test-results.json" 2>/dev/null)"
    [ "${status}" = "pass" ]
}

# ─────────────────────────────────────────────────────────────────────────────
# R658-04: Vacuous npm_script (echo skip)
# ─────────────────────────────────────────────────────────────────────────────
@test "R658-04: vacuous npm_script emits pass with tail_parsed source" {
    cat > "${PROJ}/package.json" <<'EOF'
{"name":"test-project","scripts":{"test":"echo skip"}}
EOF

    # shellcheck source=/dev/null
    source "${DAEMON_RERUN}"
    daemon_run_tests "${REQ_DIR}" "${PROJ}" "integration"
    local rc=$?

    [ "${rc}" -eq 0 ]
    [ -f "${REQ_DIR}/test-results.json" ]

    local runner source_type tests failures status
    runner="$(jq -r '.runner' "${REQ_DIR}/test-results.json")"
    source_type="$(jq -r '.source' "${REQ_DIR}/test-results.json")"
    tests="$(jq -r '.tests' "${REQ_DIR}/test-results.json")"
    failures="$(jq -r '.failures' "${REQ_DIR}/test-results.json")"
    status="$(jq -r '.status' "${REQ_DIR}/test-results.json")"

    [ "${runner}" = "npm_script" ]
    [ "${source_type}" = "tail_parsed" ]
    [ "${tests}" = "0" ]
    [ "${failures}" = "0" ]
    [ "${status}" = "pass" ]

    # Event daemon_test_rerun_no_tests_collected must be in events.jsonl
    local event_found
    event_found="$(jq -r '.event' "${REQ_DIR}/events.jsonl" 2>/dev/null \
        | grep 'daemon_test_rerun_no_tests_collected' || true)"
    [ -n "${event_found}" ]
}

# ─────────────────────────────────────────────────────────────────────────────
# R658-05: Presence miss with reexec still verifies (presence-downgrade path)
# ─────────────────────────────────────────────────────────────────────────────
@test "R658-05: idempotent test cmd missing from audit log still verifies via reexec" {
    # Create a mock bun binary that exits 0 with matching output.
    local mock_bin="${PROJ}/mock-bin"
    mkdir -p "${mock_bin}"
    cat > "${mock_bin}/bun" <<'EOF'
#!/usr/bin/env bash
echo "Tests:  5 passed, 5 total"
exit 0
EOF
    chmod +x "${mock_bin}/bun"
    _ORIG_PATH="${PATH}"
    export PATH="${mock_bin}:${PATH}"

    # No daemon-rerun artifact; no executor-tail; empty audit log.
    _mk_empty_audit "${REQ_DIR}"
    _mk_phase_result "${REQ_DIR}" "bun test" "${_phase_started_at}"

    export VERIFICATION_REEXEC=1
    export VERIFICATION_REEXEC_TIMEOUT_S=10

    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local rc=$?
    set -e

    # With REEXEC=1 and mock bun exiting 0, should verify (rc=0).
    [ "${rc}" -eq 0 ]

    # Row must have presence_check=fail_observability_only and reexec_check=pass.
    local pres reexec verdict
    pres="$(jq -r '.checks.presence' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    reexec="$(jq -r '.checks.re_execution' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"
    verdict="$(jq -r '.verdict' "${REQ_DIR}/verification-report.jsonl" 2>/dev/null)"

    [ "${pres}" = "fail_observability_only" ]
    [ "${reexec}" = "pass" ]
    [ "${verdict}" = "verified" ]
}

# ─────────────────────────────────────────────────────────────────────────────
# R658-06: Kill-switch honoured
# ─────────────────────────────────────────────────────────────────────────────
@test "R658-06: VERIFICATION_DAEMON_RERUN=0 disables producer" {
    _mk_vitest_project "${PROJ}"
    _ORIG_PATH="${PATH}"
    export PATH="${PROJ}/node_modules/.bin:${PATH}"

    # shellcheck source=/dev/null
    source "${DAEMON_RERUN}"

    export VERIFICATION_DAEMON_RERUN=0
    set +e
    daemon_run_tests "${REQ_DIR}" "${PROJ}" "integration"
    local rc=$?
    set -e

    # Must return 1 with no artifact.
    [ "${rc}" -eq 1 ]
    [ ! -f "${REQ_DIR}/test-results.json" ]

    # Kill-switch event in events.jsonl.
    local event_found
    event_found="$(jq -r '.event' "${REQ_DIR}/events.jsonl" 2>/dev/null \
        | grep 'daemon_test_rerun_skipped_kill_switch' || true)"
    [ -n "${event_found}" ]

    # Verify that verify_envelope falls through to existing artifact-proof rescue.
    # (No daemon-rerun, but an executor-tail artifact is present.)
    cat > "${REQ_DIR}/test-output/run.log" <<'EOF'
Tests:  3 passed, 3 total
EOF
    cat > "${REQ_DIR}/phase-result-integration.json" <<EOF
{
  "phase": "integration",
  "status": "pass",
  "feedback": "tests passed",
  "phase_started_at": "${_phase_started_at}",
  "evidence": [{
    "command": "npm test",
    "status": "pass",
    "exit_code": 0,
    "output_tail": "Tests: 3 passed, 0 failed"
  }],
  "artifacts": [{
    "kind": "executor-tail",
    "path": "${REQ_DIR}/test-output/run.log",
    "title": "test output"
  }]
}
EOF
    _mk_empty_audit "${REQ_DIR}"
    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local ve_rc=$?
    set -e
    # With executor-tail artifact, the existing artifact-proof path rescues.
    [ "${ve_rc}" -eq 0 ]
}

# ─────────────────────────────────────────────────────────────────────────────
# R658-07: F7 corrects stale synthesised fail with fresh daemon-rerun artifact
# ─────────────────────────────────────────────────────────────────────────────
@test "R658-07: F7 finds fresh daemon-rerun artifact and corrects stale fail" {
    # Pre-seed phase-result with synthesised fail.
    cat > "${REQ_DIR}/phase-result-integration.json" <<EOF
{
  "phase": "integration",
  "status": "fail",
  "feedback": "VERIFICATION_FAILED",
  "status_reason": "command_not_in_audit_log",
  "phase_started_at": "${_phase_started_at}",
  "synthesized": true,
  "exit_code": 0,
  "evidence": [],
  "artifacts": []
}
EOF

    # Write fresh 0-failure daemon-rerun artifact.
    _mk_vitest_project "${PROJ}"
    _ORIG_PATH="${PATH}"
    export PATH="${PROJ}/node_modules/.bin:${PATH}"
    # shellcheck source=/dev/null
    source "${DAEMON_RERUN}"
    daemon_run_tests "${REQ_DIR}" "${PROJ}" "integration"

    [ -f "${REQ_DIR}/test-results.json" ]
    local art_status
    art_status="$(jq -r '.status' "${REQ_DIR}/test-results.json")"
    [ "${art_status}" = "pass" ]

    # Build F7 ctx_json.
    local ctx_json
    ctx_json="$(jq -n \
        --arg req "REQ-658" \
        --arg proj "${PROJ}" \
        --arg ph "integration" \
        --arg sf "${PROJ}/.autonomous-dev/requests/REQ-658/state.json" \
        --arg rf "${REQ_DIR}/phase-result-integration.json" \
        --arg ef "${REQ_DIR}/events.jsonl" \
        --arg psa "${_phase_started_at}" \
        '{request_id:$req, project:$proj, phase:$ph, state_file:$sf,
          result_file:$rf, events_file:$ef, phase_started_at:$psa}')"

    # Source self-heal modules.
    local LIB_DIR="${PLUGIN_DIR}/bin/lib"
    # shellcheck source=/dev/null
    source "${LIB_DIR}/self-heal-state.sh" 2>/dev/null || true
    # shellcheck source=/dev/null
    source "${LIB_DIR}/self-heal-events.sh" 2>/dev/null || true
    # shellcheck source=/dev/null
    source "${LIB_DIR}/self-heal.sh" 2>/dev/null || true

    # Detect.
    set +e
    _SELFHEAL_LAST_EVIDENCE='{}'
    detect_verification_false_negative "${ctx_json}"
    local dvfn_rc=$?
    set -e
    [ "${dvfn_rc}" -eq 0 ]

    # Remediate.
    local evidence="${_SELFHEAL_LAST_EVIDENCE}"
    [[ -z "${evidence}" ]] && evidence="{}"
    local rem_ctx
    rem_ctx="$(printf '%s' "${ctx_json}" | jq --argjson ev "${evidence}" '. + {evidence: $ev}')"
    set +e
    remediate_self_verify "${rem_ctx}"
    local rem_rc=$?
    set -e
    [ "${rem_rc}" -eq 0 ]

    # phase-result-integration.json must now have status=pass.
    local result_status
    result_status="$(jq -r '.status' "${REQ_DIR}/phase-result-integration.json")"
    [ "${result_status}" = "pass" ]
}

# ─────────────────────────────────────────────────────────────────────────────
# R658-08: Timeout produces non-proof artefact; verify_envelope refuses
# ─────────────────────────────────────────────────────────────────────────────
@test "R658-08: runner timeout produces status=timeout artifact; verifier refuses" {
    # Mock vitest that sleeps.
    mkdir -p "${PROJ}/node_modules/.bin"
    cat > "${PROJ}/package.json" <<'EOF'
{"name":"test-project","scripts":{"test":"vitest run"}}
EOF
    cat > "${PROJ}/node_modules/.bin/vitest" <<'EOF'
#!/usr/bin/env bash
sleep 30
exit 0
EOF
    chmod +x "${PROJ}/node_modules/.bin/vitest"
    _ORIG_PATH="${PATH}"
    export PATH="${PROJ}/node_modules/.bin:${PATH}"
    _mk_phase_result "${REQ_DIR}" "npm test" "${_phase_started_at}"
    _mk_empty_audit "${REQ_DIR}"

    # Short timeout so test doesn't hang.
    export VERIFICATION_DAEMON_RERUN_TIMEOUT_S=1

    # shellcheck source=/dev/null
    source "${DAEMON_RERUN}"
    set +e
    daemon_run_tests "${REQ_DIR}" "${PROJ}" "integration"
    local drt_rc=$?
    set -e

    # Producer must return 2 on timeout.
    [ "${drt_rc}" -eq 2 ]

    # Artifact status must be "timeout", exit_code=124.
    [ -f "${REQ_DIR}/test-results.json" ]
    local art_status art_exit
    art_status="$(jq -r '.status' "${REQ_DIR}/test-results.json")"
    art_exit="$(jq -r '.exit_code' "${REQ_DIR}/test-results.json")"
    [ "${art_status}" = "timeout" ]
    [ "${art_exit}" = "124" ]

    # _verifier_daemon_rerun_confirms must return 1 (timeout is NOT proof).
    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    _verifier_daemon_rerun_confirms "${REQ_DIR}" ""
    local vdrc_rc=$?
    set -e
    [ "${vdrc_rc}" -eq 1 ]

    # verify_envelope must refuse.
    set +e
    verify_envelope "${REQ_DIR}" "integration" "refuse" 2>/dev/null
    local ve_rc=$?
    set -e
    [ "${ve_rc}" -eq 2 ]

    # Timeout event must be in events.jsonl.
    local event_found
    event_found="$(jq -r '.event' "${REQ_DIR}/events.jsonl" 2>/dev/null \
        | grep 'daemon_test_rerun_timeout' || true)"
    [ -n "${event_found}" ]
}

# ═════════════════════════════════════════════════════════════════════════════
# U-01..U-20: _is_test_runner_command classifier unit tests
# ═════════════════════════════════════════════════════════════════════════════

@test "U-01: bun test → matches (0)" {
    source "${VERIFIER}"
    _is_test_runner_command "bun test"
}

@test "U-02: bun test --coverage → matches (0)" {
    source "${VERIFIER}"
    _is_test_runner_command "bun test --coverage"
}

@test "U-03: npm test → matches (0)" {
    source "${VERIFIER}"
    _is_test_runner_command "npm test"
}

@test "U-04: pnpm test --run → matches (0)" {
    source "${VERIFIER}"
    _is_test_runner_command "pnpm test --run"
}

@test "U-05: vitest run → matches (0)" {
    source "${VERIFIER}"
    _is_test_runner_command "vitest run"
}

@test "U-06: pytest -q tests/ → matches (0)" {
    source "${VERIFIER}"
    _is_test_runner_command "pytest -q tests/"
}

@test "U-07: python -m pytest → matches (0)" {
    source "${VERIFIER}"
    _is_test_runner_command "python -m pytest"
}

@test "U-08: cargo test --all → matches (0)" {
    source "${VERIFIER}"
    _is_test_runner_command "cargo test --all"
}

@test "U-09: go test ./... → matches (0)" {
    source "${VERIFIER}"
    _is_test_runner_command "go test ./..."
}

@test "U-10: git push origin main → does NOT match (1)" {
    source "${VERIFIER}"
    run _is_test_runner_command "git push origin main"
    [ "${status}" -eq 1 ]
}

@test "U-11: git commit -m msg → does NOT match (1)" {
    source "${VERIFIER}"
    run _is_test_runner_command 'git commit -m "msg"'
    [ "${status}" -eq 1 ]
}

@test "U-12: gh pr create --title x → does NOT match (1)" {
    source "${VERIFIER}"
    run _is_test_runner_command "gh pr create --title x"
    [ "${status}" -eq 1 ]
}

@test "U-13: gh pr merge 42 → does NOT match (1)" {
    source "${VERIFIER}"
    run _is_test_runner_command "gh pr merge 42"
    [ "${status}" -eq 1 ]
}

@test "U-14: git tag v1.0 → does NOT match (1)" {
    source "${VERIFIER}"
    run _is_test_runner_command "git tag v1.0"
    [ "${status}" -eq 1 ]
}

@test "U-15: git merge feature → does NOT match (1)" {
    source "${VERIFIER}"
    run _is_test_runner_command "git merge feature"
    [ "${status}" -eq 1 ]
}

@test "U-16: npm publish → does NOT match (1)" {
    source "${VERIFIER}"
    run _is_test_runner_command "npm publish"
    [ "${status}" -eq 1 ]
}

@test "U-17: docker push img → does NOT match (1)" {
    source "${VERIFIER}"
    run _is_test_runner_command "docker push img"
    [ "${status}" -eq 1 ]
}

@test "U-18: echo npm test not really → does NOT substring-match (1)" {
    source "${VERIFIER}"
    run _is_test_runner_command 'echo "npm test not really"'
    [ "${status}" -eq 1 ]
}

@test "U-19: leading whitespace bun test → matches (0)" {
    source "${VERIFIER}"
    _is_test_runner_command "    bun test"
}

@test "U-20: bunx test → does NOT match bun test (1)" {
    source "${VERIFIER}"
    run _is_test_runner_command "bunx test"
    [ "${status}" -eq 1 ]
}
