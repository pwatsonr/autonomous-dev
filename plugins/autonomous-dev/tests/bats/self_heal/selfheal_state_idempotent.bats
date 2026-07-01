#!/usr/bin/env bats
# TC-004: selfheal_state_set is byte-preserving for unrelated keys
# TC-005: selfheal_state_set is idempotent
# TC-006: selfheal_state_set returns 2 on jq failure (malformed JSON)

PLUGIN_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/../../.." && pwd)"
LIB_DIR="${PLUGIN_DIR}/bin/lib"

setup() {
    source "${LIB_DIR}/self-heal-state.sh"
    TMPDIR_TEST="$(mktemp -d)"
}

teardown() {
    rm -rf "${TMPDIR_TEST}"
}

@test "TC-004: selfheal_state_set preserves unrelated top-level keys" {
    local state_file="${TMPDIR_TEST}/state.json"
    cat > "${state_file}" <<'EOF'
{
  "id": "REQ-000001",
  "status": "running",
  "current_phase": "code",
  "current_phase_metadata": {
    "dispatched_phase": "code"
  }
}
EOF
    # Save a snapshot of everything except the self_heal subtree
    before=$(jq 'del(.current_phase_metadata.self_heal)' "${state_file}")

    selfheal_state_set "${state_file}" "review_loop.X.count" "1"

    after=$(jq 'del(.current_phase_metadata.self_heal)' "${state_file}")

    [ "$before" = "$after" ]
    # The new path should be set
    val=$(jq '.current_phase_metadata.self_heal.review_loop.X.count' "${state_file}")
    [ "$val" = "1" ]
}

@test "TC-005: selfheal_state_set is idempotent — calling twice produces the same result" {
    local state_file="${TMPDIR_TEST}/state.json"
    echo '{"id":"REQ-000001","status":"running","current_phase_metadata":{}}' > "${state_file}"

    selfheal_state_set "${state_file}" "reviewer_timeouts.X" "3"
    checksum1=$(cat "${state_file}")

    selfheal_state_set "${state_file}" "reviewer_timeouts.X" "3"
    checksum2=$(cat "${state_file}")

    [ "$checksum1" = "$checksum2" ]
}

@test "TC-006: selfheal_state_set returns 2 on malformed JSON and leaves no tmp file" {
    local state_file="${TMPDIR_TEST}/state_bad.json"
    echo 'NOT JSON {' > "${state_file}"

    run selfheal_state_set "${state_file}" "review_loop.X.count" "1"
    [ "$status" -eq 2 ]

    # No tmp file should remain
    local tmp_count=0
    local -a tmp_files=()
    shopt -s nullglob
    tmp_files=("${TMPDIR_TEST}"/state_bad.json.tmp.*)
    shopt -u nullglob
    tmp_count="${#tmp_files[@]}"
    [ "$tmp_count" -eq 0 ]
}

@test "TC-006: selfheal_state_get returns empty for missing state file" {
    run selfheal_state_get "/nonexistent/state.json" "some.path"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "selfheal_state_get returns empty for missing path" {
    local state_file="${TMPDIR_TEST}/state.json"
    echo '{"id":"REQ-000001","status":"running","current_phase_metadata":{}}' > "${state_file}"

    run selfheal_state_get "${state_file}" "nonexistent.path"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "selfheal_state_get returns value for existing path" {
    local state_file="${TMPDIR_TEST}/state.json"
    echo '{"id":"REQ-000001","status":"running","current_phase_metadata":{"self_heal":{"review_loop":{"X":{"count":5}}}}}' > "${state_file}"

    val=$(selfheal_state_get "${state_file}" "review_loop.X.count")
    [ "$val" = "5" ]
}
