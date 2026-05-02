/**
 * HookRegistry unit tests (SPEC-019-1-05).
 *
 * @module __tests__/hooks/test-registry
 */

import * as path from 'node:path';
import { HookRegistry } from '../../hooks/registry';
import {
  FailureMode,
  HookPoint,
  type HookEntry,
  type HookManifest,
} from '../../hooks/types';

function entry(id: string, priority: number, point: HookPoint = HookPoint.CodePreWrite): HookEntry {
  return {
    id,
    hook_point: point,
    entry_point: `./${id}.js`,
    priority,
    failure_mode: FailureMode.Warn,
  };
}

function manifest(id: string, hooks: HookEntry[]): HookManifest {
  return { id, name: id, version: '1.0.0', hooks };
}

const ROOT = '/tmp/plugin-root';

describe('HookRegistry', () => {
  let reg: HookRegistry;

  beforeEach(() => {
    reg = new HookRegistry();
  });

  test('empty registry: getHooksForPoint returns empty array', () => {
    expect(reg.getHooksForPoint(HookPoint.CodePreWrite)).toEqual([]);
    expect(reg.size()).toBe(0);
  });

  test('registers all hooks for a single plugin', () => {
    reg.register(manifest('p1', [entry('a', 100), entry('b', 50)]), ROOT);
    expect(reg.size()).toBe(2);
    expect(reg.getHooksForPoint(HookPoint.CodePreWrite)).toHaveLength(2);
  });

  test('priorities 100/50/75 in declaration order yield list [100, 75, 50]', () => {
    reg.register(
      manifest('p1', [entry('a', 100), entry('b', 50), entry('c', 75)]),
      ROOT,
    );
    const hooks = reg.getHooksForPoint(HookPoint.CodePreWrite);
    expect(hooks.map((h) => h.hook.priority)).toEqual([100, 75, 50]);
  });

  test('tie ordering preserves registration order', () => {
    reg.register(
      manifest('p1', [entry('first', 50), entry('second', 50)]),
      ROOT,
    );
    const hooks = reg.getHooksForPoint(HookPoint.CodePreWrite);
    expect(hooks.map((h) => h.hook.id)).toEqual(['first', 'second']);
  });

  test('unregister removes all hooks from a plugin and returns the count', () => {
    reg.register(manifest('p1', [entry('a', 100), entry('b', 50)]), ROOT);
    reg.register(manifest('p2', [entry('c', 75)]), ROOT);
    const removed = reg.unregister('p1');
    expect(removed).toBe(2);
    expect(reg.size()).toBe(1);
    expect(reg.getHooksForPoint(HookPoint.CodePreWrite)[0].pluginId).toBe('p2');
  });

  test('unregister of unknown plugin id returns 0', () => {
    reg.register(manifest('p1', [entry('a', 100)]), ROOT);
    expect(reg.unregister('does-not-exist')).toBe(0);
  });

  test('clear empties every list; size returns 0', () => {
    reg.register(manifest('p1', [entry('a', 100)]), ROOT);
    reg.register(manifest('p2', [entry('b', 50, HookPoint.DeployPre)]), ROOT);
    reg.clear();
    expect(reg.size()).toBe(0);
    expect(reg.getHooksForPoint(HookPoint.CodePreWrite)).toEqual([]);
    expect(reg.getHooksForPoint(HookPoint.DeployPre)).toEqual([]);
  });

  test('snapshot is deep-frozen', () => {
    reg.register(manifest('p1', [entry('a', 100), entry('b', 50)]), ROOT);
    const snap = reg.snapshot();
    expect(Object.isFrozen(snap)).toBe(true);
    for (const list of snap.values()) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });

  test('mutating a snapshot array throws (frozen)', () => {
    reg.register(manifest('p1', [entry('a', 100)]), ROOT);
    const snap = reg.snapshot();
    const list = snap.get(HookPoint.CodePreWrite) as readonly unknown[];
    expect(() => (list as unknown[]).push({} as never)).toThrow();
  });

  test('stability sweep: 100 hooks at random priorities preserve insertion order at every priority', () => {
    const rand = mulberry32(42);
    const inserts: Array<{ id: string; priority: number; index: number }> = [];
    for (let i = 0; i < 100; i++) {
      const priority = Math.floor(rand() * 5) * 10; // 5 distinct priority bands
      const id = `h-${i}`;
      inserts.push({ id, priority, index: i });
      reg.register(manifest(`pl-${i}`, [entry(id, priority)]), ROOT);
    }
    const list = reg.getHooksForPoint(HookPoint.CodePreWrite);
    // Group by priority and check insertion order is preserved within each band.
    const byPrio = new Map<number, string[]>();
    for (const h of list) {
      const arr = byPrio.get(h.hook.priority) ?? [];
      arr.push(h.hook.id);
      byPrio.set(h.hook.priority, arr);
    }
    for (const [prio, ids] of byPrio.entries()) {
      const expected = inserts
        .filter((x) => x.priority === prio)
        .sort((a, b) => a.index - b.index)
        .map((x) => x.id);
      expect(ids).toEqual(expected);
    }
  });

  test('resolvedEntryPoint is absolute and normalized', () => {
    reg.register(manifest('p1', [entry('a', 100)]), '/tmp/plug');
    const list = reg.getHooksForPoint(HookPoint.CodePreWrite);
    const resolved = list[0].resolvedEntryPoint;
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved).not.toContain('..');
  });
});

// Tiny seeded PRNG for the stability sweep — keeps the test deterministic.
function mulberry32(seed: number): () => number {
  let t = seed;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
