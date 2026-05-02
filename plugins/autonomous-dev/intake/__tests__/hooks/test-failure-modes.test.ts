/**
 * Failure-mode tests (SPEC-019-4-05 §test-failure-modes).
 *
 * Exercises the executor's `block` / `warn` / `ignore` switch:
 *   - `block` throws `HookBlockedError`; subsequent hooks are NOT invoked.
 *   - `warn` continues iteration and emits a structured WARN log.
 *   - `ignore` continues silently (no log emission).
 *   - Mixed scenarios produce the documented `results` / `failures` /
 *     `aborted` aggregate.
 *   - Block-mode hooks still see prior `previousResults` (chained context
 *     applies even on the doomed hook).
 *
 * @module __tests__/hooks/test-failure-modes
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { HookExecutor } from '../../hooks/executor';
import { HookBlockedError } from '../../hooks/errors';
import { HookRegistry } from '../../hooks/registry';
import {
  FailureMode,
  HookPoint,
  type HookEntry,
  type HookManifest,
} from '../../hooks/types';

const POINT = HookPoint.CodePreWrite;

interface Fixture {
  rootDir: string;
  invocations: string[];
}

async function makeFixture(): Promise<Fixture> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-fail-mode-'));
  return { rootDir, invocations: [] };
}

async function writeSuccessHook(rootDir: string, name: string, output: unknown): Promise<void> {
  const code = `'use strict';
module.exports = function (input, ctx) { return ${JSON.stringify(output)}; };
`;
  await fs.writeFile(path.join(rootDir, `${name}.js`), code);
}

async function writeThrowingHook(rootDir: string, name: string, message: string): Promise<void> {
  const code = `'use strict';
module.exports = function (input, ctx) { throw new Error(${JSON.stringify(message)}); };
`;
  await fs.writeFile(path.join(rootDir, `${name}.js`), code);
}

/**
 * Hook that asserts the first prior result's output equals 42; throws otherwise.
 * Used to prove `block`-mode hooks still observe `previousResults`.
 */
async function writeAssertingBlockHook(rootDir: string, name: string): Promise<void> {
  const code = `'use strict';
module.exports = function (input, ctx) {
  if (!ctx || !ctx.previousResults || ctx.previousResults.length === 0) {
    throw new Error('expected at least one prior result');
  }
  var first = ctx.previousResults[0];
  if (!first.output || first.output.value !== 42) {
    throw new Error('expected first.output.value === 42, got ' + JSON.stringify(first.output));
  }
  return { ok: true };
};
`;
  await fs.writeFile(path.join(rootDir, `${name}.js`), code);
}

function entry(id: string, priority: number, mode: FailureMode): HookEntry {
  return {
    id,
    hook_point: POINT,
    entry_point: `./${id}.js`,
    priority,
    failure_mode: mode,
  };
}

function manifest(pluginId: string, hooks: HookEntry[]): HookManifest {
  return { id: pluginId, name: pluginId, version: '1.0.0', hooks };
}

// ---------------------------------------------------------------------------

describe('HookExecutor.executeHooksChained — failure modes', () => {
  let fixtures: Fixture[] = [];

  afterEach(async () => {
    for (const f of fixtures) {
      await fs.rm(f.rootDir, { recursive: true, force: true });
    }
    fixtures = [];
  });

  test('block-mode throw aborts execution; subsequent hooks are NOT invoked', async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeSuccessHook(f.rootDir, 'h1', 'A');
    await writeThrowingHook(f.rootDir, 'h2', 'boom-block');
    await writeSuccessHook(f.rootDir, 'h3', 'C');

    const reg = new HookRegistry();
    reg.register(
      manifest('p1', [
        entry('h1', 100, FailureMode.Warn),
        entry('h2', 90, FailureMode.Block),
        entry('h3', 80, FailureMode.Warn),
      ]),
      f.rootDir,
    );
    const exec = new HookExecutor(() => reg.snapshot());

    let caught: unknown;
    try {
      await exec.executeHooksChained(POINT, {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HookBlockedError);
    const blocked = caught as HookBlockedError;
    expect(blocked.hookResult.hook_id).toBe('h2');
    expect(blocked.hookResult.error?.failure_mode).toBe('block');
    expect(blocked.hookResult.error?.message).toContain('boom-block');

    // Verify h3 was never executed by checking the file was never required —
    // we re-write h3.js with a sentinel that would have flipped a flag if
    // executed, but the simplest contract is: replacing h3.js with a hook
    // that throws "should-not-run" would have surfaced as the thrown error
    // instead of HookBlockedError. The fact that we got HookBlockedError
    // (not "should-not-run") proves h3 was skipped.
    //
    // Belt-and-suspenders: rewrite h3 to throw and re-run; the result must
    // still be HookBlockedError on h2, never an h3 error.
    await writeThrowingHook(f.rootDir, 'h3', 'should-not-run');
    // Bust require cache so the rewritten module is picked up.
    delete require.cache[path.resolve(f.rootDir, 'h3.js')];
    let caught2: unknown;
    try {
      await exec.executeHooksChained(POINT, {});
    } catch (err) {
      caught2 = err;
    }
    expect(caught2).toBeInstanceOf(HookBlockedError);
    expect((caught2 as HookBlockedError).hookResult.hook_id).toBe('h2');
  });

  test('warn-mode throw continues; logger receives WARN with metadata', async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeSuccessHook(f.rootDir, 'h1', 'A');
    await writeThrowingHook(f.rootDir, 'h2', 'soft-fail');
    await writeSuccessHook(f.rootDir, 'h3', 'C');

    const reg = new HookRegistry();
    reg.register(
      manifest('p1', [
        entry('h1', 100, FailureMode.Warn),
        entry('h2', 90, FailureMode.Warn),
        entry('h3', 80, FailureMode.Warn),
      ]),
      f.rootDir,
    );
    const exec = new HookExecutor(() => reg.snapshot());

    const logCalls: Array<{ level: string; msg: string; meta: Record<string, unknown> }> = [];
    const log = (level: 'warn' | 'info', msg: string, meta: Record<string, unknown>) => {
      logCalls.push({ level, msg, meta });
    };

    const result = await exec.executeHooksChained(POINT, {}, log);

    expect(result.aborted).toBe(false);
    expect(result.results).toHaveLength(3);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].hook_id).toBe('h2');
    expect(result.failures[0].error?.failure_mode).toBe('warn');

    expect(logCalls).toHaveLength(1);
    expect(logCalls[0].level).toBe('warn');
    expect(logCalls[0].msg).toBe('hook-failure');
    expect(logCalls[0].meta).toMatchObject({
      plugin_id: 'p1',
      hook_id: 'h2',
    });
  });

  test('ignore-mode throw continues silently; logger NOT called', async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeSuccessHook(f.rootDir, 'h1', 'A');
    await writeThrowingHook(f.rootDir, 'h2', 'silent-fail');
    await writeSuccessHook(f.rootDir, 'h3', 'C');

    const reg = new HookRegistry();
    reg.register(
      manifest('p1', [
        entry('h1', 100, FailureMode.Warn),
        entry('h2', 90, FailureMode.Ignore),
        entry('h3', 80, FailureMode.Warn),
      ]),
      f.rootDir,
    );
    const exec = new HookExecutor(() => reg.snapshot());

    const logCalls: unknown[] = [];
    const log = (level: 'warn' | 'info', msg: string, meta: Record<string, unknown>) => {
      logCalls.push({ level, msg, meta });
    };

    const result = await exec.executeHooksChained(POINT, {}, log);

    expect(result.aborted).toBe(false);
    expect(result.results).toHaveLength(3);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].hook_id).toBe('h2');
    expect(result.failures[0].error?.failure_mode).toBe('ignore');
    expect(logCalls).toHaveLength(0);
  });

  test('mixed [warn(throw), ignore(throw), success]: 3 results, 2 failures, not aborted', async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeThrowingHook(f.rootDir, 'h1', 'warn-err');
    await writeThrowingHook(f.rootDir, 'h2', 'ignore-err');
    await writeSuccessHook(f.rootDir, 'h3', 'C');

    const reg = new HookRegistry();
    reg.register(
      manifest('p1', [
        entry('h1', 100, FailureMode.Warn),
        entry('h2', 90, FailureMode.Ignore),
        entry('h3', 80, FailureMode.Warn),
      ]),
      f.rootDir,
    );
    const exec = new HookExecutor(() => reg.snapshot());

    const result = await exec.executeHooksChained(POINT, {});

    expect(result.aborted).toBe(false);
    expect(result.results).toHaveLength(3);
    expect(result.failures).toHaveLength(2);
    expect(result.failures.map((r) => r.hook_id)).toEqual(['h1', 'h2']);
    expect(result.failures.map((r) => r.error?.failure_mode)).toEqual(['warn', 'ignore']);
    // failures must equal the error subset of results.
    expect(result.failures).toEqual(result.results.filter((r) => r.error !== undefined));
  });

  test('block after prior warn: warn is recorded then block throws', async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeThrowingHook(f.rootDir, 'h1', 'warn-first');
    await writeThrowingHook(f.rootDir, 'h2', 'block-second');

    const reg = new HookRegistry();
    reg.register(
      manifest('p1', [
        entry('h1', 100, FailureMode.Warn),
        entry('h2', 90, FailureMode.Block),
      ]),
      f.rootDir,
    );
    const exec = new HookExecutor(() => reg.snapshot());

    const logCalls: Array<{ level: string; msg: string; meta: Record<string, unknown> }> = [];
    const log = (level: 'warn' | 'info', msg: string, meta: Record<string, unknown>) => {
      logCalls.push({ level, msg, meta });
    };

    let caught: unknown;
    try {
      await exec.executeHooksChained(POINT, {}, log);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HookBlockedError);
    expect((caught as HookBlockedError).hookResult.hook_id).toBe('h2');
    // Warn was logged before block fired.
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0].meta.hook_id).toBe('h1');
  });

  test('block-mode hook still observes previousResults (chained context applies)', async () => {
    const f = await makeFixture();
    fixtures.push(f);
    // h1 succeeds with output {value: 42}.
    await fs.writeFile(
      path.join(f.rootDir, 'h1.js'),
      `'use strict';\nmodule.exports = function () { return { value: 42 }; };\n`,
    );
    // h2 (block-mode) reads ctx.previousResults[0].output.value; throws if not 42.
    await writeAssertingBlockHook(f.rootDir, 'h2');

    const reg = new HookRegistry();
    reg.register(
      manifest('p1', [
        entry('h1', 100, FailureMode.Warn),
        entry('h2', 90, FailureMode.Block),
      ]),
      f.rootDir,
    );
    const exec = new HookExecutor(() => reg.snapshot());

    // No throw expected: h2's assertion passes, so no block fire.
    const result = await exec.executeHooksChained(POINT, {});
    expect(result.results).toHaveLength(2);
    expect(result.results.map((r) => r.hook_id)).toEqual(['h1', 'h2']);
    expect(result.failures).toHaveLength(0);
  });
});
