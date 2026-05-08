/**
 * Unit tests for `dispatch` (intake/cli/dispatcher.ts).
 *
 * Spec coverage: SPEC-030-3-01 — argv routing, exit-code contract,
 * plugin-name validation, and the closed-set exit-code guard.
 *
 * No subprocess is spawned. The reloadHook is injected directly; modules
 * are not mocked. Logger output is captured via an injected buffer rather
 * than spying on `console`.
 */

import { dispatch } from './dispatcher';
import type {
  PluginReloadDeps,
  ReloadResult,
} from './commands/plugin';

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
    log: (...a: unknown[]) => {
      out.push(a.join(' '));
    },
    error: (...a: unknown[]) => {
      err.push(a.join(' '));
    },
    warn: () => {
      // Unused in dispatcher; kept to satisfy the logger shape.
    },
  };
}

function makeDeps(result: ReloadResult): PluginReloadDeps {
  return { reloadHook: async () => result };
}

describe('dispatch (SPEC-030-3-01)', () => {
  it('returns 0 for the bare shorthand when reloadHook returns ok', async () => {
    const logger = makeLogger();
    const code = await dispatch(['my-plugin'], {
      logger,
      pluginReload: makeDeps({ kind: 'ok', version: '1.2.3' }),
    });
    expect(code).toBe(0);
    expect(logger.out.join('\n')).toMatch(/1\.2\.3/);
  });

  it('returns 0 for the verb form `plugin reload <name>`', async () => {
    const logger = makeLogger();
    const code = await dispatch(['plugin', 'reload', 'my-plugin'], {
      logger,
      pluginReload: makeDeps({ kind: 'ok', version: '1.2.3' }),
    });
    expect(code).toBe(0);
    expect(logger.out.join('\n')).toMatch(/1\.2\.3/);
  });

  it('returns 1 with stderr when reloadHook returns transient (ECONNREFUSED)', async () => {
    const logger = makeLogger();
    const code = await dispatch(['my-plugin'], {
      logger,
      pluginReload: makeDeps({ kind: 'transient', message: 'ECONNREFUSED' }),
    });
    expect(code).toBe(1);
    expect(logger.err.join('\n')).toMatch(/ECONNREFUSED/);
  });

  it('returns 2 with stderr when reloadHook returns config-error', async () => {
    const logger = makeLogger();
    const code = await dispatch(['my-plugin'], {
      logger,
      pluginReload: makeDeps({
        kind: 'config-error',
        message: 'manifest.json invalid',
      }),
    });
    expect(code).toBe(2);
    expect(logger.err.join('\n')).toMatch(/manifest\.json invalid/);
  });

  it('returns 2 and prints Usage on an unknown command', async () => {
    const logger = makeLogger();
    const code = await dispatch(['foo', 'bar'], { logger });
    expect(code).toBe(2);
    expect(logger.err.join('\n')).toMatch(/Usage:/);
  });

  it('returns 2 and prints Usage on empty argv', async () => {
    const logger = makeLogger();
    const code = await dispatch([], { logger });
    expect(code).toBe(2);
    expect(logger.err.join('\n')).toMatch(/Usage:/);
  });

  it('returns 2 and rejects path-traversal plugin names', async () => {
    const logger = makeLogger();
    const code = await dispatch(['../etc/passwd'], {
      logger,
      pluginReload: makeDeps({ kind: 'ok', version: '1.0.0' }),
    });
    expect(code).toBe(2);
    expect(logger.err.join('\n')).toMatch(/Invalid plugin name/);
  });

  it('returns 2 and rejects whitespace in plugin names', async () => {
    const logger = makeLogger();
    const code = await dispatch(['hello world'], {
      logger,
      pluginReload: makeDeps({ kind: 'ok', version: '1.0.0' }),
    });
    expect(code).toBe(2);
    expect(logger.err.join('\n')).toMatch(/Invalid plugin name/);
  });

  it('returns 2 and rejects names containing slash or backslash', async () => {
    const logger = makeLogger();
    expect(
      await dispatch(['foo/bar'], {
        logger,
        pluginReload: makeDeps({ kind: 'ok', version: '1.0.0' }),
      }),
    ).toBe(2);
    expect(
      await dispatch(['foo\\bar'], {
        logger,
        pluginReload: makeDeps({ kind: 'ok', version: '1.0.0' }),
      }),
    ).toBe(2);
  });

  it('does NOT invoke the reloadHook when argv is invalid', async () => {
    let called = false;
    const logger = makeLogger();
    const deps: PluginReloadDeps = {
      reloadHook: async () => {
        called = true;
        return { kind: 'ok', version: 'x' };
      },
    };
    await dispatch(['../etc/passwd'], { logger, pluginReload: deps });
    expect(called).toBe(false);
  });

  it('returns 2 with stderr when the reloadHook throws', async () => {
    const logger = makeLogger();
    const deps: PluginReloadDeps = {
      reloadHook: async () => {
        throw new Error('boom');
      },
    };
    const code = await dispatch(['my-plugin'], {
      logger,
      pluginReload: deps,
    });
    expect(code).toBe(2);
    expect(logger.err.join('\n')).toMatch(/boom/);
  });

  it('returns 2 when the reloadHook is not configured', async () => {
    const logger = makeLogger();
    const code = await dispatch(['my-plugin'], { logger });
    expect(code).toBe(2);
    expect(logger.err.join('\n')).toMatch(
      /daemon reload hook not configured/,
    );
  });

  it('caps return values to the closed set {0, 1, 2}', async () => {
    const logger = makeLogger();
    const code = await dispatch(['my-plugin'], {
      logger,
      pluginReload: makeDeps({ kind: 'ok', version: 'x' }),
    });
    expect([0, 1, 2]).toContain(code);
  });

  it('uses console as the default logger when deps.logger is omitted', async () => {
    // Smoke test: just make sure no throw occurs and the right code returns.
    const code = await dispatch(['my-plugin'], {
      pluginReload: makeDeps({ kind: 'ok', version: '1.0.0' }),
    });
    expect(code).toBe(0);
  });
});
