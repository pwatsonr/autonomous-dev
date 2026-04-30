# SPEC-019-4-03: Sequential Execution with Chained Context + Failure-Mode Semantics

## Metadata
- **Parent Plan**: PLAN-019-4
- **Tasks Covered**: Task 5 (sequential execution with chained context), Task 6 (failure-mode semantics)
- **Estimated effort**: 6 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-019-4-03-sequential-execution-failure-modes.md`

## Description
Upgrade `HookExecutor.executeHooks()` (introduced in PLAN-019-1) so that hooks within a single hook point execute strictly in priority order (descending), each receives the cumulative results of all prior hooks as part of its input context, and per-hook failures are governed by the hook entry's `failure_mode` (`block` | `warn` | `ignore`). The executor returns an aggregated result that always includes a `failures[]` array enumerating every warn/ignore failure so callers (the daemon, audit writer) can record what happened even when execution proceeded. This is the runtime contract that hook authors and the daemon depend on; it is also where the "hook X delays hook Y" trade-off documented in TDD §12.1 becomes observable.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/hooks/executor.ts` | Modify | Replace fan-out with priority-sorted sequential loop; add `failure_mode` switch |
| `plugins/autonomous-dev/src/hooks/types.ts` | Modify | Add `FailureMode`, `HookContext`, `HookResult`, `HookExecutionResult`, ensure `HookEntry.failure_mode` |
| `plugins/autonomous-dev/src/hooks/errors.ts` | Create | `HookBlockedError` thrown when a `block`-mode hook fails |
| `plugins/autonomous-dev/tests/hooks/test-executor-sequential.test.ts` | Create (schema only) | Authored fully in SPEC-019-4-05 |
| `plugins/autonomous-dev/tests/hooks/test-failure-modes.test.ts` | Create (schema only) | Authored fully in SPEC-019-4-05 |

## Implementation Details

### Type Additions (`src/hooks/types.ts`)

```ts
export type FailureMode = 'block' | 'warn' | 'ignore';

/** Augment existing `HookEntry` (already partial after SPEC-019-4-01). */
export interface HookEntry {
  // ...existing fields...
  failure_mode: FailureMode;     // required; manifests must declare
  priority: number;              // existing; higher runs first
}

/** Per-invocation context handed to a hook. */
export interface HookContext<I = unknown> {
  /** The original input passed to executeHooks(). Read-only. */
  readonly originalContext: I;
  /** Results from all prior hooks at this hook point, in execution order. */
  readonly previousResults: ReadonlyArray<HookResult>;
}

/** What a single hook returned (or recorded as a non-blocking failure). */
export interface HookResult<O = unknown> {
  plugin_id: string;
  plugin_version: string;
  hook_id: string;          // stable identifier from manifest
  priority: number;
  /** Either `output` (success) or `error` (failure under warn/ignore). */
  output?: O;
  error?: { message: string; stack?: string; failure_mode: FailureMode };
  duration_ms: number;
}

/** Aggregated outcome from executeHooks(). */
export interface HookExecutionResult<O = unknown> {
  hook_point: string;
  results: HookResult<O>[];
  /** Subset of results where `error` is set (warn + ignore only). */
  failures: HookResult<O>[];
  /** True if any block-mode failure aborted execution before completion. */
  aborted: boolean;
}
```

### `src/hooks/errors.ts`

```ts
import type { HookResult } from './types.js';

export class HookBlockedError extends Error {
  readonly hookResult: HookResult;
  constructor(hookResult: HookResult) {
    super(`Hook ${hookResult.plugin_id}:${hookResult.hook_id} blocked execution: ${hookResult.error?.message}`);
    this.name = 'HookBlockedError';
    this.hookResult = hookResult;
  }
}
```

### Executor Rewrite (`src/hooks/executor.ts`)

`executeHooks(hookPoint, originalContext)` algorithm:

1. `entries = registry.getHooks(hookPoint)`.
2. Sort `entries` descending by `priority`. Stable sort: for equal priorities, preserve registration order.
3. Initialize `results: HookResult[] = []` and `failures: HookResult[] = []`.
4. For each `entry` in sorted order:
   a. Build `context = { originalContext, previousResults: [...results] }` (defensive copy on each iteration; the spread enforces read-only contract for hooks).
   b. Record `start = performance.now()`.
   c. Try: `output = await entry.invoke(context)`.
   d. On success: push `{plugin_id, plugin_version, hook_id, priority, output, duration_ms}` to `results`. Continue.
   e. On error (caught from the awaited promise): build `result = {plugin_id, plugin_version, hook_id, priority, error: {message, stack, failure_mode: entry.failure_mode}, duration_ms}`. Then:
      - `failure_mode === 'block'`: push to `results`, set `aborted = true`, throw `new HookBlockedError(result)`. Caller (daemon) catches and translates to escalation per TDD-009.
      - `failure_mode === 'warn'`: push to `results` and `failures`. Log at WARN level with `{plugin_id, hook_id, error}`. Continue loop.
      - `failure_mode === 'ignore'`: push to `results` and `failures`. No log emission. Continue loop.
5. After the loop: return `{hook_point, results, failures, aborted: false}`.

Notes:
- The `block` path is the only branch that throws; the daemon's `executeHooks` callsite must wrap in try/catch to translate to a request-level failure. This is documented in JSDoc on `executeHooks`.
- `previousResults` always includes failed-but-non-blocking results (warn/ignore) so downstream hooks can see and react to predecessor failures (e.g., a "cleanup" hook that runs after a "validation" warn).
- `duration_ms` uses `performance.now()` for sub-millisecond precision; rounded to 3 decimals when serialized.

### Hook Invocation Contract

The executor calls `entry.invoke(context)` where `invoke` returns `Promise<unknown>`. The hook author's contract (documented in JSDoc):
- Hooks MUST NOT mutate `context.originalContext` or `context.previousResults`. (Enforced softly by the `Readonly` types; TS will complain at hook-author compile time.)
- Hooks MAY throw or reject; the failure-mode rules above apply uniformly.
- Hooks SHOULD complete within their declared per-hook timeout (governed by capability limits in PLAN-019-2/3, not enforced here). This spec does not impose a hard timeout; that lands with the sandbox runtime (PRD-001).

### Test Schemas (full bodies in SPEC-019-4-05)

`test-executor-sequential.test.ts` must cover:
- Three hooks at priorities 100, 75, 50 — assert each hook saw the correct `previousResults` slice.
- Equal-priority hooks — assert stable order matches registration order.
- Empty hook point — `executeHooks` returns `{results: [], failures: [], aborted: false}` without invoking anything.
- Single hook — `previousResults` is empty.
- Cumulative chaining — 5 hooks; the last hook sees all 4 prior results.

`test-failure-modes.test.ts` must cover:
- `block`-mode hook throwing — executor throws `HookBlockedError` with `aborted: true` semantics on the embedded result. Subsequent hooks NOT invoked (assert via spy).
- `warn`-mode hook throwing — executor continues; result appears in both `results` and `failures`; logger receives WARN.
- `ignore`-mode hook throwing — executor continues; result appears in both `results` and `failures`; logger NOT called.
- Mixed: `[warn(throws), ignore(throws), success]` — final state has 3 entries in `results`, 2 in `failures`, `aborted: false`.
- `block` after `warn` — the warn failure is recorded, then block throws; `failures` contains the warn entry, the block result is also in `results` (as the last entry before the throw).

## Acceptance Criteria

- [ ] Hooks within a hook point execute in priority order (descending) with stable tie-breaking by registration order.
- [ ] The i-th hook receives `previousResults` containing exactly the result entries for the first i-1 hooks (success or warn/ignore failure).
- [ ] `previousResults` is read-only (TS `ReadonlyArray`); mutating it does not affect the executor's internal state.
- [ ] `originalContext` is identical (referentially or structurally per implementation choice — must be documented) across every hook invocation in a single `executeHooks` call.
- [ ] A `block`-mode hook that throws causes `executeHooks` to throw `HookBlockedError`. The error wraps the failing `HookResult`. No subsequent hooks are invoked.
- [ ] A `warn`-mode hook that throws is logged at WARN level with `{plugin_id, hook_id, error}`; iteration continues; the failure is in `result.failures`.
- [ ] An `ignore`-mode hook that throws is silently skipped (no logger call); iteration continues; the failure is in `result.failures`.
- [ ] `HookExecutionResult.failures` always equals `results.filter(r => r.error !== undefined)` for any non-aborted execution.
- [ ] `duration_ms` is populated on every result, success or failure, and is non-negative.
- [ ] Empty hook point returns `{hook_point, results: [], failures: [], aborted: false}` without invoking anything (no error).
- [ ] Existing PLAN-019-1 executor tests still pass (no regressions); any tests assuming parallel fan-out are updated to expect sequential semantics (this is a documented behavior change).
- [ ] JSDoc on `executeHooks` explicitly states the `block` propagation contract and the daemon's responsibility to catch `HookBlockedError`.

## Dependencies

- **Blocked by**: PLAN-019-1 (`HookExecutor`, `HookEntry`, `HookRegistry`).
- **Consumed by**: SPEC-019-4-04 (audit writer instruments every result + failure into the audit log); SPEC-019-4-05 (full test bodies).
- **Coordinates with**: TDD-009 / PLAN-009-X escalation infrastructure for `block`-mode propagation; PLAN-019-2 validation pipeline runs before each invoke.

## Notes

- The behavior change from "parallel fan-out" (if PLAN-019-1's initial executor implemented that) to "sequential chained" is intentional per TDD §12.1. Hook-point latency now grows linearly with N hooks; operators manage this via priority and per-hook timeouts.
- `HookBlockedError` carries the failing `HookResult` so the daemon can directly serialize it into an escalation payload without re-deriving identity.
- The executor never catches `HookBlockedError` itself once thrown — propagation is the daemon's job. This keeps the executor's contract narrow and testable.
- We do not impose a hard per-hook timeout in this spec; that comes with the sandbox runtime (PRD-001). Hook authors must use cooperative cancellation for now.
- `failures[]` deliberately excludes `block` failures because `block` aborts before completing aggregation; the daemon receives the failing hook directly via `HookBlockedError.hookResult`.
- Stable sort matters: when two hooks register at priority 50, the registration-order tiebreaker is part of the hook contract (manifest authors can rely on it). Use `Array.prototype.sort` semantics on V8 (stable since Node 12) — no custom stable-sort implementation needed.
