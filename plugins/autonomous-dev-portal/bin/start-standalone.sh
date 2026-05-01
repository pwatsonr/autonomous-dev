#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# start-standalone.sh - Standalone-mode launcher for autonomous-dev-portal
#                       (SPEC-013-1-03 §Task 5)
#
# Run the portal outside of Claude Code (e.g., from a systemd unit, a tmux
# pane, or a Kubernetes container). Validates the runtime and userConfig
# preconditions, then exec's `bun run server/server.ts`.
#
# Required environment:
#   PORTAL_DATA_DIR        Operator-writable data directory (analog of
#                          ${CLAUDE_PLUGIN_DATA})
#
# Optional environment:
#   PORTAL_ROOT_DIR        Plugin root (default: derived from script location)
#   PORTAL_PORT            TCP port (default: 19280)
#   PORTAL_AUTH_MODE       localhost | tailscale | oauth (default: localhost)
#   PORTAL_TAILNET         Required when PORTAL_AUTH_MODE=tailscale
#   PORTAL_OAUTH_PROVIDER  Required when PORTAL_AUTH_MODE=oauth (github|google)
#
# Flags:
#   --check-only           Validate prerequisites and exit; do not launch
#   --help, -h             Show help and exit
#
# Exit codes:
#   0    success (server launched, or --check-only passed)
#   1    Bun missing (propagated from check-runtime.sh) OR validation error
#   2    Bun outdated (propagated from check-runtime.sh)
###############################################################################

# ---------------------------------------------------------------------------
# usage() -> void
# ---------------------------------------------------------------------------
usage() {
    cat <<'EOF'
Usage: start-standalone.sh [--check-only] [--help]

Run the autonomous-dev-portal outside of Claude Code.

Required environment:
  PORTAL_DATA_DIR        Operator-writable data directory

Optional environment:
  PORTAL_ROOT_DIR        Plugin root (default: derived from script location)
  PORTAL_PORT            TCP port to bind (default: 19280)
  PORTAL_AUTH_MODE       localhost | tailscale | oauth (default: localhost)
  PORTAL_TAILNET         Required when PORTAL_AUTH_MODE=tailscale
  PORTAL_OAUTH_PROVIDER  Required when PORTAL_AUTH_MODE=oauth (github|google)

Flags:
  --check-only           Validate prerequisites and exit; do not launch server
  --help, -h             Show this help and exit
EOF
}

# ---------------------------------------------------------------------------
# fail(message) -> never returns
#   Print ERROR: <message> to stderr and exit 1.
# ---------------------------------------------------------------------------
fail() {
    echo "ERROR: $*" >&2
    exit 1
}

# ---------------------------------------------------------------------------
# validate_auth_mode() -> void | exit 1
#   Apply the same conditional rules as session-start.sh, but using the
#   PORTAL_* env-var names.
# ---------------------------------------------------------------------------
validate_auth_mode() {
    local mode="${PORTAL_AUTH_MODE:-localhost}"
    case "${mode}" in
        localhost) : ;;
        tailscale)
            if [[ -z "${PORTAL_TAILNET:-}" ]]; then
                fail "PORTAL_AUTH_MODE=tailscale requires PORTAL_TAILNET to be set"
            fi
            ;;
        oauth)
            if [[ "${PORTAL_OAUTH_PROVIDER:-}" != "github" && "${PORTAL_OAUTH_PROVIDER:-}" != "google" ]]; then
                fail "PORTAL_AUTH_MODE=oauth requires PORTAL_OAUTH_PROVIDER in [github, google] (got '${PORTAL_OAUTH_PROVIDER:-}')"
            fi
            ;;
        *)
            fail "invalid PORTAL_AUTH_MODE '${mode}'; expected localhost|tailscale|oauth"
            ;;
    esac
}

# ---------------------------------------------------------------------------
# forward_signal(sig) -> void
#   Forward the named signal to the child bun PID (when CHILD_PID is set).
#   Note: when using `exec` (the default code path below), bash is replaced
#   by bun and signals reach bun directly without bash's involvement, so
#   this trap is only relevant if a future change replaces `exec` with
#   backgrounding. Documented and preserved as a safety net.
# ---------------------------------------------------------------------------
forward_signal() {
    local sig="$1"
    if [[ -n "${CHILD_PID:-}" ]]; then
        kill "-${sig}" "${CHILD_PID}" 2>/dev/null || true
    fi
}

# ---------------------------------------------------------------------------
# start_standalone(args...) -> never returns (or exits with check code)
# ---------------------------------------------------------------------------
start_standalone() {
    local check_only=0
    local arg
    for arg in "$@"; do
        case "${arg}" in
            --check-only) check_only=1 ;;
            --help|-h) usage; exit 0 ;;
            *) fail "unknown flag '${arg}'. Run start-standalone.sh --help" ;;
        esac
    done

    # Resolve script location -> default plugin root.
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local plugin_root="${PORTAL_ROOT_DIR:-$(dirname "${script_dir}")}"

    # Required env.
    if [[ -z "${PORTAL_DATA_DIR:-}" ]]; then
        fail "PORTAL_DATA_DIR is required (operator data directory)"
    fi
    if ! mkdir -p "${PORTAL_DATA_DIR}"; then
        fail "cannot create PORTAL_DATA_DIR='${PORTAL_DATA_DIR}' (permission denied?)"
    fi

    # Pre-flight runtime check. Propagate exit code (0|1|2).
    local runtime_check="${script_dir}/check-runtime.sh"
    if [[ ! -x "${runtime_check}" ]]; then
        fail "${runtime_check} not found or not executable"
    fi
    if ! "${runtime_check}" --quiet; then
        exit $?
    fi

    # Conditional userConfig validation.
    validate_auth_mode

    # Unify env-var names with Claude-Code mode. The server itself never
    # sees the difference between launch modes — both export the same
    # CLAUDE_PLUGIN_* variables.
    export CLAUDE_PLUGIN_ROOT="${plugin_root}"
    export CLAUDE_PLUGIN_DATA="${PORTAL_DATA_DIR}"
    export PORTAL_PORT="${PORTAL_PORT:-19280}"

    if (( check_only == 1 )); then
        echo "start-standalone: --check-only OK (PORTAL_DATA_DIR=${PORTAL_DATA_DIR}, PORTAL_PORT=${PORTAL_PORT})" >&2
        exit 0
    fi

    # Trap installed for documentation/future-refactor safety; under exec
    # it will not actually fire because the bash process is replaced.
    trap 'forward_signal SIGTERM' SIGTERM
    trap 'forward_signal SIGINT'  SIGINT

    cd "${plugin_root}"
    exec bun run server/server.ts
}

start_standalone "$@"
