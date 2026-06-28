/**
 * Smoke tests for the best-effort hook-emission CLI (#561 item 1 / #568 part 2).
 *
 * Tests the `main(argv, deps)` seam exported from bin/hooks-cli.ts. A
 * pre-built HookRegistry is injected so no on-disk plugin scan happens.
 * stdout is captured by temporarily replacing process.stdout.write.
 *
 * Locks:
 *   - Empty registry → exit 0, prints `ran:0` (the live no-op contract).
 *   - Unknown hook-point → non-zero (the ONLY non-zero path).
 *   - Registry with one matching hook → that hook runs (ran:1), exit 0.
 *   - Non-`emit` command → exit 0 (best-effort, never blocks).
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { main } from '../../bin/hooks-cli';
import { HookRegistry } from '../../intake/hooks/registry';
import { FailureMode, HookPoint, type HookManifest } from '../../intake/hooks/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function trackedTmp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** Run `main(argv, deps)` while capturing stdout. */
async function runCli(
  argv: string[],
  deps: { registry?: HookRegistry } = {},
): Promise<{ code: number; output: string }> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
  try {
    const code = await main(argv, deps);
    return { code, output: chunks.join('') };
  } finally {
    process.stdout.write = originalWrite;
  }
}

const BASE_ARGS = ['--request-id', 'R1', '--repo', '/x', '--phase', 'plan'];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hooks-cli main()', () => {
  test('empty registry → exit 0, ran:0 (live no-op)', async () => {
    const registry = new HookRegistry();
    const { code, output } = await runCli(['emit', 'plan-pre-author', ...BASE_ARGS], { registry });
    expect(code).toBe(0);
    const summary = JSON.parse(output.trim());
    expect(summary).toEqual({
      point: 'plan-pre-author',
      ran: 0,
      aborted: false,
      failures: 0,
    });
  });

  test('spec-pre-author with empty registry → exit 0, ran:0', async () => {
    const registry = new HookRegistry();
    const { code, output } = await runCli(
      ['emit', 'spec-pre-author', '--request-id', 'R2', '--repo', '/y', '--phase', 'spec'],
      { registry },
    );
    expect(code).toBe(0);
    expect(JSON.parse(output.trim()).point).toBe('spec-pre-author');
    expect(JSON.parse(output.trim()).ran).toBe(0);
  });

  test('unknown hook-point → non-zero (the only non-zero path)', async () => {
    const registry = new HookRegistry();
    const { code } = await runCli(['emit', 'not-a-real-hook', ...BASE_ARGS], { registry });
    expect(code).not.toBe(0);
  });

  test('registry with one matching hook → it runs (ran:1)', async () => {
    const rootDir = await trackedTmp('ad-hooks-cli-');
    const entryPath = path.join(rootDir, 'hook.js');
    // A trivial hook entry-point: a function that returns a marker object.
    await fs.writeFile(entryPath, 'module.exports = function () { return { ok: true }; };\n');

    const manifest: HookManifest = {
      id: 'fixture-plugin',
      name: 'Fixture Plugin',
      version: '1.0.0',
      hooks: [
        {
          id: 'plan-observer',
          hook_point: HookPoint.PlanPreAuthor,
          entry_point: './hook.js',
          priority: 100,
          failure_mode: FailureMode.Warn,
        },
      ],
    };

    const registry = new HookRegistry();
    registry.register(manifest, rootDir);

    const { code, output } = await runCli(['emit', 'plan-pre-author', ...BASE_ARGS], { registry });
    expect(code).toBe(0);
    const summary = JSON.parse(output.trim());
    expect(summary.point).toBe('plan-pre-author');
    expect(summary.ran).toBe(1);
    expect(summary.aborted).toBe(false);
    expect(summary.failures).toBe(0);
  });

  test('non-emit command → exit 0, no output (best-effort, never blocks)', async () => {
    const registry = new HookRegistry();
    const { code } = await runCli(['list'], { registry });
    expect(code).toBe(0);
  });
});
