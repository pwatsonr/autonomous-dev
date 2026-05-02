/**
 * Integration test: discovery -> registry -> executor -> reload
 * (SPEC-019-1-05).
 *
 * Runs entirely in-process against a temp plugin directory copied from
 * the SPEC-019-1-02 fixtures. No daemon spawn (the SIGUSR1 / supervisor
 * wiring is the operator-facing surface and is intentionally not bound
 * in PLAN-019-1's hook engine).
 *
 * @module __tests__/hooks/test-integration
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PluginDiscovery } from '../../hooks/discovery';
import { HookRegistry } from '../../hooks/registry';
import { HookExecutor } from '../../hooks/executor';
import { ReloadController } from '../../hooks/reload-controller';
import { HookPoint } from '../../hooks/types';
import { validateManifest } from '../../../tests/helpers/schema-validator';

const FIXTURES = path.resolve(__dirname, '../../../tests/fixtures/plugins');

async function copyFixture(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      await copyFixture(s, d);
    } else {
      await fs.copyFile(s, d);
    }
  }
}

describe('hook engine integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-hook-int-'));
    await copyFixture(path.join(FIXTURES, 'simple'), path.join(tempDir, 'simple'));
    await copyFixture(path.join(FIXTURES, 'multi-hook'), path.join(tempDir, 'multi-hook'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('discover -> register -> execute happy path', async () => {
    const disc = new PluginDiscovery(validateManifest);
    const reg = new HookRegistry();
    const results = await disc.scan(tempDir);
    for (const r of results) {
      if (r.manifest) reg.register(r.manifest, path.dirname(r.manifestPath));
    }
    expect(reg.size()).toBe(4); // 1 simple + 3 multi-hook

    const exec = new HookExecutor(() => reg.snapshot());
    const r1 = await exec.executeHooks(HookPoint.IntakePreValidate, { foo: 1 });
    expect(r1.invocations).toHaveLength(1);
    expect(r1.invocations[0].status).toBe('ok');
    expect(r1.invocations[0].result).toMatchObject({ fixture: 'simple', received: { foo: 1 } });

    const r2 = await exec.executeHooks(HookPoint.CodePreWrite, { bar: 2 });
    expect(r2.invocations).toHaveLength(3);
    expect(r2.invocations.map((i) => i.status)).toEqual(['ok', 'ok', 'ok']);
    // Priority order: a(100), c(75), b(50).
    expect(r2.invocations.map((i) => (i.result as { marker: string }).marker)).toEqual(['a', 'c', 'b']);
  });

  test('reload picks up a removed plugin (diff.removed)', async () => {
    const disc = new PluginDiscovery(validateManifest);
    const reg = new HookRegistry();
    const ctl = new ReloadController(disc, reg, tempDir);

    // Initial population.
    await ctl.reload();
    expect(reg.size()).toBe(4);

    // Remove multi-hook directory, reload.
    await fs.rm(path.join(tempDir, 'multi-hook'), { recursive: true, force: true });
    const diff = await ctl.reload();
    expect(reg.size()).toBe(1);
    expect(diff.removed).toHaveLength(3);
    expect(diff.added).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });

  test('reload picks up a priority change (diff.changed)', async () => {
    const disc = new PluginDiscovery(validateManifest);
    const reg = new HookRegistry();
    const ctl = new ReloadController(disc, reg, tempDir);

    await ctl.reload();

    // Bump multi-hook/alpha from 100 -> 200.
    const manifestPath = path.join(tempDir, 'multi-hook', 'hooks.json');
    const m = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    m.hooks[0].priority = 200;
    await fs.writeFile(manifestPath, JSON.stringify(m, null, 2));

    const diff = await ctl.reload();
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].pluginId).toBe('multi-hook');
    expect(diff.changed[0].hookId).toBe('alpha');
    expect(diff.changed[0].before).toBe(100);
    expect(diff.changed[0].after).toBe(200);
  });

  test('snapshot stability: in-flight execution unaffected by mid-flight reload', async () => {
    const disc = new PluginDiscovery(validateManifest);
    const reg = new HookRegistry();
    const ctl = new ReloadController(disc, reg, tempDir);
    await ctl.reload();

    const exec = new HookExecutor(() => reg.snapshot());

    // Start an executeHooks call. Replace the registry contents from the
    // outside while the call is in-flight (simulated by calling clear()
    // synchronously between snapshot capture and iteration). This is the
    // contract the executor's per-call snapshot guarantees.
    const inFlight = exec.executeHooks(HookPoint.CodePreWrite, {});
    // Mutate the live registry; snapshot was already captured.
    reg.clear();
    const result = await inFlight;
    expect(result.invocations).toHaveLength(3);
    expect(result.invocations.every((i) => i.status === 'ok')).toBe(true);
  });

  test('reload debounce: rapid concurrent reload() calls share one Promise', async () => {
    const disc = new PluginDiscovery(validateManifest);
    const reg = new HookRegistry();
    const ctl = new ReloadController(disc, reg, tempDir);

    const p1 = ctl.reload();
    const p2 = ctl.reload();
    const p3 = ctl.reload();
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);
    await Promise.all([p1, p2, p3]);
    expect(reg.size()).toBe(4);
  });

  test('malformed plugin in directory does not block other plugins from loading', async () => {
    await copyFixture(path.join(FIXTURES, 'malformed'), path.join(tempDir, 'malformed'));
    const disc = new PluginDiscovery(validateManifest);
    const reg = new HookRegistry();
    const ctl = new ReloadController(disc, reg, tempDir);
    await ctl.reload();
    // simple + multi-hook still register; malformed is silently skipped.
    expect(reg.size()).toBe(4);
  });

  test('executor catches a thrown hook and continues', async () => {
    // Add a third plugin whose entry-point throws.
    const bad = path.join(tempDir, 'bad');
    await fs.mkdir(bad);
    await fs.writeFile(
      path.join(bad, 'hook.js'),
      "module.exports = function() { throw new Error('boom'); };\n",
    );
    await fs.writeFile(
      path.join(bad, 'hooks.json'),
      JSON.stringify({
        id: 'bad',
        name: 'bad',
        version: '1.0.0',
        hooks: [
          {
            id: 'boom',
            hook_point: 'code-pre-write',
            entry_point: './hook.js',
            priority: 200,
            failure_mode: 'warn',
          },
        ],
      }),
    );

    const disc = new PluginDiscovery(validateManifest);
    const reg = new HookRegistry();
    const ctl = new ReloadController(disc, reg, tempDir);
    await ctl.reload();

    const exec = new HookExecutor(() => reg.snapshot());
    const result = await exec.executeHooks(HookPoint.CodePreWrite, {});
    // 4 hooks total at code-pre-write: bad@200, alpha@100, charlie@75, bravo@50.
    expect(result.invocations).toHaveLength(4);
    expect(result.invocations[0].status).toBe('error');
    expect(result.invocations[0].error).toContain('boom');
    // Subsequent hooks still run.
    expect(result.invocations.slice(1).every((i) => i.status === 'ok')).toBe(true);
  });
});
