#!/usr/bin/env bats

# Tests for the PR review-comment loopback (issue #501).
#
# When a request reaches a terminal/awaiting-human state with an OPEN PR and the
# operator leaves NEW review comments, the daemon re-enters it into the `code`
# phase (status=running, current_phase=code) with the comments captured as
# feedback, so the author agent revises + pushes to the same branch.
#
# Covers:
#   - read_pr_comment_payload(): normalizes gh pr view + gh api comments.
#   - pr_comment_new_ids(): set-difference against the seen marker.
#   - maybe_reenter_for_pr_comments():
#       * done + OPEN PR + new comment      -> re-enters into code, marks seen
#       * comments already addressed         -> no re-entry
#       * PR MERGED/CLOSED                   -> never re-enters (safety)
#       * re-entry bound reached             -> no re-entry, exhaustion event
#       * pr_ready_for_human + new comment   -> re-enters (awaiting-human state)
#       * no PR artifact                     -> no-op
#       * gh unreadable                      -> no-op (does NOT clear comments)
#   - reenter_pr_comment_requests(): only scans terminal/awaiting-human requests.
#   - resolve_phase_prompt code phase: emits a "revision pass" prompt that checks
#     out the existing branch and pushes (no new PR, no force-push).
#
# CRITICAL: `gh` is stubbed on PATH. NO real GitHub calls, NO real pushes/merges.

PLUGIN_DIR_PATH=""

setup() {
    PLUGIN_DIR_PATH="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"

    TEST_WORK_DIR="$(mktemp -d)"
    export HOME="$TEST_WORK_DIR"
    mkdir -p "$TEST_WORK_DIR/.autonomous-dev/logs"
    mkdir -p "$TEST_WORK_DIR/.claude"

    # ---- gh stub on PATH --------------------------------------------------
    # Driven by env vars so one stub serves every scenario:
    #   GH_PR_VIEW_JSON : JSON echoed for `gh pr view ... --json ...`
    #   GH_API_JSON     : JSON echoed for `gh api .../comments`
    # Every invocation's argv is appended to GH_CALL_LOG.
    MOCK_DIR="$TEST_WORK_DIR/mock-bin"
    mkdir -p "$MOCK_DIR"
    export GH_CALL_LOG="$TEST_WORK_DIR/gh-calls.log"
    : > "$GH_CALL_LOG"
    cat > "$MOCK_DIR/gh" << 'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_CALL_LOG"
case "$1 $2" in
    "pr view")
        printf '%s' "${GH_PR_VIEW_JSON:-}"
        exit 0
        ;;
    "api"*)
        printf '%s' "${GH_API_JSON:-[]}"
        exit 0
        ;;
    "repo view")
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

    # Source phase-helpers explicitly for resolve_phase_prompt tests (the main
    # script only sources it under the __main__ guard, which is skipped here).
    source "$PLUGIN_DIR_PATH/bin/lib/phase-helpers.sh"

    # The scan/decision functions read these globals.
    MAX_PR_COMMENT_REENTRIES=3
    PR_COMMENT_SCAN_EVERY_N_POLLS=60

    TEST_PROJECT="$TEST_WORK_DIR/test-project"
    TEST_REQUEST_ID="REQ-260618"
    TEST_REQ_DIR="$TEST_PROJECT/.autonomous-dev/requests/$TEST_REQUEST_ID"
    mkdir -p "$TEST_REQ_DIR"

    # EFFECTIVE_CONFIG with this project on the allowlist (for the scanner).
    EFFECTIVE_CONFIG="$TEST_WORK_DIR/effective-config.json"
    cat > "$EFFECTIVE_CONFIG" << EOF
{ "repositories": { "allowlist": ["$TEST_PROJECT"] } }
EOF
}

teardown() {
    rm -rf "$TEST_WORK_DIR"
}

# ---- helpers --------------------------------------------------------------

# Seed a request's state.json + a github_pr artifact.
#   $1 = status (e.g. "done")
#   $2 = merge_status (e.g. "pr_ready_for_human" or "")
#   $3 = PR url (omit to skip phase-result-code.json)
seed_request() {
    local status="${1:-done}"
    local merge_status="${2:-}"
    local pr_url="${3:-}"
    cat > "$TEST_REQ_DIR/state.json" << EOF
{
  "id": "$TEST_REQUEST_ID",
  "status": "$status",
  "current_phase": "monitor",
  "merge_status": "$merge_status",
  "phase_overrides": ["code", "integration", "deploy", "monitor"],
  "current_phase_metadata": {}
}
EOF
    if [[ -n "$pr_url" ]]; then
        cat > "$TEST_REQ_DIR/phase-result-code.json" << EOF
{ "artifacts": [ { "kind": "github_pr", "url": "$pr_url", "title": "t" } ] }
EOF
    fi
}

pr_view_open_with_comment() {
    export GH_PR_VIEW_JSON='{"state":"OPEN","comments":[{"id":111,"body":"please rename the function","author":{"login":"operator"},"createdAt":"2026-06-18T10:00:00Z"}],"reviews":[]}'
    export GH_API_JSON='[]'
}

# ===========================================================================
# read_pr_comment_payload
# ===========================================================================

@test "read_pr_comment_payload: merges issue comments, reviews, and thread comments" {
    export GH_PR_VIEW_JSON='{"state":"OPEN","comments":[{"id":1,"body":"top-level","author":{"login":"alice"},"createdAt":"t1"}],"reviews":[{"id":2,"body":"review body","author":{"login":"bob"},"submittedAt":"t2"}]}'
    export GH_API_JSON='[{"id":3,"body":"inline thread","user":{"login":"carol"},"created_at":"t3"}]'

    run read_pr_comment_payload "$TEST_PROJECT" "$TEST_REQUEST_ID" "https://github.com/o/r/pull/7"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.state')" = "OPEN" ]
    [ "$(echo "$output" | jq -r '.comments | length')" = "3" ]
    [ "$(echo "$output" | jq -r '[.comments[].id] | sort | join(",")')" = "issue:1,review:2,thread:3" ]
}

@test "read_pr_comment_payload: skips empty-body review submissions (bare approve)" {
    export GH_PR_VIEW_JSON='{"state":"OPEN","comments":[],"reviews":[{"id":9,"body":"","author":{"login":"bob"},"submittedAt":"t"}]}'
    export GH_API_JSON='[]'
    run read_pr_comment_payload "$TEST_PROJECT" "$TEST_REQUEST_ID" "https://github.com/o/r/pull/7"
    [ "$(echo "$output" | jq -r '.comments | length')" = "0" ]
}

@test "read_pr_comment_payload: empty when gh pr view returns nothing" {
    export GH_PR_VIEW_JSON=''
    run read_pr_comment_payload "$TEST_PROJECT" "$TEST_REQUEST_ID" "https://github.com/o/r/pull/7"
    [ "$output" = "" ]
}

@test "read_pr_comment_payload: empty url -> empty, no gh call" {
    : > "$GH_CALL_LOG"
    run read_pr_comment_payload "$TEST_PROJECT" "$TEST_REQUEST_ID" ""
    [ "$output" = "" ]
    [ ! -s "$GH_CALL_LOG" ]
}

# ===========================================================================
# pr_comment_new_ids
# ===========================================================================

@test "pr_comment_new_ids: all new when no seen file" {
    local payload='{"state":"OPEN","comments":[{"id":"issue:1"},{"id":"issue:2"}]}'
    run pr_comment_new_ids "$payload" "$TEST_REQ_DIR/nope.json"
    [ "$(echo "$output" | sort | tr '\n' ',')" = "issue:1,issue:2," ]
}

@test "pr_comment_new_ids: excludes already-addressed ids" {
    echo '{"addressed_ids":["issue:1"]}' > "$TEST_REQ_DIR/seen.json"
    local payload='{"state":"OPEN","comments":[{"id":"issue:1"},{"id":"issue:2"}]}'
    run pr_comment_new_ids "$payload" "$TEST_REQ_DIR/seen.json"
    [ "$output" = "issue:2" ]
}

@test "pr_comment_new_ids: empty when all addressed" {
    echo '{"addressed_ids":["issue:1","issue:2"]}' > "$TEST_REQ_DIR/seen.json"
    local payload='{"state":"OPEN","comments":[{"id":"issue:1"},{"id":"issue:2"}]}'
    run pr_comment_new_ids "$payload" "$TEST_REQ_DIR/seen.json"
    [ -z "$output" ]
}

# ===========================================================================
# maybe_reenter_for_pr_comments — happy path
# ===========================================================================

@test "maybe_reenter: done + OPEN PR + new comment -> re-enters code phase, records feedback" {
    seed_request "done" "pr_ready_for_human" "https://github.com/o/r/pull/7"
    pr_view_open_with_comment

    maybe_reenter_for_pr_comments "$TEST_REQUEST_ID" "$TEST_PROJECT" "$TEST_REQ_DIR/state.json"

    # Flipped back to running/code.
    [ "$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")" = "code" ]
    [ "$(jq -r '.status' "$TEST_REQ_DIR/state.json")" = "running" ]
    # Awaiting-human markers cleared.
    [ "$(jq -r '.pr_ready_for_human' "$TEST_REQ_DIR/state.json")" = "false" ]
    [ "$(jq -r '.merge_status' "$TEST_REQ_DIR/state.json")" = "pr_comment_revision" ]
    # Feedback captured for the code agent.
    [[ "$(jq -r '.current_phase_metadata.pr_comment_feedback' "$TEST_REQ_DIR/state.json")" == *"rename the function"* ]]
    [ "$(jq -r '.current_phase_metadata.pr_comment_url' "$TEST_REQ_DIR/state.json")" = "https://github.com/o/r/pull/7" ]
    # Seen marker bumped: comment recorded as addressed, reentries=1.
    [ "$(jq -r '.reentries' "$TEST_REQ_DIR/pr-comment-seen.json")" = "1" ]
    [ "$(jq -r '.addressed_ids | index("issue:111") != null' "$TEST_REQ_DIR/pr-comment-seen.json")" = "true" ]
    # Audit event emitted.
    jq -e 'select(.event=="pr_comment_reentry") | select(.new_comments==1 and .reentry==1)' "$TEST_REQ_DIR/events.jsonl" >/dev/null
}

@test "maybe_reenter: second call with SAME comment does NOT re-enter (idempotent)" {
    seed_request "done" "pr_ready_for_human" "https://github.com/o/r/pull/7"
    pr_view_open_with_comment

    maybe_reenter_for_pr_comments "$TEST_REQUEST_ID" "$TEST_PROJECT" "$TEST_REQ_DIR/state.json"
    [ "$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")" = "code" ]

    # Simulate the request having gone terminal again (work done), same comment.
    jq '.status="done" | .current_phase="monitor"' "$TEST_REQ_DIR/state.json" > "$TEST_REQ_DIR/state.json.tmp"
    mv "$TEST_REQ_DIR/state.json.tmp" "$TEST_REQ_DIR/state.json"

    maybe_reenter_for_pr_comments "$TEST_REQUEST_ID" "$TEST_PROJECT" "$TEST_REQ_DIR/state.json"
    # No second re-entry: still done, reentries stays 1.
    [ "$(jq -r '.status' "$TEST_REQ_DIR/state.json")" = "done" ]
    [ "$(jq -r '.reentries' "$TEST_REQ_DIR/pr-comment-seen.json")" = "1" ]
    # Exactly one re-entry event ever (events are multi-line JSON; count via jq).
    [ "$(jq -s 'map(select(.event=="pr_comment_reentry")) | length' "$TEST_REQ_DIR/events.jsonl")" -eq 1 ]
}

@test "maybe_reenter: a genuinely NEW comment after the first pass triggers a 2nd re-entry" {
    seed_request "done" "pr_ready_for_human" "https://github.com/o/r/pull/7"
    pr_view_open_with_comment
    maybe_reenter_for_pr_comments "$TEST_REQUEST_ID" "$TEST_PROJECT" "$TEST_REQ_DIR/state.json"

    jq '.status="done"' "$TEST_REQ_DIR/state.json" > "$TEST_REQ_DIR/state.json.tmp"
    mv "$TEST_REQ_DIR/state.json.tmp" "$TEST_REQ_DIR/state.json"

    # A brand-new comment id appears.
    export GH_PR_VIEW_JSON='{"state":"OPEN","comments":[{"id":111,"body":"old","author":{"login":"op"},"createdAt":"t1"},{"id":222,"body":"also fix the tests","author":{"login":"op"},"createdAt":"t2"}],"reviews":[]}'

    maybe_reenter_for_pr_comments "$TEST_REQUEST_ID" "$TEST_PROJECT" "$TEST_REQ_DIR/state.json"
    [ "$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")" = "code" ]
    [ "$(jq -r '.reentries' "$TEST_REQ_DIR/pr-comment-seen.json")" = "2" ]
    [[ "$(jq -r '.current_phase_metadata.pr_comment_feedback' "$TEST_REQ_DIR/state.json")" == *"fix the tests"* ]]
}

# ===========================================================================
# Safety: closed/merged PRs
# ===========================================================================

@test "maybe_reenter: MERGED PR never re-enters (safety)" {
    seed_request "done" "merged" "https://github.com/o/r/pull/7"
    export GH_PR_VIEW_JSON='{"state":"MERGED","comments":[{"id":111,"body":"late comment","author":{"login":"op"},"createdAt":"t"}],"reviews":[]}'
    export GH_API_JSON='[]'

    maybe_reenter_for_pr_comments "$TEST_REQUEST_ID" "$TEST_PROJECT" "$TEST_REQ_DIR/state.json"
    [ "$(jq -r '.status' "$TEST_REQ_DIR/state.json")" = "done" ]
    [ "$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")" = "monitor" ]
    [ ! -f "$TEST_REQ_DIR/events.jsonl" ] || ! grep -q 'pr_comment_reentry' "$TEST_REQ_DIR/events.jsonl"
}

@test "maybe_reenter: CLOSED PR never re-enters (safety)" {
    seed_request "done" "" "https://github.com/o/r/pull/7"
    export GH_PR_VIEW_JSON='{"state":"CLOSED","comments":[{"id":111,"body":"x","author":{"login":"op"},"createdAt":"t"}],"reviews":[]}'
    maybe_reenter_for_pr_comments "$TEST_REQUEST_ID" "$TEST_PROJECT" "$TEST_REQ_DIR/state.json"
    [ "$(jq -r '.status' "$TEST_REQ_DIR/state.json")" = "done" ]
}

# ===========================================================================
# Loop bounding
# ===========================================================================

@test "maybe_reenter: re-entry bound reached -> no re-entry, exhaustion event" {
    MAX_PR_COMMENT_REENTRIES=2
    seed_request "done" "pr_ready_for_human" "https://github.com/o/r/pull/7"
    # Seen marker already at the cap, with the current comment NOT yet addressed.
    echo '{"addressed_ids":["issue:old"],"reentries":2}' > "$TEST_REQ_DIR/pr-comment-seen.json"
    pr_view_open_with_comment

    maybe_reenter_for_pr_comments "$TEST_REQUEST_ID" "$TEST_PROJECT" "$TEST_REQ_DIR/state.json"

    # No re-entry (still terminal); reentries unchanged.
    [ "$(jq -r '.status' "$TEST_REQ_DIR/state.json")" = "done" ]
    [ "$(jq -r '.reentries' "$TEST_REQ_DIR/pr-comment-seen.json")" = "2" ]
    # Exhaustion event recorded, and the now-seen comment is marked addressed so
    # we don't re-log every scan.
    jq -e 'select(.event=="pr_comment_loop_exhausted") | select(.max_reentries==2)' "$TEST_REQ_DIR/events.jsonl" >/dev/null
    [ "$(jq -r '.addressed_ids | index("issue:111") != null' "$TEST_REQ_DIR/pr-comment-seen.json")" = "true" ]
}

@test "maybe_reenter: exhaustion event logged only once across repeated scans" {
    MAX_PR_COMMENT_REENTRIES=1
    seed_request "done" "pr_ready_for_human" "https://github.com/o/r/pull/7"
    echo '{"addressed_ids":[],"reentries":1}' > "$TEST_REQ_DIR/pr-comment-seen.json"
    pr_view_open_with_comment

    maybe_reenter_for_pr_comments "$TEST_REQUEST_ID" "$TEST_PROJECT" "$TEST_REQ_DIR/state.json"
    maybe_reenter_for_pr_comments "$TEST_REQUEST_ID" "$TEST_PROJECT" "$TEST_REQ_DIR/state.json"

    [ "$(jq -s 'map(select(.event=="pr_comment_loop_exhausted")) | length' "$TEST_REQ_DIR/events.jsonl")" -eq 1 ]
}

# ===========================================================================
# awaiting-human (not done) eligibility + no-PR / unreadable
# ===========================================================================

@test "maybe_reenter: no PR artifact -> no-op" {
    seed_request "done" "pr_ready_for_human"   # no PR url
    pr_view_open_with_comment
    maybe_reenter_for_pr_comments "$TEST_REQUEST_ID" "$TEST_PROJECT" "$TEST_REQ_DIR/state.json"
    [ "$(jq -r '.status' "$TEST_REQ_DIR/state.json")" = "done" ]
}

@test "maybe_reenter: pipeline without a code phase -> no-op (cannot re-enter safely)" {
    # Doc-only request: PR exists but phase_overrides has no "code" phase.
    cat > "$TEST_REQ_DIR/state.json" << EOF
{
  "id": "$TEST_REQUEST_ID",
  "status": "done",
  "current_phase": "prd_review",
  "merge_status": "pr_ready_for_human",
  "phase_overrides": ["prd", "prd_review"],
  "current_phase_metadata": {}
}
EOF
    cat > "$TEST_REQ_DIR/phase-result-code.json" << EOF
{ "artifacts": [ { "kind": "github_pr", "url": "https://github.com/o/r/pull/7" } ] }
EOF
    pr_view_open_with_comment
    maybe_reenter_for_pr_comments "$TEST_REQUEST_ID" "$TEST_PROJECT" "$TEST_REQ_DIR/state.json"
    [ "$(jq -r '.status' "$TEST_REQ_DIR/state.json")" = "done" ]
    [ "$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")" = "prd_review" ]
}

@test "maybe_reenter: gh unreadable -> no-op, comments NOT marked addressed" {
    seed_request "done" "pr_ready_for_human" "https://github.com/o/r/pull/7"
    export GH_PR_VIEW_JSON=''   # gh returns nothing
    maybe_reenter_for_pr_comments "$TEST_REQUEST_ID" "$TEST_PROJECT" "$TEST_REQ_DIR/state.json"
    [ "$(jq -r '.status' "$TEST_REQ_DIR/state.json")" = "done" ]
    [ ! -f "$TEST_REQ_DIR/pr-comment-seen.json" ]
}

# ===========================================================================
# reenter_pr_comment_requests — scanner gating
# ===========================================================================

@test "scanner: re-enters a done request with new comments" {
    seed_request "done" "pr_ready_for_human" "https://github.com/o/r/pull/7"
    pr_view_open_with_comment
    reenter_pr_comment_requests
    [ "$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")" = "code" ]
    [ "$(jq -r '.status' "$TEST_REQ_DIR/state.json")" = "running" ]
}

@test "scanner: re-enters a pr_ready_for_human (non-done) request" {
    seed_request "running" "pr_ready_for_human" "https://github.com/o/r/pull/7"
    pr_view_open_with_comment
    reenter_pr_comment_requests
    [ "$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")" = "code" ]
}

@test "scanner: SKIPS an actively-running request that is not awaiting human" {
    # running + no awaiting-human marker -> the normal pipeline owns it.
    seed_request "running" "" "https://github.com/o/r/pull/7"
    pr_view_open_with_comment
    reenter_pr_comment_requests
    # Untouched: still on its original phase, not flipped to code by us.
    [ "$(jq -r '.current_phase' "$TEST_REQ_DIR/state.json")" = "monitor" ]
}

@test "scanner: SKIPS a gated request" {
    seed_request "gate" "" "https://github.com/o/r/pull/7"
    pr_view_open_with_comment
    reenter_pr_comment_requests
    [ "$(jq -r '.status' "$TEST_REQ_DIR/state.json")" = "gate" ]
}

# ===========================================================================
# resolve_phase_prompt — revision-pass code prompt
# ===========================================================================

@test "resolve_phase_prompt code: revision pass checks out existing branch, pushes, no new PR, no force" {
    seed_request "running" "pr_comment_revision" "https://github.com/o/r/pull/7"
    jq --arg fb "- @operator: rename the function" --arg url "https://github.com/o/r/pull/7" \
       '.current_phase="code" |
        .current_phase_metadata.pr_comment_feedback=$fb |
        .current_phase_metadata.pr_comment_url=$url' \
       "$TEST_REQ_DIR/state.json" > "$TEST_REQ_DIR/state.json.tmp"
    mv "$TEST_REQ_DIR/state.json.tmp" "$TEST_REQ_DIR/state.json"

    run resolve_phase_prompt "code" "$TEST_REQUEST_ID" "$TEST_PROJECT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Address PR Review Comments"* ]]
    [[ "$output" == *"rename the function"* ]]
    [[ "$output" == *"git checkout 'autonomous/$TEST_REQUEST_ID'"* ]]
    [[ "$output" == *"git push origin 'autonomous/$TEST_REQUEST_ID'"* ]]
    # Must NOT instruct opening a new PR.
    [[ "$output" != *"gh pr create"* ]]
    # The push command must be a plain push (no --force / --force-with-lease ON
    # the git push line). The prompt may *mention* --force in a prohibition, so
    # assert on the actual push instruction rather than the bare substring.
    ! grep -qE "git push[^\\n]*--force" <<< "$output"
}

@test "resolve_phase_prompt code: first pass (no pr_comment_feedback) still creates a PR" {
    seed_request "running" "" "https://github.com/o/r/pull/7"
    jq '.current_phase="code"' "$TEST_REQ_DIR/state.json" > "$TEST_REQ_DIR/state.json.tmp"
    mv "$TEST_REQ_DIR/state.json.tmp" "$TEST_REQ_DIR/state.json"

    run resolve_phase_prompt "code" "$TEST_REQUEST_ID" "$TEST_PROJECT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"gh pr create"* ]]
    [[ "$output" != *"Address PR Review Comments"* ]]
}
