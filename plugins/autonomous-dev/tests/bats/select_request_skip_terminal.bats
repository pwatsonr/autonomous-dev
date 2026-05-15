#!/usr/bin/env bats
###############################################################################
# select_request_skip_terminal.bats — B-13 regression guard
#
# A request whose lifecycle status is terminal (done | cancelled | failed) or
# paused MUST NOT be picked up by select_request. Without this, the daemon
# kept re-selecting completed requests and re-dispatching the `monitor` agent
# on them (seen in the Path-C build-out test on 2026-05-13: iters 25/26 of a
# from-source daemon run kept dispatching `monitor` on REQ-000003 after it
# reached `status: done`, wasting ~$1.50 before the daemon was killed).
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"

    export TMPHOME="${BATS_TEST_TMPDIR}/home"
    mkdir -p "${TMPHOME}/.claude" "${TMPHOME}/.autonomous-dev"
    export HOME="${TMPHOME}"

    REPO="${BATS_TEST_TMPDIR}/repo"
    mkdir -p "${REPO}"

    # Effective config: just the test repo on the allowlist.
    export EFFECTIVE_CONFIG="${TMPHOME}/effective-config.json"
    jq -n --arg repo "${REPO}" '{repositories:{allowlist:[$repo]}, daemon:{}}' > "${EFFECTIVE_CONFIG}"

    # Source the daemon for its function defs.
    # shellcheck source=../../bin/supervisor-loop.sh
    source "${PLUGIN_DIR}/bin/supervisor-loop.sh"
    set +e  # daemon leaves `set -e` on
}

# Write a minimal-valid state.json for the test request.
write_state() {
    local id="$1" status="$2" phase="${3:-prd}"
    local dir="${REPO}/.autonomous-dev/requests/${id}"
    mkdir -p "${dir}"
    local now; now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    cat > "${dir}/state.json" <<EOF
{
  "id": "${id}", "status": "${status}", "current_phase": "${phase}",
  "priority": 1, "created_at": "${now}", "updated_at": "${now}",
  "title": "t", "description": "d", "target_repo": "${REPO}",
  "source": "claude_app", "type": "feature",
  "blocked_by": [], "phase_history": [],
  "phase_overrides": ["intake","prd","prd_review","tdd","tdd_review","plan","plan_review","spec","spec_review","code","code_review","integration","deploy","monitor"],
  "current_phase_metadata": {},
  "cost_accrued_usd": 0, "turn_count": 0, "escalation_count": 0,
  "schema_version": 1, "error": null
}
EOF
}

@test "select_request skips a request with status=done (B-13)" {
    write_state "REQ-000001" "done" "monitor"
    run select_request
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "select_request skips status=cancelled" {
    write_state "REQ-000002" "cancelled" "prd"
    run select_request
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "select_request skips status=failed" {
    write_state "REQ-000003" "failed" "code"
    run select_request
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "select_request skips status=paused" {
    write_state "REQ-000004" "paused" "prd"
    run select_request
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "select_request DOES pick up status=queued (sanity)" {
    write_state "REQ-000005" "queued" "intake"
    run select_request
    [ "$status" -eq 0 ]
    [[ "$output" == REQ-000005\|* ]]
}

@test "select_request DOES pick up status=running (sanity)" {
    write_state "REQ-000006" "running" "prd"
    run select_request
    [ "$status" -eq 0 ]
    [[ "$output" == REQ-000006\|* ]]
}

@test "select_request DOES pick up status=gate (sanity)" {
    write_state "REQ-000007" "gate" "prd_review"
    run select_request
    [ "$status" -eq 0 ]
    [[ "$output" == REQ-000007\|* ]]
}

@test "amongst mixed states, picks an actionable one (done is skipped)" {
    write_state "REQ-000010" "done" "monitor"
    write_state "REQ-000011" "running" "prd"
    run select_request
    [ "$status" -eq 0 ]
    [[ "$output" == REQ-000011\|* ]]
}
