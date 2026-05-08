/**
 * Unit tests for `runPluginReload` (intake/cli/commands/plugin.ts).
 *
 * Spec coverage: SPEC-030-3-01 — covers the kind/exit-code mapping in
 * isolation from the dispatcher, plus the default-timeout assertion.
 */

import {
  runPluginReload,
  type Logger,
  type PluginReloadDeps,
  type ReloadResult,
} from './plugin';

interface BufferLogger extends Logger {
  out: string[];
  err: string[];
}

function makeLogger(): BufferLogger {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (...a: unknown[]) => {
      out.push(a.join(' '));
    },
    error: (...a: unknown[]) => {
      err.push(a.join(' '));
    },
  };
}

function makeDeps(
  result: ReloadResult,
  capture?: { calls: Array<{ name: string; opts: { timeoutMs: number } }> },
): PluginReloadDeps {
  return {
    reloadHook: async (name, opts) => {
      capture?.calls.push({ name, opts });
      return result;
    },
  };
}

describe('runPluginReload (SPEC-030-3-01)', () => {
  it('returns 0 and logs version to stdout when reloadHook returns ok', async () => {
    const log = makeLogger();
    const deps = makeDeps({ kind: 'ok', version: '1.0.0' });

    const code = await runPluginReload('my-plugin', deps, log);

    expect(code).toBe(0);
    expect(log.out.join('\n')).toMatch(/1\.0\.0/);
    expect(log.out.join('\n')).toMatch(/my-plugin/);
    expect(log.err).toHaveLength(0);
  });

  it('returns 1 and logs to stderr when reloadHook returns transient', async () => {
    const log = makeLogger();
    const deps = makeDeps({ kind: 'transient', message: 'timeout' });

    const code = await runPluginReload('my-plugin', deps, log);

    expect(code).toBe(1);
    expect(log.err.join('\n')).toMatch(/transient/);
    expect(log.err.join('\n')).toMatch(/timeout/);
  });

  it('returns 2 and logs to stderr when reloadHook returns config-error', async () => {
    const log = makeLogger();
    const deps = makeDeps({ kind: 'config-error', message: 'unknown plugin' });

    const code = await runPluginReload('my-plugin', deps, log);

    expect(code).toBe(2);
    expect(log.err.join('\n')).toMatch(/configuration error/);
    expect(log.err.join('\n')).toMatch(/unknown plugin/);
  });

  it('returns 2 with stderr message when deps is undefined', async () => {
    const log = makeLogger();

    const code = await runPluginReload('my-plugin', undefined, log);

    expect(code).toBe(2);
    expect(log.err.join('\n')).toMatch(/daemon reload hook not configured/);
  });

  it('passes the default timeout (5000 ms) when deps.timeoutMs is unset', async () => {
    const log = makeLogger();
    const capture = { calls: [] as Array<{ name: string; opts: { timeoutMs: number } }> };
    const deps = makeDeps({ kind: 'ok', version: '1.0.0' }, capture);

    await runPluginReload('my-plugin', deps, log);

    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0]).toEqual({
      name: 'my-plugin',
      opts: { timeoutMs: 5000 },
    });
  });

  it('passes a caller-supplied timeout when deps.timeoutMs is set', async () => {
    const log = makeLogger();
    const capture = { calls: [] as Array<{ name: string; opts: { timeoutMs: number } }> };
    const deps: PluginReloadDeps = {
      ...makeDeps({ kind: 'ok', version: '1.0.0' }, capture),
      timeoutMs: 250,
    };

    await runPluginReload('my-plugin', deps, log);

    expect(capture.calls[0]?.opts.timeoutMs).toBe(250);
  });

  it('always returns an exit code in the closed set {0, 1, 2}', async () => {
    const log = makeLogger();
    const codes = await Promise.all([
      runPluginReload('p', makeDeps({ kind: 'ok', version: 'x' }), log),
      runPluginReload('p', makeDeps({ kind: 'transient', message: 'm' }), log),
      runPluginReload(
        'p',
        makeDeps({ kind: 'config-error', message: 'm' }),
        log,
      ),
      runPluginReload('p', undefined, log),
    ]);
    for (const code of codes) {
      expect([0, 1, 2]).toContain(code);
    }
  });
});
