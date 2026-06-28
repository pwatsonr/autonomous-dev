#!/usr/bin/env bats
###############################################################################
# emit_pre_author_hook.bats - best-effort pre-author hook emission (#561/#568)
#
# Covers emit_pre_author_hook(): the supervisor-loop helper that fires the
# plan-pre-author / spec-pre-author hook points via bin/hooks-emit.ts.
#
# What is exercised here:
#   - plan / spec phases shell out to the (mocked) bun CLI with the correct
#     hook point, ONLY when at least one */hooks.json exists (cheapness guard).
#   - the CHEAPNESS GUARD: with NO hooks.json under the plugins root, the bun
#     subprocess is skipped entirely (no sentinel).
#   - NON-FATAL: a CLI that exits non-zero must NOT fail the helper (`|| true`).
#   - non plan/spec phases are a no-op (no subprocess).
#
# The plugins root is redirected via AUTONOMOUS_DEV_PLUGINS_ROOT so the test
# never touches the real ~/.claude/plugins. `bun` is shimmed so hooks-emit.ts
# is never really executed.
#
# bin/supervisor-loop.sh has a `main` guard, so sourcing it is side-effect free
# for the function definitions; it leaves `set -e` on, so callers use `set +e`.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    export EFFECTIVE_CONFIG="${BATS_TEST_TMPDIR}/effective-config.json"
    echo '{"daemon": {}}' > "${EFFECTIVE_CONFIG}"

    mkdir -p "${HOME}/.autonomous-dev/logs"

    # shellcheck source=../../bin/supervisor-loop.sh
    source "${PLUGIN_DIR}/bin/supervisor-loop.sh"
    set +e  # the sourced script leaves `set -e` on; bats `run` handles status

    # Redirect the plugins root the cheapness guard + CLI scan so we never
    # touch the real ~/.claude/plugins.
    export AUTONOMOUS_DEV_PLUGINS_ROOT="${BATS_TEST_TMPDIR}/plugins"
    mkdir -p "${AUTONOMOUS_DEV_PLUGINS_ROOT}"

    # ── Mock `bun` so hooks-emit.ts is never really executed. ──
    # The shim records its argv (sentinel) and exits per MOCK_BUN_MODE.
    MOCK_BIN="${BATS_TEST_TMPDIR}/mockbin"
    mkdir -p "${MOCK_BIN}"
    export MOCK_BUN_SENTINEL="${BATS_TEST_TMPDIR}/bun-argv"
    cat > "${MOCK_BIN}/bun" <<'SHIM'
#!/usr/bin/env bash
# Record the full argv so the test can assert the hook point + flags.
[[ -n "${MOCK_BUN_SENTINEL:-}" ]] && printf '%s\n' "$*" > "${MOCK_BUN_SENTINEL}"
case "${MOCK_BUN_MODE:-ok}" in
  ok)
    echo '{"point":"plan-pre-author","ran":0,"aborted":false,"failures":0}'
    exit 0 ;;
  nonzero)
    echo 'boom: simulated CLI failure' >&2
    exit 1 ;;
esac
SHIM
    chmod +x "${MOCK_BIN}/bun"
    export PATH="${MOCK_BIN}:${PATH}"

    PROJ="${BATS_TEST_TMPDIR}/proj"
    mkdir -p "${PROJ}"
}

# Helper: drop a minimal plugin manifest so the cheapness guard passes.
_make_hooks_json() {
    mkdir -p "${AUTONOMOUS_DEV_PLUGINS_ROOT}/example-plugin"
    echo '{"id":"example-plugin","name":"x","version":"1.0.0","hooks":[]}' \
        > "${AUTONOMOUS_DEV_PLUGINS_ROOT}/example-plugin/hooks.json"
}

# ── Function is defined ──────────────────────────────────────────────────────

@test "emit_pre_author_hook is defined" {
    run type -t emit_pre_author_hook
    [ "$status" -eq 0 ]
    [ "$output" = "function" ]
}

# ── Cheapness guard: no hooks.json -> NO subprocess ──────────────────────────

@test "emit_pre_author_hook: SKIPPED when no hooks.json exists (cheapness guard)" {
    # No manifest staged -> guard short-circuits before spawning bun.
    run emit_pre_author_hook "REQ-000001" "${PROJ}" "plan"
    [ "$status" -eq 0 ]
    [ ! -f "${MOCK_BUN_SENTINEL}" ]
}

# ── plan / spec phases invoke the CLI with the right hook point ──────────────

@test "emit_pre_author_hook: plan phase -> emits plan-pre-author" {
    _make_hooks_json
    run emit_pre_author_hook "REQ-000001" "${PROJ}" "plan"
    [ "$status" -eq 0 ]
    [ -f "${MOCK_BUN_SENTINEL}" ]
    grep -q "emit plan-pre-author" "${MOCK_BUN_SENTINEL}"
    grep -q -- "--request-id REQ-000001" "${MOCK_BUN_SENTINEL}"
    grep -q -- "--phase plan" "${MOCK_BUN_SENTINEL}"
}

@test "emit_pre_author_hook: spec phase -> emits spec-pre-author" {
    _make_hooks_json
    run emit_pre_author_hook "REQ-000002" "${PROJ}" "spec"
    [ "$status" -eq 0 ]
    [ -f "${MOCK_BUN_SENTINEL}" ]
    grep -q "emit spec-pre-author" "${MOCK_BUN_SENTINEL}"
    grep -q -- "--phase spec" "${MOCK_BUN_SENTINEL}"
}

# ── Non-fatal: CLI non-zero must NOT fail the helper ─────────────────────────

@test "emit_pre_author_hook: CLI non-zero exit is non-fatal (|| true)" {
    _make_hooks_json
    export MOCK_BUN_MODE=nonzero
    run emit_pre_author_hook "REQ-000003" "${PROJ}" "plan"
    [ "$status" -eq 0 ]
    [ -f "${MOCK_BUN_SENTINEL}" ]   # CLI was invoked
}

# ── Non plan/spec phases are a no-op ─────────────────────────────────────────

@test "emit_pre_author_hook: non plan/spec phase -> no-op (no subprocess)" {
    _make_hooks_json
    for ph in prd tdd code code_review spec_review deploy; do
        rm -f "${MOCK_BUN_SENTINEL}"
        run emit_pre_author_hook "REQ-000004" "${PROJ}" "${ph}"
        [ "$status" -eq 0 ]
        [ ! -f "${MOCK_BUN_SENTINEL}" ]
    done
}
