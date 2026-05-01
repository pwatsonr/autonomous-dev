#!/usr/bin/env bats
###############################################################################
# check-runtime.test.bats - Bats tests for bin/check-runtime.sh
#                            (SPEC-013-1-04 §`check-runtime.test.bats`)
#
# Covers the documented exit-code matrix (0/1/2), per-OS install hint
# branching, --quiet/--help flags, and the Node.js fallback notice.
#
# Requires: bats-core 1.x. Tests use stub `bun` scripts on PATH; no real
# Bun binary is required.
###############################################################################

load _helpers.bash

setup() {
    portal_test_setup
    SCRIPT="${CLAUDE_PLUGIN_ROOT}/bin/check-runtime.sh"
}

teardown() {
    portal_test_teardown
}

# ---------------------------------------------------------------------------
# Helper: invoke check-runtime.sh with the bun stub on PATH and a forced
# uname -s. Returns whatever the script returns.
# ---------------------------------------------------------------------------
run_with_uname() {
    local fake_uname="$1"
    shift
    local shim="${PORTAL_BIN_DIR}/uname"
    cat > "${shim}" <<EOF
#!/usr/bin/env bash
case "\$1" in
    -s) echo "${fake_uname}" ;;
    *)  exec /usr/bin/uname "\$@" ;;
esac
EOF
    chmod +x "${shim}"
    put_on_path
    run "${SCRIPT}" "$@"
}

###############################################################################
# Case 1: bun missing exits 1 with macOS install hint
###############################################################################
@test "bun missing exits 1 with macOS install hint" {
    strip_bun_from_path
    run_with_uname "Darwin"
    [ "$status" -eq 1 ]
    [[ "${output}" == *"brew install oven-sh/bun/bun"* ]]
}

###############################################################################
# Case 2: bun missing exits 1 with Linux install hint
###############################################################################
@test "bun missing exits 1 with Linux install hint" {
    strip_bun_from_path
    run_with_uname "Linux"
    [ "$status" -eq 1 ]
    [[ "${output}" == *"curl -fsSL https://bun.sh/install | bash"* ]]
}

###############################################################################
# Case 3: bun missing exits 1 with generic install hint on Windows
###############################################################################
@test "bun missing exits 1 with generic install hint on Windows" {
    strip_bun_from_path
    run_with_uname "MINGW64_NT-10"
    [ "$status" -eq 1 ]
    [[ "${output}" == *"https://bun.sh/docs/installation"* ]]
}

###############################################################################
# Case 4: bun version 0.9.0 exits 2 with outdated hint
###############################################################################
@test "bun version 0.9.0 exits 2 with outdated hint" {
    make_bun_stub old "0.9.0"
    put_on_path
    run "${SCRIPT}"
    [ "$status" -eq 2 ]
    [[ "${output}" == *"0.9.0"* ]]
    [[ "${output}" == *">= 1.0"* ]]
}

###############################################################################
# Case 5: bun version 1.0.0 exits 0
###############################################################################
@test "bun version 1.0.0 exits 0" {
    make_bun_stub good "1.0.0"
    put_on_path
    run "${SCRIPT}"
    [ "$status" -eq 0 ]
}

###############################################################################
# Case 6: bun version 1.1.34 exits 0
###############################################################################
@test "bun version 1.1.34 exits 0" {
    make_bun_stub good "1.1.34"
    put_on_path
    run "${SCRIPT}"
    [ "$status" -eq 0 ]
}

###############################################################################
# Case 7: bun version 1.0.0-beta.5 exits 0 (pre-release stripped)
###############################################################################
@test "bun version 1.0.0-beta.5 exits 0" {
    make_bun_stub prerelease "1.0.0-beta.5"
    put_on_path
    run "${SCRIPT}"
    [ "$status" -eq 0 ]
}

###############################################################################
# Case 8: --quiet flag suppresses success message
###############################################################################
@test "--quiet flag suppresses success message" {
    make_bun_stub good "1.1.34"
    put_on_path
    run "${SCRIPT}" --quiet
    [ "$status" -eq 0 ]
    # `run` merges stdout+stderr into $output; a quiet success must produce
    # no "Bun ... OK" line.
    [[ "${output}" != *"Bun 1.1.34 OK"* ]]
}

###############################################################################
# Case 9: --help exits 0 with usage block
###############################################################################
@test "--help exits 0 with usage block" {
    run "${SCRIPT}" --help
    [ "$status" -eq 0 ]
    [[ "${output}" == *"Usage: check-runtime.sh"* ]]
}

###############################################################################
# Case 10: Node.js fallback notice present in failure output
###############################################################################
@test "Node.js fallback notice present in failure output" {
    strip_bun_from_path
    run_with_uname "Linux"
    [ "$status" -eq 1 ]
    [[ "${output}" == *"Node.js is not currently a supported runtime"* ]]
}
