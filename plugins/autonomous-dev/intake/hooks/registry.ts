/**
 * HookRegistry — in-memory map of HookPoint -> RegisteredHook[]
 * (SPEC-019-1-03, Task 4).
 *
 * Lists are kept sorted in descending priority order. Ties preserve
 * registration order (stable sort, guaranteed by Node >= 12). The registry
 * supports copy-on-write snapshots so SPEC-019-1-04's reload path can swap
 * the active state atomically without disturbing in-flight executions.
 *
 * @module intake/hooks/registry
 */

import * as path from 'node:path';
import { HookPoint, type HookEntry, type HookManifest } from './types';

/** A registered hook resolved against its plugin. */
export interface RegisteredHook {
  pluginId: string;
  pluginVersion: string;
  /** Absolute path to the entry-point file. */
  resolvedEntryPoint: string;
  hook: HookEntry;
}

/** Read-only view of the registry's internal map. */
export type RegistrySnapshot = ReadonlyMap<HookPoint, ReadonlyArray<RegisteredHook>>;

export class HookRegistry {
  private byPoint: Map<HookPoint, RegisteredHook[]> = new Map();

  /**
   * Register every hook in the manifest under its declared HookPoint.
   *
   * Stable sort: hooks at equal priority preserve registration order.
   * See PLAN-019-1 risk register for rationale.
   */
  register(plugin: HookManifest, pluginRoot: string): void {
    for (const hook of plugin.hooks) {
      const resolved: RegisteredHook = {
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        resolvedEntryPoint: path.resolve(pluginRoot, hook.entry_point),
        hook,
      };

      const list = this.byPoint.get(hook.hook_point) ?? [];
      // Naive push + stable sort. List sizes are small (handful per point);
      // micro-opt to binary-search insertion is deferred per spec notes.
      list.push(resolved);
      list.sort((a, b) => b.hook.priority - a.hook.priority);
      this.byPoint.set(hook.hook_point, list);
    }
  }

  /**
   * Remove every hook whose `pluginId` matches.
   *
   * Returns the total count removed. O(n) over all registered hooks.
   */
  unregister(pluginId: string): number {
    let removed = 0;
    for (const [point, list] of this.byPoint.entries()) {
      const before = list.length;
      const next = list.filter((h) => h.pluginId !== pluginId);
      removed += before - next.length;
      if (next.length === 0) {
        this.byPoint.delete(point);
      } else if (next.length !== before) {
        this.byPoint.set(point, next);
      }
    }
    return removed;
  }

  /**
   * Return the (read-only) hook list for a point. May be empty.
   *
   * The return value's underlying array is the live storage. Callers MUST
   * NOT mutate. Use `snapshot()` for cross-thread / async safety.
   */
  getHooksForPoint(point: HookPoint): ReadonlyArray<RegisteredHook> {
    return this.byPoint.get(point) ?? [];
  }

  /** Empty the registry. */
  clear(): void {
    this.byPoint.clear();
  }

  /** Total registered hooks across all points. */
  size(): number {
    let total = 0;
    for (const list of this.byPoint.values()) total += list.length;
    return total;
  }

  /**
   * Return a deep-frozen snapshot. Both the outer Map and each value array
   * are frozen via `Object.freeze`. The `RegisteredHook` objects themselves
   * are not cloned — they are treated as immutable by convention.
   */
  snapshot(): RegistrySnapshot {
    const copy = new Map<HookPoint, ReadonlyArray<RegisteredHook>>();
    for (const [point, list] of this.byPoint.entries()) {
      copy.set(point, Object.freeze([...list]));
    }
    return Object.freeze(copy) as RegistrySnapshot;
  }

  /**
   * Internal hook for ReloadController only. Replaces the live map atomically
   * with the contents of another registry. Public consumers must use the
   * documented `register` / `unregister` API.
   *
   * @internal SPEC-019-1-04 reload-controller atomic swap.
   */
  _replaceInternal(other: HookRegistry): void {
    this.byPoint = other.byPoint;
  }
}
