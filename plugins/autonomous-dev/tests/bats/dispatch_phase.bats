#!/usr/bin/env bats
###############################################################################
# dispatch_phase.bats - Tests for dispatch_phase_session + resolve_phase_budget
#
# bin/supervisor-loop.sh has a `main` guard, so sourcing it is side-effect
# free for the function definitions. It does `set -euo pipefail` at the top,
# so callers must use bats `run` for anything that can return non-zero.
#
# Full end-to-end dispatch integration (mocked `claude`, real state-machine
# round-trip) lands in PR-3 alongside the main-loop call-site swap (TASK-025).
# The corrected `claude` invocation that dispatch_phase_session delegates to
# is covered by tests/bats/test_spawn_session_flags.bats.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    export EFFECTIVE_CONFIG="${BATS_TEST_TMPDIR}/effective-config.json"
    echo '{"daemon": {}}' > "${EFFECTIVE_CONFIG}"
    # shellcheck source=../../bin/supervisor-loop.sh
    source "${PLUGIN_DIR}/bin/supervisor-loop.sh"
    set +e  # the sourced script leaves `set -e` on; bats `run` handles status
}

@test "dispatch_phase_session is defined" {
    run type -t dispatch_phase_session
    [ "$status" -eq 0 ]
    [ "$output" = "function" ]
}

@test "resolve_phase_budget is defined" {
    run type -t resolve_phase_budget
    [ "$status" -eq 0 ]
    [ "$output" = "function" ]
}

@test "resolve_agent is defined" {
    run type -t resolve_agent
    [ "$status" -eq 0 ]
    [ "$output" = "function" ]
}

@test "resolve_phase_budget returns sane defaults when config has no overrides" {
    run resolve_phase_budget code
    [ "$status" -eq 0 ]
    [ "$output" = "10.0" ]

    run resolve_phase_budget prd
    [ "$output" = "5.0" ]

    run resolve_phase_budget prd_review
    [ "$output" = "2.0" ]

    run resolve_phase_budget intake
    [ "$output" = "1.0" ]
}

@test "resolve_phase_budget honors a config override" {
    echo '{"daemon": {"max_budget_usd_by_phase": {"code": 42.0}}}' > "${EFFECTIVE_CONFIG}"
    run resolve_phase_budget code
    [ "$output" = "42.0" ]
}

@test "dispatch_phase_session rejects an invalid request_id (exit 2)" {
    run dispatch_phase_session "not-a-valid-id" "/tmp/nonexistent-project"
    [ "$status" -eq 2 ]
    [[ "$output" == 2\|0\|* ]]
}

@test "dispatch_phase_session returns 1 when state.json is missing" {
    local proj="${BATS_TEST_TMPDIR}/proj-missing-state"
    mkdir -p "${proj}/.autonomous-dev/requests/REQ-000001"
    run dispatch_phase_session "REQ-000001" "${proj}"
    [ "$status" -eq 1 ]
    [[ "$output" == 1\|0\|* ]]
}
