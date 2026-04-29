# SPEC-015-1-03: Read-Only Accessors — `state.json` Request Status & Phase History

## Metadata
- **Parent Plan**: PLAN-015-1
- **Tasks Covered**: TASK-006 (aggregation cache), TASK-007 (StateReader), TASK-008 (events.jsonl reader for phase history)
- **Estimated effort**: 8 hours

## Description

Implement the read-only data accessor layer that exposes daemon `state.json` and `events.jsonl` files to the portal as typed, schema-validated, never-throwing functions. This spec covers two readers (`StateReader`, `EventsReader`), a shared in-memory aggregation cache (5s TTL, ≤50 MB ceiling, file-event invalidation), and the wiring that subscribes the cache to `FileWatcher` (SPEC-015-1-01) for invalidation and broadcasts `state-change` events to the SSE bus (SPEC-015-1-02) when state files change.

The accessors return `Result<T, Error>` and never throw. Missing files are treated as legitimate empty states (e.g., a request directory with no `state.json` yet returns `{ ok: true, value: null }`). Malformed files surface as `{ ok: false, error }` so the portal UI can show a "corrupt state file" banner without crashing the process. The cache is invalidated on `FileChangeEvent` so the very next read after a file change returns fresh data.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/portal/cache/AggregationCache.ts` | Create | Generic TTL+LRU cache with pattern invalidation |
| `src/portal/cache/types.ts` | Create | `CacheEntry`, `CacheOptions`, `CacheStats` |
| `src/portal/cache/index.ts` | Create | Barrel export |
| `src/portal/readers/StateReader.ts` | Create | `readState`, `readAllStates`, `getStateCounts` |
| `src/portal/readers/EventsReader.ts` | Create | Streaming JSONL reader for phase history |
| `src/portal/readers/schemas/state.ts` | Create | Zod schema for daemon `state.json` |
| `src/portal/readers/schemas/events.ts` | Create | Zod schema for `events.jsonl` lines |
| `src/portal/readers/types.ts` | Create | `Result<T,E>`, `RequestState`, `PhaseEvent` types |
| `src/portal/readers/index.ts` | Create | Barrel export |
| `src/portal/integration/state-pipeline.ts` | Create | Wires FileWatcher → cache invalidation → SSE broadcast |

## Implementation Details

### `AggregationCache` (`src/portal/cache/AggregationCache.ts`)

```typescript
export interface CacheOptions {
  defaultTTLMs?: number;     // default 5_000
  maxEntries?: number;       // default 1_000
  maxMemoryMB?: number;      // default 50
  logger?: { debug: Function; warn: Function };
}

export interface CacheStats {
  size: number;
  hitCount: number;
  missCount: number;
  hitRatio: number;
  approxMemoryMB: number;
  evictions: { ttl: number; size: number; memory: number; manual: number };
}

export class AggregationCache {
  constructor(opts?: CacheOptions);
  async get<T>(key: string): Promise<T | null>;
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  invalidate(key: string): boolean;
  invalidatePattern(pattern: RegExp): number;     // returns count
  getStats(): CacheStats;
  clear(): void;
  shutdown(): void;
}
```

**TTL** is per-entry: `set(key, value, 2000)` overrides `defaultTTLMs`. On `get`, if `Date.now() - entry.timestamp > entry.ttl`, the entry is deleted and `null` returned (cache miss recorded).

**LRU eviction** triggers when `size > maxEntries`. Sort entries by `lastAccess` ascending and drop the oldest until `size === maxEntries`. Eviction events are emitted internally for stats.

**Memory eviction** uses a rough estimator: for each entry, `key.length * 2 + JSON.stringify(value).length * 2 + 200 bytes overhead`. Total in MB. When the estimate exceeds `maxMemoryMB`, drop the oldest 20% of entries by `lastAccess`. The estimator is intentionally cheap; precision is not required because the ceiling is a safety valve, not a precise budget.

**Pattern invalidation** is the integration point with `FileWatcher`: a state file change for `REQ-000123` triggers `cache.invalidate('state:REQ-000123')` AND `cache.invalidatePattern(/^(all-states|state-counts):/)` to drop derived aggregates.

**Cleanup timer**: a single `setInterval` running at `defaultTTLMs / 2` (default 2.5s) sweeps expired entries to bound stale memory. Disabled when `defaultTTLMs === 0`.

### `RequestState` schema (`src/portal/readers/schemas/state.ts`)

```typescript
import { z } from 'zod';

export const RequestPhaseEnum = z.enum([
  'pending', 'planning', 'tdd', 'plan_author', 'spec_author',
  'executing', 'reviewing', 'completed', 'failed', 'cancelled', 'paused',
]);
export type RequestPhase = z.infer<typeof RequestPhaseEnum>;

export const RequestStateSchema = z.object({
  request_id: z.string().regex(/^REQ-\d{6}$/),
  phase: RequestPhaseEnum,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  repository: z.string(),
  title: z.string(),
  source: z.enum(['cli', 'claude-app', 'discord', 'slack', 'production-intelligence', 'portal']).default('cli'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  branch: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  cost_usd: z.number().nonnegative().nullable().optional(),
  paused_at_phase: RequestPhaseEnum.nullable().optional(),
});
export type RequestState = z.infer<typeof RequestStateSchema>;
```

The schema MUST stay aligned with the daemon-side schema (single source of truth: `intake/types/request.ts` from PLAN-012). When the daemon adds a field, this schema MUST be updated in lockstep — the version bump is tracked in PLAN-012's migration history.

Unknown fields are allowed (Zod default behavior) so a forward-compatible daemon writing a new field does not break the portal reader.

### `StateReader` (`src/portal/readers/StateReader.ts`)

```typescript
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export interface ReadAllStatesOptions {
  includeTerminal?: boolean;       // default false; excludes completed/failed/cancelled
  phase?: RequestPhase[];
  repository?: string;
  source?: RequestState['source'];
  limit?: number;
  offset?: number;
}

export class StateReader {
  constructor(deps: { basePath: string; cache: AggregationCache; logger?: Logger });

  async readState(requestId: string): Promise<Result<RequestState | null>>;
  async readAllStates(opts?: ReadAllStatesOptions): Promise<Result<RequestState[]>>;
  async getStateCounts(): Promise<Result<Record<RequestPhase, number>>>;
}
```

**`readState` flow**:

1. `cache.get<RequestState>('state:' + requestId)` → if hit, return.
2. Construct path: `path.join(basePath, '.autonomous-dev', 'requests', requestId, 'state.json')`.
3. `validateRequestId` — must match `/^REQ-\d{6}$/`. Else return `{ ok: false, error: Error('invalid request_id format') }` WITHOUT touching the filesystem.
4. `Bun.file(p).exists()` — false → return `{ ok: true, value: null }` (NOT an error: missing file is a valid state for a freshly-deleted request).
5. `await Bun.file(p).text()` → `JSON.parse` → `RequestStateSchema.safeParse`.
6. Parse failure → `{ ok: false, error }`. Do NOT cache.
7. Parse success → `cache.set('state:' + requestId, parsed.data)` → return `{ ok: true, value: parsed.data }`.

Errors during parse include the raw error message and the file path. The error is NOT logged at error level (it would be a noise source for legitimate operator-edited files); the portal UI surfaces it instead.

**`readAllStates` flow**:

1. `cache.get<RequestState[]>('all-states:' + JSON.stringify(opts || {}))` → if hit, return.
2. Glob `path.join(basePath, '.autonomous-dev', 'requests', '*')` to enumerate request directories. Filter to entries matching `/^REQ-\d{6}$/`.
3. For each request_id, call `readState`. Discard `{ ok: true, value: null }` and `{ ok: false }` results from the bulk list (they are surfaced individually via `readState`; bulk callers want a clean view).
4. Apply filters from `opts`: `phase`, `repository`, `source`, `includeTerminal` (when false, exclude `completed | failed | cancelled`).
5. Sort by `updated_at` descending (most recent first).
6. Apply `offset` then `limit`.
7. Cache with a SHORTER TTL: `cache.set(key, result, 2000)` — 2s ceiling, because aggregates change more often than individual states.

**`getStateCounts` flow**:

1. `cache.get<Record<RequestPhase, number>>('state-counts')` → if hit, return.
2. `readAllStates({ includeTerminal: true })` → tally per phase.
3. Cache with default TTL.

### `EventsReader` (`src/portal/readers/EventsReader.ts`)

Reads `<repo>/.autonomous-dev/requests/<REQ-id>/events.jsonl` line by line. Returns the phase-transition history for a request. Strict scope for this spec: phase-transition events only. Other event types (cost, log) are NOT decoded here; they're reserved for SPEC-015-1-04.

```typescript
export const PhaseEventSchema = z.object({
  ts: z.string().datetime(),
  type: z.literal('phase_transition'),
  request_id: z.string().regex(/^REQ-\d{6}$/),
  from_phase: RequestPhaseEnum.nullable(),
  to_phase: RequestPhaseEnum,
  trigger: z.enum(['daemon', 'operator', 'auto']).optional(),
  duration_ms: z.number().nonnegative().optional(),
});
export type PhaseEvent = z.infer<typeof PhaseEventSchema>;

export class EventsReader {
  constructor(deps: { basePath: string; cache: AggregationCache });
  async readPhaseHistory(requestId: string, opts?: { limit?: number }): Promise<Result<PhaseEvent[]>>;
}
```

**Streaming**: `events.jsonl` can grow unbounded. The reader uses `Bun.file(path).stream()` → `TextDecoderStream` → split on `\n`. For each line: skip empty, `JSON.parse` (per-line catch — parse errors skip the line and increment a `parse_errors` counter logged at debug), `PhaseEventSchema.safeParse` (filter rather than reject — non-phase events are skipped silently).

**Limit semantics**: `limit` (default 100, max 1000) returns the LAST N phase events. The streaming reader maintains a sliding window: a `Deque<PhaseEvent>` of size `limit`; on each accepted event, push; if size exceeds `limit`, shift the oldest. Returns the deque contents in chronological order.

**Cache key**: `phase-history:${requestId}:${limit}`. TTL: 5s (default). Invalidated on FileWatcher change events for the request's `events.jsonl`.

### Pipeline wiring (`src/portal/integration/state-pipeline.ts`)

Single function that subscribes a `FileWatcher` to a cache + SSE bus:

```typescript
export interface StatePipelineDeps {
  watcher: FileWatcher;          // SPEC-015-1-01
  cache: AggregationCache;
  bus: SSEEventBus;              // SPEC-015-1-02
  reader: StateReader;
  basePath: string;
}

export function wireStatePipeline(deps: StatePipelineDeps): { dispose: () => void };
```

**Behavior**:

- For every `fileChange` event from the watcher:
  - If the file path matches `<basePath>/.autonomous-dev/requests/(REQ-\d{6})/state.json`:
    - Extract `request_id`.
    - `cache.invalidate('state:' + request_id)`.
    - `cache.invalidatePattern(/^(all-states|state-counts):/)`.
    - Re-read the file via `reader.readState(request_id)`. If `ok` and value non-null, broadcast `state-change` event with `payload.request_id`, `payload.new_phase = value.phase`, `payload.repository = value.repository`. The `old_phase` is read from the cache BEFORE invalidation (best-effort; null if not previously cached).
  - If the file path matches `<basePath>/.autonomous-dev/requests/(REQ-\d{6})/events.jsonl`:
    - `cache.invalidatePattern(new RegExp('^phase-history:' + reqId + ':'))`.
- On `error` events: log at warn level, do not propagate to the bus.
- `dispose()` removes the listeners; safe to call multiple times.

The pipeline is the ONLY component in this spec that knows about the path conventions. Readers themselves just take raw `requestId` and read the corresponding file.

## Acceptance Criteria

- [ ] `StateReader.readState('REQ-999999')` for a non-existent file returns `{ ok: true, value: null }` (NOT an error).
- [ ] `StateReader.readState('not-a-valid-id')` returns `{ ok: false, error }` WITHOUT performing any filesystem I/O.
- [ ] `StateReader.readState(id)` for a malformed JSON file returns `{ ok: false, error }` with a descriptive message including the file path; cache is NOT populated.
- [ ] `StateReader.readState(id)` for a schema-violation (e.g., unknown phase) returns `{ ok: false, error }` with the Zod issue path; cache is NOT populated.
- [ ] On a successful read, the SAME file accessed within 5s returns from cache (verified by spying on `Bun.file`).
- [ ] `cache.invalidate('state:REQ-000001')` followed by `readState('REQ-000001')` re-reads the file (cache miss).
- [ ] `readAllStates({ phase: ['executing'] })` excludes terminal-state requests AND returns only requests whose phase matches the filter.
- [ ] `readAllStates({ limit: 10 })` returns at most 10 entries sorted by `updated_at` descending.
- [ ] `getStateCounts()` returns a `Record<RequestPhase, number>` summing to the count of all non-malformed state files.
- [ ] `EventsReader.readPhaseHistory(id, { limit: 5 })` returns the LAST 5 phase events in chronological order; non-phase event lines and malformed lines are silently skipped.
- [ ] `EventsReader.readPhaseHistory` for a non-existent `events.jsonl` returns `{ ok: true, value: [] }`.
- [ ] `wireStatePipeline` subscribes to the watcher; modifying `state.json` for `REQ-000001` results in (a) cache invalidation for `state:REQ-000001` AND derived aggregates, (b) a `state-change` SSE broadcast with the new phase.
- [ ] When the new state phase equals the previously-cached phase, a `state-change` event is STILL broadcast (the file changed for some other reason — UI receives the update and decides what to render).
- [ ] When file watcher emits an `error` event, the pipeline logs but does not broadcast `state-change` or invalidate caches.
- [ ] `AggregationCache` LRU eviction drops the oldest-by-`lastAccess` entry when `size > maxEntries`.
- [ ] `AggregationCache` memory eviction drops 20% of entries (oldest by `lastAccess`) when estimated MB exceeds `maxMemoryMB`.
- [ ] `cache.shutdown()` clears entries and stops the cleanup timer; subsequent `get` calls return `null` (cache effectively empty).
- [ ] `cache.invalidatePattern(/^all-states:/)` removes ALL keys starting with `all-states:` and returns the count removed.
- [ ] `pipeline.dispose()` is idempotent and removes all watcher listeners.

## Dependencies

- **Consumes**: SPEC-015-1-01 (`FileWatcher`), SPEC-015-1-02 (`SSEEventBus.broadcast`), `zod`, `Bun.file`, `glob`.
- **Blocks**: SPEC-015-1-04 (cost/log/heartbeat readers reuse the same `AggregationCache`), SPEC-015-1-05 (test suite), PLAN-015-2 (settings + gate pages query `StateReader`), PLAN-015-3 (operations dashboard queries `getStateCounts`).
- **External**: `RequestStateSchema` parallels the daemon's source-of-truth from PLAN-012-2-01 (SQLite DDL); when daemon evolves the schema, this spec MUST be updated.

## Notes

- **Why never-throwing readers?** A single corrupt file should NOT crash the portal. Operators inspecting their setup may have hand-edited a state file; the portal should report it gracefully.
- **Why NOT cache parse failures?** Caching errors would persist a transient bad state across the TTL window. Forcing a re-read on every call when the file is corrupt is the correct behavior — the cost is minimal because corrupt files are rare and the file change watcher will trigger a real re-read when fixed.
- **Why 5s default TTL?** PLAN-015-1 pins this number. Long enough to absorb 10–50 successive UI poll requests on the same data; short enough that uncached data on file changes is served within one heartbeat cycle even if the watcher missed an event (defense in depth).
- **Why 2s TTL on aggregates?** `readAllStates` and `getStateCounts` are derived from many files; staleness compounds. A shorter TTL keeps aggregate views fresh without paying the cost of re-aggregating on every poll.
- **Why allow unknown fields in the Zod schema?** Forward compatibility: a daemon shipping a new field does not require a portal upgrade. The portal simply ignores unknown fields. Removing fields IS a breaking change and requires daemon + portal coordination.
- **Why broadcast even when phase appears unchanged?** The portal does not own the daemon's authoritative phase history. A change to `state.json` (e.g., `cost_usd` updated, `error` set) is meaningful to the UI even when phase stays the same. SSE clients can debounce visually if desired.
- **Cache invalidation race**: between `invalidate` and `readState` re-population, a concurrent reader may briefly miss-then-hit. This is acceptable because the file is the source of truth — both readers will see the same fresh content, just one slightly later. We do NOT use locks; the cost outweighs the benefit.
- **EventsReader scope**: limited to phase transitions in this spec. SPEC-015-1-04 will add cost-event decoding and SPEC-015-3 will add log streaming. Splitting prevents the reader from accumulating unrelated parsing concerns.
