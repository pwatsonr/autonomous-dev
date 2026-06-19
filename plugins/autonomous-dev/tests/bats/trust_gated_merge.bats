#!/usr/bin/env bats

# Tests for the trust-gated PR merge (#487).
#
# Covers:
#   - resolve_effective_trust(): per-repo override, system default, fallback,
#     invalid-value fall-through, missing/corrupt config.
#   - maybe_merge_integration_pr() via advance_phase():
#       * L3 + OPEN/MERGEABLE/CLEAN  -> auto-merge (gh pr merge invoked once)
#       * below L3                    -> NO merge, PR-ready marker set
#       * L3 + not mergeable          -> NO merge, PR-ready marker set
#       * L3 + already MERGED         -> idempotent no-op (no gh pr merge)
#       * no PR artifact              -> skip_no_pr, no merge
#
# CRITICAL: `gh` is stubbed on PATH. These tests perform NO real merges and
# never contact GitHub. The stub records every invocation to GH_CALL_LOG and
# refuses to do anything destructive.

PLUGIN_DIR_PATH=""

setup() {
    PLUGIN_DIR_PATH="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"

    TEST_WORK_DIR="$(mktemp -d)"
    export HOME="$TEST_WORK_DIR"
    mkdir -p "$TEST_WORK_DIR/.autonomous-dev/logs"
    mkdir -p "$TEST_WORK_DIR/.claude"

    # ---- gh stub on PATH --------------------------------------------------
    # Behavior is driven by env vars so one stub serves every scenario:
    #   GH_PR_VIEW_JSON  : JSON echoed for `gh pr view ... --json ...`
    #   GH_MERGE_RC      : exit code for `gh pr merge ...` (default 0)
    # Every invocation is appended (argv) to GH_CALL_LOG so tests can assert
    # exactly which gh subcommands ran (esp. that `pr merge` did NOT run on
    # skip paths).
    MOCK_DIR="$TEST_WORK_DIR/mock-bin"
    mkdir -p "$MOCK_DIR"
    export GH_CALL_LOG="$TEST_WORK_DIR/gh-calls.log"
    : > "$GH_CALL_LOG"
    cat > "$MOCK_DIR/gh" << 'EOF'
#!/usr/bin/env bash
# Record the full argv for assertions.
printf '%s\n' "$*" >> "$GH_CALL_LOG"
case "$1 $2" in
    "pr view")
        # Emit the canned PR status JSON (empty if unset).
        printf '%s' "${GH_PR_VIEW_JSON:-}"
        exit 0
        ;;
    "pr merge")
        # NEVER perform a real merge. Just succeed/fail per GH_MERGE_RC.
        exit "${GH_MERGE_RC:-0}"
        ;;
    "repo view")
        # detect_default_branch may call this; keep it harmless.
        echo "main"
        exit 0
        ;;
    *)
        exit 0
        ;;
esac
EOF
    chmod +x "$MOCK_DIR/gh"
    export PATH="$MOCK_DIR:$PATH"

    set +e
    source "$PLUGIN_DIR_PATH/bin/supervisor-loop.sh"
    set -e

    TEST_PROJECT="$TEST_WORK_DIR/test-project"
    TEST_REQUEST_ID="REQ-260618"
    TEST_REQ_DIR="$TEST_PROJECT/.autonomous-dev/requests/$TEST_REQUEST_ID"
    mkdir -p "$TEST_REQ_DIR"
}

teardown() {
    rm -rf "$TEST_WORK_DIR"
}

# ---- helpers --------------------------------------------------------------

write_config() {
    # $1 = JSON for ~/.claude/autonomous-dev.json
    printf '%s' "$1" > "$TEST_WORK_DIR/.claude/autonomous-dev.json"
}

# Seed an integration-phase request whose code phase recorded a github_pr.
# $1 = PR url (omit to skip writing phase-result-code.json)
seed_integration_request() {
    local pr_url="${1:-}"
    cat > "$TEST_REQ_DIR/state.json" << EOF
{
  "id": "$TEST_REQUEST_ID",
  "status": "running",
  "current_phase": "integration",
  "escalation_count": 0,
  "phase_overrides": ["code", "integration", "deploy"]
}
EOF
    cat > "$TEST_REQ_DIR/phase-result-integration.json" << EOF
{ "status": "pass", "phase": "integration", "evidence": [{"command":"x","exit_code":0,"output_tail":"ok"}] }
EOF
    if [[ -n "$pr_url" ]]; then
        cat > "$TEST_REQ_DIR/phase-result-code.json" << EOF
{ "artifacts": [ { "kind": "github_pr", "url": "$pr_url", "title": "t" } ] }
EOF
    fi
}

gh_merge_was_called() {
    grep -q '^pr merge' "$GH_CALL_LOG"
}

# ===========================================================================
# resolve_effective_trust
# ===========================================================================

@test "resolve_effective_trust: per-repo override (bare int) wins over system default" {
    write_config '{"trust":{"system_default_level":1,"per_repo_overrides":{"/repo/foo":3}}}'
    run resolve_effective_trust "/repo/foo"
    [ "$status" -eq 0 ]
    [ "$output" = "3" ]
}

@test "resolve_effective_trust: per-repo override as object .default_level" {
    write_config '{"trust":{"system_default_level":0,"per_repo_overrides":{"/repo/foo":{"default_level":2}}}}'
    run resolve_effective_trust "/repo/foo"
    [ "$output" = "2" ]
}

@test "resolve_effective_trust: falls back to system default when repo not overridden" {
    write_config '{"trust":{"system_default_level":2,"per_repo_overrides":{"/repo/other":3}}}'
    run resolve_effective_trust "/repo/foo"
    [ "$output" = "2" ]
}

@test "resolve_effective_trust: system default alone (no per-repo map)" {
    write_config '{"trust":{"system_default_level":3}}'
    run resolve_effective_trust "/repo/foo"
    [ "$output" = "3" ]
}

@test "resolve_effective_trust: invalid per-repo value falls through to system default" {
    write_config '{"trust":{"system_default_level":2,"per_repo_overrides":{"/repo/foo":5}}}'
    run resolve_effective_trust "/repo/foo"
    [ "$output" = "2" ]
}

@test "resolve_effective_trust: missing config file -> 0" {
    rm -f "$TEST_WORK_DIR/.claude/autonomous-dev.json"
    run resolve_effective_trust "/repo/foo"
    [ "$output" = "0" ]
}

@test "resolve_effective_trust: empty/no trust section -> 0" {
    write_config '{}'
    run resolve_effective_trust "/repo/foo"
    [ "$output" = "0" ]
}

@test "resolve_effective_trust: corrupt JSON -> 0" {
    write_config 'not json{'
    run resolve_effective_trust "/repo/foo"
    [ "$output" = "0" ]
}

# ===========================================================================
# read_request_pr_url
# ===========================================================================

@test "read_request_pr_url: returns github_pr url, ignores other artifacts" {
    mkdir -p "$TEST_REQ_DIR"
    cat > "$TEST_REQ_DIR/phase-result-code.json" << 'EOF'
{ "artifacts": [ {"kind":"test-output","path":"x"}, {"kind":"github_pr","url":"https://github.com/o/r/pull/7"} ] }
EOF
    run read_request_pr_url "$TEST_PROJECT" "$TEST_REQUEST_ID"
    [ "$output" = "https://github.com/o/r/pull/7" ]
}

@test "read_request_pr_url: empty when no github_pr artifact / no file" {
    mkdir -p "$TEST_REQ_DIR"
    run read_request_pr_url "$TEST_PROJECT" "$TEST_REQUEST_ID"
    [ "$output" = "" ]
}

# ===========================================================================
# L3 auto-merge path
# ===========================================================================

@test "advance_phase integration L3 + OPEN/MERGEABLE/CLEAN: auto-merges via gh pr merge --squash" {
    # resolve_effective_trust keys on the project path:
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_integration_request "https://github.com/o/r/pull/7"
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'

    advance_phase "$TEST_REQUEST_ID" "$TEST_PROJECT"

    # gh pr merge was invoked with --squash and the PR url, and WITHOUT --admin/--force.
    gh_merge_was_called
    grep -q 'pr merge https://github.com/o/r/pull/7 --squash' "$GH_CALL_LOG"
    ! grep -q -- '--admin' "$GH_CALL_LOG"
    ! grep -q -- '--force' "$GH_CALL_LOG"

    # state reflects the merge.
    local merge_status trust ev_decision
    merge_status=$(jq -r '.merge_status' "$TEST_REQ_DIR/state.json")
    trust=$(jq -r '.effective_trust' "$TEST_REQ_DIR/state.json")
    [ "$merge_status" = "merged" ]
    [ "$trust" = "3" ]

    # merge_decision event recorded with merged=true.
    ev_decision=$(jq -r 'select(.event=="merge_decision") | .decision' "$TEST_REQ_DIR/events.jsonl" | tail -n1)
    [ "$ev_decision" = "merged" ]
    jq -e 'select(.event=="merge_decision") | select(.merged==true and .effective_trust==3)' "$TEST_REQ_DIR/events.jsonl" >/dev/null

    # request still advanced (integration -> deploy).
    [ "$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")" = "deploy" ]
}

# ===========================================================================
# Below-L3 skip path
# ===========================================================================

@test "advance_phase integration below L3: does NOT merge, marks PR ready for human" {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":2}}}"
    seed_integration_request "https://github.com/o/r/pull/7"
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'

    advance_phase "$TEST_REQUEST_ID" "$TEST_PROJECT"

    # No merge attempted at all (not even gh pr view is required, but merge must not run).
    ! gh_merge_was_called

    # PR-ready markers set.
    local pr_ready merge_status reason
    pr_ready=$(jq -r '.pr_ready_for_human' "$TEST_REQ_DIR/state.json")
    merge_status=$(jq -r '.merge_status' "$TEST_REQ_DIR/state.json")
    reason=$(jq -r '.status_reason' "$TEST_REQ_DIR/state.json")
    [ "$pr_ready" = "true" ]
    [ "$merge_status" = "pr_ready_for_human" ]
    [[ "$reason" == *"human merge"* ]]

    # merge_decision event: skip_below_l3, merged=false, trust=2.
    jq -e 'select(.event=="merge_decision") | select(.decision=="skip_below_l3" and .merged==false and .effective_trust==2)' "$TEST_REQ_DIR/events.jsonl" >/dev/null

    # request still reaches the next phase (non-failure outcome).
    [ "$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")" = "deploy" ]
}

# ===========================================================================
# L3 but not mergeable -> skip
# ===========================================================================

@test "advance_phase integration L3 + CONFLICTING: does NOT merge, marks PR ready" {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_integration_request "https://github.com/o/r/pull/7"
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"CONFLICTING","mergeStateStatus":"DIRTY"}'

    advance_phase "$TEST_REQUEST_ID" "$TEST_PROJECT"

    # gh pr view was consulted, but gh pr merge was NOT called.
    grep -q '^pr view' "$GH_CALL_LOG"
    ! gh_merge_was_called

    local merge_status reason
    merge_status=$(jq -r '.merge_status' "$TEST_REQ_DIR/state.json")
    reason=$(jq -r '.status_reason' "$TEST_REQ_DIR/state.json")
    [ "$merge_status" = "pr_ready_for_human" ]
    [[ "$reason" == *"not mergeable"* ]]

    jq -e 'select(.event=="merge_decision") | select(.decision=="skip_not_mergeable" and .merged==false and .effective_trust==3)' "$TEST_REQ_DIR/events.jsonl" >/dev/null
}

@test "advance_phase integration L3 + BLOCKED (required checks): does NOT merge" {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_integration_request "https://github.com/o/r/pull/7"
    # MERGEABLE but mergeStateStatus BLOCKED (branch protection / required reviews).
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}'

    advance_phase "$TEST_REQUEST_ID" "$TEST_PROJECT"

    ! gh_merge_was_called
    jq -e 'select(.event=="merge_decision") | select(.decision=="skip_not_mergeable")' "$TEST_REQ_DIR/events.jsonl" >/dev/null
}

# ===========================================================================
# Idempotency: already merged
# ===========================================================================

@test "advance_phase integration L3 + already MERGED: idempotent, no re-merge" {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_integration_request "https://github.com/o/r/pull/7"
    export GH_PR_VIEW_JSON='{"state":"MERGED","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'

    advance_phase "$TEST_REQUEST_ID" "$TEST_PROJECT"

    # No second merge attempt.
    ! gh_merge_was_called

    local merge_status
    merge_status=$(jq -r '.merge_status' "$TEST_REQ_DIR/state.json")
    [ "$merge_status" = "merged" ]
    jq -e 'select(.event=="merge_decision") | select(.decision=="skip_already_merged")' "$TEST_REQ_DIR/events.jsonl" >/dev/null
}

# ===========================================================================
# No PR artifact
# ===========================================================================

@test "advance_phase integration L3 + no PR artifact: skip_no_pr, no merge" {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_integration_request   # no PR url -> no phase-result-code.json

    advance_phase "$TEST_REQUEST_ID" "$TEST_PROJECT"

    ! gh_merge_was_called
    jq -e 'select(.event=="merge_decision") | select(.decision=="skip_no_pr" and .merged==false)' "$TEST_REQ_DIR/events.jsonl" >/dev/null

    # still advances.
    [ "$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")" = "deploy" ]
}

# ===========================================================================
# L3 merge gh failure (branch protection) -> left open, recorded, NOT retried
# ===========================================================================

@test "advance_phase integration L3 + gh merge fails: PR left open, merge_failed recorded" {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_integration_request "https://github.com/o/r/pull/7"
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'
    export GH_MERGE_RC=1   # simulate gh refusing (e.g. protection)

    advance_phase "$TEST_REQUEST_ID" "$TEST_PROJECT"

    # Exactly one merge attempt, never retried with --admin/--force.
    [ "$(grep -c '^pr merge' "$GH_CALL_LOG")" -eq 1 ]
    ! grep -q -- '--admin' "$GH_CALL_LOG"

    local merge_status
    merge_status=$(jq -r '.merge_status' "$TEST_REQ_DIR/state.json")
    [ "$merge_status" = "pr_ready_for_human" ]
    jq -e 'select(.event=="merge_decision") | select(.decision=="merge_failed")' "$TEST_REQ_DIR/events.jsonl" >/dev/null
}
