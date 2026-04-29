# SPEC-013-2-02: Middleware Chain — Request ID, Logger, Timing, Error Boundary

## Metadata
- **Parent Plan**: PLAN-013-2
- **Tasks Covered**: TASK-004 (middleware chain + ordering), TASK-005 (error handler middleware), TASK-011 (request logging + correlation)
- **Estimated effort**: 5 hours

## Description
Implement the four pieces of cross-cutting middleware that every request flows through, plus the `applyMiddlewareChain(app, config)` function that wires them in a fixed order: **request ID → structured logger → timing → security/CORS → error boundary**. The chain MUST be deterministic — the order is part of the contract and other plans (TDD-014 auth/CSRF) depend on inserting at well-defined extension points. The error boundary MUST catch every unhandled exception, sanitize the message, and produce a JSON or HTML response based on the `Accept` header without leaking stack traces or filesystem paths.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `server/middleware/request-id.ts` | Create | `requestIdMiddleware()` using `crypto.randomUUID()` |
| `server/middleware/logging.ts` | Create | `structuredLogger(level)` — JSON-per-line to stdout |
| `server/middleware/timing.ts` | Create | `timingMiddleware()` — sets `Server-Timing` and stores duration on context |
| `server/middleware/error-handler.ts` | Create | `errorHandler()` middleware + `PortalError` class + `Errors` factory |
| `server/middleware/index.ts` | Create | `applyMiddlewareChain(app, config)` orchestrator |
| `server/lib/sanitize.ts` | Create | `sanitizeErrorMessage(s)` for path/secret redaction |

## Implementation Details

### Task 1: Request ID Middleware (`request-id.ts`)

```ts
import type { MiddlewareHandler } from 'hono';

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
    startTimeMs: number;
  }
}

const HEADER = 'x-request-id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requestIdMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const incoming = c.req.header(HEADER);
    const id = incoming && UUID_RE.test(incoming) ? incoming : crypto.randomUUID();
    c.set('requestId', id);
    c.header(HEADER, id);
    await next();
  };
}
```

- Trust upstream-provided IDs ONLY when they match a UUIDv4-shaped regex. This prevents log injection from arbitrary header values.
- Use `crypto.randomUUID()` (Web Crypto, available in Bun ≥ 1.0). Do NOT add the `uuid` npm package.
- Do NOT monkey-patch `console.log` (the plan's reference snippet did this — reject it; it leaks across async boundaries and is hard to reason about). Logging context is propagated via `c.var.requestId` in the structured logger only.

### Task 2: Structured Logger (`logging.ts`)

```ts
import type { MiddlewareHandler } from 'hono';
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function structuredLogger(level: Level): MiddlewareHandler {
  const minLevel = ORDER[level];
  return async (c, next) => {
    const start = performance.now();
    c.set('startTimeMs', start);
    await next();
    if (ORDER.info < minLevel) return;
    const duration_ms = Math.round(performance.now() - start);
    process.stdout.write(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      request_id: c.var.requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms,
      user_agent: c.req.header('user-agent') ?? null,
      bytes_in: Number(c.req.header('content-length') ?? 0),
    }) + '\n');
  };
}
```

- Output format is **JSON-per-line to stdout** (newline-delimited JSON). Compatible with `jq` and standard log aggregators.
- `level` is the MINIMUM emission level read from `config.logging.level`. Access logs are emitted at `info`; below `info` they are suppressed.
- `performance.now()` provides millisecond precision; the recorded `start` is also stored on the context as `startTimeMs` for use by downstream timing middleware.

### Task 3: Timing Middleware (`timing.ts`)

```ts
import type { MiddlewareHandler } from 'hono';

export function timingMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const start = c.var.startTimeMs ?? performance.now();
    await next();
    const dur = (performance.now() - start).toFixed(1);
    c.header('Server-Timing', `total;dur=${dur}`);
  };
}
```

- Reads `startTimeMs` set by the structured logger; falls back to its own `performance.now()` if the logger ran in a configuration where it was suppressed.
- Sets the `Server-Timing` response header per [W3C Server-Timing](https://www.w3.org/TR/server-timing/).

### Task 4: Error Boundary (`error-handler.ts`)

```ts
import type { Context, MiddlewareHandler } from 'hono';
import { sanitizeErrorMessage } from '../lib/sanitize';

export class PortalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 500,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PortalError';
  }
}

export const Errors = {
  NotFound:        (resource = 'Resource') => new PortalError('NOT_FOUND', `${resource} not found`, 404),
  BadRequest:      (msg: string)           => new PortalError('BAD_REQUEST', msg, 400),
  Unauthorized:    (msg = 'Authentication required') => new PortalError('UNAUTHORIZED', msg, 401),
  Forbidden:       (msg = 'Access denied') => new PortalError('FORBIDDEN', msg, 403),
  ValidationError: (msg: string)           => new PortalError('VALIDATION_ERROR', msg, 422),
  PayloadTooLarge: (limit: number)         => new PortalError('PAYLOAD_TOO_LARGE', `Request exceeds ${limit} bytes`, 413),
  Internal:        (msg = 'Internal server error') => new PortalError('INTERNAL_ERROR', msg, 500),
  Unavailable:     (svc: string)           => new PortalError('SERVICE_UNAVAILABLE', `${svc} is currently unavailable`, 503),
};

export function errorHandler(): MiddlewareHandler {
  return async (c, next) => {
    try { await next(); }
    catch (err) {
      const requestId = c.var.requestId ?? 'unknown';
      const isPortal = err instanceof PortalError;
      const status = isPortal ? err.statusCode : 500;
      const code = isPortal ? err.code : 'INTERNAL_ERROR';
      const safeMsg = isPortal
        ? sanitizeErrorMessage(err.message)
        : 'An internal server error occurred';

      // Always log full details server-side (with stack); never echo to client.
      process.stderr.write(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        request_id: requestId,
        path: c.req.path,
        method: c.req.method,
        code,
        message: (err as Error).message,
        stack: (err as Error).stack,
      }) + '\n');

      const wantsJson = (c.req.header('accept') ?? '').includes('application/json');
      if (wantsJson) {
        return c.json({ error: { code, message: safeMsg, request_id: requestId } }, status);
      }
      // HTML body kept inline; PLAN-013-3 may swap in a JSX template.
      return c.html(
        `<!doctype html><html><head><title>Error ${status}</title></head>` +
        `<body><h1>Error ${status}</h1><p>${safeMsg}</p><p><small>Request ID: ${requestId}</small></p></body></html>`,
        status,
      );
    }
  };
}
```

- The boundary MUST run AFTER `requestIdMiddleware` (so `c.var.requestId` is set) and AFTER `structuredLogger` (so access-log emission still happens for failed requests, with the error response status visible).
- Stack traces are written to `stderr`; client responses NEVER include `err.stack`.

### Task 5: Sanitizer (`server/lib/sanitize.ts`)

```ts
export function sanitizeErrorMessage(input: string): string {
  return input
    .replace(/\/Users\/[^\/\s]+/g, '~')
    .replace(/\/home\/[^\/\s]+/g, '~')
    .replace(/(password|token|secret|api[_-]?key)\s*[=:]\s*\S+/gi, '$1=***');
}
```

- Pure function, no I/O. Unit-tested in SPEC-013-2-05.

### Task 6: Chain Orchestrator (`middleware/index.ts`)

```ts
import type { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { cors } from 'hono/cors';
import type { PortalConfig } from '../lib/config';
import { requestIdMiddleware } from './request-id';
import { structuredLogger } from './logging';
import { timingMiddleware } from './timing';
import { errorHandler } from './error-handler';

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; object-src 'none'; frame-ancestors 'none'";

export function applyMiddlewareChain(app: Hono, config: PortalConfig): void {
  // Order is contractual; do not reorder.
  app.use('*', requestIdMiddleware());                              // 1. correlation
  app.use('*', structuredLogger(config.logging.level));             // 2. access logs
  app.use('*', timingMiddleware());                                  // 3. Server-Timing
  app.use('*', secureHeaders({
    contentSecurityPolicy: CSP,
    referrerPolicy: 'strict-origin-when-cross-origin',
  }));                                                               // 4. security headers
  app.use('*', cors({
    origin: config.auth_mode === 'localhost'
      ? [`http://127.0.0.1:${config.port}`, `https://127.0.0.1:${config.port}`]
      : (config.allowed_origins ?? []),
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-CSRF-Token'],
  }));                                                               // 5. CORS
  // EXTENSION POINT: TDD-014 auth + CSRF middleware are inserted here.
  app.use('*', errorHandler());                                      // 6. error boundary (last in chain, wraps handlers)
}
```

- The single comment `EXTENSION POINT` is the contract for TDD-014 plans. Do not move it. Future auth/CSRF middleware are inserted between CORS and the error boundary.
- The error handler is registered as middleware (not `app.onError`) so it intercepts handler exceptions through the normal `try/catch` in its body. `app.onError` and `app.notFound` may be added by the bootstrap or PLAN-013-3 separately.

## Acceptance Criteria

- [ ] `applyMiddlewareChain(app, config)` registers exactly six middleware in the documented order (verified by inspecting `app.routes` or by ordered behavioral test in SPEC-013-2-05)
- [ ] Every response from the server includes an `X-Request-ID` header that is a valid UUIDv4
- [ ] When a request includes a UUIDv4-shaped `X-Request-ID` header, the server echoes that value back; non-UUID input is replaced with a freshly generated UUID
- [ ] Each successful request emits exactly one JSON line to stdout with fields `ts, level, request_id, method, path, status, duration_ms, user_agent, bytes_in`
- [ ] Each response includes a `Server-Timing: total;dur=<ms>` header where `<ms>` is a positive number
- [ ] Throwing `Errors.NotFound('User')` from a handler produces an HTTP 404 with body `{"error":{"code":"NOT_FOUND","message":"User not found","request_id":"..."}}` when `Accept: application/json`
- [ ] Throwing a generic `Error('boom: /Users/alice/secret')` produces a 500 with `message: "An internal server error occurred"` (never the raw message) and the full message + stack appears in stderr only
- [ ] `sanitizeErrorMessage('failed at /Users/alice/x with token=abc123')` returns `'failed at ~ with token=***'`
- [ ] Security headers are present on every response: `Content-Security-Policy`, `Referrer-Policy`, `X-Content-Type-Options`, `X-Frame-Options`
- [ ] CORS preflight (`OPTIONS` with `Origin: http://127.0.0.1:19280`) returns 204 with the configured `Access-Control-Allow-*` headers when `auth_mode === 'localhost'`
- [ ] `tsc --noEmit` and ESLint pass with zero warnings on all six new files

## Dependencies

- **Consumes**: `PortalConfig` from `server/lib/config.ts` (SPEC-013-2-01).
- **Consumes from Hono**: `hono/secure-headers` (note: module name is `secure-headers`, not `security-headers` — the plan reference is incorrect on this point), `hono/cors`.
- **Exposes**: `applyMiddlewareChain(app, config)` — consumed by `server/server.ts` (SPEC-013-2-01); `PortalError` and `Errors` factory — consumed by route handlers (PLAN-013-3); `EXTENSION POINT` comment between CORS and error boundary — consumed by TDD-014 plans.

## Notes

- The plan's reference snippet for `requestIdMiddleware` monkey-patches `console.log/error/warn`. This is rejected in this spec. Async context propagation through console wrappers is fragile (loses correlation across `await` boundaries when multiple requests are in flight) and the plan is to use the structured logger as the single emission path. If a developer later needs request-scoped logging from inside handler code, expose a `c.var.requestId` accessor and emit JSON directly.
- Hono's middleware module is `hono/secure-headers` (US spelling, hyphenated). The plan text says `hono/security-headers`; the implementer MUST use `secure-headers` per the actual Hono 3.12 API.
- Memory-side performance metrics (p50/p95/p99 percentile tracking) are deferred from TASK-011 to a follow-up plan. This spec only emits per-request `duration_ms`. A separate metrics aggregator can consume the JSON log stream.
- The error boundary uses simple inline HTML for non-JSON responses. Replacing this with a JSX template is owned by PLAN-013-3.
