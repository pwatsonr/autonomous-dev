#!/usr/bin/env bats
###############################################################################
# scope_context_wiring.bats — ONBOARD #597 / #598 run-path wiring
#
# Verifies the supervisor's scoped-context helpers:
#   - resolve_scope_context echoes the helper JSON only when scoped=true
#     and stays silent (fallback) when bun is absent, output is invalid,
#     or scoped=false;
#   - build_scope_prompt_appendix renders memory + skill paths, and is
#     empty when there is nothing to surface.
#
# The TS helper is stubbed via a fake `bun` on PATH so these tests exercise
# the bash plumbing in isolation (no node/bun/registry dependency).
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    # shellcheck source=../../bin/supervisor-loop.sh
    source "${PLUGIN_DIR}/bin/supervisor-loop.sh"

    FAKE_BIN="${BATS_TEST_TMPDIR}/bin"
    mkdir -p "${FAKE_BIN}"
}

# Install a fake `bun` whose stdout is the given JSON, and put it first on PATH.
_install_fake_bun() {
    local json="$1"
    cat > "${FAKE_BIN}/bun" <<EOF
#!/usr/bin/env bash
cat <<'JSON'
${json}
JSON
EOF
    chmod +x "${FAKE_BIN}/bun"
    PATH="${FAKE_BIN}:${PATH}"
}

@test "resolve_scope_context emits JSON when the helper reports scoped=true" {
    _install_fake_bun '{"scoped":true,"repoId":"acme/api","projectId":"acme","agent":"code-executor-acme","memoryPaths":["/m/standards.md"],"skillPaths":["/s/x.md"],"addDirs":["/m","/s"]}'
    run resolve_scope_context "/work/api" "code" "code-executor"
    [ "${status}" -eq 0 ]
    echo "${output}" | jq -e '.scoped == true' >/dev/null
    echo "${output}" | jq -e '.agent == "code-executor-acme"' >/dev/null
}

@test "resolve_scope_context is silent (fallback) when scoped=false" {
    _install_fake_bun '{"scoped":false,"agent":"code-executor","memoryPaths":[],"skillPaths":[],"addDirs":[]}'
    run resolve_scope_context "/work/api" "code" "code-executor"
    [ "${status}" -eq 0 ]
    [ -z "${output}" ]
}

@test "resolve_scope_context is silent when the helper emits non-JSON" {
    _install_fake_bun 'not json at all'
    run resolve_scope_context "/work/api" "code" "code-executor"
    [ "${status}" -eq 0 ]
    [ -z "${output}" ]
}

@test "resolve_scope_context is silent when bun is not on PATH" {
    # System coreutils only (rm/bash for bats), deliberately excluding the
    # homebrew dir that holds bun — so `command -v bun` fails and the helper
    # returns early before it ever needs bun/jq.
    PATH="/usr/bin:/bin"
    run resolve_scope_context "/work/api" "code" "code-executor"
    [ "${status}" -eq 0 ]
    [ -z "${output}" ]
}

@test "build_scope_prompt_appendix renders memory and skill paths" {
    local json='{"scoped":true,"memoryPaths":["/m/standards.md","/m/repo/conv.md"],"skillPaths":["/s/dup.md"]}'
    run build_scope_prompt_appendix "${json}"
    [ "${status}" -eq 0 ]
    [[ "${output}" == *"Scoped memory"* ]]
    [[ "${output}" == *"/m/standards.md"* ]]
    [[ "${output}" == *"/m/repo/conv.md"* ]]
    [[ "${output}" == *"Promoted skills"* ]]
    [[ "${output}" == *"/s/dup.md"* ]]
}

@test "build_scope_prompt_appendix is empty when there is nothing to surface" {
    local json='{"scoped":true,"memoryPaths":[],"skillPaths":[]}'
    run build_scope_prompt_appendix "${json}"
    [ "${status}" -eq 0 ]
    [ -z "${output}" ]
}
