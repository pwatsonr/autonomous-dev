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
import {
  HookPoint,
  isReviewerSlotObject,
  type HookEntry,
  type HookManifest,
  type ReviewGate,
} from './types';

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
   * Secondary index: ReviewGate → reviewer-slot hooks declared for that gate.
   *
   * Maintained in lockstep with `byPoint` by `register()`/`unregister()`.
   * Only hooks whose `reviewer_slot` is an object form (rich `ReviewerSlot`
   * declaration per SPEC-019-4-01) populate this index; the legacy string
   * form is treated as opaque and not gate-routable.
   *
   * O(1) lookup; preserves registration order within a gate.
   */
  private reviewerIndex: Map<ReviewGate, RegisteredHook[]> = new Map();

  /**
   * Register every hook in the manifest under its declared HookPoint.
   *
   * Stable sort: hooks at equal priority preserve registration order.
   * See PLAN-019-1 risk register for rationale.
   *
   * SPEC-019-4-01: hooks carrying a `ReviewerSlot` object are additionally
   * indexed under each declared `review_gates` entry. A `(plugin_id, gate)`
   * pair already in the reviewer index causes the registration to throw —
   * this protects against duplicate gate registration leaking through
   * repeated `register()` calls.
   */
  register(plugin: HookManifest, pluginRoot: string): void {
    // Pre-flight reviewer-slot duplicate check across all hooks in the
    // manifest. We do this before mutating any state so a partial
    // registration cannot leave the registry in a half-applied state.
    for (const hook of plugin.hooks) {
      const slot = hook.reviewer_slot;
      if (!isReviewerSlotObject(slot)) continue;
      for (const gate of slot.review_gates) {
        const existing = this.reviewerIndex.get(gate) ?? [];
        if (existing.some((h) => h.pluginId === plugin.id)) {
          throw new Error(
            `HookRegistry: duplicate reviewer-slot registration for plugin '${plugin.id}' on gate '${gate}'`,
          );
        }
      }
    }

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

      const slot = hook.reviewer_slot;
      if (isReviewerSlotObject(slot)) {
        for (const gate of slot.review_gates) {
          const reviewers = this.reviewerIndex.get(gate) ?? [];
          reviewers.push(resolved);
          this.reviewerIndex.set(gate, reviewers);
        }
      }
    }
  }

  /**
   * Remove every hook whose `pluginId` matches.
   *
   * Returns the total count removed. O(n) over all registered hooks. Also
   * cleans up the reviewer-slot index: any gate whose entry list becomes
   * empty after the filter is removed from the map entirely (no zombie
   * empty arrays).
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

    for (const [gate, reviewers] of this.reviewerIndex.entries()) {
      const next = reviewers.filter((h) => h.pluginId !== pluginId);
      if (next.length === 0) {
        this.reviewerIndex.delete(gate);
      } else if (next.length !== reviewers.length) {
        this.reviewerIndex.set(gate, next);
      }
    }

    return removed;
  }

  /**
   * Return all reviewer slots registered for a given review gate, in
   * registration order. Empty array if no plugins registered for that gate.
   *
   * O(1) lookup; the index is maintained on `register()`/`unregister()`.
   * Returns a defensive copy so callers cannot mutate the registry's
   * internal state.
   */
  getReviewersForGate(gate: ReviewGate): RegisteredHook[] {
    return [...(this.reviewerIndex.get(gate) ?? [])];
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

  /** Empty the registry, including the reviewer-slot index. */
  clear(): void {
    this.byPoint.clear();
    this.reviewerIndex.clear();
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
    this.reviewerIndex = other.reviewerIndex;
  }
}
