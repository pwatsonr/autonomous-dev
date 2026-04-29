# SPEC-015-1-05: Test Suite — Watcher Coalescing, SSE Backpressure, Accessor Validation, Cross-Platform fs.watch

## Metadata
- **Parent Plan**: PLAN-015-1
- **Tasks Covered**: TASK-012 (integration test suite); supplements unit-test gating across TASK-001 through TASK-011
- **Estimated effort**: 12 hours

## Description

Implement the unit, integration, and cross-platform test suite that gates SPEC-015-1-01 through SPEC-015-1-04. The suite exercises four high-risk scenario classes: (1) FileWatcher debounce/coalesce semantics across native and polling backends; (2) SSEEventBus per-client backpressure under slow-client conditions; (3) read-only accessor schema validation (happy + adversarial inputs) and redaction completeness; (4) cross-platform fs.watch behavior on macOS (FSEvents) and Linux (inotify) including rapid changes, atomic writes, and rotation. Performance and reliability tests assert the latency and resilience targets from PLAN-015-1's Definition of Done (≤1s p95 SSE delivery, ≤5 dispatches per 100 events, no leaks under 1-hour soak).

The suite is split across unit and integration directories so unit tests run in <30s on every commit while integration tests gate merges. Cross-platform tests are marked with platform guards and skipped on unsupported runners; the CI matrix runs them on macOS-latest and ubuntu-latest.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/portal/__tests__/unit/file-watcher.test.ts` | Create | Debounce, coalesce, fallback, lifecycle |
| `src/portal/__tests__/unit/sse-event-bus.test.ts` | Create | Connection cap, backpressure, heartbeat, sequence |
| `src/portal/__tests__/unit/aggregation-cache.test.ts` | Create | TTL, LRU, memory eviction, pattern invalidation |
| `src/portal/__tests__/unit/state-reader.test.ts` | Create | Schema validation, error paths, cache integration |
| `src/portal/__tests__/unit/cost-reader.test.ts` | Create | Empty ledger, summary shape |
| `src/portal/__tests__/unit/heartbeat-reader.test.ts` | Create | Stale threshold, state transitions |
| `src/portal/__tests__/unit/log-reader.test.ts` | Create | Reverse read, plain-text fallback, filtering |
| `src/portal/__tests__/unit/redaction.test.ts` | Create | Per-rule, idempotence, fuzz |
| `src/portal/__tests__/integration/event-flow.test.ts` | Create | File mutation → SSE delivery e2e |
| `src/portal/__tests__/integration/backpressure.test.ts` | Create | Slow client does not block fast clients |
| `src/portal/__tests__/integration/daemon-down.test.ts` | Create | Banner transitions on heartbeat staleness |
| `src/portal/__tests__/integration/cross-platform.test.ts` | Create | Atomic writes, rotation, rapid changes |
| `src/portal/__tests__/integration/soak.test.ts` | Create | 1-hour leak detection (gated to nightly) |
| `src/portal/__tests__/helpers/tmp-repo.ts` | Create | Scaffolds `.autonomous-dev/` tree under tmp dir |
| `src/portal/__tests__/helpers/sse-client.ts` | Create | Test-only SSE client that parses events into a queue |
| `src/portal/__tests__/helpers/atomic-write.ts` | Create | `writeAtomic`, `simulateRotation`, `bumpMtime` |
| `src/portal/__tests__/fixtures/state-fixtures.ts` | Create | Builders for valid + malformed state.json |
| `src/portal/__tests__/fixtures/log-fixtures.ts` | Create | Daemon-log lines covering all redaction rules |
| `package.json` | Modify | Add `test:integration`, `test:soak`, `test:cross-platform` scripts |
| `.github/workflows/ci.yml` | Modify | Add macos-latest matrix entry for cross-platform tests |

## Implementation Details

### Helpers

**`tmp-repo.ts`** scaffolds a complete `.autonomous-dev/` tree:

```typescript
export interface TmpPortalRepo {
  basePath: string;                       // absolute
  requestsDir: string;                    // basePath/.autonomous-dev/requests
  costLedgerPath: string;                 // .../cost-ledger.json
  heartbeatPath: string;                  // .../heartbeat.json
  daemonLogPath: string;                  // .../daemon.log
  cleanup: () => Promise<void>;
  writeRequestState(id: string, state: Partial<RequestState>): Promise<string>;
  writeHeartbeat(hb: Partial<Heartbeat>): Promise<void>;
  appendLogLine(line: string | object): Promise<void>;
  appendCostEntry(entry: Partial<CostEntry>): Promise<void>;
}
export function makeTmpPortalRepo(): Promise<TmpPortalRepo>;
```

`writeRequestState` writes via temp+rename to mirror daemon atomic-write semantics. All paths returned are absolute and canonical (`fs.realpath` resolved).

**`sse-client.ts`** opens a real `EventSource` against an in-process Hono server and exposes:

```typescript
export interface TestSSEClient {
  events: PortalEvent[];                  // accumulator
  errors: Event[];
  readyState: 'connecting' | 'open' | 'closed';
  waitForEvent(predicate: (e: PortalEvent) => boolean, timeoutMs?: number): Promise<PortalEvent>;
  waitForCount(n: number, timeoutMs?: number): Promise<void>;
  close(): void;
}
export function makeTestSSEClient(url: string): Promise<TestSSEClient>;
```

Built on Bun's `EventSource` polyfill or a thin manual fetch+ReadableStream parser if the polyfill is missing. The client MUST handle reconnection events (it just records them; the suite asserts on the events the bus sent).

**`atomic-write.ts`**:

```typescript
export async function writeAtomic(path: string, content: string): Promise<void>;
// writes to <path>.tmp.<random>, fsync, rename to <path>

export async function simulateRotation(path: string): Promise<void>;
// renames <path> to <path>.1, creates fresh empty <path>

export async function bumpMtime(path: string, deltaMs: number): Promise<void>;
// uses fs.utimes to push mtime forward (used for staleness fixtures)
```

### Unit tests — `file-watcher.test.ts`

Use `bun:test` (or `jest` if PLAN-013-2 standardized on jest). Each test creates a tmp dir + temporary FileWatcher; `afterEach` calls `dispose()`.

1. `start()` resolves patterns and emits zero events for pre-existing files (baseline mtime suppression).
2. After `start()`, atomic write to a watched file → ONE `fileChange` event with `type: 'change'` within `debounceDelay + 50ms`.
3. 50 raw events injected via the internal `_handleRawEvent` within 100ms → ONE emission whose `timestamp` is `>= firstSeen + debounceDelay`.
4. Mixed event sequence on same path: `change` then `change` → emitted type `change`. `change` then `error` → emitted type `error` (precedence). `delete` then `create` → emitted type `create` (last-wins on file replacement).
5. Polling-only mode (`options.polling: true`): `getMode() === 'polling'`, zero `FSWatcher` instances created (verify by spying on `node:fs.watch`).
6. Native fallback to polling on EMFILE: stub `fs.watch` to throw EMFILE for files past index 5; assert files 0–4 use native, 5+ use polling, NO crash.
7. `dispose()` is idempotent; calling twice does not throw and emits no further events for in-flight raw bursts.
8. `start()` after `dispose()` rejects with `Error('FileWatcher has been disposed')`.
9. `start()` calling `start()` rejects with `Error('FileWatcher already started')`.
10. Patterns matching zero files succeed; `getWatchedFiles().length === 0`; no events ever fire.
11. Polling backend: deleting a watched file emits `delete` once; subsequent polls do not re-emit until file reappears (verified via spy on the funnel).
12. `maxFileDescriptors` ceiling: with `maxFileDescriptors: 3` and 10 files, native count is exactly 3 and polling handles the remaining 7.

### Unit tests — `sse-event-bus.test.ts`

Use a stub `Hono` `Context` that captures stream output into a buffer. Each test instantiates a fresh `SSEEventBus`.

1. `handleConnection` returns 429 with `Retry-After: 30` when `connections.size === maxConnections`. The 11th request creates NO `Connection`.
2. New connection's first frame is `: connected\n\n` (SSE comment) followed by a heartbeat event.
3. `broadcast({ type: 'state-change', ...})` calls `Connection.write` on every open connection; closed connections are skipped.
4. Per-connection backpressure: stub one connection's `writeSSE` to never resolve. `writeQueueDepth` saturates at `writeQueueLimit`; further `write()` calls return `'dropped'` and increment `droppedEventCount`. The bus does NOT throw or block.
5. Connection write throws (TCP reset stub) → connection state transitions to `closed`, removed from registry within the same broadcast cycle.
6. Heartbeat sweeper closes connections whose `lastHeartbeat` is older than `connectionTimeoutMs` (use fake timers to advance clock).
7. Sequence counter is monotonic across the bus: 100 broadcasts produce events with seq `1..100` in order.
8. Every broadcast event passes `PortalEvent.safeParse(event).success === true`.
9. `shutdown()` sends a final `: shutdown\n\n` SSE comment to every connection, closes them, and subsequent `broadcast` calls are no-ops.
10. SSE wire format is exactly `id: <id>\nevent: <type>\ndata: <json>\n\n` (asserted byte-for-byte).
11. Heartbeat firing interval drift is bounded: over 5 cycles, max observed gap ≤ `heartbeatIntervalMs + 100ms`.
12. `getConnectionStats()` reflects per-connection `droppedEventCount`, `writeQueueDepth`, `ageMs`.

### Unit tests — `aggregation-cache.test.ts`

1. `set` then `get` returns the value (within TTL).
2. `get` after TTL expiry returns null (stat: `missCount++`, `hitCount` unchanged).
3. `invalidate(key)` removes the entry; subsequent `get` is a miss.
4. `invalidatePattern(/^state:/)` removes ALL keys matching; returns the count.
5. LRU eviction: `maxEntries: 5`, set 6 entries, oldest by `lastAccess` is evicted; verify via `getStats()` and `get` of the evicted key.
6. Memory eviction: `maxMemoryMB: 0.001` (force overflow with small fixtures); 20% of entries dropped on overflow.
7. `getStats().hitRatio` calculation: 7 hits + 3 misses → `0.7`.
8. `clear()` empties cache and resets counters.
9. `shutdown()` stops the cleanup timer; setting after shutdown does nothing.
10. Per-entry TTL override: `set(k, v, 100)`; after 200ms, `get(k)` is a miss even though `defaultTTLMs > 200`.

### Unit tests — `state-reader.test.ts`

1. Valid state file → `{ ok: true, value: <parsed> }`. Cache populated.
2. Second call within TTL hits cache (verify via spy on `Bun.file`).
3. Missing file → `{ ok: true, value: null }`. Cache NOT populated.
4. Malformed JSON → `{ ok: false, error }` with file path in message. Cache NOT populated.
5. Schema-violation (unknown phase value) → `{ ok: false, error }` with Zod issue path.
6. Invalid request_id format (`'not-an-id'`) → `{ ok: false, error }` WITHOUT calling `Bun.file`.
7. `readAllStates({ phase: ['executing'] })` filters correctly.
8. `readAllStates({ includeTerminal: false })` excludes `completed | failed | cancelled`.
9. `readAllStates({ limit: 5, offset: 10 })` returns the 11th–15th newest entries.
10. `getStateCounts()` sums correctly across non-malformed files; malformed files are excluded.
11. After `wireStatePipeline`, modifying a state file invalidates `state:<id>` AND aggregate caches AND broadcasts `state-change` SSE.
12. `state-change` broadcast includes correct `old_phase` (cached previous phase, null on first read) and `new_phase` (current).

### Unit tests — `redaction.test.ts`

1. Each of the 10 redaction rules: provide one canonical positive fixture and assert the output equals the documented replacement.
2. Each rule: provide a negative fixture (a string that LOOKS similar but does NOT match) and assert NO redaction occurs.
3. Idempotence: for 100 random fixtures (combination of all rules), `redactString(redactString(s)) === redactString(s)`.
4. Order matters: a string containing both a JWT-shaped token AND a Bearer header has both redacted independently.
5. `getRedactionCounts()` increments per match; redacting a string with two API keys increments the api-key counter by 2.
6. Empty string and undefined inputs are handled (redactString returns the input unchanged for empty; types reject undefined at the type level).
7. Recursive `redactLogLine.context` redaction: nested objects with strings at multiple depths are all redacted.
8. Performance smoke: `redactString` on a 10 KB log line completes in <5ms (asserted via `performance.now`).

### Unit tests — `cost-reader.test.ts`, `heartbeat-reader.test.ts`, `log-reader.test.ts`

Cover all acceptance criteria from SPEC-015-1-04. Highlights:

- `LogReader` reads ONLY the last N lines from a 100 MB synthetic log (peak memory ≤ 32 MB asserted via `process.memoryUsage().heapUsed`).
- `LogReader` plain-text legacy line → `source: 'unknown'`, `raw` populated.
- `LogReader` rotation: simulate via `simulateRotation(daemonLogPath)`; reader picks up new file's content on next call.
- `HeartbeatReader.getStatus()` transitions: warm fixtures with `bumpMtime`-controlled timestamps.

### Integration tests — `event-flow.test.ts`

Use `tmp-repo.ts` + a real Hono server bound to `localhost:0` (random port) with the full pipeline wired. `sse-client.ts` connects.

1. **End-to-end state-change**: write valid state.json for `REQ-000001` → SSE client receives `state-change` event with the correct payload within 1000ms.
2. **End-to-end cost-update**: append cost entry → SSE client receives `cost-update` with correct `delta_usd`.
3. **End-to-end log-line**: append a structured log line → SSE client receives `log-line` event with redacted message.
4. **End-to-end heartbeat staleness**: stop writing heartbeat for 65s (use fake timers) → SSE client receives `daemon-down` event with `stale_seconds >= 60`.
5. **Recovery**: after daemon-down, write a fresh heartbeat → SSE client receives `daemon-down` with `stale_seconds === 0`.
6. **Sequence numbers monotonic**: across all events received, every event's `seq` is strictly greater than the prior event's seq.
7. **Initial state on connect**: a new SSE client connecting AFTER startup receives a heartbeat as its first event.
8. **Schema integrity**: every received event passes `PortalEvent.safeParse` on the client side.

### Integration tests — `backpressure.test.ts`

1. **Fast client unaffected by slow client**: open 2 SSE clients, one normal, one stubbed to read at 1 event per 5s. Broadcast 100 events in a tight loop. The fast client receives all 100 within 2s; the slow client's `droppedEventCount` is non-zero but the bus and fast client are unaffected.
2. **10-connection cap**: open 10 SSE clients, attempt 11th → 429 response; the 10 existing clients continue receiving events.
3. **Disconnect under load**: while broadcasting 1000 events, abort one client mid-stream. The other clients receive all 1000; the aborted client's connection is removed within one broadcast cycle.
4. **Heartbeat staleness sweep**: connect a client, then freeze its read loop. After `connectionTimeoutMs + 1s`, the bus closes the connection; `getConnectionCount()` decrements.

### Integration tests — `cross-platform.test.ts`

Platform guards: tests use `process.platform === 'darwin'` / `'linux'` to select fixture variants. CI matrix runs both.

1. **Atomic write coalesce**: `writeAtomic(path, ...)` 10 times in 100ms. FileWatcher emits ≤ `Math.ceil(elapsedMs / debounceDelay) + 1` events (target: 1–2 events for 200ms debounce).
2. **Truncate-then-rewrite**: `Bun.write(path, '')` then `Bun.write(path, 'new')` within 50ms → exactly 1 emitted event.
3. **Symlink target change** (Linux only; macOS APFS treats differently): symlink `state.json -> state.real.json`, modify the target → emits change for the symlink path. Skipped on macOS.
4. **Rapid changes burst**: 200 writes within 500ms; emitted events ≤ 5 (proves debounce coalescing under load).
5. **macOS FSEvents merge**: macOS-specific test asserts that two writes to the same file within 10ms produce 1 OR 2 events (FSEvents may merge or split; both are acceptable). The bus broadcast count must be 1.
6. **Linux inotify rapid rename** (Linux only): `mv a.json b.json && mv b.json a.json` → no spurious events for `a.json` beyond the start+end (debounce absorbs the intermediate).

### Integration tests — `daemon-down.test.ts`

1. **Cold start with no heartbeat file**: pipeline starts; first poll cycle (30s default) detects missing heartbeat → broadcasts initial transition `unknown → down` event.
2. **Cold start with stale heartbeat**: heartbeat.json exists but ts is 5 minutes old → first read transitions `unknown → down`.
3. **No spam**: under steady-state healthy daemon (heartbeat written every 1s), zero `daemon-down` events broadcast over a 60s observation window.
4. **Single-event transition**: down → up transition broadcasts EXACTLY ONE recovery event, not multiple.
5. **Stale-poll detection**: stop heartbeat writes (no fs events fire); 30s + 60s threshold elapses; pipeline broadcasts `daemon-down` triggered by the poll, not by file events.

### Integration tests — `soak.test.ts`

Gated to a nightly job (skipped in PR CI to keep runtimes manageable). Runs for 1 hour:

1. Continuously write to all 4 file types at randomized intervals (10–500ms).
2. 5 SSE clients connected throughout.
3. At end of hour: assert `process.memoryUsage().heapUsed` has not grown by more than 50 MB above initial baseline (baseline measured at 30s after start to skip warmup).
4. Assert no unhandled errors in stderr; assert connection count stable.
5. Assert SSE delivery latency p95 < 1000ms across the hour (record per-event `serverEmitTs - clientReceiveTs` deltas).

### CI wiring

`package.json`:

```json
"scripts": {
  "test:unit": "bun test src/portal/__tests__/unit",
  "test:integration": "bun test src/portal/__tests__/integration --timeout 60000",
  "test:soak": "bun test src/portal/__tests__/integration/soak.test.ts --timeout 4000000",
  "test:cross-platform": "bun test src/portal/__tests__/integration/cross-platform.test.ts"
}
```

`.github/workflows/ci.yml` adds:

- `os: [ubuntu-latest, macos-latest]` matrix entry for the `test:cross-platform` step.
- A separate nightly workflow for `test:soak` (runs at 02:00 UTC, on `main` only).

## Acceptance Criteria

- [ ] `bun test:unit` runs in < 30 seconds total wall-clock on a Linux x64 4 vCPU runner.
- [ ] All 12 file-watcher unit cases pass on both macOS and Linux.
- [ ] All 12 SSE-event-bus unit cases pass; backpressure cases verify `droppedEventCount > 0` while fast clients receive all events.
- [ ] All 10 aggregation-cache unit cases pass; LRU and memory-eviction tests do not flake.
- [ ] All 12 state-reader unit cases pass; schema-violation paths do NOT cache; pipeline broadcasts `state-change` exactly once per file change.
- [ ] All 8 redaction unit cases pass; idempotence holds across 100 random fixtures.
- [ ] Integration `event-flow.test.ts`: end-to-end SSE delivery latency p95 < 1000ms over 100 events.
- [ ] Integration `backpressure.test.ts`: with 1 slow client (5s/event), 100 broadcast events deliver to fast clients in < 2 seconds; slow client's `droppedEventCount > 0`; no events lost on fast clients.
- [ ] Integration `cross-platform.test.ts`: 200 atomic writes in 500ms produce ≤ 5 SSE dispatches on BOTH macOS and Linux runners.
- [ ] Integration `daemon-down.test.ts`: down→up→down transitions produce exactly one event per transition; zero events during steady-state.
- [ ] Soak test: heap growth ≤ 50 MB after 1 hour with 5 clients connected and continuous writes.
- [ ] Coverage: `src/portal/watchers`, `src/portal/sse`, `src/portal/cache`, `src/portal/readers`, `src/portal/integration` directories reach ≥ 90% line and ≥ 85% branch coverage. CI fails below thresholds.
- [ ] No test mutates files outside the per-test tmp directory; `afterEach` cleanup verified by tmp-dir size baseline.
- [ ] All redaction rules are exercised via positive AND negative fixtures.
- [ ] Cross-platform tests are CONDITIONALLY skipped via platform guards (no false failures on unsupported runners).
- [ ] Soak test runs under a nightly workflow (`workflow_dispatch` and `schedule: cron 0 2 * * *`); excluded from PR CI.

## Dependencies

- **Consumes**: SPEC-015-1-01 (FileWatcher), SPEC-015-1-02 (SSEEventBus), SPEC-015-1-03 (StateReader, AggregationCache), SPEC-015-1-04 (CostReader, HeartbeatReader, LogReader, redaction).
- **Test framework**: `bun:test` (or jest if PLAN-013-2 standardized — verify in `package.json`). Snapshot tests are NOT used; assertions are explicit.
- **CI**: GitHub Actions runners — `ubuntu-latest`, `macos-latest`. Nightly schedule for soak.
- **External**: Bun's `EventSource` polyfill (or `eventsource` npm package as fallback for the test client).

## Notes

- **Why split unit and integration?** PR CI must remain fast (< 5 min total). Unit tests run on every commit; integration runs on PR; soak runs nightly. Cross-platform tests run on PR but are gated to the matrix runners.
- **Why explicit fake timers in some tests?** Real-time waits (e.g., for 65s heartbeat staleness) would push integration test runtime to hours. Fake timers (`Bun.test.useFakeTimers()` or `jest.useFakeTimers()`) advance the clock deterministically and reduce these to milliseconds.
- **Why no live-network SSE polyfill in unit tests?** Unit tests stub the `Hono.Context` and `streamSSE` to avoid HTTP overhead. Integration tests are the layer where real HTTP + EventSource are exercised end-to-end.
- **Why test rotation specifically?** Daemon log rotation (`logrotate` on Linux, manual `mv + create` on macOS dev) is a known source of dropped events in naive watchers; explicit tests catch regressions.
- **Why the 50 MB heap-growth ceiling on soak?** Allows for legitimate cache fill-up (50 MB matches `AggregationCache.maxMemoryMB` default) but flags any unbounded leak. Tighter ceilings yield false positives during normal cache equilibration.
- **Why a `getRedactionCounts` test?** Operations dashboard surfaces these counts. A zero-counter regression on a known-positive fixture would silently break observability without breaking any user-visible behavior.
- **Cross-platform skips**: tests that genuinely require platform-specific kernel features (inotify symlink semantics) skip rather than fail on the wrong platform. The CI matrix ensures both platforms are exercised.
- **Concurrency note**: integration tests use unique random ports (`localhost:0`) and unique tmp dirs per test to enable safe parallelism. Tests do not share state.
- **Flake mitigation**: any timing-sensitive test (debounce, heartbeat) uses `>=` rather than `===` for time comparisons and `expect(...).toBeLessThanOrEqual(...)` for upper bounds. We never assert exact timer firing times.
