#!/usr/bin/env bash
# shellcheck shell=bash
###############################################################################
# _helpers.bash - Common bats helpers for autonomous-dev-portal tests
#                 (SPEC-013-1-04)
#
# Source this from `setup()` in each *.test.bats file. Provides:
#   - portal_test_setup    create a sandbox CLAUDE_PLUGIN_ROOT/DATA tree
#                          with the plugin's hooks/bin copied in, plus
#                          a fixtures/package.json
#   - portal_test_teardown remove the sandbox
#   - make_bun_stub        write a bun stub script that prints the given
#                          version and behaves per the named profile
#   - put_on_path          prepend a directory to PATH for the test
###############################################################################

PORTAL_ROOT_REPO="${BATS_TEST_DIRNAME}/.."

# ---------------------------------------------------------------------------
# portal_test_setup() -> void
#   Create CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA inside a fresh tmp
#   dir; copy the plugin's hooks/bin and the fixtures/package.json.
# ---------------------------------------------------------------------------
portal_test_setup() {
    TEST_TMP="$(mktemp -d)"
    export CLAUDE_PLUGIN_ROOT="${TEST_TMP}/root"
    export CLAUDE_PLUGIN_DATA="${TEST_TMP}/data"
    mkdir -p "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/hooks" \
             "${CLAUDE_PLUGIN_ROOT}/bin" \
             "${CLAUDE_PLUGIN_DATA}"

    # Copy hooks (executable bit preserved).
    cp "${PORTAL_ROOT_REPO}/.claude-plugin/hooks/session-start.sh" \
       "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/hooks/session-start.sh"
    chmod 0755 "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/hooks/session-start.sh"

    # Copy bin scripts.
    cp "${PORTAL_ROOT_REPO}/bin/check-runtime.sh" \
       "${CLAUDE_PLUGIN_ROOT}/bin/check-runtime.sh"
    chmod 0755 "${CLAUDE_PLUGIN_ROOT}/bin/check-runtime.sh"

    cp "${PORTAL_ROOT_REPO}/bin/start-standalone.sh" \
       "${CLAUDE_PLUGIN_ROOT}/bin/start-standalone.sh"
    chmod 0755 "${CLAUDE_PLUGIN_ROOT}/bin/start-standalone.sh"

    # Drop a minimal package.json fixture in the fake plugin root so
    # session-start.sh can hash it.
    if [[ -f "${BATS_TEST_DIRNAME}/fixtures/package.json" ]]; then
        cp "${BATS_TEST_DIRNAME}/fixtures/package.json" \
           "${CLAUDE_PLUGIN_ROOT}/package.json"
    fi

    # Sandbox PATH so we control which `bun` is on it. Save the original
    # so subtests can restore.
    PORTAL_ORIG_PATH="${PATH}"
    PORTAL_BIN_DIR="${TEST_TMP}/bin"
    mkdir -p "${PORTAL_BIN_DIR}"
}

# ---------------------------------------------------------------------------
# portal_test_teardown() -> void
# ---------------------------------------------------------------------------
portal_test_teardown() {
    if [[ -n "${TEST_TMP:-}" && -d "${TEST_TMP}" ]]; then
        rm -rf "${TEST_TMP}"
    fi
    if [[ -n "${PORTAL_ORIG_PATH:-}" ]]; then
        export PATH="${PORTAL_ORIG_PATH}"
    fi
}

# ---------------------------------------------------------------------------
# make_bun_stub(profile, [version]) -> void
#   Write a bun stub at $PORTAL_BIN_DIR/bun. Profiles:
#     good       -> `bun --version` prints version (default 1.1.34);
#                   `bun install` exits 0 and prints "stub install OK"
#     old        -> version 0.9.0 (default); install behaves like good
#     fail       -> install exits 1; version is good
#     prerelease -> version 1.0.0-beta.5; install OK
# ---------------------------------------------------------------------------
make_bun_stub() {
    local profile="$1"
    local version="${2:-}"
    local install_exit="0"
    local install_msg="stub install OK"
    case "${profile}" in
        good)       version="${version:-1.1.34}"; install_exit=0 ;;
        old)        version="${version:-0.9.0}";  install_exit=0 ;;
        fail)       version="${version:-1.1.34}"; install_exit=1; install_msg="stub install FAILED" ;;
        prerelease) version="${version:-1.0.0-beta.5}"; install_exit=0 ;;
        *) echo "make_bun_stub: unknown profile '${profile}'" >&2; return 1 ;;
    esac

    cat > "${PORTAL_BIN_DIR}/bun" <<EOF
#!/usr/bin/env bash
case "\$1" in
    --version) echo "${version}"; exit 0 ;;
    install)   echo "${install_msg}"; exit ${install_exit} ;;
    *)         echo "stub bun: unhandled \$*" >&2; exit 0 ;;
esac
EOF
    chmod +x "${PORTAL_BIN_DIR}/bun"
}

# ---------------------------------------------------------------------------
# put_on_path() -> void
#   Prepend $PORTAL_BIN_DIR to PATH so the bun stub takes precedence.
# ---------------------------------------------------------------------------
put_on_path() {
    export PATH="${PORTAL_BIN_DIR}:${PATH}"
}

# ---------------------------------------------------------------------------
# strip_bun_from_path() -> void
#   Build a new PATH containing only directories that do NOT have a `bun`
#   binary. Use to simulate Bun-missing scenarios.
# ---------------------------------------------------------------------------
strip_bun_from_path() {
    local new_path=""
    local IFS=":"
    for dir in ${PATH}; do
        [[ -z "${dir}" ]] && continue
        if [[ ! -x "${dir}/bun" ]]; then
            if [[ -z "${new_path}" ]]; then
                new_path="${dir}"
            else
                new_path="${new_path}:${dir}"
            fi
        fi
    done
    export PATH="${new_path}"
}
