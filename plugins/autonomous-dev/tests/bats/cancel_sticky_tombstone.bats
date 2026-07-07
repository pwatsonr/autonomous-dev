#!/usr/bin/env bats
###############################################################################
# cancel_sticky_tombstone.bats — REQ-000059 sticky-cancel regression guard
#
# Verifies that:
#   - is_request_cancelled_tombstoned helper works correctly (T-B-01).
#   - select_request skips tombstoned requests (T-B-02, T-B-03).
#   - restore_interrupted_session does NOT overwrite state.json for tombstoned
#     requests (T-B-04).
#   - restore_interrupted_session deletes lingering gate-decision file (T-B-05).
#   - validate_state_file rebuilds minimal cancelled state on corruption +
#     tombstone (T-B-06).
#
# Harness mirrors select_request_skip_terminal.bats.
###############################################################################

PLUGIN_DIR=""

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"

    export TMPHOME="${BATS_TEST_TMPDIR}/home"
    mkdir -p "${TMPHOME}/.autonomous-dev/logs"
    export HOME="${TMPHOME}"

    REPO="${BATS_TEST_TMPDIR}/repo"
    mkdir -p "${REPO}"

    export EFFECTIVE_CONFIG="${TMPHOME}/effective-config.json"
    jq -n --arg repo "${REPO}" '{repositories:{allowlist:[$repo]}, daemon:{}}' > "${EFFECTIVE_CONFIG}"

    # Source the daemon for function definitions.
    # shellcheck source=../../bin/supervisor-loop.sh
    set +e
    source "${PLUGIN_DIR}/bin/supervisor-loop.sh"
    set -e

    # Gate-decisions directory used by restore_interrupted_session.
    export GATE_DECISIONS_DIR="${TMPHOME}/.autonomous-dev/gate-decisions"
    mkdir -p "${GATE_DECISIONS_DIR}"
}

# Write a minimal-valid state.json.
write_state() {
    local id="$1" status="$2" phase="${3:-prd}" session_active="${4:-false}"
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
  "phase_overrides": ["intake","prd","tdd","plan","spec","code","code_review","integration","deploy","monitor"],
  "current_phase_metadata": {"session_active": ${session_active}},
  "cost_accrued_usd": 0, "turn_count": 0, "escalation_count": 0,
  "schema_version": 1, "error": null
}
EOF
}

# Write a checkpoint.json matching the given state.
write_checkpoint() {
    local id="$1" status="$2" phase="${3:-code_review}"
    local dir="${REPO}/.autonomous-dev/requests/${id}"
    local now; now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    cat > "${dir}/checkpoint.json" <<EOF
{
  "id": "${id}", "status": "${status}", "current_phase": "${phase}",
  "priority": 1, "created_at": "${now}", "updated_at": "${now}",
  "title": "t", "description": "d", "target_repo": "${REPO}",
  "source": "claude_app", "type": "feature",
  "blocked_by": [], "phase_history": [],
  "phase_overrides": ["intake","prd","tdd","plan","spec","code","code_review","integration","deploy","monitor"],
  "current_phase_metadata": {"session_active": true},
  "cost_accrued_usd": 0, "turn_count": 0, "escalation_count": 0,
  "schema_version": 1, "error": null
}
EOF
}

# Place a tombstone in the request directory.
place_tombstone() {
    local id="$1"
    local dir="${REPO}/.autonomous-dev/requests/${id}"
    mkdir -p "${dir}"
    touch "${dir}/cancelled.tombstone"
}

###############################################################################
# T-B-01: is_request_cancelled_tombstoned helper
###############################################################################

@test "T-B-01: is_request_cancelled_tombstoned returns 1 (false) when no tombstone" {
    local req_dir; req_dir=$(mktemp -d)
    run is_request_cancelled_tombstoned "${req_dir}"
    [ "$status" -eq 1 ]
    rm -rf "${req_dir}"
}

@test "T-B-01: is_request_cancelled_tombstoned returns 0 (true) when tombstone exists" {
    local req_dir; req_dir=$(mktemp -d)
    touch "${req_dir}/cancelled.tombstone"
    run is_request_cancelled_tombstoned "${req_dir}"
    [ "$status" -eq 0 ]
    rm -rf "${req_dir}"
}

###############################################################################
# T-B-02: select_request skips tombstoned request even when status=running
###############################################################################

@test "T-B-02: select_request skips tombstoned request with status=running" {
    write_state "REQ-000001" "running"
    place_tombstone "REQ-000001"

    run select_request
    [ "$status" -eq 0 ]
    # Output must not contain REQ-000001.
    [[ "${output}" != *"REQ-000001"* ]]
}

###############################################################################
# T-B-03: select_request picks next queued request when tombstoned is higher priority
###############################################################################

@test "T-B-03: select_request picks queued REQ-000002 when REQ-000001 is tombstoned" {
    write_state "REQ-000001" "running"
    place_tombstone "REQ-000001"

    write_state "REQ-000002" "queued"

    run select_request
    [ "$status" -eq 0 ]
    [[ "${output}" == REQ-000002\|* ]]
}

###############################################################################
# T-B-04: restore_interrupted_session does NOT overwrite state.json when tombstoned
###############################################################################

@test "T-B-04: restore_interrupted_session does not restore from checkpoint when tombstoned" {
    local id="REQ-000001"
    local req_dir="${REPO}/.autonomous-dev/requests/${id}"
    mkdir -p "${req_dir}"

    write_state "${id}" "cancelled" "prd" "true"
    write_checkpoint "${id}" "gate" "code_review"
    place_tombstone "${id}"

    # Call restore_interrupted_session — it should NOT overwrite state.json.
    restore_interrupted_session "${id}" "${req_dir}" "${REPO}"

    # Status must still be "cancelled" (not "gate" from checkpoint).
    local status_after
    status_after=$(jq -r '.status' "${req_dir}/state.json")
    [ "${status_after}" = "cancelled" ]

    # session_active must be false.
    local session_after
    session_after=$(jq -r '.current_phase_metadata.session_active' "${req_dir}/state.json")
    [ "${session_after}" = "false" ]
}

###############################################################################
# T-B-05: restore_interrupted_session deletes lingering gate-decision file
###############################################################################

@test "T-B-05: restore_interrupted_session removes gate-decision file when tombstoned" {
    local id="REQ-000001"
    local req_dir="${REPO}/.autonomous-dev/requests/${id}"
    mkdir -p "${req_dir}"

    write_state "${id}" "cancelled" "prd" "true"
    write_checkpoint "${id}" "gate" "code_review"
    place_tombstone "${id}"

    local repo_basename
    repo_basename=$(basename "${REPO}")
    local gate_file="${GATE_DECISIONS_DIR}/${repo_basename}__${id}.json"
    echo '{"decision":"approved"}' > "${gate_file}"
    [ -f "${gate_file}" ]  # pre-condition

    restore_interrupted_session "${id}" "${req_dir}" "${REPO}"

    # Gate-decision file must be gone.
    [ ! -f "${gate_file}" ]
}

###############################################################################
# T-B-06: validate_state_file rebuilds minimal cancelled state on corruption + tombstone
###############################################################################

@test "T-B-06: validate_state_file rebuilds minimal cancelled state.json when tombstoned and corrupt" {
    local id="REQ-000001"
    local req_dir="${REPO}/.autonomous-dev/requests/${id}"
    mkdir -p "${req_dir}"

    # Write invalid JSON as state.json.
    echo 'not json' > "${req_dir}/state.json"

    # Also write a valid checkpoint that would normally be used for recovery.
    write_checkpoint "${id}" "gate" "code_review"

    # Place tombstone.
    place_tombstone "${id}"

    run validate_state_file "${req_dir}/state.json"
    [ "$status" -eq 0 ]

    # status must be "cancelled" (not "gate" from checkpoint, not "failed").
    local rebuilt_status
    rebuilt_status=$(jq -r '.status' "${req_dir}/state.json")
    [ "${rebuilt_status}" = "cancelled" ]

    # id must be derived from directory basename.
    local rebuilt_id
    rebuilt_id=$(jq -r '.id' "${req_dir}/state.json")
    [ "${rebuilt_id}" = "${id}" ]

    # The minimal shape omits current_phase (should be null/empty).
    local rebuilt_phase
    rebuilt_phase=$(jq -r '.current_phase // "null"' "${req_dir}/state.json")
    [ "${rebuilt_phase}" = "null" ]
}
