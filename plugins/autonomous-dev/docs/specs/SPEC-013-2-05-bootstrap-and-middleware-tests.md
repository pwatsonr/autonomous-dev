# SPEC-013-2-05: Bootstrap, Middleware, and Shutdown Tests

## Metadata
- **Parent Plan**: PLAN-013-2
- **Tasks Covered**: TASK-012 (unit + integration test suites for everything in SPECs 013-2-01..04), partial TASK-013 (basic startup + throughput benchmark targets)
- **Estimated effort**: 6 hours

## Description
Build the comprehensive Bun-test suite covering the four sibling specs in this plan: bootstrap orchestration, middleware chain, binding/auth-mode security, and graceful shutdown. Tests MUST run via `bun test` with no flaky behavior, complete in under 30 seconds for the full suite, and cover the documented edge cases for each module. This spec ships only tests; it does not modify production code. A small set of smoke benchmarks verifies the plan's performance targets (startup < 10 s, health-check p95 < 100 ms, throughput > 100 req/s).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `tests/unit/config.test.ts` | Create | Defaults + user overrides + env overrides + validation |
| `tests/unit/binding.test.ts` | Create | Auth-mode rules, port probe, privilege check |
| `tests/unit/middleware-request-id.test.ts` | Create | UUID generation, header echo, header validation |
| `tests/unit/middleware-logging.test.ts` | Create | Structured-log fields, level gating, stdout capture |
| `tests/unit/middleware-error-handler.test.ts` | Create | PortalError mapping, sanitization, JSON vs HTML |
| `tests/unit/connection-tracker.test.ts` | Create | Counter increment/decrement, drain semantics |
| `tests/unit/shutdown.test.ts` | Create | Signal handling, drain timeout, second-signal, hooks |
| `tests/unit/sanitize.test.ts` | Create | Path/secret redaction edge cases |
| `tests/integration/full-server.test.ts` | Create | End-to-end request lifecycle with real `Bun.serve` |
| `tests/integration/shutdown-lifecycle.test.ts` | Create | Spawn-process tests for SIGTERM/SIGINT |
| `tests/smoke/startup-benchmark.test.ts` | Create | Cold-start time + health-check throughput |
| `tests/helpers/test-server.ts` | Create | Shared helpers: `startTestServer`, `randomPort`, `captureStdout` |

## Implementation Details

### Task 1: Test Helpers (`tests/helpers/test-server.ts`)

```ts
import { afterEach, beforeEach } from 'bun:test';
import { startServer } from '../../server/server';
import type { Server } from 'bun';

export function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 5000);
}

export async function startTestServer(overrides: Record<string, string> = {}): Promise<{
  server: Server; port: number; baseUrl: string; close: () => Promise<void>;
}> {
  const port = randomPort();
  const prev = { ...process.env };
  process.env.PORTAL_PORT = String(port);
  Object.assign(process.env, overrides);
  const server = await startServer();
  return {
    server, port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      server.stop(true);
      process.env = prev;
    },
  };
}

export function captureStdout(): { restore: () => void; lines: () => string[] } {
  const orig = process.stdout.write.bind(process.stdout);
  const buf: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    const s = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    buf.push(...s.split('\n').filter(Boolean));
    return true;
  }) as typeof process.stdout.write;
  return { restore: () => { process.stdout.write = orig; }, lines: () => [...buf] };
}
```

### Task 2: Unit Tests — `config.test.ts`

Required cases:

| Case | Expectation |
|---|---|
| Load with no user config and no env | Returns defaults verbatim |
| Load with user config that overrides `port` | Merged result has user's port; rest from defaults |
| `PORTAL_PORT=8080` | Result `port === 8080` |
| `PORTAL_PORT=99999` | Throws `INVALID_CONFIG` (range) |
| `PORTAL_PORT=foo` | Throws `INVALID_ENV_PORTAL_PORT` |
| `PORTAL_AUTH_MODE=invalid` | Throws `INVALID_ENV_PORTAL_AUTH_MODE` |
| User config file is malformed JSON | Throws `INVALID_CONFIG_SYNTAX` with file path |
| User config file does not exist | Returns defaults silently |
| `deepMerge({a:{b:1,c:2}}, {a:{b:9}})` | `{a:{b:9,c:2}}` |
| `deepMerge` on arrays | Right-side array replaces left-side |
| `expandHome("~/foo")` | Returns `os.homedir() + "/foo"` |
| Load completes in < 50 ms (measured 10 times, median) | True |

### Task 3: Unit Tests — `binding.test.ts`

Required cases:

| Case | Expectation |
|---|---|
| `auth_mode=localhost`, no `bind_host` | `resolveBindHostname` returns `127.0.0.1` |
| `auth_mode=localhost`, `bind_host=0.0.0.0` | `validateBindingConfig` throws `BIND_HOST_DISALLOWED` |
| `auth_mode=tailscale`, host has `tailscale0` (mock `os.networkInterfaces`) | Returns the mocked IPv4 |
| `auth_mode=tailscale`, host lacks `tailscale0` | Throws `TAILSCALE_NOT_FOUND` |
| `auth_mode=oauth`, no extension registered | Throws `OAUTH_NOT_CONFIGURED` |
| `auth_mode=oauth`, extension registered | Validation passes |
| `port=80`, non-root | Throws `INSUFFICIENT_PRIVILEGES` (skip on Windows / when `getuid` is undefined) |
| Port already in use (start a probe server first) | Throws `PORT_IN_USE` |
| Port available | Resolves without error |

Mocking `os.networkInterfaces` requires `mock.module('node:os', () => ({...}))` — Bun's mock API supports this. Restore after each test.

### Task 4: Middleware Unit Tests

`middleware-request-id.test.ts`:
- Request without `x-request-id` header gets a UUIDv4 in response
- Request with valid UUID in header gets that exact UUID echoed back
- Request with invalid `x-request-id: <script>alert(1)</script>` gets a fresh UUID (rejection of injection)
- `c.var.requestId` is set inside handlers
- Response header name is exactly `x-request-id` (lowercase)

`middleware-logging.test.ts` (use `captureStdout` helper):
- One JSON line emitted per request, parseable as JSON
- All 9 fields present: `ts, level, request_id, method, path, status, duration_ms, user_agent, bytes_in`
- `level=warn` config suppresses `info`-level access logs
- `duration_ms` is a non-negative integer
- `request_id` matches the response `x-request-id` header

`middleware-error-handler.test.ts`:
- `Errors.NotFound('User')` → 404 with code `NOT_FOUND`, message `User not found`
- `Errors.PayloadTooLarge(1024)` → 413 with code `PAYLOAD_TOO_LARGE`
- Generic `throw new Error('boom: /Users/alice/secret token=abc123')` → 500, client message `An internal server error occurred`, sanitized message in stderr log line
- `Accept: application/json` returns JSON body
- `Accept: text/html` returns HTML body containing `Error 500` and the request_id
- No `Accept` header defaults to JSON (per spec)
- Error response always includes the `x-request-id` header

`sanitize.test.ts`:
- `/Users/alice/foo` → `~/foo`
- `/home/bob/data` → `~/data`
- `password=hunter2` → `password=***`
- `Bearer abc.def.ghi token=xyz` → `Bearer abc.def.ghi token=***` (token redacted, bearer left alone — only matches `key|token|password|secret` pattern)
- Empty string → empty string
- Already-sanitized string → unchanged

### Task 5: Connection Tracker Tests (`connection-tracker.test.ts`)

```ts
import { test, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { connectionCounter, getActiveRequestCount, waitForDrain, __resetForTesting }
  from '../../server/lib/connection-tracker';

beforeEach(() => __resetForTesting());

test('counter increments and decrements', async () => {
  const app = new Hono();
  app.use('*', connectionCounter());
  app.get('/slow', async (c) => {
    expect(getActiveRequestCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    return c.text('ok');
  });
  expect(getActiveRequestCount()).toBe(0);
  await app.request('/slow');
  expect(getActiveRequestCount()).toBe(0);
});

test('decrements on handler throw', async () => { /* ... */ });
test('waitForDrain returns immediately when active=0', async () => { /* ... */ });
test('waitForDrain resolves when last request finishes', async () => { /* ... */ });
test('waitForDrain returns drained:false on timeout', async () => { /* ... */ });
```

### Task 6: Shutdown Unit Tests (`shutdown.test.ts`)

Most shutdown logic involves real signals and `process.exit`, which are hard to unit-test. Test the testable surfaces directly:
- `registerShutdownHook` adds hooks; hooks run in registration order during a manually triggered shutdown
- A hook that throws does not abort subsequent hooks
- `__resetHooksForTesting()` clears the array
- Mock `process.exit` to capture exit codes; mock `process.on` to inject signals manually

For end-to-end shutdown behavior (real signals), see `tests/integration/shutdown-lifecycle.test.ts`.

### Task 7: Integration Tests — `full-server.test.ts`

Spin up the real server via `startTestServer()`:
- `GET /health` returns 200 with the documented JSON shape
- Response includes `x-request-id`, `server-timing`, `content-security-policy`, `referrer-policy`
- `GET /nonexistent` returns 404 with sanitized JSON error body
- A handler that throws `Errors.BadRequest('bad')` (registered ad-hoc for the test) returns 422 + JSON
- Concurrent 50 requests to `/health` all succeed and the access log emits 50 lines
- `OPTIONS /health` with `Origin: http://127.0.0.1:<port>` returns 204 with CORS headers
- `OPTIONS /health` with `Origin: http://evil.example` returns no `Access-Control-Allow-Origin` (origin not in allowlist)

### Task 8: Integration Tests — `shutdown-lifecycle.test.ts`

Use `Bun.spawn` to run `server/server.ts` as a child process and send real signals:

```ts
test('SIGTERM with no active requests exits 0 within 1 s', async () => {
  const proc = Bun.spawn({
    cmd: ['bun', 'run', 'server/server.ts'],
    env: { ...process.env, PORTAL_PORT: String(randomPort()) },
    stderr: 'pipe', stdout: 'pipe',
  });
  await waitForLogLine(proc, 'server_listening', 5000);
  proc.kill('SIGTERM');
  const code = await proc.exited;
  expect(code).toBe(0);
});

test('SIGTERM with in-flight slow request waits for drain', async () => { /* ... */ });
test('Two SIGINT signals force exit 1', async () => { /* ... */ });
test('Port already in use exits 1 with PORT_IN_USE log', async () => { /* ... */ });
```

`waitForLogLine` is a helper that reads `proc.stderr` line by line until it sees a JSON log with the matching `phase`.

### Task 9: Smoke Benchmarks (`smoke/startup-benchmark.test.ts`)

Two benchmarks; mark with longer timeout (`test.skip.if(process.env.CI === '1')` if CI is too constrained):

```ts
test('cold start under 10 seconds', async () => {
  const t0 = Date.now();
  const proc = Bun.spawn({ cmd: ['bun', 'run', 'server/server.ts'], stderr: 'pipe' });
  await waitForLogLine(proc, 'server_listening', 10_000);
  const elapsed = Date.now() - t0;
  proc.kill('SIGTERM');
  await proc.exited;
  expect(elapsed).toBeLessThan(10_000);
});

test('health-check throughput > 100 req/s', async () => {
  const { baseUrl, close } = await startTestServer();
  const t0 = Date.now();
  const N = 200;
  const results = await Promise.all(Array.from({ length: N }, () => fetch(`${baseUrl}/health`)));
  const elapsed = (Date.now() - t0) / 1000;
  const rps = N / elapsed;
  for (const r of results) expect(r.status).toBe(200);
  expect(rps).toBeGreaterThan(100);
  await close();
});
```

## Acceptance Criteria

- [ ] `bun test` runs all suites and exits 0
- [ ] Full suite (unit + integration + smoke) completes in < 30 seconds on developer hardware
- [ ] Unit-test code coverage ≥ 90% across `server/lib/` and `server/middleware/` (measured via `bun test --coverage`)
- [ ] No test exhibits flaky behavior across 5 consecutive runs (verified locally before merge)
- [ ] `tests/integration/full-server.test.ts` spins up a real `Bun.serve` listener on a randomized port and tears it down cleanly between tests
- [ ] `tests/integration/shutdown-lifecycle.test.ts` covers all four documented signal scenarios (clean SIGTERM, drain wait, double-SIGINT, port-in-use)
- [ ] `tests/smoke/startup-benchmark.test.ts` enforces startup < 10 s and throughput > 100 req/s
- [ ] All test files compile under the strict TypeScript settings from SPEC-013-2-01
- [ ] No test relies on `setTimeout` waits longer than necessary; drain tests use real `waitForDrain` rather than fixed sleeps where possible
- [ ] `tests/helpers/test-server.ts` is the single source of port allocation and process env restoration; tests do not reach into `process.env` directly
- [ ] Each test file has at least one `expect` assertion per documented case in this spec

## Dependencies

- **Consumes**: every public symbol exported by SPECs 013-2-01 through 013-2-04. Tests assume those modules exist with the documented signatures.
- **Runtime**: Bun ≥ 1.0 with the built-in `bun:test` runner and `bun --coverage` flag.
- **No new production dependencies** — testing uses only Bun built-ins.

## Notes

- Bun's `bun:test` runner supports `mock.module(...)` for ESM mocking, which is sufficient for the `node:os` mock in binding tests. Avoid Jest-style auto-mocking; explicit `mock.module` calls are clearer.
- Spawning child processes for shutdown tests is necessary because `process.exit` cannot be mocked in-process. Each spawned test takes ~1–2 s; keep the count low (4 scenarios) to stay within the 30-second budget.
- Throughput targets are **smoke** thresholds, not strict SLAs. On constrained CI runners they may flap; if so, gate them behind `test.skipIf(process.env.CI === '1')` and document the local-run requirement in `package.json` scripts (`test:smoke`).
- Coverage exclusions: `config/portal-defaults.json` (data, no code), generated TypeScript output, and `tests/**` itself. Configure via `bunfig.toml` if needed.
- The plan lists separate "performance optimization" work (TASK-013) as a follow-up. This spec ships ONLY the basic benchmark thresholds defined in TASK-012's acceptance criteria; deeper p99 latency tracking and memory-leak regression tests are deferred.
