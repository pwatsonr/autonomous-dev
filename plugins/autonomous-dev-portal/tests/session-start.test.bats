#!/usr/bin/env bats
###############################################################################
# session-start.test.bats - Bats tests for the SessionStart hook
#                            (SPEC-013-1-04 §`session-start.test.bats`)
#
# Covers hash detection (first run vs cached vs changed), idempotence on
# unchanged input, install-failure rollback semantics, atomic write under
# parallel invocation, missing-env diagnostics, userConfig validation
# (auth_mode tailscale/oauth, allowed_roots), and runtime-check
# propagation.
#
# Tests use stub `bun` scripts on PATH; no real Bun is required.
###############################################################################

load _helpers.bash

setup() {
    portal_test_setup
    HOOK="${CLAUDE_PLUGIN_ROOT}/.claude-plugin/hooks/session-start.sh"
}

teardown() {
    portal_test_teardown
}

# ---------------------------------------------------------------------------
# Compute the expected SHA256 of the fake plugin's package.json.
# Used by tests that pre-seed the hash cache.
# ---------------------------------------------------------------------------
expected_pkg_hash() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "${CLAUDE_PLUGIN_ROOT}/package.json" | awk '{print $1}'
    else
        shasum -a 256 "${CLAUDE_PLUGIN_ROOT}/package.json" | awk '{print $1}'
    fi
}

###############################################################################
# Case 1: first run with no cache invokes bun install and writes hash
###############################################################################
@test "first run with no cache invokes bun install and writes hash" {
    make_bun_stub good
    put_on_path

    run "${HOOK}"
    [ "$status" -eq 0 ]
    [ -f "${CLAUDE_PLUGIN_DATA}/.last-install-hash" ]
    local actual
    actual="$(cat "${CLAUDE_PLUGIN_DATA}/.last-install-hash")"
    [ "${actual}" = "$(expected_pkg_hash)" ]
    [ -f "${CLAUDE_PLUGIN_DATA}/install.log" ]
    grep -q "bun install succeeded" "${CLAUDE_PLUGIN_DATA}/install.log"
}

###############################################################################
# Case 2: second run with unchanged package.json skips bun install
###############################################################################
@test "second run with unchanged package.json skips bun install" {
    make_bun_stub good
    put_on_path

    # Pre-seed the cache with the correct hash so the hook should skip.
    expected_pkg_hash > "${CLAUDE_PLUGIN_DATA}/.last-install-hash"

    run "${HOOK}"
    [ "$status" -eq 0 ]
    # The "running bun install" line must NOT appear in this invocation's
    # log entries (filter to lines without "skipping" to be specific).
    grep -q "skipping bun install" "${CLAUDE_PLUGIN_DATA}/install.log"
    ! grep -q "running bun install" "${CLAUDE_PLUGIN_DATA}/install.log"
}

###############################################################################
# Case 3: package.json change triggers reinstall
###############################################################################
@test "package.json change triggers reinstall" {
    make_bun_stub good
    put_on_path

    # Pre-seed cache with a stale hash.
    echo "stale_hash_value_does_not_match" > "${CLAUDE_PLUGIN_DATA}/.last-install-hash"

    # Replace package.json with the modified fixture.
    cp "${BATS_TEST_DIRNAME}/fixtures/package.json.modified" \
       "${CLAUDE_PLUGIN_ROOT}/package.json"

    run "${HOOK}"
    [ "$status" -eq 0 ]
    local actual
    actual="$(cat "${CLAUDE_PLUGIN_DATA}/.last-install-hash")"
    [ "${actual}" = "$(expected_pkg_hash)" ]
    grep -q "running bun install" "${CLAUDE_PLUGIN_DATA}/install.log"
}

###############################################################################
# Case 4: bun install failure does not update cache
###############################################################################
@test "bun install failure does not update cache" {
    make_bun_stub fail
    put_on_path

    local sentinel="X_PRESERVED_HASH_X"
    echo "${sentinel}" > "${CLAUDE_PLUGIN_DATA}/.last-install-hash"

    run "${HOOK}"
    [ "$status" -eq 1 ]
    grep -q "bun install FAILED" "${CLAUDE_PLUGIN_DATA}/install.log"
    local actual
    actual="$(cat "${CLAUDE_PLUGIN_DATA}/.last-install-hash")"
    [ "${actual}" = "${sentinel}" ]
}

###############################################################################
# Case 5: hash file write is atomic (parallel invocation)
###############################################################################
@test "hash file write is atomic" {
    make_bun_stub good
    put_on_path

    # Run two invocations in parallel; both will compute the same hash and
    # both will write it. The result must be a well-formed single line that
    # exactly equals the expected hash — never a partial/corrupt write.
    "${HOOK}" >/dev/null 2>&1 &
    local pid1=$!
    "${HOOK}" >/dev/null 2>&1 &
    local pid2=$!
    wait "${pid1}" || true
    wait "${pid2}" || true

    [ -f "${CLAUDE_PLUGIN_DATA}/.last-install-hash" ]
    local lines
    lines="$(wc -l < "${CLAUDE_PLUGIN_DATA}/.last-install-hash" | tr -d ' ')"
    [ "${lines}" -eq 1 ]
    local actual
    actual="$(cat "${CLAUDE_PLUGIN_DATA}/.last-install-hash")"
    [ "${actual}" = "$(expected_pkg_hash)" ]
}

###############################################################################
# Case 6: missing CLAUDE_PLUGIN_ROOT or CLAUDE_PLUGIN_DATA exits 2
###############################################################################
@test "missing CLAUDE_PLUGIN_ROOT exits 2" {
    make_bun_stub good
    put_on_path

    local saved="${CLAUDE_PLUGIN_ROOT}"
    unset CLAUDE_PLUGIN_ROOT
    run "${HOOK}"
    export CLAUDE_PLUGIN_ROOT="${saved}"
    [ "$status" -eq 2 ]
    [[ "${output}" == *"CLAUDE_PLUGIN_ROOT"* ]]
}

@test "missing CLAUDE_PLUGIN_DATA exits 2" {
    make_bun_stub good
    put_on_path

    local saved="${CLAUDE_PLUGIN_DATA}"
    unset CLAUDE_PLUGIN_DATA
    run "${HOOK}"
    export CLAUDE_PLUGIN_DATA="${saved}"
    [ "$status" -eq 2 ]
    [[ "${output}" == *"CLAUDE_PLUGIN_DATA"* ]]
}

###############################################################################
# Case 7: auth_mode=tailscale without tailnet rejected
###############################################################################
@test "auth_mode=tailscale without tailnet rejected" {
    make_bun_stub good
    put_on_path

    # Use the per-key env var shape (the JSON-blob shape requires jq and
    # ends up at the same code path).
    export CLAUDE_PLUGIN_USERCONFIG_AUTH_MODE="tailscale"
    export CLAUDE_PLUGIN_USERCONFIG_TAILSCALE_TAILNET=""
    run "${HOOK}"
    unset CLAUDE_PLUGIN_USERCONFIG_AUTH_MODE CLAUDE_PLUGIN_USERCONFIG_TAILSCALE_TAILNET
    [ "$status" -eq 1 ]
    [[ "${output}" == *"tailscale_tailnet"* ]]
}

###############################################################################
# Case 8: auth_mode=oauth without valid provider rejected
###############################################################################
@test "auth_mode=oauth without valid provider rejected" {
    make_bun_stub good
    put_on_path

    export CLAUDE_PLUGIN_USERCONFIG_AUTH_MODE="oauth"
    export CLAUDE_PLUGIN_USERCONFIG_OAUTH_PROVIDER="bogus"
    run "${HOOK}"
    unset CLAUDE_PLUGIN_USERCONFIG_AUTH_MODE CLAUDE_PLUGIN_USERCONFIG_OAUTH_PROVIDER
    [ "$status" -eq 1 ]
    [[ "${output}" == *"oauth_provider"* ]]
}

###############################################################################
# Case 9: non-absolute allowed_root rejected
###############################################################################
@test "non-absolute allowed_root rejected" {
    make_bun_stub good
    put_on_path

    # Use the JSON-blob shape so we can carry an array (jq is a documented
    # required runtime utility for the hook).
    if ! command -v jq >/dev/null 2>&1; then
        skip "jq not available; the hook's array path requires jq"
    fi
    export CLAUDE_PLUGIN_USERCONFIG='{"portal.path_policy.allowed_roots": ["./relative/path"]}'
    run "${HOOK}"
    unset CLAUDE_PLUGIN_USERCONFIG
    [ "$status" -eq 1 ]
    [[ "${output}" == *"allowed_roots"* ]]
}

###############################################################################
# Case 10: runtime check failure (bun missing) propagates as exit 1
###############################################################################
@test "runtime check failure (bun missing) propagates as exit 1" {
    strip_bun_from_path
    run "${HOOK}"
    [ "$status" -eq 1 ]
}
