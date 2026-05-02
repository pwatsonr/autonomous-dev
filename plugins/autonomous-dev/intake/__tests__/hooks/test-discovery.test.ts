/**
 * PluginDiscovery unit tests (SPEC-019-1-05).
 *
 * Runs against the fixture plugins from SPEC-019-1-02 and against
 * temporary directories built per test for isolation.
 *
 * @module __tests__/hooks/test-discovery
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PluginDiscovery, type DiscoveryError } from '../../hooks/discovery';
import { validateManifest } from '../../../tests/helpers/schema-validator';

const FIXTURES = path.resolve(__dirname, '../../../tests/fixtures/plugins');

async function mkTemp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ad-discovery-'));
}

async function rmTemp(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

describe('PluginDiscovery.scan', () => {
  let discovery: PluginDiscovery;

  beforeEach(() => {
    discovery = new PluginDiscovery(validateManifest);
  });

  test('returns empty for non-existent rootDir', async () => {
    const results = await discovery.scan('/definitely/not/a/real/path');
    expect(results).toEqual([]);
  });

  test('returns 3 results for simple+multi-hook+malformed in lex order', async () => {
    const results = await discovery.scan(FIXTURES);
    // Lex order: malformed, multi-hook, simple.
    const ids = results.map((r) => path.basename(path.dirname(r.manifestPath)));
    expect(ids).toEqual(['malformed', 'multi-hook', 'simple']);
    expect(results).toHaveLength(3);
  });

  test('simple and multi-hook results are ok; malformed has /id error', async () => {
    const results = await discovery.scan(FIXTURES);
    const byName: Record<string, typeof results[number]> = {};
    for (const r of results) {
      byName[path.basename(path.dirname(r.manifestPath))] = r;
    }
    expect(byName.simple.errors).toEqual([]);
    expect(byName.simple.manifest?.id).toBe('simple');
    expect(byName['multi-hook'].errors).toEqual([]);
    expect(byName['multi-hook'].manifest?.hooks).toHaveLength(3);

    expect(byName.malformed.manifest).toBeUndefined();
    expect(byName.malformed.errors.length).toBeGreaterThan(0);
    const idErr = byName.malformed.errors.find((e: DiscoveryError) => e.pointer === '/id');
    expect(idErr).toBeDefined();
    expect(idErr?.code).toBe('SCHEMA_ERROR');
  });

  test('skips files at the top level of rootDir', async () => {
    const dir = await mkTemp();
    try {
      await fs.writeFile(path.join(dir, 'README.md'), '# nothing');
      await fs.mkdir(path.join(dir, 'good'));
      await fs.writeFile(
        path.join(dir, 'good', 'hooks.json'),
        JSON.stringify({ id: 'good', name: 'G', version: '1.0.0', hooks: [] }),
      );
      const results = await discovery.scan(dir);
      expect(results).toHaveLength(1);
      expect(results[0].manifest?.id).toBe('good');
    } finally {
      await rmTemp(dir);
    }
  });

  test('skips hidden directories (name starts with .)', async () => {
    const dir = await mkTemp();
    try {
      await fs.mkdir(path.join(dir, '.git'));
      await fs.writeFile(
        path.join(dir, '.git', 'hooks.json'),
        JSON.stringify({ id: 'shouldnt-appear', name: 'X', version: '1.0.0', hooks: [] }),
      );
      const results = await discovery.scan(dir);
      expect(results).toEqual([]);
    } finally {
      await rmTemp(dir);
    }
  });

  test('does NOT execute any plugin entry-point during scan', async () => {
    // Hook a marker into module._load via Node's require cache: if discovery
    // were to require the fixture entry-point, the cache would gain an entry.
    const before = Object.keys(require.cache).filter((k) => k.includes('fixtures/plugins'));
    await discovery.scan(FIXTURES);
    const after = Object.keys(require.cache).filter((k) => k.includes('fixtures/plugins'));
    expect(after).toEqual(before);
  });

  test('parseManifest on bad JSON returns one PARSE_ERROR', async () => {
    const dir = await mkTemp();
    try {
      const p = path.join(dir, 'broken.json');
      await fs.writeFile(p, 'not json');
      const result = await discovery.parseManifest(p);
      expect(result.manifest).toBeUndefined();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('PARSE_ERROR');
    } finally {
      await rmTemp(dir);
    }
  });

  test('validateManifest delegates to injected validator (identity)', () => {
    const sentinel: DiscoveryError[] = [
      { manifestPath: '/x', code: 'SCHEMA_ERROR', message: 'sentinel' },
    ];
    const mock = new PluginDiscovery(() => sentinel);
    expect(mock.validateManifest({}, '/x')).toBe(sentinel);
  });

  test('symlink to a real plugin directory is followed', async () => {
    if (process.platform === 'win32') return;
    const dir = await mkTemp();
    try {
      const targetSimple = path.join(FIXTURES, 'simple');
      const link = path.join(dir, 'linked-simple');
      await fs.symlink(targetSimple, link, 'dir');
      const results = await discovery.scan(dir);
      expect(results).toHaveLength(1);
      expect(results[0].manifest?.id).toBe('simple');
    } finally {
      await rmTemp(dir);
    }
  });

  test('Unicode plugin directory name round-trips', async () => {
    const dir = await mkTemp();
    try {
      const sub = path.join(dir, 'héllo-plugin');
      await fs.mkdir(sub);
      await fs.writeFile(
        path.join(sub, 'hooks.json'),
        JSON.stringify({ id: 'hello', name: 'Héllo', version: '1.0.0', hooks: [] }),
      );
      const results = await discovery.scan(dir);
      expect(results).toHaveLength(1);
      expect(results[0].manifest?.id).toBe('hello');
      expect(results[0].manifest?.name).toBe('Héllo');
    } finally {
      await rmTemp(dir);
    }
  });

  test('50-plugin scan completes in < 500ms (jest budget)', async () => {
    const dir = await mkTemp();
    try {
      const tasks: Promise<void>[] = [];
      for (let i = 0; i < 50; i++) {
        const sub = path.join(dir, `plug-${String(i).padStart(2, '0')}`);
        tasks.push(
          (async () => {
            await fs.mkdir(sub);
            await fs.writeFile(
              path.join(sub, 'hooks.json'),
              JSON.stringify({ id: `plug-${i}`, name: 'P', version: '1.0.0', hooks: [] }),
            );
          })(),
        );
      }
      await Promise.all(tasks);

      const start = Date.now();
      const results = await discovery.scan(dir);
      const elapsed = Date.now() - start;
      expect(results).toHaveLength(50);
      // The spec target is <100ms on local SSD; CI hardware is variable so
      // the assertion budget is widened to <500ms while the actual ms is
      // surfaced for visibility.
      // eslint-disable-next-line no-console
      console.info(`50-plugin scan took ${elapsed}ms`);
      expect(elapsed).toBeLessThan(500);
    } finally {
      await rmTemp(dir);
    }
  });
});
