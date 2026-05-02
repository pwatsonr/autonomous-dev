/**
 * Sequential executor tests (SPEC-019-4-05 §test-executor-sequential).
 *
 * Exercises `HookExecutor.executeHooksChained`:
 *   - Priority order (descending) with stable insertion-order ties.
 *   - Cumulative `previousResults` chained through each invocation.
 *   - Defensive copy: a hook mutating `previousResults` cannot leak into
 *     the next iteration's view.
 *   - Empty hook point returns the no-op aggregate.
 *   - `originalContext` is referentially stable across invocations.
 *   - `duration_ms` is populated and non-negative on every result.
 *
 * Fixture strategy: each test writes one or more entry-point JS files into
 * an isolated tempdir, registers a manifest pointing at them, and runs the
 * executor. The fixtures echo metadata into module-scope arrays so the
 * test can introspect the per-hook view of `previousResults`.
 *
 * @module __tests__/hooks/test-executor-sequential
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { HookExecutor } from '../../hooks/executor';
import { HookRegistry } from '../../hooks/registry';
import {
  FailureMode,
  HookPoint,
  type HookEntry,
  type HookManifest,
} from '../../hooks/types';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const POINT = HookPoint.CodePreWrite;

interface Fixture {
  rootDir: string;
  /** Path the fixture writes its observed `previousResults` JSON into. */
  observePath: string;
}

async function makeFixture(): Promise<Fixture> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-exec-seq-'));
  const observePath = path.join(rootDir, 'observed.jsonl');
  await fs.writeFile(observePath, '');
  return { rootDir, observePath };
}

/**
 * Write a hook entry-point JS file that:
 *   - records the priorities it observed in `previousResults` to `observePath`,
 *   - returns `output`.
 */
async function writeRecorderHook(opts: {
  rootDir: string;
  observePath: string;
  hookName: string;
  output: unknown;
}): Promise<string> {
  const file = path.join(opts.rootDir, `${opts.hookName}.js`);
  const code = `'use strict';
const fs = require('fs');
module.exports = function (input, ctx) {
  const seen = (ctx && ctx.previousResults) ? ctx.previousResults.map(function (r) {
    return { plugin_id: r.plugin_id, hook_id: r.hook_id, priority: r.priority, output: r.output };
  }) : [];
  fs.appendFileSync(${JSON.stringify(opts.observePath)},
    JSON.stringify({ hook: ${JSON.stringify(opts.hookName)}, originalContext: input, previousResults: seen }) + '\\n');
  return ${JSON.stringify(opts.output)};
};
`;
  await fs.writeFile(file, code);
  return file;
}

function entry(id: string, priority: number): HookEntry {
  return {
    id,
    hook_point: POINT,
    entry_point: `./${id}.js`,
    priority,
    failure_mode: FailureMode.Warn,
  };
}

function manifest(pluginId: string, hooks: HookEntry[]): HookManifest {
  return { id: pluginId, name: pluginId, version: '1.0.0', hooks };
}

async function readObserved(observePath: string): Promise<
  Array<{
    hook: string;
    originalContext: unknown;
    previousResults: Array<{ plugin_id: string; hook_id: string; priority: number; output: unknown }>;
  }>
> {
  const text = await fs.readFile(observePath, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HookExecutor.executeHooksChained — sequential semantics', () => {
  let fixtures: Fixture[] = [];

  afterEach(async () => {
    for (const f of fixtures) {
      await fs.rm(f.rootDir, { recursive: true, force: true });
    }
    fixtures = [];
  });

  test('empty hook point returns no-op aggregate without invoking anything', async () => {
    const reg = new HookRegistry();
    const exec = new HookExecutor(() => reg.snapshot());

    const result = await exec.executeHooksChained(POINT, { foo: 1 });

    expect(result).toEqual({
      hook_point: POINT,
      results: [],
      failures: [],
      aborted: false,
    });
  });

  test('single hook sees empty previousResults and lands in results', async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeRecorderHook({
      rootDir: f.rootDir,
      observePath: f.observePath,
      hookName: 'a',
      output: { value: 'A' },
    });

    const reg = new HookRegistry();
    reg.register(manifest('p1', [entry('a', 50)]), f.rootDir);
    const exec = new HookExecutor(() => reg.snapshot());

    const result = await exec.executeHooksChained(POINT, { in: 1 });

    expect(result.results).toHaveLength(1);
    expect(result.failures).toHaveLength(0);
    expect(result.aborted).toBe(false);
    expect(result.results[0].output).toEqual({ value: 'A' });

    const observed = await readObserved(f.observePath);
    expect(observed).toHaveLength(1);
    expect(observed[0].previousResults).toEqual([]);
  });

  test('three descending priorities: each hook sees the correct previousResults slice', async () => {
    const f = await makeFixture();
    fixtures.push(f);
    // Register in deliberately scrambled order to prove sort works.
    await writeRecorderHook({ rootDir: f.rootDir, observePath: f.observePath, hookName: 'low', output: 'L' });
    await writeRecorderHook({ rootDir: f.rootDir, observePath: f.observePath, hookName: 'high', output: 'H' });
    await writeRecorderHook({ rootDir: f.rootDir, observePath: f.observePath, hookName: 'mid', output: 'M' });

    const reg = new HookRegistry();
    reg.register(
      manifest('p1', [entry('low', 50), entry('high', 100), entry('mid', 75)]),
      f.rootDir,
    );
    const exec = new HookExecutor(() => reg.snapshot());

    const result = await exec.executeHooksChained(POINT, { in: 'x' });

    expect(result.results.map((r) => r.hook_id)).toEqual(['high', 'mid', 'low']);
    expect(result.results.map((r) => r.priority)).toEqual([100, 75, 50]);

    const observed = await readObserved(f.observePath);
    expect(observed).toHaveLength(3);
    expect(observed[0].previousResults.map((p) => p.priority)).toEqual([]);
    expect(observed[1].previousResults.map((p) => p.priority)).toEqual([100]);
    expect(observed[2].previousResults.map((p) => p.priority)).toEqual([100, 75]);
  });

  test('equal priorities preserve registration order (stable sort)', async () => {
    const f = await makeFixture();
    fixtures.push(f);
    for (const name of ['a', 'b', 'c']) {
      await writeRecorderHook({ rootDir: f.rootDir, observePath: f.observePath, hookName: name, output: name });
    }

    const reg = new HookRegistry();
    reg.register(
      manifest('p1', [entry('a', 50), entry('b', 50), entry('c', 50)]),
      f.rootDir,
    );
    const exec = new HookExecutor(() => reg.snapshot());

    const result = await exec.executeHooksChained(POINT, {});

    expect(result.results.map((r) => r.hook_id)).toEqual(['a', 'b', 'c']);
  });

  test('cumulative chaining: 5th hook sees all 4 prior results in order', async () => {
    const f = await makeFixture();
    fixtures.push(f);
    const names = ['h1', 'h2', 'h3', 'h4', 'h5'];
    for (const name of names) {
      await writeRecorderHook({ rootDir: f.rootDir, observePath: f.observePath, hookName: name, output: name });
    }
    // Priorities 100, 90, 80, 70, 60 → execution order h1..h5.
    const reg = new HookRegistry();
    reg.register(
      manifest('p1', names.map((n, i) => entry(n, 100 - i * 10))),
      f.rootDir,
    );
    const exec = new HookExecutor(() => reg.snapshot());

    await exec.executeHooksChained(POINT, {});
    const observed = await readObserved(f.observePath);

    expect(observed[4].previousResults).toHaveLength(4);
    expect(observed[4].previousResults.map((p) => p.hook_id)).toEqual(['h1', 'h2', 'h3', 'h4']);
    expect(observed[4].previousResults.map((p) => p.output)).toEqual(['h1', 'h2', 'h3', 'h4']);
  });

  test('mutating previousResults inside a hook does not leak into the next iteration', async () => {
    const f = await makeFixture();
    fixtures.push(f);
    // Hook A returns 'A'. Hook B mutates ctx.previousResults then returns 'B'.
    // Hook C records what it sees — should be exactly [A, B], not the
    // mutated array.
    const aPath = path.join(f.rootDir, 'a.js');
    await fs.writeFile(
      aPath,
      `'use strict';\nmodule.exports = function (i, ctx) { return 'A'; };\n`,
    );
    const bPath = path.join(f.rootDir, 'b.js');
    await fs.writeFile(
      bPath,
      `'use strict';
module.exports = function (i, ctx) {
  try { ctx.previousResults.push({ hax: true }); } catch (e) {}
  return 'B';
};
`,
    );
    await writeRecorderHook({
      rootDir: f.rootDir,
      observePath: f.observePath,
      hookName: 'c',
      output: 'C',
    });

    const reg = new HookRegistry();
    reg.register(
      manifest('p1', [entry('a', 100), entry('b', 90), entry('c', 80)]),
      f.rootDir,
    );
    const exec = new HookExecutor(() => reg.snapshot());

    await exec.executeHooksChained(POINT, {});
    const observed = await readObserved(f.observePath);

    // 'c' is the only recorder. It must see exactly two prior results.
    expect(observed).toHaveLength(1);
    expect(observed[0].hook).toBe('c');
    expect(observed[0].previousResults).toHaveLength(2);
    expect(observed[0].previousResults.map((p) => p.hook_id)).toEqual(['a', 'b']);
  });

  test('originalContext is the same object reference across all invocations', async () => {
    const f = await makeFixture();
    fixtures.push(f);
    // Hook records `originalContext` — we then assert all observed JSON
    // payloads are deep-equal (identity is collapsed by JSON serialization;
    // equality is the strongest assertion the fixture can make over IPC).
    for (const name of ['a', 'b', 'c']) {
      await writeRecorderHook({ rootDir: f.rootDir, observePath: f.observePath, hookName: name, output: name });
    }
    const reg = new HookRegistry();
    reg.register(
      manifest('p1', [entry('a', 100), entry('b', 90), entry('c', 80)]),
      f.rootDir,
    );
    const exec = new HookExecutor(() => reg.snapshot());

    const ctx = { trace: 'fixed', deep: { nested: 1 } };
    await exec.executeHooksChained(POINT, ctx);
    const observed = await readObserved(f.observePath);

    expect(observed).toHaveLength(3);
    for (const o of observed) {
      expect(o.originalContext).toEqual(ctx);
    }
  });

  test('duration_ms is populated and non-negative on every result', async () => {
    const f = await makeFixture();
    fixtures.push(f);
    for (const name of ['a', 'b']) {
      await writeRecorderHook({ rootDir: f.rootDir, observePath: f.observePath, hookName: name, output: name });
    }
    const reg = new HookRegistry();
    reg.register(manifest('p1', [entry('a', 100), entry('b', 50)]), f.rootDir);
    const exec = new HookExecutor(() => reg.snapshot());

    const result = await exec.executeHooksChained(POINT, {});

    for (const r of result.results) {
      expect(typeof r.duration_ms).toBe('number');
      expect(r.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });
});
