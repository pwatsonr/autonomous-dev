#!/usr/bin/env bats

# Tests for the order-aware merge gate (REQ-000053, §4.3).
#
# Covers T01..T12: the new G1-G4 gates added to maybe_merge_integration_pr():
#   T01 - happy path (up-to-date, no overlap, no dup, reverify pass)  -> merged
#   T02 - G1 BEHIND, rebase succeeds, merged
#   T03 - G1 BEHIND, rebase fails                                      -> skip_rebase_failed
#   T04 - G2 serialize (earlier in-flight PR overlaps files)           -> skip_serialized
#   T05 - G3 duplicate patches detected                                -> skip_duplicate
#   T06 - G4 reverify fails after rebase                               -> skip_reverify_failed
#   T07 - rebase_attempts cap reached (>=2)                            -> skip_rebase_loop_exhausted
#   T08 - below L3                                                     -> skip_below_l3 (unchanged)
#   T09 - gh absent                                                    -> skip_no_gh  (unchanged)
#   T10 - not mergeable                                                -> skip_not_mergeable (unchanged)
#   T11 - hotfix bypasses G2 serialize                                 -> merged
#   T12 - rebase counter reset to 0 on successful merge
#
# Cross-cutting assertions (every test):
#   1. maybe_merge_integration_pr exits 0.
#   2. Exactly one merge_decision event appended to events.jsonl.
#   3. `gh pr merge` NEVER passed --admin or --force.
#
# CRITICAL: gh and git are stubbed on PATH. NO real network calls. NO real
# merges. NO real git operations.

PLUGIN_DIR_PATH=""

setup() {
    PLUGIN_DIR_PATH="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"

    TEST_WORK_DIR="$(mktemp -d)"
    export HOME="$TEST_WORK_DIR"
    mkdir -p "$TEST_WORK_DIR/.autonomous-dev/logs"
    mkdir -p "$TEST_WORK_DIR/.claude"

    # ---- stub directory on PATH ------------------------------------------
    MOCK_DIR="$TEST_WORK_DIR/mock-bin"
    mkdir -p "$MOCK_DIR"

    # Call logs.
    export GH_CALL_LOG="$TEST_WORK_DIR/gh-calls.log"
    export GIT_CALL_LOG="$TEST_WORK_DIR/git-calls.log"
    : > "$GH_CALL_LOG"
    : > "$GIT_CALL_LOG"

    # ---- gh stub (extended for REQ-000053) --------------------------------
    # Env-var knobs:
    #   GH_PR_VIEW_JSON        : JSON for `gh pr view --json state,mergeable,mergeStateStatus`
    #   GH_PR_REFS_JSON        : JSON for `gh pr view --json baseRefName,headRefName,headRefOid`
    #   GH_PR_FILES_OUTPUT     : newline-separated file paths for `gh pr view --json files --jq`
    #   GH_MERGE_RC            : exit code for `gh pr merge` (default 0)
    #   GH_UPDATE_BRANCH_RC    : exit code for `gh pr update-branch` (default 0)
    #   GH_UPDATE_BRANCH_STDERR: stderr text emitted when update-branch fails
    cat > "$MOCK_DIR/gh" << 'GHEOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_CALL_LOG"
# Detect subcommand patterns.
if [[ "$1 $2" == "pr view" ]]; then
    case "$*" in
        *"--json files"*)
            # File-listing query used by _this_pr_files and _list_inflight_pr_files.
            printf '%s\n' "${GH_PR_FILES_OUTPUT:-}"
            exit 0
            ;;
        *"--json baseRefName"*)
            # Refs query used by _pr_branch_up_to_date and _pr_has_duplicate_patches.
            printf '%s' "${GH_PR_REFS_JSON:-{\"baseRefName\":\"main\",\"headRefName\":\"feat\",\"headRefOid\":\"deadbeef\"}}"
            exit 0
            ;;
        *)
            # Default: mergeability query (state,mergeable,mergeStateStatus).
            # GH_PR_VIEW_JSON_SECOND: if set, returned on the 2nd+ call to
            # this branch — lets T24 simulate a different post-rebase response.
            if [[ -n "${GH_PR_VIEW_JSON_SECOND:-}" ]]; then
                _cnt_f="${GH_CALL_LOG%.log}-view-cnt.txt"
                _cnt=$(( $(cat "${_cnt_f}" 2>/dev/null || echo 0) + 1 ))
                printf '%d' "${_cnt}" > "${_cnt_f}"
                if [[ "${_cnt}" -gt 1 ]]; then
                    printf '%s' "${GH_PR_VIEW_JSON_SECOND}"
                    exit 0
                fi
            fi
            printf '%s' "${GH_PR_VIEW_JSON:-}"
            exit 0
            ;;
    esac
elif [[ "$1 $2" == "pr checks" ]]; then
    # _evaluate_merge_checks calls this; driven by GH_PR_CHECKS_JSON.
    printf '%s' "${GH_PR_CHECKS_JSON:-}"
    exit 0
elif [[ "$1 $2" == "pr merge" ]]; then
    exit "${GH_MERGE_RC:-0}"
elif [[ "$1 $2" == "pr update-branch" ]]; then
    if [[ "${GH_UPDATE_BRANCH_RC:-0}" -ne 0 ]]; then
        printf '%s\n' "${GH_UPDATE_BRANCH_STDERR:-update-branch failed}" >&2
        exit "${GH_UPDATE_BRANCH_RC}"
    fi
    exit 0
elif [[ "$1 $2" == "repo view" ]]; then
    echo "main"
    exit 0
else
    exit 0
fi
GHEOF
    chmod +x "$MOCK_DIR/gh"

    # ---- git stub ---------------------------------------------------------
    # Env-var knobs:
    #   GIT_IS_ANCESTOR_RC  : exit code for `git merge-base --is-ancestor` (0=up-to-date)
    #   GIT_MERGE_BASE_SHA  : output for `git merge-base <A> <B>` without --is-ancestor
    #   GIT_LOG_SHAS        : output for `git log --format=%H ...` (one SHA per line)
    #   GIT_PATCH_ID_OUTPUT : output for `git patch-id` (one "<patchid> <sha>" per line)
    cat > "$MOCK_DIR/git" << 'GITEOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GIT_CALL_LOG"
case "$1" in
    fetch)
        exit 0
        ;;
    merge-base)
        if [[ "$2" == "--is-ancestor" ]]; then
            exit "${GIT_IS_ANCESTOR_RC:-0}"
        else
            # Plain merge-base: emit merge-base SHA.
            echo "${GIT_MERGE_BASE_SHA:-aabbccdd}"
            exit 0
        fi
        ;;
    log)
        printf '%s\n' "${GIT_LOG_SHAS:-}"
        exit 0
        ;;
    show)
        # Emit a synthetic patch for git patch-id to process.
        echo "diff --git a/file b/file"
        echo "index 000..111 100644"
        echo "--- a/file"
        echo "+++ b/file"
        echo "@@ -0,0 +1 @@"
        printf '+%s\n' "$2"
        exit 0
        ;;
    patch-id)
        # Read patch content from stdin, emit "<patchid> <sha>" pairs.
        # Use GIT_PATCH_ID_OUTPUT if set; otherwise emit a fixed synthetic id.
        if [[ -n "${GIT_PATCH_ID_OUTPUT:-}" ]]; then
            printf '%s\n' "${GIT_PATCH_ID_OUTPUT}"
        else
            # Emit one line per commit SHA if we got explicit log output.
            printf '%s\n' "${GIT_LOG_SHAS:-}" | while IFS= read -r sha; do
                [[ -n "${sha}" ]] && echo "synthetic-patch-id-${sha} ${sha}"
            done
        fi
        exit 0
        ;;
    -C)
        # git -C <dir> <subcmd> ...
        shift 2
        exec git "$@"
        ;;
    *)
        exit 0
        ;;
esac
GITEOF
    chmod +x "$MOCK_DIR/git"

    export PATH="$MOCK_DIR:$PATH"

    set +e
    source "$PLUGIN_DIR_PATH/bin/supervisor-loop.sh"
    set -e

    TEST_PROJECT="$TEST_WORK_DIR/test-project"
    TEST_REQUEST_ID="REQ-000099"
    TEST_REQ_DIR="$TEST_PROJECT/.autonomous-dev/requests/$TEST_REQUEST_ID"
    mkdir -p "$TEST_REQ_DIR"

    # ---- Default mock overrides for merge-gate helpers -------------------
    # Individual tests override these via env vars or function redefinition.
    _pr_branch_up_to_date() { return "${G1_RC:-0}"; }
    _attempt_rebase_pr() {
        local stderr_text="${REBASE_STDERR:-}"
        [[ -n "${stderr_text}" ]] && printf '%s\n' "${stderr_text}"
        return "${GH_UPDATE_BRANCH_RC:-0}"
    }
    _list_inflight_pr_files() {
        printf '%s\n' "${INFLIGHT_FILES:-}"
        return 0
    }
    _this_pr_files() {
        printf '%s\n' "${THIS_PR_FILES:-}"
        return 0
    }
    _pr_has_duplicate_patches() {
        [[ -n "${DUP_SHAS:-}" ]] && printf '%s\n' "${DUP_SHAS}"
        return "${DUP_RC:-1}"
    }
    _reverify_pr_after_rebase() {
        # Write a synthetic phase-result-integration.json so the caller can
        # read .feedback from it if needed.
        local req_dir="${TEST_PROJECT}/.autonomous-dev/requests/${TEST_REQUEST_ID}"
        printf '{"status":"%s","phase":"integration","feedback":"%s","evidence":[{"command":"x","exit_code":0,"output_tail":"ok"}]}\n' \
            "${REVERIFY_STATUS:-pass}" "${REVERIFY_FEEDBACK:-}" \
            > "${req_dir}/phase-result-integration.json"
        return "${REVERIFY_RC:-0}"
    }
}

teardown() {
    rm -rf "$TEST_WORK_DIR"
}

# ---- helpers ---------------------------------------------------------------

write_config() {
    printf '%s' "$1" > "$TEST_WORK_DIR/.claude/autonomous-dev.json"
}

# Seed a request ready for the merge gate.
# $1 = PR url
# $2 = JSON fragment to merge into current_phase_metadata (optional)
# $3 = request type (optional, default "refactor")
seed_merge_request() {
    local pr_url="${1:-https://github.com/o/r/pull/777}"
    local extra_meta="${2:-}"
    local req_type="${3:-refactor}"
    local dispatched_at="2026-06-30T01:30:00Z"

    cat > "$TEST_REQ_DIR/state.json" << EOF
{
  "id": "$TEST_REQUEST_ID",
  "status": "running",
  "current_phase": "integration",
  "type": "$req_type",
  "escalation_count": 0,
  "phase_overrides": ["code", "integration", "deploy"],
  "current_phase_metadata": {
    "dispatched_at": "$dispatched_at",
    "rebase_attempts": 0
    ${extra_meta:+,$extra_meta}
  }
}
EOF
    cat > "$TEST_REQ_DIR/phase-result-integration.json" << EOF
{ "status": "pass", "phase": "integration", "feedback": "all good", "evidence": [{"command":"x","exit_code":0,"output_tail":"ok"}] }
EOF
    cat > "$TEST_REQ_DIR/phase-result-code.json" << EOF
{ "artifacts": [ { "kind": "github_pr", "url": "$pr_url", "title": "test PR" } ] }
EOF
    : > "$TEST_REQ_DIR/events.jsonl"
}

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

merge_decision_count() {
    jq -r 'select(.event=="merge_decision") | .decision' \
        "$TEST_REQ_DIR/events.jsonl" | wc -l | tr -d ' '
}

gh_merge_was_called() {
    grep -q '^pr merge' "$GH_CALL_LOG"
}

gh_update_branch_was_called() {
    grep -q '^pr update-branch' "$GH_CALL_LOG"
}

# ===========================================================================
# T01 — happy path: up-to-date, no overlap, no dup, reverify n/a -> merged
# ===========================================================================

@test "T01: up-to-date, no overlap, no dup -> merged" {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/777"
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'
    # G1: up-to-date (rc=0 default)
    # G2: no inflight files (INFLIGHT_FILES empty default)
    # G3: no dup (DUP_RC=1 default)
    # G4: not triggered (rebase_attempts=0)

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "merged" ]
    [ "$(merge_decision_count)" -eq 1 ]
    gh_merge_was_called
    grep -q 'pr merge https://github.com/o/r/pull/777 --squash' "$GH_CALL_LOG"
    ! grep -q -- '--admin' "$GH_CALL_LOG"
    ! grep -q -- '--force' "$GH_CALL_LOG"
    # state reflects the merge
    [ "$(jq -r '.merge_status' "$TEST_REQ_DIR/state.json")" = "merged" ]
    jq -e 'select(.event=="merge_decision") | select(.merged==true and .effective_trust==3)' \
        "$TEST_REQ_DIR/events.jsonl" >/dev/null
}

# ===========================================================================
# T02 — G1 BEHIND, rebase succeeds -> merged; gh pr update-branch called once
# ===========================================================================

@test "T02: PR behind base, rebase succeeds -> merged" {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/777"
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'
    export G1_RC=1                  # G1: BEHIND on first call
    export GH_UPDATE_BRANCH_RC=0    # rebase succeeds
    # After rebase, _pr_branch_up_to_date is still called with G1_RC=1, but
    # the rebase path re-reads pr status from GH_PR_VIEW_JSON (CLEAN -> ok).

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "merged" ]
    [ "$(merge_decision_count)" -eq 1 ]
    gh_merge_was_called
    gh_update_branch_was_called
    [ "$(grep -c '^pr update-branch' "$GH_CALL_LOG")" -eq 1 ]
    ! grep -q -- '--admin' "$GH_CALL_LOG"
    ! grep -q -- '--force' "$GH_CALL_LOG"
}

# ===========================================================================
# T03 — G1 BEHIND, rebase fails -> skip_rebase_failed
# ===========================================================================

@test "T03: PR behind base, rebase fails -> skip_rebase_failed" {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/777"
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'
    export G1_RC=1
    export GH_UPDATE_BRANCH_RC=1
    export REBASE_STDERR="protected branch update not permitted"

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "skip_rebase_failed" ]
    [ "$(merge_decision_count)" -eq 1 ]
    ! gh_merge_was_called
    # reason contains the stderr text
    jq -e 'select(.event=="merge_decision") | select(.decision=="skip_rebase_failed")
           | select(.reason | test("protected branch"))' \
        "$TEST_REQ_DIR/events.jsonl" >/dev/null
    # PR marked ready for human
    [ "$(jq -r '.merge_status' "$TEST_REQ_DIR/state.json")" = "pr_ready_for_human" ]
}

# ===========================================================================
# T04 — G2 serialize: another earlier in-flight PR overlaps in src/foo.ts
# ===========================================================================

@test "T04: overlapping in-flight PR is ahead in queue -> skip_serialized" {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/777"
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'
    # G1 up-to-date
    # G2: override _list_inflight_pr_files and _this_pr_files with overlap.
    # INFLIGHT_FILES format: <req_id>\t<dispatched_at>\t<pr_url>\t<file_path>
    export THIS_PR_FILES="src/foo.ts"
    export INFLIGHT_FILES="REQ-000098	2026-06-30T01:00:00Z	https://github.com/o/r/pull/770	src/foo.ts"

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "skip_serialized" ]
    [ "$(merge_decision_count)" -eq 1 ]
    ! gh_merge_was_called
    jq -e 'select(.event=="merge_decision") | select(.decision=="skip_serialized")
           | select(.reason | test("REQ-000098"))' \
        "$TEST_REQ_DIR/events.jsonl" >/dev/null
    [ "$(jq -r '.merge_status' "$TEST_REQ_DIR/state.json")" = "pr_ready_for_human" ]
}

# ===========================================================================
# T05 — G3 duplicate patches detected -> skip_duplicate
# ===========================================================================

@test "T05: patch-id matches already-merged commit -> skip_duplicate" {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/777"
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'
    # G1 up-to-date, G2 no overlap
    export DUP_RC=0
    export DUP_SHAS="abc1234"

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "skip_duplicate" ]
    [ "$(merge_decision_count)" -eq 1 ]
    ! gh_merge_was_called
    jq -e 'select(.event=="merge_decision") | select(.decision=="skip_duplicate")
           | select(.reason | test("abc1234"))' \
        "$TEST_REQ_DIR/events.jsonl" >/dev/null
    [ "$(jq -r '.merge_status' "$TEST_REQ_DIR/state.json")" = "pr_ready_for_human" ]
}

# ===========================================================================
# T06 — G4 re-verify fails on rebased head -> skip_reverify_failed
# ===========================================================================

@test "T06: re-verify fails after rebase -> skip_reverify_failed" {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/777"
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'
    export G1_RC=1                   # BEHIND -> triggers rebase
    export GH_UPDATE_BRANCH_RC=0     # rebase succeeds
    export REVERIFY_RC=1             # re-verify fails
    export REVERIFY_STATUS="fail"
    export REVERIFY_FEEDBACK="tsc errors (3 errors)"

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "skip_reverify_failed" ]
    [ "$(merge_decision_count)" -eq 1 ]
    ! gh_merge_was_called
    jq -e 'select(.event=="merge_decision") | select(.decision=="skip_reverify_failed")
           | select(.reason | test("tsc"))' \
        "$TEST_REQ_DIR/events.jsonl" >/dev/null
    [ "$(jq -r '.merge_status' "$TEST_REQ_DIR/state.json")" = "pr_ready_for_human" ]
}

# ===========================================================================
# T07 — rebase_attempts cap: pre-set to 2, G1 BEHIND -> skip_rebase_loop_exhausted
# ===========================================================================

@test "T07: rebase_attempts=2 cap reached, G1 BEHIND -> skip_rebase_loop_exhausted" {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    # Pre-set rebase_attempts=2 via extra_meta argument.
    seed_merge_request "https://github.com/o/r/pull/777" '"rebase_attempts": 2'
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'
    export G1_RC=1  # BEHIND

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "skip_rebase_loop_exhausted" ]
    [ "$(merge_decision_count)" -eq 1 ]
    ! gh_merge_was_called
    # gh pr update-branch was NOT called (we bailed before the attempt).
    ! gh_update_branch_was_called
    [ "$(jq -r '.merge_status' "$TEST_REQ_DIR/state.json")" = "pr_ready_for_human" ]
}

# ===========================================================================
# T08 — below L3 (existing behaviour, unchanged)
# ===========================================================================

@test "T08: below L3 trust -> skip_below_l3 (unchanged)" {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":2}}}"
    seed_merge_request "https://github.com/o/r/pull/777"
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "skip_below_l3" ]
    [ "$(merge_decision_count)" -eq 1 ]
    ! gh_merge_was_called
}

# ===========================================================================
# T09 — gh absent (existing behaviour, unchanged)
# ===========================================================================

@test "T09: gh not on PATH -> skip_no_gh (unchanged)" {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/777"
    # Remove MOCK_DIR from PATH so gh is not found.
    local saved_path="$PATH"
    export PATH="${PATH//$MOCK_DIR:/}"

    run run_merge_gate
    export PATH="$saved_path"
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "skip_no_gh" ]
    [ "$(merge_decision_count)" -eq 1 ]
}

# ===========================================================================
# T10 — not mergeable: CONFLICTING (existing behaviour, unchanged)
# ===========================================================================

@test "T10: mergeable=CONFLICTING -> skip_not_mergeable (unchanged)" {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    seed_merge_request "https://github.com/o/r/pull/777"
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"CONFLICTING","mergeStateStatus":"DIRTY"}'

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "skip_not_mergeable" ]
    [ "$(merge_decision_count)" -eq 1 ]
    ! gh_merge_was_called
}

# ===========================================================================
# T11 — hotfix bypasses G2 serialize; G1/G3/G4 still apply -> merged
# ===========================================================================

@test "T11: hotfix type bypasses G2 overlap check -> merged despite other in-flight PR" {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    # type=hotfix in seed_merge_request.
    seed_merge_request "https://github.com/o/r/pull/777" "" "hotfix"
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'
    # Set up an overlapping in-flight PR (same as T04) — but it should be bypassed.
    export THIS_PR_FILES="src/foo.ts"
    export INFLIGHT_FILES="REQ-000098	2026-06-30T01:00:00Z	https://github.com/o/r/pull/770	src/foo.ts"
    # G1 up-to-date, G3 no dup, G4 not triggered (no rebase)

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "merged" ]
    [ "$(merge_decision_count)" -eq 1 ]
    gh_merge_was_called
    ! grep -q -- '--admin' "$GH_CALL_LOG"
    ! grep -q -- '--force' "$GH_CALL_LOG"
}

# ===========================================================================
# T12 — rebase counter is reset to 0 on successful merge
# ===========================================================================

@test "T12: rebase_attempts reset to 0 after successful merge" {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    # Pre-set rebase_attempts=1 (previous tick did a rebase).
    seed_merge_request "https://github.com/o/r/pull/777" '"rebase_attempts": 1'
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'
    # G1 up-to-date (no further rebase).
    # G2 no overlap, G3 no dup.
    # G4 WILL run because rebase_attempts=1 > 0; reverify passes (default REVERIFY_RC=0).

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "merged" ]
    [ "$(merge_decision_count)" -eq 1 ]
    gh_merge_was_called
    # rebase_attempts must be reset to 0 after the merge.
    local post_attempts
    post_attempts=$(jq -r '.current_phase_metadata.rebase_attempts // -1' \
        "$TEST_REQ_DIR/state.json")
    [ "$post_attempts" -eq 0 ]
}

# ===========================================================================
# T24 — REQ-000054 TASK-007: synthetic readiness composes with G1 rebase
#
# Flow (single tick):
#   Gate 0b: initial view BLOCKED -> synthetic readiness runs -> markdown
#            allowlisted -> ok, synthetic_ignored_csv="markdown"
#   G1:      BEHIND -> rebase succeeds -> post-rebase re-read returns CLEAN
#            -> strict post-rebase CLEAN check passes
#   G2:      no overlap
#   G3:      no dup
#   G4:      rebase_attempts=1 -> reverify passes (default REVERIFY_RC=0)
#   Merge:   reason contains "synthetic-readiness, ignored=[markdown]"
#            rebase_attempts reset to 0
# ===========================================================================

@test "T24: synthetic readiness composes with G1 rebase -> merged with synthetic-readiness reason" {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    # Set synthetic-readiness globals directly (load_config is not called here).
    MERGE_GATE_NON_BLOCKING_CHECKS='["markdown"]'
    MERGE_GATE_SKIP_BASELINE_RED='false'
    seed_merge_request "https://github.com/o/r/pull/777"

    # Initial view: BLOCKED + MERGEABLE -> triggers synthetic-readiness gate.
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}'
    # Post-rebase re-read: CLEAN (2nd+ default pr view call returns this).
    export GH_PR_VIEW_JSON_SECOND='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'
    # All checks allowlisted: markdown FAILURE passes synthetic readiness.
    export GH_PR_CHECKS_JSON='[{"name":"markdown","state":"FAILURE","bucket":"fail"},{"name":"test","state":"SUCCESS","bucket":"pass"}]'
    # G1: BEHIND -> triggers rebase.
    export G1_RC=1
    export GH_UPDATE_BRANCH_RC=0
    # G2: no overlap (default INFLIGHT_FILES/THIS_PR_FILES empty).
    # G3: no dup (default DUP_RC=1).
    # G4: will fire (rebase_attempts=1); reverify passes (default REVERIFY_RC=0).

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "merged" ]
    [ "$(merge_decision_count)" -eq 1 ]
    gh_merge_was_called
    ! grep -q -- '--admin' "$GH_CALL_LOG"
    ! grep -q -- '--force' "$GH_CALL_LOG"
    # Reason must reflect synthetic-readiness (not plain CLEAN path).
    jq -e 'select(.event=="merge_decision") | select(.reason | contains("synthetic-readiness, ignored=[markdown]"))' \
        "$TEST_REQ_DIR/events.jsonl" > /dev/null
    # rebase_attempts is reset to 0 after the merge.
    local post_attempts
    post_attempts=$(jq -r '.current_phase_metadata.rebase_attempts // -1' \
        "$TEST_REQ_DIR/state.json")
    [ "$post_attempts" -eq 0 ]
}

# ===========================================================================
# T25 — REQ-000054 TASK-007: synthetic readiness still respects G3 dup-patch gate
#
# Even after synthetic-readiness passes (Gate 0b ok), G3 fires and blocks
# the merge when duplicate patches are detected.  This verifies that the
# synthetic-readiness short-circuit does NOT bypass the downstream G1-G4 gates.
# ===========================================================================

@test "T25: synthetic readiness still respects G3 duplicate-patch gate -> skip_duplicate" {
    write_config "{\"trust\":{\"per_repo_overrides\":{\"$TEST_PROJECT\":3}}}"
    MERGE_GATE_NON_BLOCKING_CHECKS='["markdown"]'
    MERGE_GATE_SKIP_BASELINE_RED='false'
    seed_merge_request "https://github.com/o/r/pull/777"

    # View: BLOCKED + MERGEABLE -> synthetic readiness fires.
    export GH_PR_VIEW_JSON='{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}'
    # All checks allowlisted -> synthetic readiness passes, synthetic_ignored_csv set.
    export GH_PR_CHECKS_JSON='[{"name":"markdown","state":"FAILURE","bucket":"fail"}]'
    # G1: up-to-date (default G1_RC=0).
    # G2: no overlap (default INFLIGHT_FILES/THIS_PR_FILES empty).
    # G3: duplicate work detected -> should still block the merge.
    export DUP_RC=0
    export DUP_SHAS="abc1234"

    run run_merge_gate
    [ "$status" -eq 0 ]
    [ "$(last_merge_decision)" = "skip_duplicate" ]
    [ "$(merge_decision_count)" -eq 1 ]
    ! gh_merge_was_called
    # Reason must reference the duplicate SHA.
    jq -e 'select(.event=="merge_decision") | select(.decision=="skip_duplicate")
           | select(.reason | test("abc1234"))' \
        "$TEST_REQ_DIR/events.jsonl" > /dev/null
    [ "$(jq -r '.merge_status' "$TEST_REQ_DIR/state.json")" = "pr_ready_for_human" ]
}
