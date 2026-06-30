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
        # Differentiate by flag to support both merge-state and author queries.
        case "$*" in
            *"--json baseRefName"*)
                printf '%s' "${GH_PR_REFS_JSON:-{\"baseRefName\":\"main\"}}"
                exit 0
                ;;
            *"--json author"*)
                # _baseline_red_checks and author-capture path: return login string.
                printf '%s' "${GH_PR_AUTHOR_LOGIN:-}"
                exit 0
                ;;
            *)
                # Default: mergeability / state query.
                printf '%s' "${GH_PR_VIEW_JSON:-}"
                exit 0
                ;;
        esac
        ;;
    "pr checks")
        # _evaluate_merge_checks calls this; driven by GH_PR_CHECKS_JSON.
        # No default: unset/empty → empty output → triggers unreadable path.
        printf '%s' "${GH_PR_CHECKS_JSON}"
        exit 0
        ;;
    "pr merge")
        # NEVER perform a real merge. Just succeed/fail per GH_MERGE_RC.
        exit "${GH_MERGE_RC:-0}"
        ;;
    "api"*)
        # _baseline_red_checks calls gh api .../check-runs
        printf '%s' "${GH_API_JSON:-[]}"
        exit 0
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

# Run the merge gate directly (bypasses advance_phase so G1-G4 stubs apply cleanly).
# G1-G4 helpers must be overridden before calling this.
run_merge_gate() {
    local state_file="$TEST_REQ_DIR/state.json"
    local events_file="$TEST_REQ_DIR/events.jsonl"
    local ts="2026-06-30T02:00:00Z"
    maybe_merge_integration_pr "$TEST_REQUEST_ID" "$TEST_PROJECT" \
        "$state_file" "$events_file" "$ts"
}

last_merge_decision() {
    jq -r 'select(.event=="merge_decision") | .decision' \
        "$TEST_REQ_DIR/events.jsonl" | tail -n1
}

# Seed for merge-gate direct tests (same shape as merge_gate_order_aware.bats).
seed_merge_request() {
    local pr_url="${1:-https://github.com/o/r/pull/42}"
    cat > "$TEST_REQ_DIR/state.json" << EOF
{
  "id": "$TEST_REQUEST_ID",
  "status": "running",
  "current_phase": "integration",
  "escalation_count": 0,
  "type": "refactor",
  "phase_overrides": ["code", "integration", "deploy"],
  "current_phase_metadata": {
    "dispatched_at": "2026-06-30T01:30:00Z",
    "rebase_attempts": 0
  }
}
EOF
    cat > "$TEST_REQ_DIR/phase-result-integration.json" << EOF
{ "status": "pass", "phase": "integration", "feedback": "ok", "evidence": [{"command":"x","exit_code":0,"output_tail":"ok"}] }
EOF
    cat > "$TEST_REQ_DIR/phase-result-code.json" << EOF
{ "artifacts": [ { "kind": "github_pr", "url": "$pr_url", "title": "t" } ] }
EOF
    : > "$TEST_REQ_DIR/events.jsonl"
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

# ===========================================================================
# REQ-000054 TASK-001 — T01: load_config emits the three new globals
# ===========================================================================

@test "T01: load_config emits the three new globals with defaults" {
    # DAEMON_HOME and DEFAULTS_FILE are set at source-time based on $HOME.
    # $HOME=$TEST_WORK_DIR so DAEMON_HOME=$TEST_WORK_DIR/.autonomous-dev (exists).
    # CONFIG_FILE=$TEST_WORK_DIR/.claude/autonomous-dev.json does NOT exist -> defaults used.
    load_config

    # MERGE_GATE_NON_BLOCKING_CHECKS must be a JSON array containing "markdown".
    echo "$MERGE_GATE_NON_BLOCKING_CHECKS" | jq -e 'type == "array"' > /dev/null
    echo "$MERGE_GATE_NON_BLOCKING_CHECKS" | jq -e 'any(.[]; . == "markdown")' > /dev/null

    # MERGE_GATE_SKIP_BASELINE_RED must be the literal string "false".
    [ "$MERGE_GATE_SKIP_BASELINE_RED" = "false" ]

    # PR_COMMENT_NON_ACTIONABLE_AUTHORS must be a JSON array containing "[bot]".
    echo "$PR_COMMENT_NON_ACTIONABLE_AUTHORS" | jq -e 'type == "array"' > /dev/null
    echo "$PR_COMMENT_NON_ACTIONABLE_AUTHORS" | jq -e 'any(.[]; . == "[bot]")' > /dev/null
}

# ===========================================================================
# REQ-000054 TASK-004 — T09-T14: _evaluate_merge_checks unit tests
# ===========================================================================

# Helper: set up the globals needed by _evaluate_merge_checks.
_setup_emc_globals() {
    MERGE_GATE_NON_BLOCKING_CHECKS="${1:-[]}"
    MERGE_GATE_SKIP_BASELINE_RED="${2:-false}"
}

# Helper: invoke _evaluate_merge_checks and parse the TAB-separated output.
call_evaluate_merge_checks() {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/42"
    # Stub the four G1-G4 helpers so the function can be defined.
    _pr_branch_up_to_date() { return 0; }
    _list_inflight_pr_files() { echo ""; return 0; }
    _this_pr_files() { echo ""; return 0; }
    _pr_has_duplicate_patches() { return 1; }
    _reverify_pr_after_rebase() { return 0; }
    # The nested helper _evaluate_merge_checks is defined when
    # maybe_merge_integration_pr is first called. We call it to get the definition
    # then invoke the helper directly.
    # Actually, we need to call maybe_merge_integration_pr once to define the nested
    # functions. But it would try to merge. Use a dummy invocation with MERGEABLE+CLEAN
    # so it exits the merge path immediately (no synthetic readiness) and returns after
    # recording a `merged` decision.  We then call _evaluate_merge_checks directly.
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'
    run_merge_gate > /dev/null 2>&1 || true
    # Now _evaluate_merge_checks is in scope.
}

@test "T09: _evaluate_merge_checks: all failures allowlisted -> ok" {
    _setup_emc_globals '["markdown"]' "false"
    export GH_PR_CHECKS_JSON='[{"name":"markdown","state":"FAILURE","bucket":"fail"},{"name":"test","state":"SUCCESS","bucket":"pass"}]'
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/42"
    _pr_branch_up_to_date() { return 0; }
    _list_inflight_pr_files() { echo ""; return 0; }
    _this_pr_files() { echo ""; return 0; }
    _pr_has_duplicate_patches() { return 1; }
    _reverify_pr_after_rebase() { return 0; }
    # Run with BLOCKED to trigger synthetic readiness and expose _evaluate_merge_checks result.
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}'
    run run_merge_gate
    [ "$status" -eq 0 ]
    local decision
    decision=$(jq -r 'select(.event=="merge_decision") | .decision' "$TEST_REQ_DIR/events.jsonl" | tail -1)
    [ "$decision" = "merged" ]
    jq -e 'select(.event=="merge_decision") | select(.reason | contains("synthetic-readiness, ignored=[markdown]"))' \
        "$TEST_REQ_DIR/events.jsonl" > /dev/null
}

@test "T10: _evaluate_merge_checks: non-allowlisted failure -> not_ok with blocking CSV" {
    _setup_emc_globals '["markdown"]' "false"
    export GH_PR_CHECKS_JSON='[{"name":"typecheck","state":"FAILURE","bucket":"fail"}]'
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/42"
    _pr_branch_up_to_date() { return 0; }
    _list_inflight_pr_files() { echo ""; return 0; }
    _this_pr_files() { echo ""; return 0; }
    _pr_has_duplicate_patches() { return 1; }
    _reverify_pr_after_rebase() { return 0; }
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}'
    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "skip_not_mergeable" ]
    jq -e 'select(.event=="merge_decision") | select(.reason | contains("blocking checks=typecheck"))' \
        "$TEST_REQ_DIR/events.jsonl" > /dev/null
    ! gh_merge_was_called
}

@test "T11: _evaluate_merge_checks: pending check -> not_ok (verdict only; no blocking CSV content)" {
    _setup_emc_globals '["markdown"]' "false"
    export GH_PR_CHECKS_JSON='[{"name":"test","state":"IN_PROGRESS","bucket":""}]'
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/42"
    _pr_branch_up_to_date() { return 0; }
    _list_inflight_pr_files() { echo ""; return 0; }
    _this_pr_files() { echo ""; return 0; }
    _pr_has_duplicate_patches() { return 1; }
    _reverify_pr_after_rebase() { return 0; }
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}'
    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "skip_not_mergeable" ]
    ! gh_merge_was_called
}

@test "T12: _evaluate_merge_checks: empty gh pr checks output -> unreadable" {
    _setup_emc_globals '["markdown"]' "false"
    export GH_PR_CHECKS_JSON=''
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/42"
    _pr_branch_up_to_date() { return 0; }
    _list_inflight_pr_files() { echo ""; return 0; }
    _this_pr_files() { echo ""; return 0; }
    _pr_has_duplicate_patches() { return 1; }
    _reverify_pr_after_rebase() { return 0; }
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}'
    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "skip_status_unreadable" ]
    ! gh_merge_was_called
}

@test "T13: _evaluate_merge_checks: non-JSON gh pr checks output -> unreadable" {
    _setup_emc_globals '["markdown"]' "false"
    export GH_PR_CHECKS_JSON='not json'
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/42"
    _pr_branch_up_to_date() { return 0; }
    _list_inflight_pr_files() { echo ""; return 0; }
    _this_pr_files() { echo ""; return 0; }
    _pr_has_duplicate_patches() { return 1; }
    _reverify_pr_after_rebase() { return 0; }
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}'
    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "skip_status_unreadable" ]
    ! gh_merge_was_called
}

@test "T14: _evaluate_merge_checks: multiple ignored + multiple blocking" {
    _setup_emc_globals '["markdown","lychee"]' "false"
    export GH_PR_CHECKS_JSON='[{"name":"markdown","state":"FAILURE","bucket":"fail"},{"name":"lychee","state":"FAIL","bucket":"fail"},{"name":"typecheck","state":"ERROR","bucket":"fail"}]'
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/42"
    _pr_branch_up_to_date() { return 0; }
    _list_inflight_pr_files() { echo ""; return 0; }
    _this_pr_files() { echo ""; return 0; }
    _pr_has_duplicate_patches() { return 1; }
    _reverify_pr_after_rebase() { return 0; }
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}'
    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "skip_not_mergeable" ]
    jq -e 'select(.event=="merge_decision") | select(.reason | contains("blocking checks=typecheck"))' \
        "$TEST_REQ_DIR/events.jsonl" > /dev/null
    jq -e 'select(.event=="merge_decision") | select(.reason | contains("ignored="))' \
        "$TEST_REQ_DIR/events.jsonl" > /dev/null
    ! gh_merge_was_called
}

# ===========================================================================
# REQ-000054 TASK-005 — T15-T20: maybe_merge_integration_pr wiring tests
# ===========================================================================

@test "T15: merge gate ignores allowlisted failing checks -> merged with synthetic-readiness reason" {
    _setup_emc_globals '["markdown"]' "false"
    export GH_PR_CHECKS_JSON='[{"name":"markdown","state":"FAILURE","bucket":"fail"},{"name":"test","state":"SUCCESS","bucket":"pass"}]'
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/42"
    _pr_branch_up_to_date() { return 0; }
    _list_inflight_pr_files() { echo ""; return 0; }
    _this_pr_files() { echo ""; return 0; }
    _pr_has_duplicate_patches() { return 1; }
    _reverify_pr_after_rebase() { return 0; }
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}'

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "merged" ]
    jq -e 'select(.event=="merge_decision") | select(.merged==true)' "$TEST_REQ_DIR/events.jsonl" > /dev/null
    jq -e 'select(.event=="merge_decision") | select(.reason | contains("synthetic-readiness, ignored=[markdown]"))' \
        "$TEST_REQ_DIR/events.jsonl" > /dev/null
    gh_merge_was_called
    grep -q 'pr merge https://github.com/o/r/pull/42 --squash' "$GH_CALL_LOG"
}

@test "T16: merge gate blocks when a non-allowlisted real check fails" {
    _setup_emc_globals '["markdown"]' "false"
    export GH_PR_CHECKS_JSON='[{"name":"typecheck","state":"FAILURE","bucket":"fail"}]'
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/42"
    _pr_branch_up_to_date() { return 0; }
    _list_inflight_pr_files() { echo ""; return 0; }
    _this_pr_files() { echo ""; return 0; }
    _pr_has_duplicate_patches() { return 1; }
    _reverify_pr_after_rebase() { return 0; }
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}'

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "skip_not_mergeable" ]
    jq -e 'select(.event=="merge_decision") | select(.reason | contains("blocking checks=typecheck"))' \
        "$TEST_REQ_DIR/events.jsonl" > /dev/null
    ! gh_merge_was_called
}

@test "T17: merge gate blocks while real checks are still pending" {
    _setup_emc_globals '["markdown"]' "false"
    export GH_PR_CHECKS_JSON='[{"name":"test","state":"IN_PROGRESS","bucket":""}]'
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/42"
    _pr_branch_up_to_date() { return 0; }
    _list_inflight_pr_files() { echo ""; return 0; }
    _this_pr_files() { echo ""; return 0; }
    _pr_has_duplicate_patches() { return 1; }
    _reverify_pr_after_rebase() { return 0; }
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}'

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "skip_not_mergeable" ]
    ! gh_merge_was_called
}

@test "T18: merge gate handles unreadable gh pr checks" {
    _setup_emc_globals '["markdown"]' "false"
    export GH_PR_CHECKS_JSON=''
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/42"
    _pr_branch_up_to_date() { return 0; }
    _list_inflight_pr_files() { echo ""; return 0; }
    _this_pr_files() { echo ""; return 0; }
    _pr_has_duplicate_patches() { return 1; }
    _reverify_pr_after_rebase() { return 0; }
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}'

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "skip_status_unreadable" ]
    ! gh_merge_was_called
}

@test "T19: synthetic readiness disabled when allowlist empty AND baseline_red off" {
    _setup_emc_globals '[]' "false"
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/42"
    _pr_branch_up_to_date() { return 0; }
    _list_inflight_pr_files() { echo ""; return 0; }
    _this_pr_files() { echo ""; return 0; }
    _pr_has_duplicate_patches() { return 1; }
    _reverify_pr_after_rebase() { return 0; }
    : > "$GH_CALL_LOG"
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}'

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "skip_not_mergeable" ]
    jq -e 'select(.event=="merge_decision") | select(.reason | contains("synthetic-readiness disabled"))' \
        "$TEST_REQ_DIR/events.jsonl" > /dev/null
    # gh pr checks must NOT be called (short-circuit before _evaluate_merge_checks).
    ! grep -q '^pr checks' "$GH_CALL_LOG"
    ! gh_merge_was_called
}

@test "T20: mergeable=CONFLICTING never proceeds to synthetic readiness" {
    _setup_emc_globals '["markdown"]' "false"
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/42"
    _pr_branch_up_to_date() { return 0; }
    _list_inflight_pr_files() { echo ""; return 0; }
    _this_pr_files() { echo ""; return 0; }
    _pr_has_duplicate_patches() { return 1; }
    _reverify_pr_after_rebase() { return 0; }
    : > "$GH_CALL_LOG"
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"CONFLICTING","mergeStateStatus":"DIRTY"}'

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "skip_not_mergeable" ]
    jq -e 'select(.event=="merge_decision") | select(.reason | contains("mergeable=CONFLICTING"))' \
        "$TEST_REQ_DIR/events.jsonl" > /dev/null
    # gh pr checks must NOT be called (short-circuit on CONFLICTING).
    ! grep -q '^pr checks' "$GH_CALL_LOG"
    ! gh_merge_was_called
}

# ===========================================================================
# REQ-000054 TASK-006 — T21-T23: _baseline_red_checks tests
# ===========================================================================

@test "T21: baseline_red opt-in widens the allowlist" {
    _setup_emc_globals '[]' "true"
    # _baseline_red_checks will: call 'gh pr view --json baseRefName' -> GH_PR_REFS_JSON
    # then 'gh api .../check-runs' -> GH_API_JSON returning ["lychee"]
    export GH_PR_REFS_JSON='{"baseRefName":"main"}'
    export GH_API_JSON='["lychee"]'
    export GH_PR_CHECKS_JSON='[{"name":"lychee","state":"FAILURE","bucket":"fail"}]'
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/42"
    _pr_branch_up_to_date() { return 0; }
    _list_inflight_pr_files() { echo ""; return 0; }
    _this_pr_files() { echo ""; return 0; }
    _pr_has_duplicate_patches() { return 1; }
    _reverify_pr_after_rebase() { return 0; }
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}'

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "merged" ]
    jq -e 'select(.event=="merge_decision") | select(.reason | contains("synthetic-readiness, ignored=[lychee]"))' \
        "$TEST_REQ_DIR/events.jsonl" > /dev/null
}

@test "T22: baseline_red opt-off — same PR is NOT merged" {
    _setup_emc_globals '[]' "false"
    export GH_PR_CHECKS_JSON='[{"name":"lychee","state":"FAILURE","bucket":"fail"}]'
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/42"
    _pr_branch_up_to_date() { return 0; }
    _list_inflight_pr_files() { echo ""; return 0; }
    _this_pr_files() { echo ""; return 0; }
    _pr_has_duplicate_patches() { return 1; }
    _reverify_pr_after_rebase() { return 0; }
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}'

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "skip_not_mergeable" ]
    jq -e 'select(.event=="merge_decision") | select(.reason | contains("synthetic-readiness disabled"))' \
        "$TEST_REQ_DIR/events.jsonl" > /dev/null
    ! gh_merge_was_called
}

@test "T23: _baseline_red_checks returns [] on gh failure" {
    _setup_emc_globals '[]' "true"
    # Make gh pr view --json baseRefName return empty (simulates gh failure).
    export GH_PR_REFS_JSON=''
    export GH_PR_CHECKS_JSON='[{"name":"lychee","state":"FAILURE","bucket":"fail"}]'
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/42"
    _pr_branch_up_to_date() { return 0; }
    _list_inflight_pr_files() { echo ""; return 0; }
    _this_pr_files() { echo ""; return 0; }
    _pr_has_duplicate_patches() { return 1; }
    _reverify_pr_after_rebase() { return 0; }
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}'

    run run_merge_gate
    [ "$status" -eq 0 ]
    # With baseline returning [], the allowlist remains empty + baseline-red "true" but no widening.
    # Since allowlist is [] and GH_PR_REFS_JSON is empty (base branch unknown), _baseline_red_checks
    # returns []. So _evaluate_merge_checks sees lychee as non-ignorable -> not_ok -> skip.
    # But wait: MERGE_GATE_SKIP_BASELINE_RED=true AND allowlist=[] -> we call _evaluate_merge_checks.
    # _evaluate_merge_checks calls _baseline_red_checks which returns [] (gh failure).
    # lychee is not in allowlist=[] and not in baseline=[] -> blocking -> not_ok -> skip_not_mergeable.
    [ "$(last_merge_decision)" = "skip_not_mergeable" ]
    # The key assertion: _baseline_red_checks returned [] (not a crash), exit code was 0.
    # Verified by: run_merge_gate exited 0 and produced a decision (not a crash/abort).
    ! gh_merge_was_called
}
