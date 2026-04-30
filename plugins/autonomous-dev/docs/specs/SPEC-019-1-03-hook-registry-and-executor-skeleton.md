# SPEC-019-1-03: HookRegistry Class and HookExecutor Skeleton

## Metadata
- **Parent Plan**: PLAN-019-1
- **Tasks Covered**: Task 4 (HookRegistry class), Task 5 (HookExecutor skeleton)
- **Estimated effort**: 6 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-019-1-03-hook-registry-and-executor-skeleton.md`

## Description
Implement the in-memory hook registry that maps each `HookPoint` to an ordered list of registered hooks, plus the executor skeleton that walks that list and invokes each hook's entry-point function. The registry uses copy-on-write snapshots so SIGUSR1 reload (SPEC-019-1-04) can swap the active state atomically without disturbing in-flight executions. The executor implements ONLY the happy-path loop here; full failure-mode semantics (`block`/`warn`/`ignore` gating, context propagation, audit log) land in PLAN-019-4. This spec's executor catches throws, logs them, and continues — a deliberate "fail open" safety net so a single bad plugin cannot crash the daemon during PLAN-019-1's bring-up.

Together these two classes are the central runtime artifact of PLAN-019-1: discovery (SPEC-019-1-02) feeds the registry, the CLI (SPEC-019-1-04) reads from it, and the daemon's lifecycle hooks call into the executor.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/hooks/registry.ts` | Create | HookRegistry class |
| `plugins/autonomous-dev/src/hooks/executor.ts` | Create | HookExecutor skeleton |
| `plugins/autonomous-dev/src/hooks/index.ts` | Modify | Re-export registry + executor public types |

## Implementation Details

### `src/hooks/registry.ts`

```ts
import { HookPoint, type HookEntry, type HookManifest } from './types';

/** A registered hook resolved against its plugin. */
export interface RegisteredHook {
  pluginId: string;
  pluginVersion: string;
  /** Absolute path to the entry-point file. */
  resolvedEntryPoint: string;
  hook: HookEntry;
}

export type RegistrySnapshot = ReadonlyMap<HookPoint, ReadonlyArray<RegisteredHook>>;

export class HookRegistry {
  private byPoint = new Map<HookPoint, RegisteredHook[]>();

  register(plugin: HookManifest, pluginRoot: string): void { /* ... */ }
  unregister(pluginId: string): number { /* returns count removed */ }
  getHooksForPoint(point: HookPoint): ReadonlyArray<RegisteredHook> { /* ... */ }
  clear(): void { /* ... */ }
  snapshot(): RegistrySnapshot { /* deep-frozen */ }
  size(): number { /* total registered hooks across all points */ }
}
```

Behavior contract:

1. `register(plugin, pluginRoot)`:
   - Iterates `plugin.hooks`. For each, resolves `path.resolve(pluginRoot, hook.entry_point)` into `resolvedEntryPoint`.
   - Inserts the resulting `RegisteredHook` into `byPoint.get(hook.hook_point)`. The list is maintained in **descending priority order** (highest first). Ties preserve insertion order (stable sort guaranteed by Node ≥ 12's `Array.prototype.sort`).
   - Insertion is binary-search positioning (O(log n) locate + O(n) splice) so the list stays sorted incrementally.
2. `unregister(pluginId)`:
   - Walks every list in `byPoint`, removes entries whose `pluginId` matches. Returns the total count removed. O(n) over all registered hooks.
3. `getHooksForPoint(point)`:
   - Returns the underlying array reference cast to `ReadonlyArray`. Callers MUST NOT mutate. (Snapshot is the safe path for cross-thread / async readers.)
4. `clear()`:
   - Empties the registry. Used by reload before re-populating.
5. `snapshot()`:
   - Returns a deep-frozen `Map<HookPoint, readonly RegisteredHook[]>` view. Both the map and its arrays are frozen (via `Object.freeze`). The `RegisteredHook` objects are NOT cloned (they are already treated as immutable by convention). Used by `HookExecutor.executeHooks` so that an in-flight execution sees a stable view even if `clear()` + re-register runs mid-flight.

JSDoc on `register` MUST document: "Stable sort: hooks at equal priority preserve registration order. See PLAN-019-1 risk register for rationale."

### `src/hooks/executor.ts`

```ts
import type { HookPoint } from './types';
import type { RegisteredHook, RegistrySnapshot } from './registry';

export interface HookInvocationOutcome {
  pluginId: string;
  hookId: string;
  /** `'ok'` if the hook returned, `'error'` if it threw. */
  status: 'ok' | 'error';
  /** The hook's return value (when status='ok'). */
  result?: unknown;
  /** The thrown error message (when status='error'). */
  error?: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

export interface HookExecutionResult {
  point: HookPoint;
  invocations: HookInvocationOutcome[];
}

export class HookExecutor {
  constructor(private readonly snapshotProvider: () => RegistrySnapshot) {}

  async executeHooks(point: HookPoint, context: unknown): Promise<HookExecutionResult> {
    const snapshot = this.snapshotProvider();
    const hooks = snapshot.get(point) ?? [];
    const invocations: HookInvocationOutcome[] = [];
    for (const hook of hooks) {
      invocations.push(await this.invokeOne(hook, context));
    }
    return { point, invocations };
  }

  private async invokeOne(hook: RegisteredHook, context: unknown): Promise<HookInvocationOutcome> {
    const start = performance.now();
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(hook.resolvedEntryPoint);
      const fn = typeof mod === 'function' ? mod : mod.default ?? mod;
      if (typeof fn !== 'function') throw new Error(`entry-point is not a function: ${hook.resolvedEntryPoint}`);
      const result = await Promise.resolve(fn(context));
      return { pluginId: hook.pluginId, hookId: hook.hook.id, status: 'ok', result, durationMs: performance.now() - start };
    } catch (err) {
      return { pluginId: hook.pluginId, hookId: hook.hook.id, status: 'error', error: (err as Error).message, durationMs: performance.now() - start };
    }
  }
}
```

Behavior contract:

1. `executeHooks(point, context)`:
   - Captures a snapshot at the START of the call. All subsequent iteration uses that snapshot. A reload mid-execution does not affect the in-flight call.
   - Iterates hooks **sequentially** (no `Promise.all`). PLAN-019-4 may add concurrency rules later; PLAN-019-1 is sequential.
   - Same `context` reference is passed to every hook (no per-hook copy). Mutation semantics are PLAN-019-4's concern.
   - Returns a `HookExecutionResult` aggregating all invocation outcomes in the order they ran.
2. `invokeOne(hook, context)`:
   - Dynamic `require(resolvedEntryPoint)` — module cache is honored, so repeated calls don't re-read disk. Reload (SPEC-019-1-04) does NOT clear `require.cache` in this plan; that is deferred so PLAN-019-1 stays small. (Operators reloading plugin code-changes today must restart the daemon.)
   - The exported value can be a function directly, an object with `.default`, or a CommonJS module assigning to `module.exports`. Anything else throws.
   - `await Promise.resolve(fn(context))` — supports both sync and async hooks transparently.
   - Any thrown error is caught and recorded as `status: 'error'` with the message. The executor NEVER re-throws — this is the "fail open" safety net.
   - Wall-clock duration is captured via `performance.now()`.
3. Logging:
   - One INFO log line per invocation: `executor: <hookPoint> <pluginId>/<hookId> -> <status> (<durationMs>ms)`.
   - Errors get an additional WARN line including the message (no stack — stacks land in PLAN-019-4's audit log).

## Acceptance Criteria

### HookRegistry

- [ ] Registering a `HookManifest` with one hook adds exactly one entry to the matching `HookPoint`'s list.
- [ ] Registering three hooks at the same `HookPoint` with priorities `[100, 50, 75]` (in declaration order) yields `getHooksForPoint(point)` order `[100, 75, 50]`.
- [ ] Two hooks at identical priority preserve registration order (the first-registered runs first).
- [ ] `unregister('foo')` removes every hook whose `pluginId === 'foo'` and returns the count removed.
- [ ] `unregister` of a plugin id that was never registered returns `0` (not an error).
- [ ] `clear()` empties every `HookPoint` list; `size()` returns `0` after.
- [ ] `snapshot()` returns a `Map` whose `Object.isFrozen` is true; each value array is also frozen.
- [ ] Mutating an array returned by `getHooksForPoint` would be a TypeScript error (the return type is `ReadonlyArray`); at runtime, mutation of a snapshot's array throws (frozen).
- [ ] Stability test: 100 hooks registered at random priorities (with intentional ties) produce a sort where ties preserve registration order across all 100 entries.
- [ ] `resolvedEntryPoint` is the absolute, normalized path (no `..` segments, no symlink resolution beyond what `path.resolve` does).

### HookExecutor

- [ ] For a `HookPoint` with two registered hooks (priorities 100 and 50), `executeHooks` invokes both, in priority order, and the returned `invocations` array has length 2 in that order.
- [ ] Each hook receives the same `context` reference (verified by the fixture echo plugins from SPEC-019-1-02).
- [ ] A hook that returns a value sees that value in `invocations[i].result`.
- [ ] A hook that throws synchronously is caught: `invocations[i].status === 'error'` with the thrown message in `error`. Iteration continues to subsequent hooks.
- [ ] A hook that returns a rejected `Promise` is caught the same way as a sync throw.
- [ ] An async hook (`async function`) is awaited; a fixture that resolves after a `setTimeout(10)` is captured correctly.
- [ ] `durationMs` is a positive number for every invocation.
- [ ] `executeHooks` for a `HookPoint` with zero registered hooks returns `{ point, invocations: [] }` (no error, no log noise beyond a single DEBUG line).
- [ ] Snapshot stability: replacing the underlying registry mid-execution does NOT affect the in-flight call's hook list (verified by a test that calls `clear()` from inside hook 1 and asserts hook 2 still runs).
- [ ] Hooks are invoked sequentially: a fixture that records `Date.now()` on entry shows monotonic non-overlapping timestamps.
- [ ] Module caching: invoking the same hook twice does not re-read the entry-point file from disk (verified via `fs.readFile` spy).

## Dependencies

- SPEC-019-1-01 (types).
- SPEC-019-1-02 (fixture plugins for executor tests).
- Node ≥ 18 (`performance` global, stable `Array.prototype.sort`).
- No new npm packages.

## Notes

- The executor takes a `snapshotProvider` callback (not the registry directly) so that SPEC-019-1-04's reload logic can swap the underlying registry by changing what the provider returns. Tests inject a static snapshot.
- "Fail open" (catch-and-continue) is intentional and limited to PLAN-019-1. PLAN-019-4 introduces the failure-mode gating that turns a `block`-mode hook's error into a halt. Until then, every plugin is effectively `warn`-mode regardless of its declared `failure_mode`. This MUST be called out in the daemon's startup banner so operators are not surprised.
- `require.cache` is intentionally NOT invalidated on reload in this spec. Plugin code changes require a daemon restart for PLAN-019-1; manifest-only changes (priority bumps, hook removal, new plugins) work via SIGUSR1 because they only re-read JSON. A future spec will add cache invalidation behind a feature flag once the safety implications are reviewed.
- The `RegisteredHook` shape includes `pluginVersion` so the CLI (SPEC-019-1-04) can render it without consulting the manifest separately. This pre-flattening also makes `snapshot()` self-contained.
- Binary-search insertion is an optimization, not a correctness requirement. A naive `push + sort` is acceptable on the first cut; profile before optimizing if discovery + register stays within the 100ms budget.
