#!/usr/bin/env bats
###############################################################################
# redteam_fabricated_still_refuses.bats — REQ-000052 TASK-014
#
# Regression contract: every fabricated red-team fixture continues to refuse
# AFTER the artifact-fallback is enabled (VERIFICATION_ARTIFACT_FALLBACK=1).
#
# The artifact fallback must NEVER rescue a fixture in the fabricated/ set,
# because those fixtures do NOT include a valid, fresh, ecosystem-matched
# artifact (by design — the fixtures contain only an empty or irrelevant
# audit log with no supporting artifact on disk).
#
# Tests RT-01..RT-10 (one per fabricated fixture) + RT-INV (negative
# pre-check that no fixture would pass artifact gates).
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    VERIFIER="${PLUGIN_DIR}/lib/verification/verifier.sh"
    ARTIFACT_PROOF_LIB="${PLUGIN_DIR}/lib/verification/artifact-proof.sh"
    FIXTURES_DIR="${PLUGIN_DIR}/tests/red-team/no-faked-evidence/fabricated"

    export VERIFICATION_REEXEC=0
    export VERIFICATION_ARTIFACT_FALLBACK=1
    unset VERIFICATION_MODE
}

teardown() {
    unset VERIFICATION_REEXEC VERIFICATION_ARTIFACT_FALLBACK VERIFICATION_MODE
}

# ── Helper: run the verifier against a single fixture ────────────────────────
_run_fixture() {
    local fixture_dir="$1"
    local envelope="${fixture_dir}/envelope.json"
    local audit_log="${fixture_dir}/audit-log.jsonl"
    local expected="${fixture_dir}/expected.json"

    [[ -f "${envelope}" ]] || { echo "MISSING envelope: ${fixture_dir}" >&2; return 1; }
    [[ -f "${expected}" ]] || { echo "MISSING expected: ${fixture_dir}" >&2; return 1; }

    # Build a temporary req_dir mirroring what the daemon uses.
    # NOTE: Do NOT use `trap RETURN` here — in bash, the RETURN pseudosignal
    # fires on every nested function return AND every source/. completion, not
    # only when _run_fixture itself returns. That causes tmp_proj to be deleted
    # as soon as the first sub-function or source call inside verify_envelope
    # completes, making audit_log_exists return false and triggering fail-open
    # (RC=0 instead of RC=2). Explicit cleanup before each return is correct.
    local tmp_proj
    tmp_proj="$(mktemp -d -t adv-rt-XXXXXX)"

    local req_dir="${tmp_proj}/.autonomous-dev/requests/REQ-RT"
    mkdir -p "${req_dir}"

    # Copy envelope as phase-result-integration.json.
    local phase
    phase="$(jq -r '.phase // "integration"' "${expected}" 2>/dev/null || echo "integration")"
    cp "${envelope}" "${req_dir}/phase-result-${phase}.json"

    # Copy audit log (may be empty or have irrelevant rows).
    if [[ -f "${audit_log}" ]]; then
        cp "${audit_log}" "${req_dir}/command-audit.jsonl"
    else
        : > "${req_dir}/command-audit.jsonl"
    fi
    chmod 0600 "${req_dir}/command-audit.jsonl"

    # Create a state.json with dispatched_at = NOW (so mtime-freshness check
    # is tight — but fixtures have no artifacts so it won't matter).
    local now_ts
    now_ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    cat > "${req_dir}/state.json" <<EOF
{ "id":"REQ-RT", "status":"running", "current_phase":"${phase}",
  "current_phase_metadata": { "dispatched_at": "${now_ts}" },
  "updated_at": "${now_ts}" }
EOF

    # Source the verifier and run verify_envelope in refuse mode.
    # Following the same pattern as verifier_refusal_mode.bats (no extra
    # subshell — each bats @test already runs in its own subshell).
    # shellcheck source=/dev/null
    source "${VERIFIER}"
    set +e
    verify_envelope "${req_dir}" "${phase}" "refuse" 2>/dev/null
    local verify_rc=$?
    set -e

    # The expected.json says should_detect: true → must refuse (rc=2).
    local should_detect
    should_detect="$(jq -r '.should_detect // "true"' "${expected}" 2>/dev/null || echo "true")"
    if [[ "${should_detect}" == "true" ]]; then
        if [[ "${verify_rc}" -ne 2 ]]; then
            echo "FAIL: fixture ${fixture_dir##*/} expected rc=2 (refuse), got ${verify_rc}" >&2
            cat "${req_dir}/verification-report.jsonl" >&2 2>/dev/null || true
            rm -rf "${tmp_proj}"
            return 1
        fi
    fi

    # Check that the verdict is would_have_failed (not rescued).
    local report="${req_dir}/verification-report.jsonl"
    if [[ -f "${report}" ]]; then
        local rescued_count
        rescued_count="$(jq 'select(.verdict=="verified_by_artifact")' "${report}" 2>/dev/null | wc -l | tr -d ' ')"
        if [[ "${rescued_count}" -gt 0 ]]; then
            echo "FAIL: fixture ${fixture_dir##*/} was rescued by artifact fallback!" >&2
            jq . "${report}" >&2 2>/dev/null || true
            rm -rf "${tmp_proj}"
            return 1
        fi
    fi

    rm -rf "${tmp_proj}"
    return 0
}

# ── RT-01..RT-10: each fabricated fixture still refuses ──────────────────────

@test "RT-01: f01-bun-test-not-run still refuses with FALLBACK=1" {
    _run_fixture "${FIXTURES_DIR}/f01-bun-test-not-run"
}

@test "RT-02: f02-pytest-empty-audit still refuses with FALLBACK=1" {
    _run_fixture "${FIXTURES_DIR}/f02-pytest-empty-audit"
}

@test "RT-03: f03-npm-test-only-install still refuses with FALLBACK=1" {
    _run_fixture "${FIXTURES_DIR}/f03-npm-test-only-install"
}

@test "RT-04: f04-tsc-vs-ls still refuses with FALLBACK=1" {
    _run_fixture "${FIXTURES_DIR}/f04-tsc-vs-ls"
}

@test "RT-05: f05-cargo-test-vs-build still refuses with FALLBACK=1" {
    _run_fixture "${FIXTURES_DIR}/f05-cargo-test-vs-build"
}

@test "RT-06: f06-ruff-vs-pip still refuses with FALLBACK=1" {
    _run_fixture "${FIXTURES_DIR}/f06-ruff-vs-pip"
}

@test "RT-07: f07-eslint-vs-version still refuses with FALLBACK=1" {
    _run_fixture "${FIXTURES_DIR}/f07-eslint-vs-version"
}

@test "RT-08: f08-cypress-totally-fake still refuses with FALLBACK=1" {
    _run_fixture "${FIXTURES_DIR}/f08-cypress-totally-fake"
}

@test "RT-09: f09-git-push-not-run still refuses with FALLBACK=1" {
    _run_fixture "${FIXTURES_DIR}/f09-git-push-not-run"
}

@test "RT-10: f10-gh-pr-view-vs-list still refuses with FALLBACK=1" {
    _run_fixture "${FIXTURES_DIR}/f10-gh-pr-view-vs-list"
}

# ── RT-INV: No fabricated fixture ships an artifact that would pass the gates ─
@test "RT-INV: no fabricated fixture's evidence produces a valid artifact proof" {
    # shellcheck source=/dev/null
    source "${ARTIFACT_PROOF_LIB}"

    local fixture_dir fail_count=0
    for fixture_dir in "${FIXTURES_DIR}"/*/; do
        [[ -d "${fixture_dir}" ]] || continue
        local envelope="${fixture_dir}/envelope.json"
        [[ -f "${envelope}" ]] || continue

        # Build a minimal req_dir for the artifact-proof check.
        local tmp_proj
        tmp_proj="$(mktemp -d -t adv-rtinv-XXXXXX)"
        local req_dir="${tmp_proj}/.autonomous-dev/requests/REQ-INV"
        mkdir -p "${req_dir}"

        local now_ts
        now_ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
        cat > "${req_dir}/state.json" <<EOF
{ "id":"REQ-INV", "status":"running", "current_phase":"integration",
  "current_phase_metadata": { "dispatched_at": "${now_ts}" },
  "updated_at": "${now_ts}" }
EOF

        local phase
        phase="$(jq -r '.phase // "integration"' "${fixture_dir}/expected.json" 2>/dev/null || echo "integration")"
        cp "${envelope}" "${req_dir}/phase-result-${phase}.json"

        # Extract evidence rows and test each claim.
        local ev_count i
        ev_count="$(jq '(.evidence // []) | length' "${envelope}" 2>/dev/null || echo 0)"
        for ((i = 0; i < ev_count; i++)); do
            local claim_json
            claim_json="$(jq -c ".evidence[${i}]" "${envelope}" 2>/dev/null || echo '{}')"
            local proof=""
            proof="$(VERIFICATION_ARTIFACT_FALLBACK=1 \
                verification_artifact_proof_for "${req_dir}" "${claim_json}" "${phase}" \
                2>/dev/null || true)"
            if [[ -n "${proof}" ]]; then
                echo "FAIL: fixture ${fixture_dir##*/} claim ${i} returned proof: ${proof}" >&2
                fail_count=$((fail_count + 1))
            fi
        done

        rm -rf "${tmp_proj}"
    done

    [ "${fail_count}" -eq 0 ]
}
