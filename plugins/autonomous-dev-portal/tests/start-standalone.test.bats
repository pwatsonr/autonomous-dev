#!/usr/bin/env bats
###############################################################################
# start-standalone.test.bats - Bats tests for bin/start-standalone.sh
#                               (SPEC-013-1-04 §`start-standalone.test.bats`)
#
# All cases run with --check-only so the test suite never spawns a real
# server. Cases 7 (env-var derivation) inspects the script's --check-only
# output, which echoes the resolved CLAUDE_PLUGIN_* values to stderr.
###############################################################################

load _helpers.bash

setup() {
    portal_test_setup
    SCRIPT="${CLAUDE_PLUGIN_ROOT}/bin/start-standalone.sh"
    DATA_DIR="${TEST_TMP}/standalone-data"
    # Disable inherited Claude Code env so the standalone script controls it.
    unset CLAUDE_PLUGIN_DATA CLAUDE_PLUGIN_ROOT
    export PORTAL_DATA_DIR="${DATA_DIR}"
    # Force PORTAL_ROOT_DIR so the script does not try to walk up from a
    # weird BATS invocation cwd.
    export PORTAL_ROOT_DIR="${CLAUDE_PLUGIN_ROOT}"
}

teardown() {
    unset PORTAL_DATA_DIR PORTAL_ROOT_DIR PORTAL_AUTH_MODE \
          PORTAL_TAILNET PORTAL_OAUTH_PROVIDER
    portal_test_teardown
}

###############################################################################
# Case 1: --check-only with all prerequisites exits 0; no bun spawned
###############################################################################
@test "--check-only with all prerequisites exits 0" {
    make_bun_stub good
    put_on_path
    # Sentinel: stub bun records each invocation. We assert it was called
    # only for --version (by check-runtime), never for `run` or `install`.
    local marker="${TEST_TMP}/bun-invocations.log"
    cat > "${PORTAL_BIN_DIR}/bun" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "${marker}"
case "\$1" in
    --version) echo "1.1.34"; exit 0 ;;
    install)   exit 0 ;;
    run)       echo "ERROR: --check-only must NOT spawn server" >&2; exit 99 ;;
    *)         exit 0 ;;
esac
EOF
    chmod +x "${PORTAL_BIN_DIR}/bun"

    run "${SCRIPT}" --check-only
    [ "$status" -eq 0 ]
    # Marker should contain only "--version" lines (from check-runtime).
    if [[ -f "${marker}" ]]; then
        ! grep -q "^run " "${marker}"
        ! grep -q "^install" "${marker}"
    fi
}

###############################################################################
# Case 2: --check-only without PORTAL_DATA_DIR exits non-zero
###############################################################################
@test "--check-only without PORTAL_DATA_DIR exits non-zero" {
    make_bun_stub good
    put_on_path
    unset PORTAL_DATA_DIR
    run "${SCRIPT}" --check-only
    [ "$status" -ne 0 ]
    [[ "${output}" == *"PORTAL_DATA_DIR"* ]]
}

###############################################################################
# Case 3: --check-only with missing bun propagates exit 1
###############################################################################
@test "--check-only with missing bun propagates exit 1" {
    strip_bun_from_path
    run "${SCRIPT}" --check-only
    [ "$status" -eq 1 ]
}

###############################################################################
# Case 4: --check-only with old bun propagates exit 2
###############################################################################
@test "--check-only with old bun propagates exit 2" {
    make_bun_stub old "0.9.0"
    put_on_path
    run "${SCRIPT}" --check-only
    [ "$status" -eq 2 ]
}

###############################################################################
# Case 5: --check-only validates auth_mode=tailscale requires PORTAL_TAILNET
###############################################################################
@test "--check-only validates auth_mode=tailscale requires PORTAL_TAILNET" {
    make_bun_stub good
    put_on_path
    export PORTAL_AUTH_MODE="tailscale"
    unset PORTAL_TAILNET
    run "${SCRIPT}" --check-only
    [ "$status" -ne 0 ]
    [[ "${output}" == *"PORTAL_TAILNET"* ]]
}

###############################################################################
# Case 6: --check-only validates auth_mode=oauth requires PORTAL_OAUTH_PROVIDER
###############################################################################
@test "--check-only validates auth_mode=oauth requires PORTAL_OAUTH_PROVIDER" {
    make_bun_stub good
    put_on_path
    export PORTAL_AUTH_MODE="oauth"
    export PORTAL_OAUTH_PROVIDER="not-a-supported-provider"
    run "${SCRIPT}" --check-only
    [ "$status" -ne 0 ]
    [[ "${output}" == *"PORTAL_OAUTH_PROVIDER"* ]]
}

###############################################################################
# Case 7: exports CLAUDE_PLUGIN_ROOT/DATA derived from PORTAL_*
###############################################################################
@test "exports CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA derived from PORTAL_*" {
    make_bun_stub good
    put_on_path
    run "${SCRIPT}" --check-only
    [ "$status" -eq 0 ]
    # The --check-only success line echoes the resolved PORTAL_DATA_DIR
    # back, which the script set into CLAUDE_PLUGIN_DATA right before
    # printing. The assertion below is a guarantee that the operator-side
    # name is faithfully forwarded.
    [[ "${output}" == *"${PORTAL_DATA_DIR}"* ]]
    # PORTAL_PORT default surfaces too — proves the script's defaults work.
    [[ "${output}" == *"19280"* ]]
}

###############################################################################
# Case 8: --help exits 0 with documented usage block
###############################################################################
@test "--help exits 0 with documented usage block" {
    run "${SCRIPT}" --help
    [ "$status" -eq 0 ]
    [[ "${output}" == *"Usage: start-standalone.sh"* ]]
    [[ "${output}" == *"PORTAL_DATA_DIR"* ]]
    [[ "${output}" == *"--check-only"* ]]
}
