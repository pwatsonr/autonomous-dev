# SPEC-013-1-04: Tests, Plugin-Install Smoke & Lifecycle Integration

## Metadata
- **Parent Plan**: PLAN-013-1
- **Tasks Covered**: Task 10 (lifecycle + hook tests), plus full coverage of all PLAN-013-1 acceptance criteria via integration smoke tests
- **Estimated effort**: 4 hours

## Description
Deliver the test suite that validates the plugin packaging, MCP lifecycle, and Bun runtime work end-to-end: bash unit tests for the SessionStart hook (hash detection, idempotence, failure rollback), bash unit tests for `check-runtime.sh` (exit-code matrix, OS branching), bun-test unit coverage for `lifecycle.ts` (priority ordering, timeout, force-exit, idempotence), and an integration smoke test that walks the plugin install → session-start → SIGTERM → clean-exit cycle.

This spec is the gate for PLAN-013-1's exit criteria. Every acceptance bullet in the plan must be exercised by at least one test here. Integration tests use a sandbox temp directory as `${CLAUDE_PLUGIN_DATA}` and a real Bun process; manual verification ("appears in Claude Code's plugin list") is captured as a documented manual-test runbook with screenshots.

The full server bootstrap is NOT yet built (PLAN-013-2/3/4); for these tests the spec provides a minimal stub `server.ts` that does just enough to register lifecycle handlers and prove the lifecycle works. The stub is deleted (or replaced) when PLAN-013-2 begins.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-portal/tests/session-start.test.bats` | Create | Bats tests for SessionStart hook |
| `plugins/autonomous-dev-portal/tests/check-runtime.test.bats` | Create | Bats tests for runtime detection |
| `plugins/autonomous-dev-portal/tests/start-standalone.test.bats` | Create | Bats tests for standalone launcher |
| `plugins/autonomous-dev-portal/server/lifecycle.test.ts` | Modify | Extend smoke tests from SPEC-013-1-02 to full coverage |
| `plugins/autonomous-dev-portal/tests/integration/install-and-lifecycle.test.bats` | Create | End-to-end smoke (install → start → SIGTERM → exit) |
| `plugins/autonomous-dev-portal/server/server.ts` | Create | Minimal stub: imports lifecycle, prints ready, sleeps until signal |
| `plugins/autonomous-dev-portal/package.json` | Create | Minimal — registers `bun test`; declares `hono` peer for future specs but no runtime deps required by this spec's stub |
| `plugins/autonomous-dev-portal/tests/manual/plugin-list-verification.md` | Create | Manual runbook for the one "must appear in plugin list" criterion |

## Implementation Details

### Bats Test Suite Layout

All bats tests run via `bats tests/` from the plugin root. Common helper file `tests/_helpers.bash` provides:

```bash
setup() {
  TEST_TMP="$(mktemp -d)"
  export CLAUDE_PLUGIN_ROOT="$TEST_TMP/root"
  export CLAUDE_PLUGIN_DATA="$TEST_TMP/data"
  mkdir -p "$CLAUDE_PLUGIN_ROOT" "$CLAUDE_PLUGIN_DATA"
  # Copy plugin scripts to fake root
  cp -r "$BATS_TEST_DIRNAME/../.claude-plugin" "$CLAUDE_PLUGIN_ROOT/"
  cp -r "$BATS_TEST_DIRNAME/../bin" "$CLAUDE_PLUGIN_ROOT/"
  cp "$BATS_TEST_DIRNAME/fixtures/package.json" "$CLAUDE_PLUGIN_ROOT/"
}

teardown() { rm -rf "$TEST_TMP"; }
```

Fixtures dir `tests/fixtures/`:
- `package.json` — minimal valid package.json (used as the "before" file).
- `package.json.modified` — same shape but with one extra dep (used to trigger hash mismatch).
- `bun-stub-good` — bash script that prints `1.1.34` (chmod 0755) — used to fake a working `bun` on PATH.
- `bun-stub-old` — bash script that prints `0.9.0`.
- `bun-stub-fail` — bash script that exits 1 on `bun install`.

### `check-runtime.test.bats`

Required test cases (one `@test` block each):

1. `bun missing exits 1 with macOS install hint` — strip `bun` from PATH; assert exit 1 and stderr contains `brew install oven-sh/bun/bun` when `uname -s` is `Darwin`.
2. `bun missing exits 1 with Linux install hint` — strip `bun` from PATH; mock `uname -s` → `Linux`; assert stderr contains `curl -fsSL https://bun.sh/install | bash`.
3. `bun missing exits 1 with generic install hint on Windows` — mock `uname -s` → `MINGW64_NT-10`; assert stderr contains `https://bun.sh/docs/installation`.
4. `bun version 0.9.0 exits 2 with outdated hint` — PATH has `bun-stub-old`; assert exit 2 and stderr contains both `0.9.0` and `>= 1.0`.
5. `bun version 1.0.0 exits 0` — PATH has stub printing `1.0.0`; assert exit 0.
6. `bun version 1.1.34 exits 0` — assert exit 0.
7. `bun version 1.0.0-beta.5 exits 0` — pre-release stripped.
8. `--quiet flag suppresses success message` — assert exit 0 and empty stderr.
9. `--help exits 0 with usage block` — assert exit 0 and stdout contains `Usage: check-runtime.sh`.
10. `Node.js fallback notice present in failure output` — verify `Node.js is not currently a supported runtime` substring in any failure mode.

### `session-start.test.bats`

1. `first run with no cache invokes bun install and writes hash` — start with empty `${CLAUDE_PLUGIN_DATA}`; PATH has `bun-stub-good` that fakes a successful install; assert post-state: `.last-install-hash` exists, contains expected SHA256, `install.log` contains "bun install succeeded".
2. `second run with unchanged package.json skips bun install` — pre-seed `.last-install-hash` with the correct hash; assert exit 0 and `install.log` does NOT gain a new "running bun install" line.
3. `package.json change triggers reinstall` — pre-seed cache with stale hash; replace `package.json` with `package.json.modified`; assert install runs, hash file updated to new value.
4. `bun install failure does not update cache` — PATH has `bun-stub-fail`; pre-seed cache with hash X; assert exit 1, `install.log` contains "bun install FAILED", `.last-install-hash` still equals X.
5. `hash file write is atomic` — race-test by running hook twice in parallel (subprocesses); assert resulting hash file is well-formed (one line, valid SHA256), not partially overwritten.
6. `missing CLAUDE_PLUGIN_ROOT or CLAUDE_PLUGIN_DATA exits 2` — unset each in turn; assert exit 2 and stderr explanation.
7. `auth_mode=tailscale without tailnet rejected` — set userConfig env, assert exit 1, stderr names `tailscale_tailnet`.
8. `auth_mode=oauth without valid provider rejected` — assert exit 1, stderr names `oauth_provider`.
9. `non-absolute allowed_root rejected` — set `portal.path_policy.allowed_roots=["./relative"]`; assert exit 1.
10. `runtime check failure (bun missing) propagates as exit 1` — strip bun from PATH; assert hook exits 1 (not 0).

### `start-standalone.test.bats`

1. `--check-only with all prerequisites exits 0` — full happy path; verify the `bun` process is NOT spawned.
2. `--check-only without PORTAL_DATA_DIR exits non-zero` — error mentions `PORTAL_DATA_DIR`.
3. `--check-only with missing bun propagates exit 1`.
4. `--check-only with old bun propagates exit 2`.
5. `--check-only validates auth_mode=tailscale requires PORTAL_TAILNET`.
6. `--check-only validates auth_mode=oauth requires PORTAL_OAUTH_PROVIDER`.
7. `exports CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA derived from PORTAL_*` — verify via instrumented stub server that prints `$CLAUDE_PLUGIN_ROOT` and exits.
8. `--help exits 0 with documented usage block`.

### `lifecycle.test.ts` (extended from SPEC-013-1-02 smoke)

Extends the 3 smoke tests with full coverage:

1. (smoke, retained) `registerResource adds entries in priority order`.
2. (smoke, retained) `initLifecycle is idempotent`.
3. (smoke, retained) `registerResource validates inputs`.
4. `cleanups run in ascending priority order on SIGTERM` — register 3 resources with priorities `[30, 10, 20]`, capture call order via shared array; emit `SIGTERM` to current process; assert order is `[10, 20, 30]`.
5. `slow cleanup is timed out at 2000ms` — register a resource whose cleanup awaits a 5s promise; assert next resource in priority order still runs.
6. `process force-exits within 10s of SIGTERM if all cleanups hang` — register multiple hanging cleanups; spawn the test under a child process with a 12s timeout; assert child exit code is 1 and total wall time < 11s.
7. `subsequent signals during shutdown are debounced` — emit SIGTERM, then SIGINT 100ms later; assert only one shutdown sequence runs.
8. `cleanup throwing an error logs and continues` — register cleanup that throws; assert next resource still runs and stderr contains the error.

Use `bun test` runner. Each test that involves real signals spawns a child process via `Bun.spawn` so that signals don't kill the test runner.

### Integration Smoke: `install-and-lifecycle.test.bats`

End-to-end test simulating the Claude Code lifecycle:

1. Set up sandbox with full plugin tree copied to `$TEST_TMP/root`, fresh `$TEST_TMP/data`.
2. Stub Bun on PATH (real Bun is required — the test skips with `bats skip` if `bun` is unavailable).
3. Invoke `session-start.sh` (asserts: hash cache populated, install.log written).
4. Spawn the stub `server.ts` via `bun run server/server.ts` in background; capture PID.
5. Wait up to 5s for the server to print `[ready]` to stderr (signal that lifecycle.ts wired up).
6. Send SIGTERM to the PID.
7. Assert the process exits with code 0 within 10s.
8. Assert stderr contains `[lifecycle] received SIGTERM` and `[lifecycle] shutdown complete`.

If `bun` is not installed on the test runner, this test calls `skip "bun not available; install via bin/check-runtime.sh"` so CI doesn't false-fail.

### Stub `server.ts`

Bare minimum to make the integration test green:

```typescript
import { initLifecycle, registerResource } from "./lifecycle";

initLifecycle();

registerResource({
  name: "demo-resource",
  priority: 50,
  cleanup: async () => {
    console.error("[demo-resource] cleaning up");
    await new Promise((r) => setTimeout(r, 100));
  },
});

console.error("[ready]");

// Keep process alive
await new Promise(() => {});
```

This stub is replaced wholesale when PLAN-013-2 lands the real bootstrap; the integration test's assertions (`[ready]`, `[lifecycle] received SIGTERM`, `[lifecycle] shutdown complete`) survive the swap because they are lifecycle-layer concerns.

### Manual Runbook: `tests/manual/plugin-list-verification.md`

Captures the one criterion that is genuinely manual — verifying the plugin appears in Claude Code's plugin list after install. Required content:

1. **Preconditions** — Claude Code installed, autonomous-dev base plugin installed, autonomous-dev-portal built locally.
2. **Step-by-step** — exact menu / command sequence to add the plugin from local marketplace.
3. **Expected** — plugin name, version, and "enabled" state visible.
4. **Screenshot placeholder** — `screenshots/plugin-list.png` (operator captures during verification).
5. **Failure modes & remediation** — at minimum: "plugin missing" (check marketplace path), "plugin shows error" (check `install.log`), "MCP server not starting" (check Claude Code's MCP log).

## Acceptance Criteria

- [ ] `bats tests/` runs all `*.test.bats` files and exits 0 (after Bun is installed locally).
- [ ] `bun test` runs `lifecycle.test.ts` and exits 0; all 8 tests pass.
- [ ] `check-runtime.test.bats` covers all 10 documented test cases.
- [ ] `session-start.test.bats` covers all 10 documented test cases including atomic-write race test (case 5).
- [ ] `start-standalone.test.bats` covers all 8 documented test cases.
- [ ] `lifecycle.test.ts` priority-ordering test (case 4) deterministically demonstrates ascending order across at least 3 resources.
- [ ] `lifecycle.test.ts` force-exit test (case 6) verifies wall-time deadline within tolerance (< 11s for a 10s budget).
- [ ] Integration smoke test passes when run against real Bun (or skips cleanly when Bun absent).
- [ ] Stub `server.ts` is < 30 lines and imports only from `./lifecycle`.
- [ ] `package.json` declares no production dependencies for this spec's stub (real deps land in PLAN-013-2).
- [ ] All bats files pass `shellcheck --severity=warning` on their `_helpers.bash`.
- [ ] Each PLAN-013-1 acceptance bullet maps to at least one specific test or manual runbook step (mapping documented in `tests/manual/plugin-list-verification.md` appendix).
- [ ] CI runs the suite under both Linux and macOS (matrix entries; Windows excluded per Bun support matrix).
- [ ] No test takes > 15s individually (force-exit test is the longest at ~10s).

## Dependencies

- SPEC-013-1-01 — supplies the directory and manifest under test.
- SPEC-013-1-02 — supplies `session-start.sh`, `lifecycle.ts`, `.mcp.json` under test.
- SPEC-013-1-03 — supplies `check-runtime.sh`, `start-standalone.sh` under test.
- `bats-core` — bash test runner; install via `brew install bats-core` (macOS) or system package (Linux). Document in README.
- `bun` — required to run `lifecycle.test.ts` and the integration smoke. Tests that require Bun skip cleanly if absent.
- No new TypeScript runtime deps; lifecycle.ts has zero imports.

## Notes

- The integration smoke test is the load-bearing validation for PLAN-013-1's exit criteria. Unit tests prove individual pieces work; the smoke test proves they work together. Without the smoke test passing, the plan is not "done" regardless of unit-test status.
- Atomic-write race test (session-start case 5) deliberately runs the hook twice in parallel via subshells to prove the `mv` of `.tmp` to `.last-install-hash` is atomic. The test asserts the file is well-formed; it does NOT assert which of the two writes "won" (both writes contain the same hash, so the result is byte-identical anyway).
- Stub Bun scripts (`bun-stub-good`, `bun-stub-old`) are shell scripts that mimic `bun --version` and `bun install`. They are mocked onto PATH by the `setup()` helper. The integration smoke test uses the real Bun (no mock) because it must exercise actual subprocess behavior.
- Manual verification (plugin-list visibility) is captured as a runbook rather than an automated test because the Claude Code plugin loader UI is out-of-process and not easily scripted. The runbook is shipped in-tree so future contributors know what "appearing in plugin list" means in concrete terms.
- The 15s-per-test limit excludes the integration smoke (which legitimately takes 10–12s due to the 10s shutdown deadline test). Unit tests must stay snappy or CI total time balloons.
- When PLAN-013-2 lands, the stub `server.ts` is replaced wholesale and this spec's tests continue to pass because they target the lifecycle contract (signals → ordered cleanup → exit), not the server's actual behavior.
