#!/usr/bin/env bats
# #648 — the merge gate must not strand a real PR when the github_pr artifact
# is missing (e.g. a mid-build restart dropped phase-result-code.json).
# read_request_pr_url recovers the PR from its head branch autonomous/<id> and
# persists it durably; _persist_recovered_pr_artifact writes it atomically.

PLUGIN_DIR_PATH=""

setup() {
    PLUGIN_DIR_PATH="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    TEST_WORK_DIR="$(mktemp -d)"
    export HOME="$TEST_WORK_DIR"
    mkdir -p "$TEST_WORK_DIR/.autonomous-dev/logs"
    set +e; source "$PLUGIN_DIR_PATH/bin/supervisor-loop.sh"; set -e
    PROJ="$TEST_WORK_DIR/proj"
    RID="REQ-000999"
    RC="$PROJ/.autonomous-dev/requests/$RID/phase-result-code.json"
    mkdir -p "$(dirname "$RC")"

    # gh stub: `gh pr list --head autonomous/REQ-000999 …` echoes GH_STUB_URL.
    STUB_BIN="$TEST_WORK_DIR/bin"; mkdir -p "$STUB_BIN"
    cat > "$STUB_BIN/gh" <<'SH'
#!/usr/bin/env bash
# Only the recovery lookup is stubbed; anything else returns empty.
for a in "$@"; do case "$a" in *"autonomous/${GH_STUB_RID:-REQ-000999}"*) echo "${GH_STUB_URL:-}"; exit 0;; esac; done
echo ""
SH
    chmod +x "$STUB_BIN/gh"
    export PATH="$STUB_BIN:$PATH"
}
teardown() { rm -rf "$TEST_WORK_DIR"; }

@test "PR-01 returns the github_pr artifact url when present" {
    printf '{"status":"pass","phase":"code","artifacts":[{"kind":"github_pr","url":"https://github.com/o/r/pull/42"}]}' > "$RC"
    run read_request_pr_url "$PROJ" "$RID"
    [ "$status" -eq 0 ]; [ "$output" = "https://github.com/o/r/pull/42" ]
}

@test "PR-02 empty when no artifact AND no branch PR" {
    printf '{"status":"pass","phase":"code","artifacts":[]}' > "$RC"
    export GH_STUB_URL=""
    run read_request_pr_url "$PROJ" "$RID"
    [ "$status" -eq 0 ]; [ -z "$output" ]
}

@test "PR-03 recovers PR from head branch when artifact missing" {
    printf '{"status":"pass","phase":"code","artifacts":[]}' > "$RC"
    export GH_STUB_URL="https://github.com/o/r/pull/645"
    run read_request_pr_url "$PROJ" "$RID"
    [ "$status" -eq 0 ]; [ "$output" = "https://github.com/o/r/pull/645" ]
}

@test "PR-04 recovery PERSISTS the artifact back into the result file" {
    printf '{"status":"pass","phase":"code","artifacts":[]}' > "$RC"
    export GH_STUB_URL="https://github.com/o/r/pull/645"
    read_request_pr_url "$PROJ" "$RID" >/dev/null
    # Now the artifact is durable: a second read finds it with NO gh (empty stub).
    export GH_STUB_URL=""
    run read_request_pr_url "$PROJ" "$RID"
    [ "$output" = "https://github.com/o/r/pull/645" ]
    run jq -r '.artifacts[0].kind' "$RC"; [ "$output" = "github_pr" ]
}

@test "PR-05 recovers + synthesizes a result file when it was lost entirely" {
    rm -f "$RC"
    export GH_STUB_URL="https://github.com/o/r/pull/645"
    run read_request_pr_url "$PROJ" "$RID"
    [ "$output" = "https://github.com/o/r/pull/645" ]
    [ -f "$RC" ]
    run jq -r '.status' "$RC"; [ "$output" = "pass" ]
}
