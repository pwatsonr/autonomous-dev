# SPEC-013-1-03: Bun Runtime Detection, Install Guidance & Version Pinning

## Metadata
- **Parent Plan**: PLAN-013-1
- **Tasks Covered**: Task 5 (standalone-mode launcher), Task 8 (Bun runtime version check)
- **Estimated effort**: 2 hours

## Description
Provide the runtime pre-flight checks and the standalone-mode launcher for the `autonomous-dev-portal` plugin. The portal requires Bun >= 1.0; this spec implements the strict version check that runs from both the Claude Code SessionStart hook and the standalone launcher, and provides per-OS install instructions when Bun is missing or too old. This spec also delivers `bin/start-standalone.sh`, the documented path for operators who want the portal running outside Claude Code (e.g., as a long-lived service on a homelab).

The runtime check is a single bash script with three exit codes (`0`/`1`/`2`); the standalone launcher composes it with environment validation and exec's `bun run server.ts` with proper signal forwarding. Node.js fallback is documented as untested for MVP — the runtime check fails fast rather than attempting Node.js compatibility shims.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-portal/bin/check-runtime.sh` | Create | Executable; Bun version check + install guidance |
| `plugins/autonomous-dev-portal/bin/start-standalone.sh` | Create | Executable; standalone launcher |

## Implementation Details

### Task 8: `check-runtime.sh`

Executable bash (chmod 0755). Strict mode: `set -euo pipefail`. Shellcheck-clean at `--severity=warning`.

Exit-code contract (load-bearing — consumers branch on these):

| Exit | Meaning |
|------|---------|
| `0`  | Bun installed and version >= 1.0.0 |
| `1`  | Bun not installed (or not on PATH) |
| `2`  | Bun installed but version too old |

Function pseudocode:

```
check_runtime() -> exit_code
  1. detect OS: uname -s -> "Darwin" | "Linux" | other
  2. if ! command -v bun; then
       print_install_instructions "$os" "missing"
       exit 1
     fi
  3. raw_version = bun --version              # e.g. "1.1.34" or "1.0.0-beta.5"
  4. parsed = strip trailing pre-release tag (everything from first "-")
  5. split parsed into major/minor/patch on "."
  6. if major < 1 || (major == 1 && minor < 0 && patch < 0); then
       print_install_instructions "$os" "outdated" "$raw_version"
       exit 2
     fi
  7. echo "Bun $raw_version OK" >&2 (informational; suppressible via --quiet flag)
  8. exit 0
```

CLI flags:
- `--quiet` — suppress the success message on exit 0 (errors still print).
- `--help` / `-h` — print usage and exit 0.

Per-OS install instructions (printed to stderr when Bun missing or outdated):

**Darwin (macOS):**
```
ERROR: Bun runtime not found (or version too old).

Install with Homebrew (recommended):
  brew install oven-sh/bun/bun

Or with the official installer:
  curl -fsSL https://bun.sh/install | bash

After install, restart your shell or run:
  source ~/.bashrc   # or ~/.zshrc

The autonomous-dev-portal plugin requires Bun >= 1.0.
```

**Linux:**
```
ERROR: Bun runtime not found (or version too old).

Install with the official installer:
  curl -fsSL https://bun.sh/install | bash

Then add to PATH (if not auto-added):
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"

The autonomous-dev-portal plugin requires Bun >= 1.0.
```

**Other (Windows / unknown):**
```
ERROR: Bun runtime not found (or version too old).

See https://bun.sh/docs/installation for installation instructions
appropriate to your platform.

Note: autonomous-dev-portal is not currently tested on Windows.
The autonomous-dev-portal plugin requires Bun >= 1.0.
```

When the failure mode is "outdated" (exit 2), prefix the OS-specific block with:

```
Detected Bun version: $raw_version (too old; need >= 1.0)
```

Node.js fallback notice — printed once below all "missing" messages:

```
Note: Node.js is not currently a supported runtime for this plugin (MVP).
Bun is required.
```

Implementation notes:
- Use bash's built-in arithmetic (`(( major < 1 ))`) for version comparison; do NOT shell out to `awk`/`bc`.
- Pre-release versions (`1.0.0-beta.X`) are treated as their stripped numeric form: `1.0.0-beta.5` → `1.0.0` → passes.
- The version string from `bun --version` is single-line and stable across releases (verified against `1.0.x`, `1.1.x`); if a future Bun changes the output shape, the regex stripping must be updated and a new test case added to SPEC-013-1-04.
- Do not require `jq` for this script — it must run before any dependencies are guaranteed available.

### Task 5: `start-standalone.sh`

Executable bash (chmod 0755). Strict mode: `set -euo pipefail`.

Purpose: run the portal outside Claude Code. The operator sets a few env vars and invokes this script directly (e.g., from a systemd unit, a tmux pane, or a Kubernetes container).

Required environment variables:

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORTAL_DATA_DIR` | Equivalent of `${CLAUDE_PLUGIN_DATA}` — operator-writable data dir | (none — required) |
| `PORTAL_ROOT_DIR` | Equivalent of `${CLAUDE_PLUGIN_ROOT}` — derived from script location if unset | `$(dirname $(dirname $0))` |
| `PORTAL_PORT` | TCP port to bind | `19280` |
| `PORTAL_AUTH_MODE` | `localhost` / `tailscale` / `oauth` | `localhost` |

Function pseudocode:

```
start_standalone() -> never_returns
  1. SCRIPT_DIR = $(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  2. PORTAL_ROOT_DIR = "${PORTAL_ROOT_DIR:-$(dirname "$SCRIPT_DIR")}"
  3. require PORTAL_DATA_DIR or fail with: "ERROR: PORTAL_DATA_DIR is required (operator data directory)"
  4. mkdir -p "$PORTAL_DATA_DIR" || fail with permission error
  5. invoke "$SCRIPT_DIR/check-runtime.sh"; propagate exit code
  6. validate auth-mode conditional fields per SPEC-013-1-01:
       - PORTAL_AUTH_MODE=tailscale requires PORTAL_TAILNET non-empty
       - PORTAL_AUTH_MODE=oauth requires PORTAL_OAUTH_PROVIDER in [github, google]
  7. export CLAUDE_PLUGIN_ROOT="$PORTAL_ROOT_DIR"
     export CLAUDE_PLUGIN_DATA="$PORTAL_DATA_DIR"
  8. trap forward_signal SIGTERM SIGINT
  9. cd "$PORTAL_ROOT_DIR"
  10. exec bun run server/server.ts
```

`forward_signal` trap:
- Forwards `SIGTERM` to the child `bun` process (PID captured via `&` + `wait`).
- Note: when using `exec` (step 10), the bash process is replaced by `bun`, so `bun` directly receives signals from the OS — no manual forwarding needed. The trap is therefore only relevant if a future change replaces `exec` with backgrounding. Document this and prefer `exec`.

CLI flags:
- `--check-only` — run `check-runtime.sh` and the env validation, then exit 0 without launching the server. Used by SPEC-013-1-04 integration tests.
- `--help` / `-h` — print usage and exit 0.

Help text (verbatim, ≤ 80 cols):

```
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
```

## Acceptance Criteria

- [ ] `bin/check-runtime.sh` is executable (mode 0755) and shellcheck passes at `--severity=warning`.
- [ ] `check-runtime.sh` exit code matrix: missing → 1, outdated (e.g. `0.9.0`) → 2, current (`1.0.0+`) → 0.
- [ ] `check-runtime.sh` parses Bun versions `1.0.0`, `1.1.34`, and `1.0.0-beta.5` correctly (pre-release stripped).
- [ ] `check-runtime.sh --quiet` suppresses success output but still prints errors.
- [ ] `check-runtime.sh --help` prints usage and exits 0.
- [ ] On Darwin, "missing" failure includes the `brew install oven-sh/bun/bun` line.
- [ ] On Linux, "missing" failure includes the `curl -fsSL https://bun.sh/install | bash` line.
- [ ] On unknown OS, "missing" failure points at https://bun.sh/docs/installation.
- [ ] "Outdated" failure includes the detected version string and the required minimum (`>= 1.0`).
- [ ] Both scripts include the Node.js fallback notice (Bun-only for MVP).
- [ ] `bin/start-standalone.sh` is executable (mode 0755) and shellcheck passes at `--severity=warning`.
- [ ] `start-standalone.sh` exits non-zero with a clear error when `PORTAL_DATA_DIR` is unset.
- [ ] `start-standalone.sh` invokes `check-runtime.sh` and propagates its exit code.
- [ ] `start-standalone.sh` exports `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` before exec'ing Bun, so server code reads them via the same names regardless of launch mode.
- [ ] `start-standalone.sh --check-only` exits 0 (or matching error code) without launching the server.
- [ ] `start-standalone.sh --help` prints the documented usage block.
- [ ] `start-standalone.sh` rejects `PORTAL_AUTH_MODE=tailscale` when `PORTAL_TAILNET` is empty.

## Dependencies

- SPEC-013-1-01 — supplies the plugin directory layout (specifically `bin/`) and the userConfig schema this script enforces in standalone mode.
- SPEC-013-1-02 — `session-start.sh` invokes `check-runtime.sh` as its first step; this spec must land before or with that one.
- `bash` >= 4.0 — required for arithmetic comparison and string manipulation builtins.
- `uname` (POSIX) — for OS detection.
- No external utilities beyond POSIX (`uname`, `mkdir`, `dirname`, `cd`); deliberately avoids `jq`/`awk`/`bc` so it remains executable on a fresh system before any dependency installation.

## Notes

- The exit-code contract (`0`/`1`/`2`) is the public interface used by SPEC-013-1-02's hook and by SPEC-013-1-04's integration tests. Changing these values is a breaking change.
- Bun version comparison is implemented in pure bash arithmetic to avoid dependencies on `awk`/`bc`. The current logic handles `MAJOR.MINOR.PATCH[-pre.release]`; semver "build metadata" (`+build`) is not expected in Bun's output and is not handled.
- Per-OS install snippets are intentionally copy-pasteable single commands. The Darwin block leads with Homebrew because most macOS developers already have it; the official installer is the fallback.
- Standalone mode unifies env-var names with Claude Code mode by exporting `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` from the operator-friendly `PORTAL_ROOT_DIR` / `PORTAL_DATA_DIR`. The server itself never sees the difference between launch modes.
- `exec` (vs background-and-wait) is preferred so that signals from the OS reach `bun` directly without bash playing middleman. The `trap` block is documented but currently unreachable under `exec`; preserved as a safety net for future refactors.
- Node.js compatibility is explicitly out of scope for MVP. The runtime check fails fast rather than attempting any compat layer; revisiting this is a post-MVP TDD-013 follow-up.
