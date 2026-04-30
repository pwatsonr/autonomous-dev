#!/usr/bin/env bash
# Shared proxy that every autonomous-dev-*.md command body sources.
#
# Resolves the compiled TypeScript bridge, validates its presence, exports
# the contract environment variables, and invokes node with the requested
# subcommand and arguments.
#
# Exit-code contract (TDD-011 §6.4 / SPEC-011-2-01):
#   0  success
#   1  user error (validation, unknown subcommand, missing required arg)
#   2  system error (bridge missing, node missing, runtime crash)
#
# Source-of-truth references:
#   - SPEC-011-2-01 (proxy contract)
#   - SPEC-011-2-02 (bridge contract)
#   - TDD-011 §6.3 (bash proxy contract)

# Strict mode: fail fast on undefined variables, errors, and pipe failures.
set -euo pipefail

# ---------------------------------------------------------------------------
# bridge_proxy_invoke -- forward a subcommand to the TypeScript bridge.
#
# Usage:
#   bridge_proxy_invoke <subcommand> [args...]
#
# Returns the bridge's exit code so command bodies can `set -e` cleanly.
# ---------------------------------------------------------------------------
bridge_proxy_invoke() {
  local subcommand="${1:-}"
  if [[ -z "${subcommand}" ]]; then
    printf 'ERROR: bridge_proxy_invoke called without a subcommand.\n' >&2
    return 1
  fi
  shift

  # Resolve plugin root: this file lives at <plugin>/commands/_shared/, so the
  # plugin root is two directories up.
  local plugin_dir
  plugin_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

  local bridge_path="${plugin_dir}/dist/intake/adapters/claude_command_bridge.js"

  if [[ ! -f "${bridge_path}" ]]; then
    printf 'ERROR: autonomous-dev bridge not built.\n' >&2
    printf 'Run: cd "%s" && npm install && npm run build\n' "${plugin_dir}" >&2
    return 2
  fi

  if ! command -v node >/dev/null 2>&1; then
    printf 'ERROR: Node.js not found on PATH.\n' >&2
    printf 'Install Node.js >= 20.x and re-run.\n' >&2
    return 2
  fi

  # Contract env vars (read by the bridge's CLI entrypoint).
  export CLAUDE_COMMAND_SOURCE="${CLAUDE_COMMAND_SOURCE:-claude-app}"
  export CLAUDE_SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"

  # Forward to the compiled bridge. The "$@" spread preserves quoting so
  # multi-word values inside double-quoted args survive intact.
  node "${bridge_path}" "${subcommand}" "$@"
}
