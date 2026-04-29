# SPEC-015-2-03: Intake-Router HTTP Client — Typed POSTs, Error Mapping, Retries

## Metadata
- **Parent Plan**: PLAN-015-2
- **Tasks Covered**: Task 1 (intake router client foundation), Task 9 (daemon reload helper)
- **Estimated effort**: 5 hours

## Description

Implement the `IntakeRouterClient` class used by all portal mutation paths to communicate with the intake router over `http://127.0.0.1:<port>/router`. This spec defines port discovery, the typed `submitCommand` method, error classification (transient vs permanent), exponential-backoff retry logic, the `healthCheck` endpoint, and the `daemonReloadIfNeeded` helper. It does NOT define the intake router server or the command schema beyond what the portal sends — those live in TDD-012. This client is the single chokepoint for all portal-to-intake traffic; no other module is allowed to fetch the router directly.

The client runs in-process inside the portal's Bun server. All requests go to localhost (the router only binds `127.0.0.1`), so we treat network errors as transient by default but cap retries to avoid blocking forever during a daemon restart.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/portal/lib/intake-router-client.ts` | Create | `IntakeRouterClient` class, types, constants |
| `src/portal/lib/intake-error-classifier.ts` | Create | `classifyError(err) → 'transient' | 'permanent'` |
| `src/portal/lib/daemon-reload.ts` | Create | `requiresDaemonReload(changes)`, `signalDaemonReload(client, reason)` helpers |
| `src/portal/lib/index.ts` | Modify | Re-export the public surface |

## Implementation Details

### Public Types

```typescript
export interface IntakeCommand {
  command: 'approve' | 'request-changes' | 'reject' | 'config-set' | 'daemon-reload' | 'kill-switch' | 'circuit-breaker-reset';
  requestId: string;             // UUID for the command itself, not the request being approved
  comment?: string;
  source: 'portal';              // Always 'portal' from this client
  sourceUserId: string;          // Operator identity
  configChanges?: Record<string, unknown>;   // For 'config-set' only
  confirmationToken?: string;    // For destructive ops requiring typed-CONFIRM
  targetRequestId?: string;      // For approve/reject/request-changes — the REQ-* id
}

export interface IntakeResponse {
  success: boolean;
  commandId: string;             // Server-assigned id for tracing
  error?: string;                // Human-readable
  errorCode?: string;            // Machine-readable, e.g., 'INVALID_TOKEN', 'INVALID_TRANSITION'
  data?: unknown;
}

export interface HealthResult {
  healthy: boolean;
  version?: string;
  latencyMs?: number;
  error?: string;
}
```

### Class Skeleton

```typescript
export class IntakeRouterClient {
  private readonly baseUrl: string;
  private readonly timeoutMs = 5_000;
  private readonly retryAttempts = 3;
  private readonly initialBackoffMs = 200;
  private readonly maxBackoffMs = 2_000;

  constructor(opts: { port?: number; userConfigPath?: string } = {}) {
    const port = opts.port ?? this.discoverIntakePort(opts.userConfigPath);
    this.baseUrl = `http://127.0.0.1:${port}/router`;
  }

  async submitCommand(cmd: IntakeCommand): Promise<IntakeResponse>;
  async healthCheck(): Promise<HealthResult>;

  private discoverIntakePort(userConfigPath?: string): number;
  private async makeRequest(path: string, body: unknown, opts?: { timeoutMs?: number }): Promise<Response>;
  private async retry<T>(op: () => Promise<T>): Promise<T>;
  private delay(ms: number): Promise<void>;
}
```

### Port Discovery

```typescript
private discoverIntakePort(userConfigPath?: string): number {
  const path = userConfigPath ?? '../autonomous-dev/.claude-plugin/userConfig.json';
  try {
    const config = JSON.parse(readFileSync(path, 'utf-8'));
    const port = config?.router?.port;
    if (typeof port === 'number' && port > 0 && port < 65536) return port;
  } catch {
    // fall through to default
  }
  return DEFAULT_INTAKE_ROUTER_PORT;     // 19279, exported constant
}
```

Discovery is synchronous and called once in the constructor. If discovery fails for any reason, the client uses the well-known default port 19279 (per TDD-008). A `console.warn` is emitted exactly once on fallback.

### Error Classification

```typescript
// intake-error-classifier.ts
export type ErrorClass = 'transient' | 'permanent';

export function classifyError(err: unknown, response?: Response): ErrorClass {
  // 1. Network-level failures: transient
  if (err instanceof TypeError && err.message.includes('fetch failed')) return 'transient';
  if (err instanceof DOMException && err.name === 'AbortError') return 'transient';   // timeout
  if (err instanceof DOMException && err.name === 'TimeoutError') return 'transient';

  // 2. HTTP 5xx: transient (server temporarily down or restarting)
  if (response && response.status >= 500 && response.status < 600) return 'transient';

  // 3. HTTP 503 explicit: transient with backoff hint
  if (response && response.status === 503) return 'transient';

  // 4. HTTP 408, 429: transient
  if (response && (response.status === 408 || response.status === 429)) return 'transient';

  // 5. Everything else (4xx) is permanent — retrying won't help
  return 'permanent';
}
```

Permanent errors include `400` (bad request), `401`/`403` (auth), `404` (no such command/request), `409` (state conflict, e.g., already approved), `422` (validation). The client surfaces these directly without retrying.

### Retry Logic

`retry()` wraps any operation that may fail transiently. It implements exponential backoff with full jitter:

```typescript
private async retry<T>(op: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      const klass = classifyError(err);
      if (klass === 'permanent') throw err;        // No retry
      if (attempt === this.retryAttempts - 1) throw err;   // Last attempt
      const backoff = Math.min(
        this.maxBackoffMs,
        this.initialBackoffMs * Math.pow(2, attempt)
      );
      const jittered = Math.random() * backoff;
      await this.delay(jittered);
    }
  }
  throw lastErr;
}
```

Total worst-case wait: ~`200 + 400 + 800` = 1.4s of backoff (jittered, so half on average) plus 3 × 5s timeouts = up to ~16.4s. We accept this latency over surfacing transient errors during daemon restarts.

### `submitCommand`

```typescript
async submitCommand(cmd: IntakeCommand): Promise<IntakeResponse> {
  // Validate locally before hitting network — saves a roundtrip on dev mistakes
  if (cmd.source !== 'portal') {
    return { success: false, commandId: '', error: 'source must be "portal"', errorCode: 'CLIENT_VALIDATION' };
  }
  if (!cmd.sourceUserId) {
    return { success: false, commandId: '', error: 'sourceUserId is required', errorCode: 'CLIENT_VALIDATION' };
  }

  try {
    const response = await this.retry(() => this.makeRequest('/command', cmd));
    const body = await response.json();
    if (!response.ok) {
      return {
        success: false,
        commandId: body.commandId ?? '',
        error: body.error ?? `HTTP ${response.status}`,
        errorCode: body.errorCode ?? `HTTP_${response.status}`,
      };
    }
    return {
      success: true,
      commandId: body.commandId ?? crypto.randomUUID(),
      data: body.data,
    };
  } catch (err) {
    // After retry exhaustion, classify final error
    const errorCode = classifyError(err) === 'transient' ? 'NETWORK_TRANSIENT' : 'NETWORK_PERMANENT';
    return {
      success: false,
      commandId: '',
      error: err instanceof Error ? err.message : 'Unknown error',
      errorCode,
    };
  }
}
```

`makeRequest`:

```typescript
private async makeRequest(path: string, body: unknown, opts: { timeoutMs?: number } = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? this.timeoutMs);
  try {
    return await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `autonomous-dev-portal/${PORTAL_VERSION}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
```

### `healthCheck`

```typescript
async healthCheck(): Promise<HealthResult> {
  const start = performance.now();
  try {
    const response = await this.makeRequest('/health', {}, { timeoutMs: 2_000 });
    const latencyMs = Math.round(performance.now() - start);
    if (!response.ok) {
      return { healthy: false, latencyMs, error: `HTTP ${response.status}` };
    }
    const body = await response.json();
    return { healthy: true, version: body.version, latencyMs };
  } catch (err) {
    return {
      healthy: false,
      latencyMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : 'Unknown',
    };
  }
}
```

Health check uses a tighter 2s timeout (vs 5s for commands) and intentionally NO retry — the caller (typically a `/health` route on the portal) wants a fast yes/no answer.

### Daemon Reload Helper

```typescript
// daemon-reload.ts
const RELOAD_TRIGGER_PREFIXES = [
  'costCaps.',
  'trustLevels.',
  'circuitBreaker.',
  'killSwitch.',
];

export function requiresDaemonReload(changes: Record<string, unknown>): boolean {
  const flatKeys = flattenKeys(changes);
  return flatKeys.some(k => RELOAD_TRIGGER_PREFIXES.some(p => k.startsWith(p)));
}

export async function signalDaemonReload(
  client: IntakeRouterClient,
  reason: string,
  operatorId: string
): Promise<{ ok: boolean; error?: string }> {
  const response = await client.submitCommand({
    command: 'daemon-reload',
    requestId: crypto.randomUUID(),
    source: 'portal',
    sourceUserId: operatorId,
    comment: reason,
  });
  if (!response.success) {
    return { ok: false, error: response.error };
  }
  return { ok: true };
}

export function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenKeys(v as Record<string, unknown>, path));
    } else {
      out.push(path);
    }
  }
  return out;
}
```

`signalDaemonReload` is intentionally non-blocking on completion: it submits the command and returns. It does NOT wait for the daemon to actually finish reloading. Callers that need to wait should poll `healthCheck` separately.

### Constants

```typescript
export const DEFAULT_INTAKE_ROUTER_PORT = 19279;
export const PORTAL_VERSION = '1.0';
```

## Acceptance Criteria

- [ ] `IntakeRouterClient` constructor reads `userConfig.json` and uses `router.port` when present and valid (1-65535)
- [ ] `IntakeRouterClient` falls back to `19279` when `userConfig.json` is missing, malformed, or has invalid port
- [ ] `IntakeRouterClient` emits `console.warn` exactly once when falling back to default port
- [ ] `submitCommand` rejects locally (no network call) when `source !== 'portal'` or `sourceUserId` is empty, returning `errorCode: 'CLIENT_VALIDATION'`
- [ ] `submitCommand` succeeds on first attempt when router responds 200
- [ ] `submitCommand` retries up to 3 times on network errors (TypeError 'fetch failed', AbortError, 5xx, 408, 429, 503)
- [ ] `submitCommand` does NOT retry on 4xx other than 408/429 (e.g., 400, 401, 403, 404, 409, 422)
- [ ] Retry backoff is exponential with full jitter: 200ms, 400ms, 800ms upper bounds
- [ ] After 3 failed attempts, `submitCommand` returns `success: false, errorCode: 'NETWORK_TRANSIENT'`
- [ ] `submitCommand` enforces 5-second timeout per attempt via AbortController
- [ ] `healthCheck` uses 2-second timeout and does NOT retry
- [ ] `healthCheck` returns `latencyMs` measured via `performance.now()`
- [ ] `requiresDaemonReload` returns `true` when changes include any key starting with `costCaps.`, `trustLevels.`, `circuitBreaker.`, or `killSwitch.`
- [ ] `requiresDaemonReload` returns `false` for changes only in `notifications.*`
- [ ] `signalDaemonReload` submits a `command: 'daemon-reload'` with the reason in the `comment` field
- [ ] `flattenKeys({ a: { b: 1, c: { d: 2 } } })` returns `['a.b', 'a.c.d']`
- [ ] All exports from `lib/intake-router-client.ts` are re-exported from `lib/index.ts`

## Test Cases

1. **Port from config** — Mock `userConfig.json` with `{ router: { port: 12345 } }`. Construct client. Assert: `baseUrl` ends with `:12345/router`.
2. **Port fallback malformed JSON** — Mock readFileSync to throw. Construct client. Assert: `baseUrl` ends with `:19279/router`; `console.warn` called once.
3. **Port fallback invalid value** — Mock config with `{ router: { port: 99999 } }`. Construct. Assert: fallback to 19279.
4. **submitCommand local validation** — Call with `source: 'cli'`. Assert: returns `success: false, errorCode: 'CLIENT_VALIDATION'`; no fetch occurred.
5. **submitCommand happy path** — Mock fetch returning 200 + `{commandId: 'C1', data: {}}`. Assert: returns `{success: true, commandId: 'C1'}`.
6. **submitCommand retries on 503** — Mock fetch: first 503, second 200. Assert: 2 fetch calls; final `success: true`; total elapsed time >= 100ms (some jittered backoff).
7. **submitCommand exhausts retries** — Mock fetch: always 503. Assert: 3 fetch calls; returns `errorCode: 'NETWORK_TRANSIENT'`.
8. **submitCommand permanent 422** — Mock fetch: 422 with `{error: "invalid"}`. Assert: 1 fetch call; returns `success: false, errorCode: 'HTTP_422'`.
9. **submitCommand permanent 409** — Mock fetch: 409 with `{errorCode: 'INVALID_TRANSITION'}`. Assert: 1 fetch call; returns `errorCode: 'INVALID_TRANSITION'`.
10. **submitCommand timeout** — Mock fetch to delay 6s. Assert: AbortError thrown after 5s; classified transient; retried.
11. **healthCheck happy** — Mock fetch returning 200 + `{version: "1.2.3"}`. Assert: `{healthy: true, version: "1.2.3", latencyMs: <number>}`.
12. **healthCheck no retry** — Mock fetch: first 503, second never reached. Assert: returns `healthy: false` after first failure (no second call).
13. **requiresDaemonReload cost cap** — `{costCaps: {daily: 10}}`. Assert: `true`.
14. **requiresDaemonReload notifications only** — `{notifications: {email: {to: "x@y"}}}`. Assert: `false`.
15. **flattenKeys nested** — `{a: {b: 1, c: {d: 2}}, e: [1,2]}`. Assert: `['a.b', 'a.c.d', 'e']` (arrays are leaves).
16. **signalDaemonReload submits correct command** — Mock client. Call `signalDaemonReload(client, "test reason", "op1")`. Assert: `submitCommand` called once with `{command: 'daemon-reload', source: 'portal', sourceUserId: 'op1', comment: 'test reason'}`.

## Dependencies

- TDD-008: Intake router server contract (commands accepted, response shape, port convention)
- TDD-012: Two-phase commit semantics (informational; client doesn't depend on it directly)
- Bun's native `fetch` and `AbortController` (no third-party HTTP library)
- Existing `crypto.randomUUID()` for command IDs

## Notes

- We deliberately do NOT introduce `axios`, `got`, or other HTTP libraries. Bun's native fetch is sufficient and avoids dependency surface area.
- The 5s command timeout is chosen to comfortably exceed the intake router's worst-case write latency (atomic fsync on a slow disk) while still feeling responsive in the UI.
- Localhost-only binding (`127.0.0.1`) means we never actually traverse a network. Most "transient" errors here are either the daemon restarting or running out of file descriptors. Retries are short on purpose.
- `errorCode` is preferred over parsing `error` strings. Callers branch on `errorCode === 'INVALID_TOKEN'` etc. The string `error` field is for human display only.
- We do NOT implement circuit breaking in this client. The intake router is local; if it's down, the operator needs to know immediately. A circuit breaker would mask the failure and degrade UX.
- Client-side validation (`source`, `sourceUserId`) duplicates server-side checks intentionally — fast feedback for dev mistakes without a roundtrip. This is defense in depth, not the security boundary.
- `signalDaemonReload` is fire-and-forget. The caller (settings handler) does not await daemon health after reload. If the daemon takes too long, subsequent operator interactions surface the issue naturally; we don't want to block the form submission for an unbounded period.
- `flattenKeys` treats arrays as leaves (returning the parent key, not indexed entries). This matches the daemon-reload trigger semantics where `allowlist[0]` doesn't trigger reload but `costCaps.daily` does.
