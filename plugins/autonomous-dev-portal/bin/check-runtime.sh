#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# check-runtime.sh - Bun runtime pre-flight check (SPEC-013-1-03 §Task 8)
#
# Verifies Bun >= 1.0 is installed and on PATH. On failure, prints per-OS
# install guidance to stderr and exits with a load-bearing code so callers
# can branch on the failure mode.
#
# Exit codes (PUBLIC INTERFACE — used by session-start.sh and tests):
#   0  Bun installed and version >= 1.0.0
#   1  Bun not installed (or not on PATH)
#   2  Bun installed but version too old
#
# Flags:
#   --quiet       Suppress success message (errors still print)
#   --help, -h    Print usage and exit 0
#
# Uses ONLY POSIX utilities (uname) plus bash builtins; deliberately avoids
# jq/awk/bc so it works on a fresh system before any deps are installed.
###############################################################################

# ---------------------------------------------------------------------------
# usage() -> void
#   Prints usage to stdout.
# ---------------------------------------------------------------------------
usage() {
    cat <<'EOF'
Usage: check-runtime.sh [--quiet] [--help]

Verify the Bun runtime (>= 1.0) is installed and on PATH. Exits 0 on
success, 1 if Bun is missing, 2 if installed but too old. Prints per-OS
install guidance to stderr on failure.

Flags:
  --quiet       Suppress the success message (errors still print)
  --help, -h    Show this help and exit
EOF
}

# ---------------------------------------------------------------------------
# detect_os() -> string
#   Prints "Darwin" | "Linux" | "Other" based on `uname -s`.
# ---------------------------------------------------------------------------
detect_os() {
    case "$(uname -s)" in
        Darwin) echo "Darwin" ;;
        Linux)  echo "Linux"  ;;
        *)      echo "Other"  ;;
    esac
}

# ---------------------------------------------------------------------------
# print_install_instructions(os, mode, [version]) -> void
#   Prints OS-specific install guidance to stderr. mode is "missing"
#   or "outdated"; when "outdated", $3 is the detected version string.
# ---------------------------------------------------------------------------
print_install_instructions() {
    local os="$1"
    local mode="$2"
    local detected="${3:-}"

    {
        if [[ "${mode}" == "outdated" ]]; then
            echo "Detected Bun version: ${detected} (too old; need >= 1.0)"
            echo
        fi

        case "${os}" in
            Darwin)
                cat <<'EOF'
ERROR: Bun runtime not found (or version too old).

Install with Homebrew (recommended):
  brew install oven-sh/bun/bun

Or with the official installer:
  curl -fsSL https://bun.sh/install | bash

After install, restart your shell or run:
  source ~/.bashrc   # or ~/.zshrc

The autonomous-dev-portal plugin requires Bun >= 1.0.
EOF
                ;;
            Linux)
                cat <<'EOF'
ERROR: Bun runtime not found (or version too old).

Install with the official installer:
  curl -fsSL https://bun.sh/install | bash

Then add to PATH (if not auto-added):
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"

The autonomous-dev-portal plugin requires Bun >= 1.0.
EOF
                ;;
            *)
                cat <<'EOF'
ERROR: Bun runtime not found (or version too old).

See https://bun.sh/docs/installation for installation instructions
appropriate to your platform.

Note: autonomous-dev-portal is not currently tested on Windows.
The autonomous-dev-portal plugin requires Bun >= 1.0.
EOF
                ;;
        esac

        # Node.js fallback notice — printed for both "missing" and "outdated".
        echo
        echo "Note: Node.js is not currently a supported runtime for this plugin (MVP)."
        echo "Bun is required."
    } >&2
}

# ---------------------------------------------------------------------------
# parse_version_to_triplet(raw) -> "MAJOR MINOR PATCH" on stdout
#   Strips any pre-release tag (everything from first "-") and splits on ".".
#   Missing components default to 0 (e.g., "1.1" -> "1 1 0").
# ---------------------------------------------------------------------------
parse_version_to_triplet() {
    local raw="$1"
    # Strip from first "-" onward (pre-release suffix).
    local stripped="${raw%%-*}"
    local major="${stripped%%.*}"
    local rest="${stripped#*.}"
    local minor patch
    if [[ "${rest}" == "${stripped}" ]]; then
        # No "." after major (e.g. raw was just "1").
        minor=0
        patch=0
    else
        minor="${rest%%.*}"
        local rest2="${rest#*.}"
        if [[ "${rest2}" == "${rest}" ]]; then
            patch=0
        else
            patch="${rest2%%.*}"
        fi
    fi
    # Default any non-numeric component to 0 (defensive).
    [[ "${major}" =~ ^[0-9]+$ ]] || major=0
    [[ "${minor}" =~ ^[0-9]+$ ]] || minor=0
    [[ "${patch}" =~ ^[0-9]+$ ]] || patch=0
    echo "${major} ${minor} ${patch}"
}

# ---------------------------------------------------------------------------
# check_runtime() -> exit_code
#   Main entrypoint per SPEC-013-1-03 §Task 8 pseudocode.
# ---------------------------------------------------------------------------
check_runtime() {
    local quiet=0
    local arg
    for arg in "$@"; do
        case "${arg}" in
            --quiet) quiet=1 ;;
            --help|-h) usage; exit 0 ;;
            *)
                echo "ERROR: unknown flag '${arg}'. Run check-runtime.sh --help" >&2
                exit 1
                ;;
        esac
    done

    local os
    os="$(detect_os)"

    if ! command -v bun >/dev/null 2>&1; then
        print_install_instructions "${os}" "missing"
        exit 1
    fi

    local raw_version
    raw_version="$(bun --version 2>/dev/null || true)"
    # Trim leading/trailing whitespace defensively.
    raw_version="${raw_version#"${raw_version%%[![:space:]]*}"}"
    raw_version="${raw_version%"${raw_version##*[![:space:]]}"}"

    if [[ -z "${raw_version}" ]]; then
        # Found `bun` but it produced nothing — treat as missing.
        print_install_instructions "${os}" "missing"
        exit 1
    fi

    local triplet major minor patch
    triplet="$(parse_version_to_triplet "${raw_version}")"
    # shellcheck disable=SC2086
    set -- ${triplet}
    major="$1"; minor="$2"; patch="$3"

    # Required: major >= 1 (i.e., any 1.x.y or higher).
    if (( major < 1 )); then
        print_install_instructions "${os}" "outdated" "${raw_version}"
        exit 2
    fi

    if (( quiet == 0 )); then
        echo "Bun ${raw_version} OK" >&2
    fi
    # Reference parsed components so shellcheck does not flag them as
    # unused; they are intentionally available for future minor/patch
    # constraints (e.g. >= 1.1) without changing the parsing path.
    : "${minor}" "${patch}"
    exit 0
}

check_runtime "$@"
