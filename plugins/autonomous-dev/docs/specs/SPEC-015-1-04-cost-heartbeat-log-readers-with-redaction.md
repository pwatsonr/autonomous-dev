# SPEC-015-1-04: Read-Only Accessors — `cost-ledger.json`, `heartbeat.json`, `daemon.log` (with Redaction)

## Metadata
- **Parent Plan**: PLAN-015-1
- **Tasks Covered**: TASK-009 (CostReader), TASK-010 (LogReader), TASK-011 (DaemonHealthMonitor / heartbeat reader)
- **Estimated effort**: 8 hours

## Description

Implement the remaining read-only accessors for the daemon's three repo-level files: `cost-ledger.json` (running cost totals + per-request breakdown), `heartbeat.json` (daemon liveness signal), and `daemon.log` (last 500 lines with structured parsing). All three readers reuse the `AggregationCache` and `FileWatcher` infrastructure from SPEC-015-1-03 and broadcast typed SSE events (`cost-update`, `daemon-down`, `log-line`) when their underlying files change.

**Redaction is non-negotiable for the log reader.** `daemon.log` may contain absolute filesystem paths under user home directories, environment variable values that include secrets, request payloads with API keys, and stacktraces with file:line references that leak internal structure. The `LogReader` applies a deterministic redaction pipeline before any log line leaves the portal process — both via direct `readRecent()` calls and via SSE `log-line` broadcasts. The redaction matrix is defined in this spec and MUST match the daemon's own audit-log redaction pattern (SPEC-014-3-03 baseline) so portal-rendered logs and daemon-stored logs are byte-identical for the redacted spans.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/portal/readers/CostReader.ts` | Create | Reads + aggregates cost-ledger.json |
| `src/portal/readers/HeartbeatReader.ts` | Create | Reads heartbeat.json + computes staleness |
| `src/portal/readers/LogReader.ts` | Create | Reverse-reads last 500 lines + applies redaction |
| `src/portal/readers/redaction.ts` | Create | Pure redaction functions (testable in isolation) |
| `src/portal/readers/schemas/cost.ts` | Create | Zod schemas for cost-ledger.json + cost events |
| `src/portal/readers/schemas/heartbeat.ts` | Create | Zod schema for heartbeat.json |
| `src/portal/readers/schemas/log.ts` | Create | Zod schema for structured log lines |
| `src/portal/readers/types.ts` | Modify | Add `CostLedger`, `Heartbeat`, `LogLine` types |
| `src/portal/readers/index.ts` | Modify | Export new readers |
| `src/portal/integration/cost-pipeline.ts` | Create | Wires FileWatcher → cost cache invalidation → SSE |
| `src/portal/integration/heartbeat-pipeline.ts` | Create | Watches heartbeat staleness; emits daemon-down |
| `src/portal/integration/log-pipeline.ts` | Create | Tails daemon.log; broadcasts redacted lines |

## Implementation Details

### Cost ledger schema (`src/portal/readers/schemas/cost.ts`)

```typescript
import { z } from 'zod';

export const CostEntrySchema = z.object({
  ts: z.string().datetime(),
  request_id: z.string().regex(/^REQ-\d{6}$/).nullable(),
  phase: z.string().nullable(),
  delta_usd: z.number(),
  reason: z.enum(['session_completion', 'session_failure', 'manual_adjustment']).default('session_completion'),
  session_id: z.string().nullable().optional(),
});

export const CostLedgerSchema = z.object({
  version: z.literal(1),
  total_usd: z.number().nonnegative(),
  daily_usd: z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.number().nonnegative()),
  per_request: z.record(z.string().regex(/^REQ-\d{6}$/), z.number().nonnegative()),
  entries: z.array(CostEntrySchema),       // append-only log
  last_updated: z.string().datetime(),
});
export type CostLedger = z.infer<typeof CostLedgerSchema>;
export type CostEntry = z.infer<typeof CostEntrySchema>;
```

### `CostReader` (`src/portal/readers/CostReader.ts`)

```typescript
export interface CostSummary {
  total_usd: number;
  daily_usd: Record<string, number>;
  recent_entries: CostEntry[];     // last 50 entries by ts desc
  per_request_top: Array<{ request_id: string; cost_usd: number }>;  // top 10
}

export class CostReader {
  constructor(deps: { basePath: string; cache: AggregationCache });

  /** Returns the full ledger, validated. Missing file → returns ok with empty ledger. */
  async readLedger(): Promise<Result<CostLedger>>;

  /** Cached summary view used by dashboards. TTL: 5s. */
  async getSummary(): Promise<Result<CostSummary>>;

  /** Pre-computed last-N entries; convenience accessor. */
  async getRecentEntries(limit?: number): Promise<Result<CostEntry[]>>;
}
```

**Empty-ledger semantics**: when `cost-ledger.json` does NOT exist, `readLedger` returns `{ ok: true, value: { version: 1, total_usd: 0, daily_usd: {}, per_request: {}, entries: [], last_updated: now() } }`. This makes downstream consumers simpler (no null-check branches in the UI).

**Cache keys**: `cost:ledger`, `cost:summary`, `cost:recent:<limit>`. All TTL 5s. Invalidated on `FileChangeEvent` for `cost-ledger.json`.

**No cost calculation logic in this spec.** PLAN-015-3 owns trend analysis, forecasting, and budget threshold checks. This spec is purely a reader + aggregator that shapes the data for the UI.

### Heartbeat schema (`src/portal/readers/schemas/heartbeat.ts`)

```typescript
export const HeartbeatSchema = z.object({
  version: z.literal(1),
  ts: z.string().datetime(),
  pid: z.number().int().positive(),
  uptime_s: z.number().int().nonnegative(),
  daemon_version: z.string(),
  active_requests: z.number().int().nonnegative().default(0),
});
export type Heartbeat = z.infer<typeof HeartbeatSchema>;
```

### `HeartbeatReader` (`src/portal/readers/HeartbeatReader.ts`)

```typescript
export interface DaemonStatus {
  state: 'up' | 'down' | 'unknown';
  last_heartbeat: Heartbeat | null;
  stale_seconds: number;            // 0 when state='up'
  threshold_seconds: number;
}

export class HeartbeatReader {
  constructor(deps: { basePath: string; cache: AggregationCache; staleThresholdSeconds?: number });
  // default staleThresholdSeconds = 60

  async readHeartbeat(): Promise<Result<Heartbeat | null>>;
  async getStatus(): Promise<Result<DaemonStatus>>;
}
```

`getStatus` flow:

1. `readHeartbeat()` → if missing or malformed, return `{ ok: true, value: { state: 'unknown', last_heartbeat: null, stale_seconds: 0, threshold_seconds } }`.
2. `stale_seconds = (now - heartbeat.ts) / 1000`.
3. If `stale_seconds <= threshold_seconds` → state `'up'`. Else `'down'`.

Cache TTL: 2s (heartbeat liveness must be fresh). Invalidated on heartbeat.json file changes AND on a 30s timer that re-checks staleness even without file changes (to detect daemon-down when heartbeat STOPS being written).

### `HeartbeatPipeline` (`src/portal/integration/heartbeat-pipeline.ts`)

```typescript
export function wireHeartbeatPipeline(deps: {
  watcher: FileWatcher;
  reader: HeartbeatReader;
  cache: AggregationCache;
  bus: SSEEventBus;
  staleCheckIntervalMs?: number;   // default 30_000
}): { dispose: () => void };
```

Two trigger paths feed `daemon-down` broadcasts:

1. **File-change path**: `heartbeat.json` updates → cache invalidate → re-read → if state transitioned from previous `state`, broadcast `daemon-down` event with the current `stale_seconds` (positive if down, 0 if recovering).
2. **Stale-poll path**: a `setInterval(staleCheckIntervalMs)` that re-reads the heartbeat (NOT via cache; direct file read) and triggers the same transition-detection logic. This catches the case where the daemon has died and stopped touching the file — `fs.watch` produces NO events for a file that simply isn't being modified.

State-transition detection uses an internal `lastBroadcastedState` field. Only state transitions trigger broadcasts (no spam every 30s while daemon is healthy). When transitioning to `'down'`, the broadcast payload's `last_heartbeat_ts` is the most recent heartbeat ts seen; on `'up'` recovery, broadcast a fresh `daemon-down` with `stale_seconds=0` (recovery signal — clients toggle the banner off).

Initial state on startup: `'unknown'` until the first read completes. The first transition from `'unknown'` to `'up'` or `'down'` IS broadcast.

### Log line schema (`src/portal/readers/schemas/log.ts`)

The daemon writes log lines as JSONL with a known schema; legacy lines may be plain text. The reader handles both.

```typescript
export const StructuredLogLineSchema = z.object({
  ts: z.string().datetime(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  source: z.enum(['daemon', 'intake', 'portal']).default('daemon'),
  request_id: z.string().regex(/^REQ-\d{6}$/).nullable().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export const LogLineSchema = z.object({
  ts: z.string().datetime(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  source: z.enum(['daemon', 'intake', 'portal', 'unknown']).default('unknown'),
  request_id: z.string().nullable().optional(),
  raw: z.string().optional(),       // present when origin was unstructured plain text
});
export type LogLine = z.infer<typeof LogLineSchema>;
```

### Redaction pipeline (`src/portal/readers/redaction.ts`)

A pure function `redactLogLine(line: LogLine): LogLine` and `redactString(s: string): string`. Applied to:

- `LogLine.message`
- `LogLine.raw` (if present)
- All string-valued leaves of `LogLine.context` (recursive)

**Redaction rules** (applied in order, all are case-insensitive where regex supports it):

| # | Pattern | Replacement | Notes |
|---|---------|-------------|-------|
| 1 | `\b(sk-[A-Za-z0-9]{20,})` | `sk-[REDACTED]` | OpenAI / Anthropic style API keys |
| 2 | `\b(ghp_[A-Za-z0-9]{36})` | `ghp_[REDACTED]` | GitHub fine-grained PATs |
| 3 | `\b(github_pat_[A-Za-z0-9_]{82})` | `github_pat_[REDACTED]` | GitHub fine-grained PAT (newer format) |
| 4 | `\b(xox[baprs]-[A-Za-z0-9-]{10,})` | `xoxx-[REDACTED]` | Slack tokens |
| 5 | `\b([A-Za-z0-9]+:\/\/[^@\s]+@[^\s]+)` | scheme + `://[REDACTED]@` + host | URL credentials (`https://user:pass@host`) |
| 6 | `\b(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})` | `eyJ.[REDACTED].[REDACTED]` | JWTs (3-segment) |
| 7 | `\bAuthorization:\s*Bearer\s+([A-Za-z0-9._-]{16,})` | `Authorization: Bearer [REDACTED]` | Bearer tokens in headers |
| 8 | `(/Users/[^/\s]+)/` | `/Users/[REDACTED]/` | macOS home directories |
| 9 | `(/home/[^/\s]+)/` | `/home/[REDACTED]/` | Linux home directories |
| 10 | `\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})` | `[REDACTED]@\2` | Email addresses (preserves domain for triage) |

Rules MUST be applied in order; later rules MUST NOT match against `[REDACTED]` placeholders introduced by earlier rules (placeholders include `[REDACTED]` literal which contains no characters matching the patterns above — verified by test).

Redaction is implemented as a list of `{ pattern: RegExp, replacer: (match, ...groups) => string }` records. The function MUST be deterministic and side-effect-free (callable from broadcast hot paths and tests alike).

**Counter for observability**: the redactor exports `getRedactionCounts(): Record<string, number>` showing how many times each rule fired in the current process lifetime, exposed via the operations dashboard in PLAN-015-3. Counters are incremented atomically per replacement (each match counts once).

### `LogReader` (`src/portal/readers/LogReader.ts`)

```typescript
export interface ReadLogOptions {
  limit?: number;                  // default 500, max 5000
  level?: LogLine['level'][];       // filter
  since?: string;                   // ISO ts; only entries >= since
  search?: string;                  // case-insensitive substring on message (post-redaction)
}

export class LogReader {
  constructor(deps: { basePath: string; cache: AggregationCache });
  async readRecent(opts?: ReadLogOptions): Promise<Result<LogLine[]>>;
}
```

**Reverse reading**: the daemon log can grow to many MB. The reader reads from the END of the file:

1. `Bun.file(path).size` to get total bytes.
2. Read backward in 64 KB chunks via `Bun.file(path).slice(start, end).text()`.
3. Split on `\n`, drop the first chunk's leading partial line (it may be mid-line until the previous chunk arrives).
4. Buffer lines until `>= limit` complete lines are collected OR file start is reached.
5. For each line: try `JSON.parse + StructuredLogLineSchema.safeParse`. On success, normalize to `LogLine`. On failure, treat as plain text with `{ ts: now(), level: 'info', message: line, source: 'unknown', raw: line }`.
6. Apply redaction.
7. Apply filters (`level`, `since`, `search`).
8. Reverse to chronological order.
9. Return.

Cache key: `log:recent:${JSON.stringify(opts || {})}`. TTL: 2s. Invalidated on `daemon.log` file changes.

### `LogPipeline` (`src/portal/integration/log-pipeline.ts`)

```typescript
export function wireLogPipeline(deps: {
  watcher: FileWatcher;
  reader: LogReader;
  cache: AggregationCache;
  bus: SSEEventBus;
  basePath: string;
}): { dispose: () => void };
```

Tails the log: on each `daemon.log` change event, the pipeline:

1. Invalidates `log:*` cache keys.
2. Reads NEW lines only — maintains an internal `lastByteOffset` cursor; on file change, reads from `lastByteOffset` to current `size`, parses, redacts.
3. For each new line, broadcasts a `log-line` SSE event with `{ level, message, source }` (where `message` is post-redaction). `request_id` and `context` are intentionally NOT sent over the wire in this spec — the events tab uses `LogReader.readRecent` for full context. SSE log-line is the live tail only.

**Log rotation handling**: if the watched file's `size < lastByteOffset` (file was truncated or rotated), reset `lastByteOffset = 0` and re-tail from the start of the new file. Log a warn-level diagnostic.

**Cost pipeline** (`src/portal/integration/cost-pipeline.ts`) is structurally analogous: invalidates cost cache + broadcasts `cost-update` SSE events with the delta of `total_usd` since the last broadcast (computed by holding the previous `total_usd` in a closure variable; first event on startup uses `delta_usd = 0`).

## Acceptance Criteria

- [ ] `CostReader.readLedger()` for a missing `cost-ledger.json` returns `{ ok: true, value: { version: 1, total_usd: 0, daily_usd: {}, per_request: {}, entries: [], last_updated: <iso> } }`.
- [ ] `CostReader.readLedger()` for a malformed file returns `{ ok: false, error }` and does NOT cache.
- [ ] `CostReader.getSummary()` returns `recent_entries` sorted by `ts` desc, length ≤ 50, AND `per_request_top` length ≤ 10 sorted by `cost_usd` desc.
- [ ] `HeartbeatReader.getStatus()` returns `state: 'up'` when `now - heartbeat.ts <= 60s`, `state: 'down'` when greater, `state: 'unknown'` when file missing or malformed.
- [ ] `wireHeartbeatPipeline` broadcasts a single `daemon-down` SSE event when the daemon transitions from `up` → `down`, and a single recovery `daemon-down` event with `stale_seconds=0` on `down` → `up`. No broadcasts during steady state.
- [ ] The 30s stale-poll timer detects daemon death even when no file events fire (verified by stopping all writes to `heartbeat.json` and waiting > threshold + interval).
- [ ] `LogReader.readRecent()` for a missing `daemon.log` returns `{ ok: true, value: [] }`.
- [ ] `LogReader.readRecent({ limit: 100 })` reads at most 100 lines and avoids loading the entire file into memory (verified by checking peak memory under a 100 MB synthetic log).
- [ ] Plain-text legacy log lines are returned with `source: 'unknown'` and the original text in `raw`.
- [ ] Every redaction rule from the table fires correctly: an input string containing one example of each pattern returns the documented replacements (test fixture provides one canonical example per rule).
- [ ] Redaction is idempotent: `redactString(redactString(s)) === redactString(s)` for any `s` (verified by a property-style test on a fixture set).
- [ ] No log line emitted via SSE `log-line` event contains an unredacted match for any of the 10 redaction rules (verified by a fuzz test that injects each pattern into a daemon-log fixture and asserts the broadcast payload is clean).
- [ ] `wireLogPipeline` broadcasts only NEW lines after each file change (`lastByteOffset` advances correctly); restarting the pipeline does NOT re-broadcast historical lines.
- [ ] When `daemon.log.size < lastByteOffset` (rotation), the pipeline resets and resumes from the new file's beginning without crashing.
- [ ] `wireCostPipeline` broadcasts `cost-update` events with `delta_usd` equal to `current.total_usd - previous.total_usd`. The first broadcast on startup uses `delta_usd = 0` (no historical deltas).
- [ ] `getRedactionCounts()` returns a non-decreasing counter map; calling redaction operations increments the matching rule's count.
- [ ] All readers respect cache TTLs documented in this spec (5s for cost, 2s for heartbeat, 2s for log) — verified via spy on `Bun.file`.
- [ ] All pipelines' `dispose()` removes listeners, clears intervals, and is safe to call twice.

## Dependencies

- **Consumes**: SPEC-015-1-01 (`FileWatcher`), SPEC-015-1-02 (`SSEEventBus`), SPEC-015-1-03 (`AggregationCache`, `Result<T>` type), `zod`, `Bun.file`.
- **Blocks**: SPEC-015-1-05 (test suite); PLAN-015-3 (cost analysis page consumes `CostReader.getSummary`); PLAN-015-3 (log tailing UI consumes `wireLogPipeline` SSE stream); PLAN-015-4 (operations page consumes `HeartbeatReader.getStatus`).
- **External**: Daemon writes `cost-ledger.json` and `heartbeat.json` per the formats documented in PLAN-001 (daemon spec) and PLAN-008-2 (cost ledger spec). Schemas in this spec are the portal's contract with those producers.

## Notes

- **Why redact in the portal even though the daemon already redacts its audit log?** Defense in depth. The daemon's audit log uses redaction (SPEC-014-3-03); `daemon.log` is a separate, less-curated stream where ad-hoc `console.log` from intake adapters or third-party libraries can leak. Re-applying the same regex pattern in the portal ensures portal output is safe regardless of what the daemon emits.
- **Why share the redaction matrix with the daemon?** Auditability: a security review can verify that BOTH paths apply identical redaction by diffing the `redaction.ts` regex tables. This spec's table is the canonical source; the daemon's matching matrix lives in SPEC-014-3-03.
- **Why no log-line `context` in SSE broadcasts?** SSE is a wire-format with size-sensitive delivery. The full structured log entry is available via `LogReader.readRecent` for the events tab; live tail is intentionally lean.
- **Why not stream `events.jsonl` log events?** That file's high-frequency phase events would saturate the 50-event write queue. SPEC-015-1-03 already broadcasts `state-change` for the user-relevant transitions. The `log-line` channel is reserved for human-readable text from `daemon.log`.
- **Why allow up to 5000 lines in `readRecent`?** The 500-line default matches PLAN-015-1's "last 500 lines" scope, but operators sometimes need deeper context for incident response. 5000 is a hard ceiling that bounds memory and read time.
- **Why `delta_usd = 0` on first broadcast?** No prior baseline; broadcasting the absolute total as a delta would lie. UI initial-state load via `getSummary` provides the absolute number.
- **Heartbeat threshold**: 60s default is documented in PLAN-015-1's Definition of Done. Operator-tunable via constructor option for debugging or low-throughput dev environments.
- **Cost summary's `per_request_top`** is intentionally `top 10`, not paginated. The cost analysis page in PLAN-015-3 will add filtering and pagination over `entries`. This spec keeps the summary cheap to compute.
