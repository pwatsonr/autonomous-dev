#!/usr/bin/env bats
###############################################################################
# review_gate_cli.bats — #561 end-to-end coverage of bin/review-gate-cli.ts.
#
# The jest suites exercise the orchestrator + dispatcher + CLI with INJECTED
# mocks. This bats suite covers the one path they cannot: the real
# `child_process.spawn` dispatcher resolving `claude` on PATH and the
# `require.main === module` entrypoint — i.e. exactly how the daemon would
# invoke the CLI. We put a fake `claude` on PATH so no live model is needed.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    # The executable launcher (bun-run entry); imports main from review-gate-cli.ts.
    CLI="${PLUGIN_DIR}/bin/review-gate.ts"
    TMP="$(mktemp -d -t adv-rgcli-XXXXXX)"
    MOCKBIN="${TMP}/bin"
    REPO="${TMP}/repo"
    mkdir -p "${MOCKBIN}" "${REPO}"

    # Default mock: every reviewer approves with a high score.
    write_mock_claude '{"score": 95, "verdict": "APPROVE"}'
}

teardown() {
    rm -rf "${TMP}"
}

# write_mock_claude <json-line> — install a fake `claude` that echoes the given
# verdict JSON to stdout and exits 0, regardless of the args it receives.
write_mock_claude() {
    cat > "${MOCKBIN}/claude" <<EOF
#!/usr/bin/env bash
echo '${1}'
EOF
    chmod +x "${MOCKBIN}/claude"
}

@test "561: CLI runs the default chain end-to-end via a mock claude (non-frontend)" {
    PATH="${MOCKBIN}:${PATH}" run bun run "${CLI}" \
        --repo "${REPO}" --request-type feature --gate code_review --request-id REQ-TEST
    [ "$status" -eq 0 ]
    # stdout is a GateDecision JSON; all reviewers approved → APPROVE.
    echo "$output" | jq -e '.outcome == "APPROVE"' >/dev/null
    # Non-frontend change set → the 5 always-on reviewers run; the two
    # frontend-only reviewers (ux-ui, accessibility) are scheduled out.
    echo "$output" | jq -e '.results | length == 5' >/dev/null
    echo "$output" | jq -e '[.results[].reviewer_name] | index("ux-ui-reviewer") == null' >/dev/null
    echo "$output" | jq -e '.request_id == "REQ-TEST"' >/dev/null
    echo "$output" | jq -e '.gate == "code_review"' >/dev/null
}

@test "561: a frontend change set pulls in the frontend-only reviewers" {
    PATH="${MOCKBIN}:${PATH}" run bun run "${CLI}" \
        --repo "${REPO}" --request-type feature --gate code_review \
        --frontend --changed-files src/app.tsx
    [ "$status" -eq 0 ]
    # ux-ui-reviewer + accessibility-reviewer join → 7 total.
    echo "$output" | jq -e '.results | length == 7' >/dev/null
    echo "$output" | jq -e '[.results[].reviewer_name] | index("ux-ui-reviewer") != null' >/dev/null
    echo "$output" | jq -e '[.results[].reviewer_name] | index("accessibility-reviewer") != null' >/dev/null
}

@test "561: a rejecting reviewer drives the gate to REQUEST_CHANGES" {
    write_mock_claude '{"score": 40, "verdict": "REQUEST_CHANGES"}'
    PATH="${MOCKBIN}:${PATH}" run bun run "${CLI}" \
        --repo "${REPO}" --request-type feature --gate code_review
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.outcome == "REQUEST_CHANGES"' >/dev/null
}

@test "561: an unconfigured gate yields an empty-chain APPROVE" {
    PATH="${MOCKBIN}:${PATH}" run bun run "${CLI}" \
        --repo "${REPO}" --request-type feature --gate no_such_gate
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.outcome == "APPROVE"' >/dev/null
    echo "$output" | jq -e '.results | length == 0' >/dev/null
}

@test "561: a reviewer subprocess failure is captured as an ERROR result, not a crash" {
    # Mock claude that exits non-zero → the dispatcher throws → the runner
    # records verdict ERROR for that reviewer; the CLI still completes (exit 0).
    cat > "${MOCKBIN}/claude" <<'EOF'
#!/usr/bin/env bash
echo "boom" >&2
exit 3
EOF
    chmod +x "${MOCKBIN}/claude"
    PATH="${MOCKBIN}:${PATH}" run bun run "${CLI}" \
        --repo "${REPO}" --request-type feature --gate code_review
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '[.results[] | select(.verdict == "ERROR")] | length >= 1' >/dev/null
}

@test "561: --help prints usage and exits 0" {
    run bun run "${CLI}" --help
    [ "$status" -eq 0 ]
    echo "$output" | grep -q "Usage: review-gate-cli"
}

@test "561: missing required --gate exits 1 with an error" {
    run bun run "${CLI}" --repo "${REPO}" --request-type feature
    [ "$status" -eq 1 ]
    echo "$output" | grep -qi "missing required option"
}
