# SPEC-030-2-01: Pipeline Interface Contract (`pipeline-types.ts`)

## Metadata
- **Parent Plan**: PLAN-030-2 (TDD-015 portal pipeline closeout)
- **Parent TDD**: TDD-030 §6.1, §6.3
- **Tasks Covered**: TASK-001 (interface contract module)
- **Estimated effort**: 0.25 day
- **Depends on**: nothing (this spec is a pure type contract)
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-030-2-01-pipeline-types-interface.md`

## Description

Lock the public interface that SPEC-030-2-02 (heartbeat), SPEC-030-2-03 (cost), and SPEC-030-2-04 (log) implement. This spec ships exactly one TypeScript file: `pipeline-types.ts`. It is **not** a base class, **not** a runtime export — it is a `Pipeline<E>` interface plus the `PipelineEvent` discriminated union, both consumed by the three pipeline files.

`server/integration/state-pipeline.ts` is the reference implementation but is **not** modified by this spec (per TDD-030 NG-3004). The new pipelines `implements` the interface; the existing pipeline does not retroactively `implements` it.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-portal/server/integration/pipeline-types.ts` | Create | ≤25 lines of code; imports nothing runtime |

No production code modifications. No `state-pipeline.ts` modifications.

## Implementation Details

### `pipeline-types.ts`

```ts
/**
 * Public surface implemented by the live-data pipelines under
 * server/integration/{cost,heartbeat,log}-pipeline.ts.
 *
 * See TDD-030 §6.3. This is an interface, not a base class — see
 * NG-3004 for why no abstraction is extracted from state-pipeline.ts.
 */
export type PipelineEvent = 'data' | 'error' | 'recovered';

export interface PipelineErrorPayload {
  /** Categorical failure mode; assert on this, NEVER on the message string. */
  readonly code: string;
  /** Optional underlying cause (e.g., a watcher error). */
  readonly cause?: unknown;
  /** Human-readable description; for logs only, not for branching. */
  readonly message?: string;
}

export interface Pipeline<E> {
  /**
   * Begin watching the source artifact. Resolves once the watcher is
   * attached and the pipeline is ready to emit. Idempotent: a second
   * start() while already running is a no-op (NOT an error).
   */
  start(): Promise<void>;

  /**
   * Stop watching and release resources. Resolves after the watcher is
   * fully detached. Idempotent: a second stop() while already stopped
   * is a no-op.
   */
  stop(): Promise<void>;

  /**
   * Subscribe to a pipeline lifecycle event.
   *  - 'data'      → listener receives a typed E payload
   *  - 'error'     → listener receives a PipelineErrorPayload
   *  - 'recovered' → listener receives nothing (void)
   *
   * Multiple listeners per event are permitted (registered in order).
   * No 'off' / 'removeListener' API is required by this contract — the
   * pipeline is single-process, single-consumer in production.
   */
  on(event: 'data', listener: (payload: E) => void): void;
  on(event: 'error', listener: (err: PipelineErrorPayload) => void): void;
  on(event: 'recovered', listener: () => void): void;
}
```

Constraints:
- The file declares **only** types and interfaces; no `class`, no `function`, no runtime export. A `grep` for `^class\\|^function\\|^const\\|^let` against the file returns zero hits.
- The `on` method is overloaded so each event name binds the listener to the correct payload type at the call site.
- `PipelineEvent` and `PipelineErrorPayload` are exported alongside `Pipeline<E>` for use by tests.
- No imports from `state-pipeline.ts`. No runtime dependencies. The file compiles with `--noEmit` and produces zero output JS.

### Compatibility check (read-only)

After authoring, run `tsc --noEmit` from the portal directory. The build MUST pass without modification to `state-pipeline.ts`. The interface is purely additive — `state-pipeline.ts` is not retroactively required to implement it.

## Acceptance Criteria

- AC-1: `plugins/autonomous-dev-portal/server/integration/pipeline-types.ts` exists.
- AC-2: The file exports `Pipeline<E>`, `PipelineEvent`, and `PipelineErrorPayload`. A grep for those identifiers in the file returns three hits.
- AC-3: The event-name union is exactly `'data' | 'error' | 'recovered'`. No other strings appear in the union.
- AC-4: The `on` method has three overloads (one per event), each typing the listener payload correctly.
- AC-5: The file is ≤ 50 lines including JSDoc and blank lines (TDD-030 §6.1's "≤25-line" budget refers to runtime LOC; comments are excluded).
- AC-6: `tsc --noEmit` from `plugins/autonomous-dev-portal/` passes.
- AC-7: `state-pipeline.ts` is unmodified by this spec. `git diff main -- plugins/autonomous-dev-portal/server/integration/state-pipeline.ts` returns empty.
- AC-8: The file contains zero runtime exports. `grep -E "^export (class|function|const|let|var) " pipeline-types.ts` returns zero hits.
- AC-9: A trivial consumer file (test scratch — not committed) of the form `class Foo implements Pipeline<{x: number}> { ... }` compiles cleanly when all three methods are stubbed. Verify and discard during review.

### Given/When/Then

```
Given a TypeScript file pipeline-types.ts that declares interface Pipeline<E>
When a downstream pipeline file declares "class HeartbeatPipeline implements Pipeline<HeartbeatPayload>"
Then the compiler enforces that the class has start, stop, and on methods with the contract signatures

Given the existing state-pipeline.ts file
When pipeline-types.ts is added to the tree
Then the portal's tsc --noEmit build still passes
And state-pipeline.ts has not been modified
```

## Test Requirements

This spec ships only types. Verification:

1. `tsc --noEmit` from the portal passes after adding the file.
2. AC-9's scratch-class compatibility check is performed once and the experiment discarded.
3. No automated test file is created by this spec — the downstream specs (SPEC-030-2-02..04) exercise the interface via real implementations.

## Implementation Notes

- Place the file at `server/integration/pipeline-types.ts` (sibling to `state-pipeline.ts`). Do NOT place it in a `types/` subdirectory; the portal's existing convention is to colocate types with their consumers.
- JSDoc on each method references TDD-030 §6.3.
- The `PipelineErrorPayload.code` field is the assertion target for downstream pipeline tests (per the auth-test pattern: typed-property assertions, never message-string matching).

## Rollout Considerations

Pure type contract. No runtime impact. Revert by deleting the file. Cannot break production (zero runtime emit).

## Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Interface signature drifts from `state-pipeline.ts`'s implicit shape | Low | Medium | Read `state-pipeline.ts` first; align field names exactly |
| Future pipelines need an `off` / `removeListener` API | Low | Low | Add later; YAGNI for the closeout |
| Discriminated union for events causes consumer ergonomic friction | Low | Low | The three `on` overloads handle the typing; consumers see correctly-typed listeners |
