/**
 * End-to-end integration test for the plugin-reload CLI (SPEC-030-3-03,
 * PLAN-030-3 / TDD-030 §7.3, §7.4; PRD-016 FR-1643, FR-1660).
 *
 * The autonomous-dev plugin does not yet ship a real daemon, so per the
 * SPEC-030-3-03 implementation note ("swap in whatever introspection
 * mechanism the daemon exposes") and the TDD-030 closeout directive
 * ("mock the daemon with a short-loop child... or use a JSON file as the
 * daemon state and have the CLI talk to it via filesystem"), this test:
 *
 *   1. Spawns a minimal "daemon shim" subprocess via `child_process.spawn`
 *      — a Node child running a short-loop that holds the daemon's PID
 *      and stays alive until SIGTERM. No real long-running daemon is
 *      required; the wall-clock budget is well under 10 s.
 *   2. Drives `dispatch()` (the real PLAN-030-3 dispatcher) with a custom
 *      `reloadHook` that talks to the daemon shim via the filesystem:
 *      the hook checks the daemon PID is alive (`process.kill(pid, 0)`),
 *      then re-reads `manifest.json` from the plugins root. This is the
 *      file-based "RPC" the user-directive endorses for this closeout.
 *   3. Asserts CLI exit 0, daemon PID unchanged, version bumped to 1.1.0
 *      (happy path).
 *   4. Asserts CLI exit 1 within 2 s when the daemon is down (negative).
 *   5. Cleans up the daemon (SIGTERM → 2 s grace → SIGKILL) and the temp
 *      dir in `afterEach` unconditionally.
 *
 * Trade-off vs SPEC-030-3-03 AC-10 ("CLI invocation via spawnSync"):
 * because `bin/reload-plugins.js` does not (yet) wire a production daemon
 * hook, invoking it as a subprocess would always return exit 2. The user-
 * sanctioned filesystem-mock variant exercises the full dispatcher
 * pipeline (argv parsing, validation, exit-code mapping) end-to-end with
 * a real subprocess daemon — which is the contract the integration test
 * exists to prove. The bin wrapper itself is covered by SPEC-030-3-02's
 * unit tests. Future work (TDD-031+) wires a real daemon hook and an
 * end-to-end spawnSync(`bin/reload-plugins.js`) test alongside this one.
 *
 * The test file and fixtures contain no `process[.]exit` calls (FR-1660).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { dispatch } from '../../intake/cli/dispatcher';
import type { PluginReloadDeps, ReloadResult } from '../../intake/cli/commands/plugin';

const PLUGIN_NAME = 'my-test-plugin';
const FIXTURE_SRC = resolve(__dirname, 'fixtures', 'test-plugin');

interface BufferLogger {
  log: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  out: string[];
  err: string[];
}

function makeLogger(): BufferLogger {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (...a) => {
      out.push(a.join(' '));
    },
    error: (...a) => {
      err.push(a.join(' '));
    },
    warn: () => {},
  };
}

/**
 * Spawn a minimal daemon shim subprocess. The shim is a Node child that
 * sits idle on a long timer and exits cleanly on SIGTERM. We capture its
 * PID for the "PID-unchanged" assertion.
 */
function spawnDaemonShim(): ChildProcess {
  const proc = spawn(
    process.execPath,
    [
      '-e',
      // Default Node behaviour on SIGTERM terminates the process; we
      // deliberately install no signal handler (FR-1660 forbids the
      // `process[.]exit` token in test files or fixtures). The
      // setInterval is a no-op heartbeat that keeps the event loop alive
      // until SIGTERM arrives.
      "setInterval(()=>{},60000);console.log('daemon-ready pid='+process.pid);",
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return proc;
}

/** Wait until the shim prints its "daemon-ready" line, with a hard timeout. */
function waitForReady(proc: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => {
      rejectP(new Error(`daemon shim did not become ready within ${timeoutMs} ms`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      if (chunk.toString().includes('daemon-ready')) {
        clearTimeout(timer);
        proc.stdout?.off('data', onData);
        resolveP();
      }
    };
    proc.stdout?.on('data', onData);
    proc.once('exit', () => {
      clearTimeout(timer);
      rejectP(new Error('daemon shim exited before signalling ready'));
    });
  });
}

/** Promise that resolves when `proc` has exited; rejects on timeout. */
function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error('exit timeout')), timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolveP();
    });
  });
}

/** True iff a process with the given PID is currently alive. */
function isAlive(pid: number): boolean {
  try {
    // Signal 0 = liveness probe; throws ESRCH if the process is gone.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the file-based daemon-reload hook. The hook performs three steps:
 *   1. Check daemon liveness via `process.kill(pid, 0)`. If dead → transient.
 *   2. Re-read `manifest.json` from disk. If missing/malformed → config-error.
 *   3. Return `{kind:'ok', version}` mirroring what a real daemon's reload
 *      RPC would return.
 *
 * This is the "filesystem RPC" the user-directive sanctioned for this
 * closeout.
 */
function makeFsHook(daemonPid: number, manifestPath: string): PluginReloadDeps {
  return {
    timeoutMs: 1_000,
    reloadHook: async (): Promise<ReloadResult> => {
      if (!isAlive(daemonPid)) {
        return { kind: 'transient', message: 'ECONNREFUSED: daemon unreachable' };
      }
      try {
        const raw = readFileSync(manifestPath, 'utf-8');
        const parsed = JSON.parse(raw) as { version?: unknown };
        if (typeof parsed.version !== 'string') {
          return { kind: 'config-error', message: 'manifest.version missing' };
        }
        return { kind: 'ok', version: parsed.version };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { kind: 'config-error', message: msg };
      }
    },
  };
}

describe('plugin-reload CLI (integration, SPEC-030-3-03)', () => {
  let dir: string;
  let pluginsDir: string;
  let manifestPath: string;
  let daemon: ChildProcess | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plugin-reload-int-'));
    pluginsDir = join(dir, 'plugins');
    cpSync(FIXTURE_SRC, join(pluginsDir, PLUGIN_NAME), { recursive: true });
    manifestPath = join(pluginsDir, PLUGIN_NAME, 'manifest.json');
  });

  afterEach(async () => {
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill('SIGTERM');
      await waitForExit(daemon, 2_000).catch(() => {
        try {
          daemon!.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      });
    }
    daemon = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reloads a plugin without restarting the daemon (exit 0, PID unchanged, v1.1.0)', async () => {
    // 1. Spawn the daemon shim and capture its PID once it is ready.
    daemon = spawnDaemonShim();
    await waitForReady(daemon, 3_000);
    const pidBefore = daemon.pid;
    expect(typeof pidBefore).toBe('number');
    expect(isAlive(pidBefore!)).toBe(true);

    // 2. Pre-state: hook reports v1.0.0.
    const preLogger = makeLogger();
    const preCode = await dispatch([PLUGIN_NAME], {
      logger: preLogger,
      pluginReload: makeFsHook(pidBefore!, manifestPath),
    });
    expect(preCode).toBe(0);
    expect(preLogger.out.join('\n')).toMatch(/1\.0\.0/);

    // 3. Bump manifest on disk to v1.1.0.
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.version = '1.1.0';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // 4. Capture PID immediately before the reload (≤100 ms window).
    const tBeforeReload = Date.now();
    expect(daemon.pid).toBe(pidBefore);
    expect(isAlive(pidBefore!)).toBe(true);

    // 5. Invoke the dispatcher with the same hook.
    const logger = makeLogger();
    const code = await dispatch([PLUGIN_NAME], {
      logger,
      pluginReload: makeFsHook(pidBefore!, manifestPath),
    });

    // 6. Assertions: exit 0, stdout reports new version, PID unchanged,
    // window is well under 100 ms (no daemon self-restart possible since
    // the shim has no restart logic).
    const tAfterReload = Date.now();
    expect(code).toBe(0);
    expect(logger.out.join('\n')).toMatch(/1\.1\.0/);
    expect(daemon.pid).toBe(pidBefore);
    expect(isAlive(pidBefore!)).toBe(true);
    expect(daemon.exitCode).toBeNull();
    expect(tAfterReload - tBeforeReload).toBeLessThan(100);
  }, 8_000);

  it('returns exit 1 within 2 s when the daemon is not running', async () => {
    // Spawn a daemon, wait for ready, kill it, then drive dispatch().
    daemon = spawnDaemonShim();
    await waitForReady(daemon, 3_000);
    const deadPid = daemon.pid!;
    daemon.kill('SIGTERM');
    await waitForExit(daemon, 2_000);
    // After SIGTERM the PID slot is freed; isAlive(deadPid) === false.

    const logger = makeLogger();
    const start = Date.now();
    const code = await dispatch([PLUGIN_NAME], {
      logger,
      pluginReload: makeFsHook(deadPid, manifestPath),
    });
    const elapsed = Date.now() - start;

    expect(code).toBe(1);
    expect(elapsed).toBeLessThan(2_000);
    expect(logger.err.join('\n')).toMatch(/transient|ECONNREFUSED|unreachable/i);
  }, 5_000);
});
