# SPEC-015-1-02: SSE Event Bus — Broadcast + Per-Client Backpressure + Heartbeat

## Metadata
- **Parent Plan**: PLAN-015-1
- **Tasks Covered**: TASK-002 (SSEServer + Connection), TASK-003 (event protocol + schemas), TASK-004 (heartbeat manager)
- **Estimated effort**: 8 hours

## Description

Implement the Server-Sent Events (SSE) event bus that broadcasts portal events to web clients in real time. The bus exposes a single Hono endpoint (`GET /portal/events`) that opens an indefinitely-streaming SSE connection per client, manages per-client lifecycle (connect → heartbeat → disconnect), enforces a 10-connection cap with HTTP 429 backpressure, and applies per-client write backpressure (slow clients are dropped rather than blocking the broadcast). A 30-second server-driven heartbeat keeps proxies alive and lets the server detect zombie connections; clients that miss heartbeats for 5 minutes are forcibly closed.

The event protocol is typed (`state-change`, `cost-update`, `heartbeat`, `log-line`, `daemon-down`), every event carries a monotonically-increasing `sequenceNumber` for client-side deduplication after reconnect, and the schema is versioned (`v: 1`) for forward compatibility. The bus does NOT itself watch files — it consumes `FileChangeEvent`s from SPEC-015-1-01 (wired in SPEC-015-1-03/SPEC-015-1-04) and translates them into typed SSE events.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/portal/sse/SSEEventBus.ts` | Create | Public class: connection registry, broadcast, lifecycle |
| `src/portal/sse/Connection.ts` | Create | Per-client wrapper: write queue, sequence tracking, backpressure |
| `src/portal/sse/HeartbeatManager.ts` | Create | 30s broadcast loop + 5min staleness sweeper |
| `src/portal/sse/EventProtocol.ts` | Create | Sequence counter, `formatSSE()` framing helper |
| `src/portal/events/schemas.ts` | Create | Zod schemas for all 5 event types + envelope |
| `src/portal/events/types.ts` | Create | TS types inferred from Zod schemas |
| `src/portal/sse/types.ts` | Create | `SSEServerOptions`, `ConnectionState`, internal types |
| `src/portal/sse/index.ts` | Create | Barrel export |
| `src/portal/events/index.ts` | Create | Barrel export |
| `src/portal/routes/events.ts` | Create | Hono route handler that delegates to `SSEEventBus.handleConnection` |

## Implementation Details

### Event protocol (`src/portal/events/schemas.ts`)

All events carry a common envelope. The discriminated union is keyed on `type`.

```typescript
import { z } from 'zod';

export const EventEnvelopeBase = z.object({
  v: z.literal(1),
  id: z.string().min(1),               // ULID or `evt_<ts>_<rand>`
  seq: z.number().int().nonnegative(),
  ts: z.string().datetime(),            // ISO 8601 server emit time
});

export const StateChangeEvent = EventEnvelopeBase.extend({
  type: z.literal('state-change'),
  payload: z.object({
    request_id: z.string().regex(/^REQ-\d{6}$/),
    old_phase: z.string().nullable(),
    new_phase: z.string(),
    repository: z.string(),
  }),
});

export const CostUpdateEvent = EventEnvelopeBase.extend({
  type: z.literal('cost-update'),
  payload: z.object({
    request_id: z.string().regex(/^REQ-\d{6}$/).optional(),
    delta_usd: z.number(),
    total_usd: z.number(),
  }),
});

export const HeartbeatEvent = EventEnvelopeBase.extend({
  type: z.literal('heartbeat'),
  payload: z.object({
    server_ts: z.string().datetime(),
    connection_age_s: z.number().int().nonnegative(),
  }),
});

export const LogLineEvent = EventEnvelopeBase.extend({
  type: z.literal('log-line'),
  payload: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string(),
    source: z.enum(['daemon', 'intake', 'portal']),
  }),
});

export const DaemonDownEvent = EventEnvelopeBase.extend({
  type: z.literal('daemon-down'),
  payload: z.object({
    last_heartbeat_ts: z.string().datetime().nullable(),
    stale_seconds: z.number().int().nonnegative(),
  }),
});

export const PortalEvent = z.discriminatedUnion('type', [
  StateChangeEvent, CostUpdateEvent, HeartbeatEvent, LogLineEvent, DaemonDownEvent,
]);
export type PortalEvent = z.infer<typeof PortalEvent>;
```

### `EventProtocol.ts`

Stateless helpers + a single `SequenceCounter` instance per `SSEEventBus`.

```typescript
export class SequenceCounter {
  private value = 0;
  next(): number { return ++this.value; }
  current(): number { return this.value; }
}

export function formatSSE(event: PortalEvent): string;
// Returns SSE wire format:
//   id: <event.id>\n
//   event: <event.type>\n
//   data: <JSON.stringify(event)>\n
//   \n
```

`id:` uses the event's `id` (NOT `seq`) so clients can use `Last-Event-ID` headers. The full event including `seq` is in the `data:` payload so clients can deduplicate across reconnects.

### `Connection` class

```typescript
export interface ConnectionDeps {
  stream: SSEStreamingApi;     // from hono/streaming
  id: string;                   // `conn_<ts>_<rand>`
  createdAt: Date;
  options: { writeQueueLimit: number; heartbeatTimeoutMs: number };
}

export class Connection {
  readonly id: string;
  readonly createdAt: Date;
  state: 'open' | 'closing' | 'closed';
  lastHeartbeat: Date;
  writeQueueDepth: number;
  droppedEventCount: number;

  constructor(deps: ConnectionDeps);
  async write(event: PortalEvent): Promise<'sent' | 'dropped' | 'closed'>;
  close(reason: 'client' | 'server' | 'stale' | 'overcap'): Promise<void>;
  isStale(now: Date): boolean;   // last heartbeat older than heartbeatTimeoutMs
}
```

**Backpressure** (per-client, non-blocking):

- `Connection.write` enqueues the formatted SSE frame to `stream.writeSSE(...)`.
- The connection tracks `writeQueueDepth` (incremented before await, decremented after). If `writeQueueDepth >= writeQueueLimit` (default: 50), the new event is DROPPED for that connection — `write` returns `'dropped'`, `droppedEventCount++`, and a single warning is logged at the connection level (rate-limited to once per 10 seconds).
- The broadcast loop in `SSEEventBus` does NOT await each `write`; it fires them in parallel via `Promise.allSettled` so one slow client never blocks delivery to others.
- If a `write` throws (client TCP reset, write to closed stream, etc.), the connection transitions to `closed` and is removed from the registry.

### `SSEEventBus.ts`

```typescript
export interface SSEServerOptions {
  maxConnections?: number;          // default 10
  heartbeatIntervalMs?: number;     // default 30_000
  connectionTimeoutMs?: number;     // default 300_000
  writeQueueLimit?: number;         // default 50 events per client
  logger?: { warn: Function; info: Function; error: Function };
}

export class SSEEventBus {
  constructor(options?: SSEServerOptions);

  // Hono handler: GET /portal/events
  handleConnection(c: Context): Response | Promise<Response>;

  // Public broadcast — used by FileWatcher integration in SPEC-015-1-03/04
  broadcast(event: Omit<PortalEvent, 'v' | 'id' | 'seq' | 'ts'> & { type: PortalEvent['type']; payload: unknown }): Promise<void>;

  getConnectionCount(): number;
  getConnectionStats(): Array<{ id: string; ageMs: number; writeQueueDepth: number; droppedEventCount: number; lastHeartbeatMs: number }>;
  shutdown(): Promise<void>;
}
```

**Connection acceptance**:

1. On `handleConnection`, check `connections.size >= maxConnections`. If so, return `c.text('Too many SSE connections (max 10). Retry later.', 429)` with header `Retry-After: 30`.
2. Else allocate a `Connection`, register in the connections `Map<string, Connection>`, and return `streamSSE(c, async (stream) => { ... })`.
3. Inside the `streamSSE` callback:
   - Send an initial `connection` event-type SSE comment (`: connected\n\n`) to flush proxy buffers.
   - Send a synthetic `heartbeat` event immediately so clients see liveness on connect.
   - Register `stream.onAbort(() => bus._removeConnection(id, 'client'))`.
   - Return a `new Promise<void>(() => {})` to keep the stream open. Closure happens via `_removeConnection`.

**Broadcast**:

```typescript
async broadcast(partial) {
  const event: PortalEvent = {
    v: 1,
    id: generateEventId(),
    seq: this.sequence.next(),
    ts: new Date().toISOString(),
    ...partial,
  };
  // validate (non-throwing in production; log + drop if invalid):
  const parsed = PortalEvent.safeParse(event);
  if (!parsed.success) { this.options.logger.error('invalid event', parsed.error); return; }

  const connections = Array.from(this.connections.values()).filter(c => c.state === 'open');
  await Promise.allSettled(connections.map(c => c.write(parsed.data)));
}
```

The sequence counter is shared across all connections — every event has a global `seq`, so a client that reconnects with `Last-Event-ID: 42` knows to filter out events `<= 42` it already saw.

### `HeartbeatManager.ts`

Owns two `setInterval`s, both running on `SSEEventBus.start()` (called from constructor):

1. **Heartbeat broadcaster** — every `heartbeatIntervalMs` (30s default), call `bus.broadcast({ type: 'heartbeat', payload: { server_ts: <now>, connection_age_s: 0 } })`. Per-connection `connection_age_s` is filled in by the `Connection.write` path immediately before formatting (small protocol concession — heartbeat is the only event whose payload is connection-specific).
2. **Staleness sweeper** — every `heartbeatIntervalMs / 2` (15s default), iterate connections and call `connection.close('stale')` for any connection where `connection.isStale(now) === true`.

`Connection.lastHeartbeat` is updated on every successful `write` (not just heartbeat events) — any event delivered through proves the connection is alive.

### Hono route (`src/portal/routes/events.ts`)

```typescript
import { Hono } from 'hono';
import type { SSEEventBus } from '../sse/SSEEventBus.ts';

export function eventsRoute(bus: SSEEventBus): Hono {
  const app = new Hono();
  app.get('/portal/events', (c) => bus.handleConnection(c));
  return app;
}
```

Mounted onto the portal app in PLAN-015-1's bootstrap (extends SPEC-013-2 bootstrap; no changes to that spec — this route is added at portal-server init time).

### Connection lifecycle states

```
[handleConnection]
  → connections.size >= max? → return 429 (no Connection created)
  → create Connection (state=open)
  → register
  → streamSSE callback runs
  → onAbort(()=>removeConnection('client'))
[broadcast]
  → write succeeds → state stays open, lastHeartbeat updated
  → write throws → state=closed → removeConnection('server')
[sweeper]
  → isStale(now) → state=closing → connection.close('stale') → removeConnection
[shutdown]
  → for each connection: state=closing → close('server') → write final 'shutdown' SSE comment → remove
```

`removeConnection` is idempotent: it deletes from the registry, calls `connection.close()` if not already closed, logs at debug level, and emits an internal `'connection-closed'` event for metrics.

## Acceptance Criteria

- [ ] `GET /portal/events` returns `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive` headers.
- [ ] First frame on a new connection is the SSE comment `: connected\n\n` followed by a `heartbeat` event with `seq=N` (whatever the bus's current sequence is).
- [ ] When 10 connections are already open, the 11th request receives HTTP 429 with `Retry-After: 30` and is NOT registered (no `Connection` created, no resources held).
- [ ] `broadcast({ type: 'state-change', payload: {...} })` delivers to every open connection in parallel; one slow client (sleep in `writeSSE`) does NOT delay delivery to fast clients (verified by timing test in SPEC-015-1-05).
- [ ] When a connection's `writeQueueDepth >= writeQueueLimit`, subsequent `write()` calls return `'dropped'` and increment `droppedEventCount` without throwing or closing the connection.
- [ ] When `writeSSE` throws (simulated TCP reset), the connection transitions to `closed` and is removed from the registry within the same broadcast cycle.
- [ ] Heartbeat events fire at `heartbeatIntervalMs` ± 100ms intervals (verified by recording timestamps over 5 cycles).
- [ ] A connection with `lastHeartbeat` older than `connectionTimeoutMs` is closed by the sweeper within `heartbeatIntervalMs / 2` of the deadline.
- [ ] Every emitted event satisfies `PortalEvent.safeParse(event).success === true` (Zod-validated before write).
- [ ] `seq` is monotonically increasing across the entire bus (shared counter); two events emitted in quick succession have `seq_b === seq_a + 1`.
- [ ] Each event's SSE wire format is exactly: `id: <id>\nevent: <type>\ndata: <json>\n\n` (single trailing blank line; no extra whitespace).
- [ ] `shutdown()` sends a final `: shutdown\n\n` SSE comment to every connection, awaits queue drain (up to 1s), then closes all connections; subsequent `broadcast` calls are no-ops.
- [ ] `getConnectionStats()` returns per-connection metrics with `writeQueueDepth`, `droppedEventCount`, and age in ms — used by the operations dashboard in PLAN-015-3.
- [ ] Schema version `v: 1` is present on every event; `EventEnvelopeBase.v` is `z.literal(1)` (typo would fail Zod parse).

## Dependencies

- **Consumes**: SPEC-013-2 Bun + Hono runtime (provides `streamSSE` from `hono/streaming`); `zod` (already a project dep from earlier specs); SPEC-015-1-01 `FileWatcher` (events flow into the bus via SPEC-015-1-03 / SPEC-015-1-04).
- **Blocks**: SPEC-015-1-03 + SPEC-015-1-04 (accessors broadcast via the bus); SPEC-015-1-05 (test suite); PLAN-015-2 (settings mutation triggers state-change events).
- **External**: `hono/streaming` `streamSSE` API — version pinned by PLAN-013-2.

## Notes

- **Why drop instead of block on slow clients?** A blocking write queue would couple all clients to the slowest one, defeating the purpose of broadcast fan-out. Dropping is observable (via `droppedEventCount`) so operators can detect stuck clients without affecting the rest of the system.
- **Why server-side `seq` rather than per-connection?** Per-connection sequence resets on reconnect, which makes deduplication ambiguous. A global server `seq` lets clients use `Last-Event-ID` to recover deterministically.
- **Why 5-min idle timeout?** Long enough to absorb network blips and proxy idle (typically 60–120s) without forcing real reconnects, short enough that genuinely-dead clients are reaped before the connection cap fills.
- **Why max 10 connections?** PLAN-015-1's portal is a single-user operator console; 10 connections covers a developer with multiple browser tabs + a curl debug session + headroom. Production multi-user portal raises this in a future plan.
- **Why no auth here?** Authentication, CSRF, and rate limiting are out of scope for PLAN-015-1 (per its "Out of Scope" section, deferred to PLAN-014-*). The bus assumes upstream middleware already authenticated the request. Adding auth later is non-breaking: middleware runs before `handleConnection` is called.
- **Backward compat plan**: When the protocol bumps to `v: 2`, the bus will offer both `/portal/events` (v1) and `/portal/events/v2` for one release cycle, then deprecate v1. Clients pin via the `Accept` header or query string in the future.
- **Why versioned envelope (`v`) AND per-event Zod schemas?** `v` lets a future protocol revision change the envelope shape (e.g., add `correlation_id`) without breaking type discrimination. The Zod schemas catch malformed payloads at emit time so server bugs don't propagate to the wire.
