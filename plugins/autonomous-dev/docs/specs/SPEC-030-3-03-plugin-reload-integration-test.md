# SPEC-030-3-03: Plugin-Reload Integration Test (FR-1643)

## Metadata
- **Parent Plan**: PLAN-030-3 (TDD-019 plugin-reload CLI closeout)
- **Parent TDD**: TDD-030 §7.3, §7.4; PRD-016 FR-1643, FR-1660
- **Tasks Covered**: TASK-003 (plugin-reload.test.ts + fixtures)
- **Estimated effort**: 1 day
- **Depends on**: SPEC-030-3-01 (dispatcher) + SPEC-030-3-02 (bin wrapper) merged
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-030-3-03-plugin-reload-integration-test.md`

## Description

Author the **single end-to-end integration test** that proves the plugin-reload CLI works against a real daemon process. Per TDD-030 §9.4, this is the one integration test PLAN-030-3 ships — mock-only unit tests of `commands/plugin.ts` are explicitly rejected as insufficient evidence of wiring.

Test outline (TDD-030 §7.4):
1. Create a `mkdtempSync` directory.
2. Drop a fixture plugin at v1.0.0 inside it.
3. Spawn the daemon as a child process pointed at the temp dir.
4. Wait for the daemon to be ready (poll a status endpoint or read a "ready" line on stdout).
5. Capture the daemon's PID.
6. Modify the fixture plugin's `manifest.json` to v1.1.0.
7. Spawn `node bin/reload-plugins.js my-test-plugin`.
8. Assert: CLI exit code = 0; daemon PID unchanged; daemon RPC reports plugin at v1.1.0.
9. Negative case: kill the daemon; spawn the CLI; assert exit code 1 within 2 s.
10. `afterAll`: kill the daemon; remove the temp dir.

Total runtime budget: **≤ 10 s** (TDD-030 §7.4). If the daemon's cold-start exceeds 8 s on CI consistently, bump per-test timeout to 20 s with a PR note (PLAN-030-3 risk note).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/integration/plugin-reload.test.ts` | Create | The integration test |
| `plugins/autonomous-dev/tests/integration/fixtures/test-plugin/manifest.json` | Create | v1.0.0 base manifest; rewritten mid-test to v1.1.0 |
| `plugins/autonomous-dev/tests/integration/fixtures/test-plugin/index.js` | Create | Minimal plugin entry; exports a `getVersion()` function returning the manifest version |

If `plugins/autonomous-dev/tests/integration/` already contains other integration tests (e.g., `test_full_lifecycle.sh`), reuse any boot helpers it exports rather than duplicating the daemon-spawn boilerplate. Read the existing integration directory before authoring.

## Implementation Details

### `tests/integration/plugin-reload.test.ts` — structure

```ts
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PLUGIN_NAME = 'my-test-plugin';
const FIXTURE_SRC = resolve(__dirname, 'fixtures', 'test-plugin');
const BIN_RELOAD = resolve(__dirname, '..', '..', 'bin', 'reload-plugins.js');
// Verify the daemon entry point against the existing project layout.
// Likely candidates: ./bin/daemon.js, ./dist/cjs/daemon/index.js, etc.
const DAEMON_BIN = resolve(__dirname, '..', '..', 'bin', 'daemon.js');

let dir: string;
let pluginsDir: string;
let manifestPath: string;
let daemon: ChildProcess | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'plugin-reload-int-'));
  pluginsDir = join(dir, 'plugins');
  cpSync(FIXTURE_SRC, join(pluginsDir, PLUGIN_NAME), { recursive: true });
  manifestPath = join(pluginsDir, PLUGIN_NAME, 'manifest.json');
});

afterEach(async () => {
  if (daemon && !daemon.killed) {
    daemon.kill('SIGTERM');
    // Allow up to 2 s for graceful shutdown; SIGKILL after that.
    await waitForExit(daemon, 2000).catch(() => daemon!.kill('SIGKILL'));
  }
  daemon = undefined;
  rmSync(dir, { recursive: true, force: true });
});
```

### Daemon spawn helper

```ts
async function startDaemon(pluginsRoot: string): Promise<{ proc: ChildProcess; pid: number; rpcUrl: string }> {
  const proc = spawn('node', [DAEMON_BIN, '--plugins-root', pluginsRoot, '--port', '0'], {
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const rpcUrl = await waitForReadyLine(proc, /listening on (http:\/\/[^\s]+)/, 5000);
  return { proc, pid: proc.pid!, rpcUrl };
}

/** Resolves with the captured group when stdout matches; rejects on timeout. */
async function waitForReadyLine(proc: ChildProcess, re: RegExp, timeoutMs: number): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => {
      proc.stdout?.removeAllListeners('data');
      rejectP(new Error(`daemon did not emit ready line within ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout?.on('data', (chunk: Buffer) => {
      const m = chunk.toString().match(re);
      if (m) {
        clearTimeout(timer);
        resolveP(m[1] ?? '');
      }
    });
  });
}
```

If the daemon's stdout-format does not match the regex (e.g., the daemon logs to a file rather than stdout), poll a status endpoint instead. Read the daemon source first to pick the right strategy.

### Test cases

```ts
describe('plugin reload (integration)', () => {
  it('reloads a plugin without restarting the daemon', async () => {
    const { proc, pid, rpcUrl } = await startDaemon(pluginsDir);
    daemon = proc;

    // Pre-state: daemon reports v1.0.0
    expect(await rpcGetPluginVersion(rpcUrl, PLUGIN_NAME)).toBe('1.0.0');

    // Bump manifest to v1.1.0 on disk
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.version = '1.1.0';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Invoke the CLI
    const result = spawnSync('node', [BIN_RELOAD, PLUGIN_NAME], {
      encoding: 'utf-8',
      env: { ...process.env, RELOAD_PLUGINS_RPC_URL: rpcUrl },
      timeout: 5000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/1\.1\.0/);

    // Post-state: daemon reports v1.1.0; PID unchanged.
    expect(await rpcGetPluginVersion(rpcUrl, PLUGIN_NAME)).toBe('1.1.0');
    expect(proc.pid).toBe(pid);
    expect(proc.killed).toBe(false);
  }, 15000);

  it('returns exit code 1 when the daemon is not running', async () => {
    // No daemon spawned in this case.
    const result = spawnSync('node', [BIN_RELOAD, PLUGIN_NAME], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        // Point the CLI at a port no daemon is listening on.
        RELOAD_PLUGINS_RPC_URL: 'http://127.0.0.1:1', // port 1 = always-refused
      },
      timeout: 2000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/transient|ECONNREFUSED|unreachable/i);
  }, 5000);
});
```

The exact env-var name `RELOAD_PLUGINS_RPC_URL` is illustrative — the implementer plumbs whatever transport the daemon exposes. Adjust to match the real RPC mechanism (Unix socket path, HTTP URL, named pipe, etc.) discovered while reading the daemon source for SPEC-030-3-01.

### `rpcGetPluginVersion` helper

```ts
async function rpcGetPluginVersion(rpcUrl: string, name: string): Promise<string> {
  const res = await fetch(`${rpcUrl}/plugins/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`rpc ${name}: HTTP ${res.status}`);
  const body = await res.json() as { version: string };
  return body.version;
}
```

If the daemon does not expose an HTTP `/plugins/:name` endpoint, swap in whatever introspection mechanism it does expose (a stdin/stdout JSON-RPC, a Unix-socket query, etc.). The contract this helper must satisfy is: "given a name, return the daemon's currently-loaded version of that plugin".

### Fixtures

`fixtures/test-plugin/manifest.json` (v1.0.0 base):
```json
{
  "name": "my-test-plugin",
  "version": "1.0.0",
  "main": "./index.js"
}
```

`fixtures/test-plugin/index.js`:
```js
'use strict';
const manifest = require('./manifest.json');
module.exports = {
  getVersion() { return manifest.version; },
};
```

The daemon hot-reload path must re-`require` (or re-import) `manifest.json` after the file is rewritten. If the daemon caches manifests, the CLI's reload RPC must explicitly invalidate the cache. This is part of the "daemon reload hook" inspected during SPEC-030-3-01 — if the cache invalidation does not exist, escalate per PLAN-030-3 TASK-001 risk note.

## Acceptance Criteria

- AC-1: `plugins/autonomous-dev/tests/integration/plugin-reload.test.ts` exists.
- AC-2: The fixture plugin (manifest.json, index.js) exists under `tests/integration/fixtures/test-plugin/`.
- AC-3: The "happy path" test creates a temp dir, spawns a daemon, captures PID, rewrites manifest to v1.1.0, invokes `bin/reload-plugins.js`, asserts CLI exit 0, asserts daemon RPC returns v1.1.0, asserts PID unchanged, asserts daemon process not killed.
- AC-4: The "no daemon" negative case spawns only the CLI (no daemon) and asserts exit code 1 within 2 s.
- AC-5: Both tests run under `npx jest --runInBand`. The happy-path test has `15000` ms test-level timeout but completes well under `10000` ms in normal CI.
- AC-6: `afterEach` reliably kills the daemon (SIGTERM, 2 s grace, then SIGKILL) and removes the temp dir.
- AC-7: No `process.exit` calls in the test file or its fixtures. `grep -E "process\\.exit" plugins/autonomous-dev/tests/integration/plugin-reload.test.ts plugins/autonomous-dev/tests/integration/fixtures/test-plugin/*.js` returns zero hits (PRD-016 FR-1660).
- AC-8: The PID-unchanged assertion captures the PID **immediately before** the reload RPC and asserts on the same value **immediately after** (window ≤ 100 ms). It does NOT poll later; an unrelated self-restart 2 s after reload would not invalidate the assertion.
- AC-9: `tsc --noEmit` from the autonomous-dev plugin passes.
- AC-10: Each daemon-spawn happens via `child_process.spawn`; each CLI invocation via `child_process.spawn` or `spawnSync`. No `eval`, no `require()` of the daemon module from inside the test (the daemon must run in its own process).
- AC-11: The temp dir created by `mkdtempSync` is cleaned up even on test failure (`afterEach` runs unconditionally).
- AC-12: 3 consecutive green CI runs on the PR branch (TDD-030 §8.4 flake check) — this test is the most likely flake source in PLAN-030-3.
- AC-13: If the daemon's cold-start exceeds 8 s on CI consistently, the test-level timeout is bumped to 20 s with a PR note (per PLAN-030-3 TASK-003 risk).

### Given/When/Then

```
Given a fresh temp directory containing a v1.0.0 fixture plugin and a running daemon
When the manifest is rewritten to v1.1.0 and `node bin/reload-plugins.js my-test-plugin` is invoked
Then the CLI exits with code 0
And the daemon RPC reports the plugin at v1.1.0
And the daemon PID is unchanged from before the reload
And the daemon process is still running (not killed)

Given no daemon is running
When `node bin/reload-plugins.js my-test-plugin` is invoked with an RPC URL pointing at an unreachable port
Then within 2 seconds the CLI exits with code 1
And stderr contains a transient-failure message (matching /transient|ECONNREFUSED|unreachable/i)

Given the integration test starts a daemon
When the test ends (success or failure)
Then the daemon process is sent SIGTERM
And if it has not exited within 2 seconds, it is sent SIGKILL
And the temp directory is removed
```

## Test Requirements

The integration test must:
1. Pass under `npx jest --runInBand`.
2. Run within 15 s wall-clock per `it()` on a developer laptop; aim for ≤ 10 s on CI.
3. Spawn the daemon and CLI as **separate processes** — no in-process imports of either.
4. Use `mkdtempSync` for isolation; clean up unconditionally in `afterEach`.
5. Capture stdout/stderr from `spawnSync` for assertions.
6. NOT call `process.exit` (PRD-016 FR-1660).
7. NOT depend on any global daemon or RPC port — every test creates its own.

## Implementation Notes

- **Daemon entry point discovery**: read the autonomous-dev plugin's `package.json` `bin` field and `dist/`/`lib/` layout to find the daemon executable. The path `bin/daemon.js` in the example is illustrative.
- **Ready-line strategy**: prefer stdout-line matching over polling. Polling adds latency (e.g., 100 ms per poll); stdout matching is event-driven. If the daemon does not emit a ready line, ask the daemon owner to add one (out of scope for this spec) or fall back to polling with a short interval.
- **PID-unchanged assertion timing**: the assertion window is ≤ 100 ms (capture PID, fire RPC, verify PID). A daemon self-restart due to an unrelated cause 5 s later does not invalidate the test (PLAN-030-3 TASK-003 risk note).
- **`spawnSync` vs `spawn`**: use `spawnSync` for the CLI (we want to wait for exit and inspect output); use `spawn` for the daemon (we want it to keep running while we poke at it).
- **No daemon mocking**: TDD-030 §9.4 explicitly rejects mock-only tests. This spec ships exactly one real-daemon test plus one daemon-down test; together they exercise the §7.3 contract end-to-end.
- **fetch vs http**: Node 18+ has global `fetch`. If the project's `tsconfig`'s `lib` is older, use `node:http` request directly.
- **Reuse existing helpers**: `tests/integration/test_full_lifecycle.sh` may already encode the daemon-boot recipe. Reuse rather than duplicate. Do NOT `cd` into directories; use absolute paths.
- **`cpSync` recursive copy** requires Node 16.7+; if the project's minimum Node is older, fall back to a hand-rolled recursive copy.

## Rollout Considerations

- **Forward**: this test runs in the `npx jest --runInBand` gate from CI. It does NOT run on every developer save (it's an integration test); developers run it on demand.
- **Rollback**: deletion of the test file leaves the dispatcher and bin wrapper in place. The contract is still enforced by the unit tests in SPEC-030-3-01.

## Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Daemon ready-line regex mismatches the actual daemon output | Medium | Medium (test never starts) | Read daemon source first; pick a stable substring; fall back to polling if the daemon has no ready line |
| Daemon cold-start > 10 s on CI | Medium | Medium (flake) | Test-level timeout 15 s with allowance to bump to 20 s with PR note (PLAN-030-3 TASK-003 risk) |
| PID-unchanged assertion races a daemon self-restart | Low | Medium | Capture PID and assert within ≤ 100 ms window; ignore later restarts |
| Daemon is not killed on test failure (zombie) | Medium | Medium | `afterEach` always runs; SIGTERM + 2 s grace + SIGKILL fallback |
| Temp dir leaks between failed test runs | Low | Low | `rmSync(..., {recursive: true, force: true})` in `afterEach` |
| RPC mechanism differs from HTTP (e.g., Unix socket) | Medium | Low | Helper is a thin wrapper; swap implementation as needed |
| `cpSync` not available on the project's Node version | Low | Low | Hand-rolled recursive copy fallback |
| Daemon caches manifest and reload RPC does not invalidate the cache | Medium | High (false-green test) | Verified during SPEC-030-3-01 daemon-source inspection; if cache invalidation is missing, escalate per PLAN-030-3 TASK-001 risk |
| Flake on CI causes 3-green check to take many tries | Medium | Medium (schedule) | Per-test timeout generous (15 s); CI parallelism reduced to 1 (`--runInBand`) |
