# SPEC-015-2-03: Intake-Router HTTP Client — Typed POSTs, Error Mapping, Retries

## Metadata
- **Parent Plan**: PLAN-015-2
- **Tasks Covered**: Task 1 (intake router client foundation), Task 9 (daemon reload helper)
- **Estimated effort**: 5 hours

## Description

Implement `IntakeRouterClient`: the single chokepoint used by all portal mutation paths to talk to the intake router over `http://127.0.0.1:<port>/router`. This spec defines port discovery, the typed `submitCommand` method, error classification (transient vs permanent), exponential-backoff retries, the `healthCheck` endpoint, and the `daemonReloadIfNeeded` helper. It does NOT define the intake router server or command schema beyond what the portal sends — those live in TDD-008/TDD-012. No other module in the portal is allowed to fetch the router directly.

The client runs in-process inside the portal's Bun server. All requests target localhost (router only binds `127.0.0.1`). Network errors are treated as transient with bounded retries, balancing UX during daemon restarts against fast failure surfacing.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/portal/lib/intake-router-client.ts` | Create | `IntakeRouterClient` class, types, constants |
| `src/portal/lib/intake-error-classifier.ts` | Create | `classifyError(err, response?) → 'transient' | 'permanent'` |
| `src/portal/lib/daemon-reload.ts` | Create | `requiresDaemonReload(changes)`, `signalDaemonReload(client, reason, op)`, `flattenKeys` |
| `src/portal/lib/index.ts` | Modify | Re-export the public surface |

## Implementation Details

### Public Types

```typescript
export interface IntakeCommand {
  command: 'approve' | 'request-changes' | 'reject' | 'config-set' | 'daemon-reload' | 'kill-switch' | 'circuit-breaker-reset';
  requestId: string;             // UUID for the COMMAND, not the target request
  comment?: string;
  source: 'portal';
  sourceUserId: string;
  configChanges?: Record<string, unknown>;
  confirmationToken?: string;
  targetRequestId?: string;      // For approve/reject/request-changes
}

export interface IntakeResponse {
  success: boolean;
  commandId: string;
  error?: string;                // Human-readable
  errorCode?: string;            // Machine-readable: 'INVALID_TOKEN', 'INVALID_TRANSITION', 'NETWORK_TRANSIENT', 'NETWORK_PERMANENT', 'CLIENT_VALIDATION', 'HTTP_<status>'
  data?: unknown;
}

export interface HealthResult {
  healthy: boolean;
  version?: string;
  latencyMs?: number;
  error?: string;
}

export const DEFAULT_INTAKE_ROUTER_PORT = 19279;
```

### Class Skeleton

```typescript
export class IntakeRouterClient {
  private readonly baseUrl: string;
  private readonly timeoutMs = 5_000;
  private readonly retryAttempts = 3;
  private readonly initialBackoffMs = 200;
  private readonly maxBackoffMs = 2_000;

  constructor(opts?: { port?: number; userConfigPath?: string });
  async submitCommand(cmd: IntakeCommand): Promise<IntakeResponse>;
  async healthCheck(): Promise<HealthResult>;
}
```

### Port Discovery

Constructor reads `opts.userConfigPath ?? '../autonomous-dev/.claude-plugin/userConfig.json'` synchronously. If JSON parses and `config.router.port` is a number in `[1, 65535]`, use it. Otherwise emit `console.warn` exactly once and fall back to `DEFAULT_INTAKE_ROUTER_PORT` (19279, per TDD-008). Final `baseUrl = http://127.0.0.1:<port>/router`.

### Error Classification

`classifyError(err, response?) → 'transient' | 'permanent'`:

- **Transient**: `TypeError('fetch failed')`, `AbortError`, `TimeoutError`, HTTP 5xx, HTTP 503, HTTP 408, HTTP 429.
- **Permanent**: All other 4xx (400, 401, 403, 404, 409, 422). Anything not classified above defaults to permanent.

The intent: anything that "might succeed if we wait briefly" is transient; anything reflecting a contract violation or final state is permanent.

### Retry Logic

`submitCommand` wraps the network call in a retry loop with exponential backoff and full jitter:

```typescript
for (let attempt = 0; attempt < retryAttempts; attempt++) {
  try { return await op(); }
  catch (err) {
    if (classifyError(err, response) === 'permanent') throw err;
    if (attempt === retryAttempts - 1) throw err;
    const cap = Math.min(maxBackoffMs, initialBackoffMs * 2 ** attempt);  // 200, 400, 800
    await delay(Math.random() * cap);                                     // jitter
  }
}
```

Worst-case wait: ~1.4s of backoff (jittered, half on average) plus 3 × 5s timeouts ≈ ~16.4s. Acceptable to mask brief daemon restarts.

### `submitCommand` Behavior

1. Local validation: if `cmd.source !== 'portal'` or `!cmd.sourceUserId`, return `{success:false, errorCode:'CLIENT_VALIDATION', error}` without a network call.
2. Wrap fetch+JSON-parse in `retry`. Per attempt, `fetch(baseUrl + '/command', {method:'POST', headers:{'Content-Type':'application/json','User-Agent':'autonomous-dev-portal/1.0'}, body: JSON.stringify(cmd), signal: AbortSignal.timeout(timeoutMs)})`.
3. On HTTP 200-299: parse body, return `{success:true, commandId: body.commandId ?? randomUUID(), data: body.data}`.
4. On HTTP error: parse body (best-effort), return `{success:false, commandId: body.commandId ?? '', error: body.error ?? 'HTTP <status>', errorCode: body.errorCode ?? 'HTTP_<status>'}`.
5. After retry exhaustion on transient error: return `{success:false, errorCode: classifyError(lastErr) === 'transient' ? 'NETWORK_TRANSIENT' : 'NETWORK_PERMANENT', error}`.

### `healthCheck`

GET-style POST `/health` with empty body, 2s timeout, NO retries. Measures latency via `performance.now()`. Returns `{healthy, version?, latencyMs, error?}`.

### Daemon Reload Helper

```typescript
export const RELOAD_TRIGGER_PREFIXES = ['costCaps.', 'trustLevels.', 'circuitBreaker.', 'killSwitch.'];

export function requiresDaemonReload(changes: Record<string, unknown>): boolean;
export async function signalDaemonReload(client: IntakeRouterClient, reason: string, operatorId: string): Promise<{ ok: boolean; error?: string }>;
export function flattenKeys(obj: Record<string, unknown>, prefix?: string): string[];
```

`requiresDaemonReload`: flatten keys; return true if any key starts with any prefix.

`signalDaemonReload`: submit `{command:'daemon-reload', requestId: uuid, source:'portal', sourceUserId, comment: reason}`. Fire-and-forget — does NOT wait for daemon to finish. Caller polls `healthCheck` separately if it needs to confirm reload.

`flattenKeys({a:{b:1, c:{d:2}}, e:[1,2]})` returns `['a.b', 'a.c.d', 'e']` — arrays are leaves.

## Acceptance Criteria

- [ ] Constructor reads `userConfig.json` and uses `router.port` when present and in `[1, 65535]`
- [ ] Constructor falls back to `DEFAULT_INTAKE_ROUTER_PORT` (19279) when config is missing/malformed/invalid
- [ ] Constructor emits `console.warn` exactly once on fallback
- [ ] `submitCommand` rejects locally (no network) when `source !== 'portal'` or `sourceUserId` empty, returning `errorCode: 'CLIENT_VALIDATION'`
- [ ] `submitCommand` succeeds on first attempt when router responds 2xx
- [ ] `submitCommand` retries up to 3 times on transient errors (network failure, AbortError, 5xx, 408, 429, 503)
- [ ] `submitCommand` does NOT retry on permanent errors (400, 401, 403, 404, 409, 422)
- [ ] Retry backoff caps at 200ms, 400ms, 800ms with full jitter
- [ ] After 3 failed transient attempts, `submitCommand` returns `errorCode: 'NETWORK_TRANSIENT'`
- [ ] `submitCommand` enforces 5s timeout per attempt via `AbortSignal.timeout`
- [ ] `healthCheck` uses 2s timeout and does NOT retry
- [ ] `healthCheck` returns `latencyMs` measured via `performance.now()`
- [ ] `requiresDaemonReload` returns `true` when changes include any key with a registered prefix
- [ ] `requiresDaemonReload` returns `false` for changes only in `notifications.*`
- [ ] `signalDaemonReload` submits `command: 'daemon-reload'` with `comment = reason` and returns immediately
- [ ] `flattenKeys` produces dotted paths and treats arrays as leaves
- [ ] All exports re-exported from `lib/index.ts`

## Test Cases

1. **Port from config** — `userConfig: {router:{port:12345}}` → `baseUrl` ends `:12345/router`.
2. **Port fallback malformed JSON** — readFileSync throws → `:19279/router`; warn called once.
3. **Port fallback invalid value** — `port: 99999` → fallback to 19279.
4. **submitCommand local validation** — `source:'cli'` → `CLIENT_VALIDATION`; no fetch.
5. **submitCommand happy** — fetch returns 200 + `{commandId:'C1'}` → `{success:true, commandId:'C1'}`.
6. **submitCommand retry-then-success** — fetch: 503 then 200 → 2 calls; success; elapsed ≥ 100ms.
7. **submitCommand exhausts retries** — fetch: always 503 → 3 calls; `errorCode: NETWORK_TRANSIENT`.
8. **submitCommand permanent 422** — fetch: 422 + `{error:"invalid"}` → 1 call; `errorCode: HTTP_422`.
9. **submitCommand permanent 409 with errorCode** — fetch: 409 + `{errorCode:'INVALID_TRANSITION'}` → 1 call; `errorCode: INVALID_TRANSITION`.
10. **submitCommand timeout** — fetch delays 6s → AbortError after 5s; classified transient; retried (3 calls).
11. **healthCheck happy** — 200 + `{version:'1.2.3'}` → `{healthy:true, version:'1.2.3', latencyMs:>=0}`.
12. **healthCheck no retry** — 503 once → `healthy:false` after one attempt; only one fetch call.
13. **requiresDaemonReload cost cap** — `{costCaps:{daily:10}}` → `true`.
14. **requiresDaemonReload notifications only** — `{notifications:{email:{to:'x@y'}}}` → `false`.
15. **flattenKeys nested** — `{a:{b:1, c:{d:2}}, e:[1,2]}` → `['a.b','a.c.d','e']`.
16. **signalDaemonReload submits correct command** — mock client; call helper; assert one `submitCommand` with the expected body.

## Dependencies

- TDD-008: Intake router server contract (commands, response shape, port convention)
- TDD-012: Two-phase commit semantics (informational)
- Bun's native `fetch`, `AbortController`, `AbortSignal.timeout` (no third-party HTTP library)
- `crypto.randomUUID()`

## Notes

- Bun's native fetch is sufficient; we deliberately avoid axios/got to keep dependency surface area minimal.
- The 5s command timeout is chosen to comfortably exceed worst-case fsync latency on a slow disk while still feeling responsive in the UI.
- Localhost-only binding means most "transient" errors here are actually a daemon restart or fd exhaustion. Retries are short on purpose; we don't mask serious problems.
- `errorCode` is preferred over `error` string parsing. Callers branch on `errorCode === 'INVALID_TOKEN'`. The string `error` field is for human display only.
- We do NOT implement circuit breaking. The intake router is local; if it's down, the operator needs to know. A circuit breaker would mask the failure and degrade UX.
- Client-side validation duplicates server checks intentionally — fast feedback for dev mistakes without a roundtrip. This is defense in depth, not a security boundary.
- `signalDaemonReload` is fire-and-forget by design. Blocking the form submission for an unbounded reload window is bad UX; if reload fails the daemon picks up the change on its next natural restart anyway.
- `flattenKeys` treats arrays as leaves. This matches reload-trigger semantics: changing `allowlist[0]` does not require reload, but `costCaps.daily` does.
