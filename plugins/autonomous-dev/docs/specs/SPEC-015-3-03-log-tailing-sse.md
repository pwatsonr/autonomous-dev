# SPEC-015-3-03: Log Tailing SSE Stream + Filter + Gzip Download

## Metadata
- **Parent Plan**: PLAN-015-3
- **Tasks Covered**: TASK-005 (LogFilter + LogParser), TASK-006 (Log tailing route + SSE), TASK-009 (Gzip download)
- **Estimated effort**: 6.5 hours

## Description
Implement the log tailing surface for the portal: a parser/filter pair that consumes `daemon.log` (NDJSON), a route handler that returns the last 500 entries with a filter form, an SSE endpoint that streams new lines as they are appended (with backpressure protection via a 1MB ring buffer), a gzip download endpoint for compressed export, and secret redaction applied uniformly across all egress paths. All log content reaching the client passes through the redaction filter. The file watcher and base SSE infrastructure are owned by PLAN-015-1; this spec consumes them.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `portal/logs/types.ts` | Create | `LogEntry`, `LogFilterCriteria`, `LogStreamFrame` |
| `portal/logs/parser.ts` | Create | `LogParser`: NDJSON line → `LogEntry` with malformed-line recovery |
| `portal/logs/filter.ts` | Create | `LogFilter`: AND-combine level/request_id/time-range; URL-serializable criteria |
| `portal/logs/redact.ts` | Create | `redactSecrets(entry): LogEntry` — applies regex-based redaction to message + context |
| `portal/logs/ring_buffer.ts` | Create | `RingBuffer<LogEntry>` — fixed 1MB byte budget; oldest-evicted; per-client instance |
| `portal/routes/logs.ts` | Create | `GET /logs`, `GET /logs/stream` (SSE), `GET /logs/download` |
| `portal/templates/logs.hbs` | Create | Full-page viewer with filter form |
| `portal/templates/_log_filter_form.hbs` | Create | HTMX-bound filter form fragment (used both standalone and embedded) |
| `portal/templates/_log_entry.hbs` | Create | Single-entry partial — used for full-page render and SSE frame body |

## Implementation Details

### Type Definitions (`portal/logs/types.ts`)

```typescript
export interface LogEntry {
  timestamp: string;        // ISO-8601 UTC
  level: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
  pid: number;
  iteration?: number;
  message: string;
  request_id?: string;      // optional REQ-NNNNNN
  context?: Record<string, unknown>;
}

export interface LogFilterCriteria {
  level?: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
  request_id?: string;       // exact match
  time_range?: '1h' | '4h' | '24h';
  start_time?: string;       // ISO-8601, overrides time_range when both set
  end_time?: string;         // ISO-8601
}

export interface LogStreamFrame {
  event: 'log-line' | 'heartbeat' | 'truncated';
  data: LogEntry | { reason: string };
  id?: string;               // last-event-id for resumption
}
```

### `LogParser` (`portal/logs/parser.ts`)

```typescript
export class LogParser {
  parseLine(line: string): LogEntry | null;        // returns null on malformed input
  parseFile(path: string, max?: number): Promise<LogEntry[]>;  // tail behavior: last `max` valid entries (default 500)
  async *streamFile(path: string): AsyncIterable<LogEntry>;     // for download endpoint
}
```

`parseLine`:
1. Trim whitespace; reject empty lines.
2. `JSON.parse` — on failure, return `null` (caller increments skip counter).
3. Validate required fields: `timestamp`, `level`, `pid`, `message`. Reject if any missing or wrong type.
4. Coerce `level` to uppercase. If not in enum, return `null`.
5. Return parsed entry.

`parseFile(path, max=500)`:
1. Open file, seek backward in 8KB chunks, accumulating lines until `max` valid entries are collected or BOF reached.
2. Reverse so the newest entry is last (chronological order).
3. Return array.

`streamFile(path)`: line-by-line stream via `readline`; yields valid entries. Used only by the gzip download endpoint.

### `LogFilter` (`portal/logs/filter.ts`)

```typescript
export class LogFilter {
  static fromQuery(query: Record<string, string | undefined>): LogFilterCriteria;
  static toQuery(criteria: LogFilterCriteria): Record<string, string>;
  apply(entries: LogEntry[], criteria: LogFilterCriteria, now?: () => Date): LogEntry[];
  matches(entry: LogEntry, criteria: LogFilterCriteria, now?: () => Date): boolean;
}
```

**`matches`** (AND-logic):
1. **Level**: if `criteria.level` set, entry.level MUST equal it.
2. **request_id**: if set, entry.request_id MUST exact-match (case-sensitive).
3. **Time window**: if `start_time`/`end_time` are set, both bounds apply (`start_time <= entry.timestamp <= end_time`); otherwise if `time_range` is set, derive bounds from `now() - rangeMs` to `now()`. If neither is set, no time constraint.

`time_range` mapping: `'1h' = 3,600,000ms`, `'4h' = 14,400,000ms`, `'24h' = 86,400,000ms`.

**`fromQuery`**: read query keys `level`, `request_id`, `time_range`, `start_time`, `end_time`. Validate enums; ignore invalid values silently (filter behaves as if unset). Sanitize `request_id` against `^REQ-[0-9]{6}$`; if invalid, drop the field.

**Performance**: `apply` MUST process 10,000 entries in <500ms on the CI runner. Use a single linear pass; do not allocate intermediate arrays per entry.

### `redactSecrets` (`portal/logs/redact.ts`)

```typescript
export function redactSecrets(entry: LogEntry): LogEntry;
export const REDACTION_PATTERNS: readonly { name: string; regex: RegExp; replace: string }[];
```

Patterns (applied in order, on `message` and recursively on string values inside `context`):
1. `name: 'anthropic_api_key', regex: /sk-ant-[A-Za-z0-9_-]{40,}/g, replace: 'sk-ant-***REDACTED***'`
2. `name: 'github_token', regex: /gh[pousr]_[A-Za-z0-9]{36,}/g, replace: '***GITHUB-TOKEN-REDACTED***'`
3. `name: 'aws_access_key', regex: /AKIA[0-9A-Z]{16}/g, replace: '***AWS-KEY-REDACTED***'`
4. `name: 'jwt_bearer', regex: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, replace: '***JWT-REDACTED***'`
5. `name: 'generic_secret_field', regex: /("(api_key|secret|password|token)"\s*:\s*)"[^"]+"/gi, replace: '$1"***REDACTED***"'`
6. `name: 'email', regex: /[\w.-]+@[\w.-]+\.[A-Za-z]{2,}/g, replace: '***EMAIL-REDACTED***'`

Redaction returns a new `LogEntry` (immutable). Original is never mutated — important when the same entry is fed to multiple SSE clients.

`redactSecrets` is invoked at exactly **one** point per egress path: just before serialization into HTML, SSE frame, or download stream. Never store redacted entries in the ring buffer (we redact at the seam to keep the buffer flexible for future operator views).

### `RingBuffer` (`portal/logs/ring_buffer.ts`)

```typescript
export class RingBuffer<T extends { timestamp: string }> {
  constructor(private maxBytes: number = 1024 * 1024);
  push(entry: T): { evicted: number };
  snapshot(): T[];                                         // returns oldest-to-newest copy
  takeSince(lastTimestamp: string | undefined): T[];       // for SSE resumption
  size(): { count: number; bytes: number };
}
```

Semantics:
- Each push computes `JSON.stringify(entry).length` as the byte cost (UTF-8 length is approximated as char length; close enough for budgeting).
- Eviction is FIFO — drop oldest entries until the buffer fits.
- `takeSince` returns entries with `timestamp > lastTimestamp` (string comparison works on ISO-8601). If `lastTimestamp` is undefined, return the whole snapshot.
- One ring buffer per SSE client connection (constructed in the route handler on connect).

When eviction happens, the connection emits one `truncated` SSE event with `{ reason: 'ring buffer overflow', evicted: N }` so the client can render a "logs may be missing" notice.

### Routes (`portal/routes/logs.ts`)

```typescript
export function registerLogRoutes(app: Hono, deps: { logPath: string; parser: LogParser; filter: LogFilter }): void;
```

**`GET /logs`** — full-page or HTMX fragment:
1. Parse query → `LogFilterCriteria` via `LogFilter.fromQuery`.
2. Read last 500 entries via `parser.parseFile(logPath, 500)`.
3. Apply filter, then `redactSecrets` on each remaining entry.
4. If `HX-Request: true` header present, render `_log_filter_form.hbs + _log_entry.hbs[]` as a fragment (no `<html>` shell). Otherwise render `logs.hbs` full page. Match the HTMX-aware pattern from SPEC-013-3-02.
5. Set `Cache-Control: no-store`.

**`GET /logs/stream`** (SSE):
1. Validate query parameters via `LogFilter.fromQuery`. Reject with 400 on schema violations (no silent drops here — the client form should never produce invalid values).
2. Set headers: `Content-Type: text/event-stream`, `Cache-Control: no-store`, `Connection: keep-alive`, `X-Accel-Buffering: no`.
3. Construct a per-client `RingBuffer<LogEntry>(1024*1024)`.
4. On connect, write the snapshot of buffered entries that match the filter (each as a `log-line` event) and a `Last-Event-ID` reflecting the newest emitted timestamp.
5. Subscribe to the file-watcher SSE accessor from PLAN-015-1: every newly-appended log line is parsed, pushed to the ring buffer, and (if it passes the filter) emitted as `event: log-line\ndata: <redacted JSON>\nid: <timestamp>\n\n`.
6. If `RingBuffer.push` returns `evicted > 0`, emit one `truncated` event between the SSE frame for the new entry and any subsequent frames. Coalesce consecutive `truncated` events within a 1-second window into a single frame to avoid flooding.
7. Heartbeat: emit `event: heartbeat\ndata: ping\n\n` every 30 seconds. Closes idle proxies cleanly without dropping the connection.
8. Respect `Last-Event-ID` request header on reconnect: replay buffered entries with `timestamp > Last-Event-ID` before resuming live tailing.
9. On client disconnect (`req.signal.aborted`), unsubscribe from the watcher and free the ring buffer.

**`GET /logs/download`** (gzip export):
1. Parse `?range=1h|4h|24h` (default `24h`). Reject other values with 400.
2. Compute the time window relative to `now()`.
3. Open `logPath` via `parser.streamFile`. For each entry whose timestamp falls in window, apply redaction, JSON-stringify with `\n`, pipe through `zlib.createGzip()`.
4. Headers: `Content-Type: application/json`, `Content-Encoding: gzip`, `Content-Disposition: attachment; filename="daemon-log-{rangeStart}-{rangeEnd}.json.gz"` where range timestamps are formatted as `YYYYMMDDTHHMMSSZ`.
5. Stream the gzipped output directly to the response — never buffer the full payload in memory. Required for log files >10MB.
6. On read error mid-stream, terminate the response (client receives a truncated gzip stream); log the error to daemon.log.

### Template Notes

- `_log_entry.hbs` renders `<li class="log-entry log-{{level}}" data-request-id="{{request_id}}">` with timestamp, level badge, message, and an expandable `<details>` for `context` (rendered as preformatted JSON).
- `_log_filter_form.hbs` uses `hx-get="/logs"` `hx-trigger="change"` `hx-target="#log-list"` `hx-include="closest form"` so changing any filter dispatches an HTMX request that updates only the log list. Form values are also pushed to history via `hx-push-url="true"` so URLs are shareable.
- `logs.hbs` includes the form, a `#log-list` container, and a `<script>` that opens an `EventSource('/logs/stream?{currentFilters}')` and prepends `log-line` events to `#log-list` while respecting the same filter form.

## Acceptance Criteria

- [ ] `LogParser.parseLine` parses a valid NDJSON line into a `LogEntry` with all fields populated.
- [ ] `LogParser.parseLine` returns `null` for malformed JSON, missing required fields, or invalid level values.
- [ ] `LogParser.parseFile(path, 500)` returns the most recent 500 valid entries from a 10,000-line file in <300ms.
- [ ] `LogFilter.fromQuery({ level: 'INFO', request_id: 'REQ-000123', time_range: '1h' })` produces a fully populated criteria object; invalid values are dropped silently.
- [ ] `LogFilter.apply` AND-combines all set criteria; an entry that fails any single criterion is excluded.
- [ ] `LogFilter.apply` over 10,000 entries with all three filter types set completes in <500ms.
- [ ] `redactSecrets` replaces an Anthropic API key (`sk-ant-...`) inside both `message` and `context.headers.authorization` strings.
- [ ] `redactSecrets` does not mutate the original entry; pre/post deep-equals checks confirm immutability.
- [ ] `RingBuffer` evicts oldest entries when adding a new entry would exceed 1MB; `size().bytes` never exceeds 1MB after a push.
- [ ] `RingBuffer.takeSince(lastTs)` returns only entries with `timestamp > lastTs`; returns full snapshot when `lastTs` is undefined.
- [ ] `GET /logs` returns the last 500 entries (or fewer if the log is shorter) and respects all filter query parameters.
- [ ] `GET /logs` with `HX-Request: true` returns a fragment without `<html>` or `<body>` tags; without the header it returns a full page.
- [ ] `GET /logs/stream` sets `Content-Type: text/event-stream` and emits at least one `log-line` event when a new line is appended to the log file under test.
- [ ] `GET /logs/stream` emits a `heartbeat` event every 30 seconds (verified in test by advancing a fake timer).
- [ ] `GET /logs/stream` with `Last-Event-ID` header replays only entries newer than the supplied timestamp.
- [ ] `GET /logs/stream` emits a single `truncated` event when the ring buffer evicts entries; consecutive evictions within 1s coalesce into one event.
- [ ] `GET /logs/stream` redaction is applied to every emitted `log-line`; raw secrets do not appear in the SSE stream output.
- [ ] `GET /logs/stream` closes cleanly on `req.signal.aborted`: watcher unsubscribed, buffer freed, no dangling listeners (verified via leak-free 1000-iteration test).
- [ ] `GET /logs/download?range=24h` returns `Content-Encoding: gzip` and the decompressed body is valid NDJSON containing only entries from the last 24 hours.
- [ ] `GET /logs/download?range=invalid` returns HTTP 400.
- [ ] `GET /logs/download` over a 50MB log file completes streaming in <5s and never holds more than 10MB in memory at once (measured via process snapshot).
- [ ] All redaction patterns are exercised: there exists at least one log entry per pattern in the redaction unit test, and the output contains the corresponding placeholder.
- [ ] Backpressure: a producer emitting 10,000 log lines/second for 5 seconds against one SSE client never crashes the server; ring buffer eviction protects memory; the client receives at least the most-recent 500 entries plus `truncated` events.

## Dependencies

- PLAN-015-1: file watcher and SSE accessor (`watchFile(path)` emitting line events). The route handler subscribes to this watcher.
- SPEC-013-3-02: HTMX-aware response pattern (used in `GET /logs`).
- Node `zlib`, `readline`, `fs/promises`, `stream/promises` builtins.
- Hono framework: `app.get`, response streaming via `c.streamSSE` (or equivalent in the project's Hono adapter).

## Notes

- Redaction is intentionally a denylist (regex-based). For high-stakes deployments, the operator should additionally configure structured-logging conventions that never log secrets in the first place — but the redaction layer is a defense in depth.
- The 1MB ring buffer is per-connection. With 10 concurrent SSE clients, the worst-case server memory is ~10MB for log buffering — within the 50MB-per-request budget from the plan.
- The `truncated` event is informational only; clients should display a warning ("logs may be missing — refresh") but do not need to retry or refetch automatically.
- The download endpoint deliberately accepts only `1h|4h|24h` to keep the surface narrow. Larger windows are supported by re-running the daemon's archival tooling, which is out of scope here.
- ISO-8601 string comparison is sufficient for `takeSince` because the timestamps are zero-padded and lexically sortable. Do NOT parse to Date for this hot path.
- Heartbeat is critical for proxies (nginx, Cloudflare) that close idle connections at 30–60s. Increasing the interval risks connection drops; decreasing wastes bandwidth.
