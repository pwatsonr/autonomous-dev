#!/usr/bin/env bats

load ../../tests/test_helpers

# Test the mock-claude fixture used by the smoke E2E test

@test "mock-claude responds to --version" {
    run test/e2e/fixtures/mock-claude.sh --version
    assert_success
    [[ "$output" =~ "claude-mock" ]]
}

@test "mock-claude writes PRD artifact for prd-author agent" {
    local tmpdir
    tmpdir=$(mktemp -d)

    local req_dir="$tmpdir/req"
    local project="$tmpdir/project"
    mkdir -p "$req_dir" "$project/docs/prd"

    # Create minimal state.json
    echo '{"current_phase":"prd","type":"feature"}' > "$req_dir/state.json"

    export SMOKE_MOCK_LOG="$tmpdir/mock.log"

    run test/e2e/fixtures/mock-claude.sh \
        --print --output-format json \
        --agent prd-author \
        --add-dir "$req_dir" \
        --add-dir "$project" \
        --permission-mode acceptEdits \
        --max-budget-usd 5.0 \
        "Test prompt"

    assert_success
    [[ "$output" =~ "total_cost_usd" ]]

    # Check PRD artifact was created
    [[ -f "$project/docs/prd/smoke-feature.md" ]]

    # Check phase-result was created
    [[ -f "$req_dir/phase-result-prd.json" ]]

    # Verify phase-result content
    local status
    status=$(jq -r '.status' "$req_dir/phase-result-prd.json")
    [[ "$status" == "pass" ]]

    rm -rf "$tmpdir"
}

@test "mock-claude writes generic result for non-prd-author agents" {
    local tmpdir
    tmpdir=$(mktemp -d)

    local req_dir="$tmpdir/req"
    local project="$tmpdir/project"
    mkdir -p "$req_dir" "$project"

    # Create minimal state.json
    echo '{"current_phase":"tdd","type":"feature"}' > "$req_dir/state.json"

    export SMOKE_MOCK_LOG="$tmpdir/mock.log"

    run test/e2e/fixtures/mock-claude.sh \
        --print --output-format json \
        --agent tdd-author \
        --add-dir "$req_dir" \
        --add-dir "$project" \
        --permission-mode acceptEdits \
        --max-budget-usd 5.0 \
        "Test prompt"

    assert_success
    [[ "$output" =~ "total_cost_usd" ]]

    # Check phase-result was created
    [[ -f "$req_dir/phase-result-tdd.json" ]]

    # Verify phase-result content
    local status
    status=$(jq -r '.status' "$req_dir/phase-result-tdd.json")
    [[ "$status" == "pass" ]]

    rm -rf "$tmpdir"
}

@test "mock-claude fails when SMOKE_MOCK_FAIL=1" {
    export SMOKE_MOCK_FAIL=1
    export SMOKE_MOCK_LOG=/dev/null

    run test/e2e/fixtures/mock-claude.sh --version
    assert_failure
}

# Helper functions
assert_success() {
    [[ "$status" -eq 0 ]]
}

assert_failure() {
    [[ "$status" -ne 0 ]]
}