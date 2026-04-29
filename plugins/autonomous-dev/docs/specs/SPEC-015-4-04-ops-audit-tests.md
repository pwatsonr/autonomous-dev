# SPEC-015-4-04: Ops, Audit, and Daemon-Health Tests

## Metadata
- **Parent Plan**: PLAN-015-4
- **Tasks Covered**: TASK-012 (Operations integration tests), TASK-013 (Audit page integration tests), TASK-014 (Daemon health unit tests), TASK-015 (CLI audit verification tool tests)
- **Estimated effort**: 10 hours

## Description
Comprehensive test coverage for PLAN-015-4: unit tests for the daemon health monitor and stale-data handler with controlled heartbeat fixtures, integration tests for the operations endpoints (kill-switch + circuit-breaker) covering the full typed-CONFIRM flow against a mocked intake-router, integration tests for the audit page covering pagination + filtering + integrity-status display, and CLI tests for the offline `audit-verify` tool. Tests use Bun's built-in test runner and ship deterministic fixtures so runs are reproducible across operator environments.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `tests/unit/daemon-health-monitor.test.ts` | Create | Status classification, polling, SSE broadcasts |
| `tests/unit/stale-data-handler.test.ts` | Create | Banner config + mutation validation |
| `tests/unit/audit-display-formatter.test.ts` | Create | Entry formatting, timestamp relativization |
| `tests/integration/operations.test.ts` | Create | Kill-switch + circuit-breaker end-to-end |
| `tests/integration/audit.test.ts` | Create | Audit page pagination, filtering, integrity |
| `tests/integration/daemon-down.test.ts` | Create | 503 mutation gating + read-only preservation |
| `tests/helpers/mock-intake-client.ts` | Create | Configurable mock for intake-router HTTP calls |
| `tests/helpers/audit-test-data.ts` | Create | Generators for valid + corrupted audit logs |
| `tests/helpers/heartbeat-fixtures.ts` | Create | Fresh / stale / dead / malformed heartbeat builders |
| `tests/cli/audit-verify.test.ts` | Create | Offline integrity tool CLI tests |

## Implementation Details

### Heartbeat Fixtures

```typescript
// tests/helpers/heartbeat-fixtures.ts
import { writeFile, unlink } from 'fs/promises';

export async function writeHeartbeat(path: string, ageMs: number, opts: { pid?: number; iteration?: number } = {}) {
  const ts = new Date(Date.now() - ageMs).toISOString();
  await writeFile(path, JSON.stringify({ timestamp: ts, pid: opts.pid ?? 12345, iteration: opts.iteration ?? 0 }));
}

export async function writeMalformedHeartbeat(path: string, content: string) {
  await writeFile(path, content);
}

export async function deleteHeartbeat(path: string) {
  try { await unlink(path); } catch { /* ignore ENOENT */ }
}
```

### Daemon Health Unit Tests

```typescript
// tests/unit/daemon-health-monitor.test.ts
import { test, expect, mock, beforeEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tmp: string;
let heartbeatPath: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'health-test-'));
  heartbeatPath = join(tmp, 'heartbeat.json');
});

test('healthy: heartbeat age <30s', async () => {
  await writeHeartbeat(heartbeatPath, 5_000);
  const monitor = new DaemonHealthMonitor(heartbeatPath, mockEventBus);
  await (monitor as any).poll();
  expect(monitor.getDaemonStatus().status).toBe('healthy');
});

test('stale: heartbeat age 30-120s', async () => {
  await writeHeartbeat(heartbeatPath, 60_000);
  const monitor = new DaemonHealthMonitor(heartbeatPath, mockEventBus);
  await (monitor as any).poll();
  expect(monitor.getDaemonStatus().status).toBe('stale');
});

test('dead: heartbeat age >120s', async () => {
  await writeHeartbeat(heartbeatPath, 300_000);
  // ... assert 'dead'
});

test('dead: heartbeat file missing', async () => {
  await deleteHeartbeat(heartbeatPath);
  // ... assert 'dead'
});

test('unknown: heartbeat malformed JSON', async () => {
  await writeMalformedHeartbeat(heartbeatPath, '{"timestamp": invalid');
  // ... assert 'unknown'
});

test('unknown: heartbeat missing timestamp field', async () => {
  await writeMalformedHeartbeat(heartbeatPath, '{"pid": 1}');
  // ... assert 'unknown'
});

test('SSE broadcast on status change', async () => {
  const broadcast = mock(() => {});
  const bus = { broadcast };
  await writeHeartbeat(heartbeatPath, 5_000);
  const monitor = new DaemonHealthMonitor(heartbeatPath, bus);
  await (monitor as any).poll();           // healthy
  await writeHeartbeat(heartbeatPath, 60_000);
  await (monitor as any).poll();           // stale → broadcast
  expect(broadcast).toHaveBeenCalledWith({ type: 'daemon-status-changed', data: expect.objectContaining({ status: 'stale' }) });
});

test('no broadcast when status unchanged', async () => {
  // healthy → healthy, broadcast count unchanged
});
```

### Stale-Data Handler Tests

```typescript
test('banner severity: none for healthy', () => {
  const monitor = stubMonitor({ status: 'healthy' });
  const handler = new StaleDataHandler(monitor);
  expect(handler.getBannerStatus().severity).toBe('none');
});

test('banner severity: warning for stale', () => { /* ... */ });
test('banner severity: error for dead', () => { /* ... */ });
test('banner severity: error for unknown', () => { /* ... */ });
test('banner showRetry: true only for dead and unknown', () => { /* ... */ });
test('mutation allowed: healthy + stale', () => { /* ... */ });
test('mutation blocked: dead + unknown', () => { /* ... */ });
```

### Operations Integration Tests

```typescript
// tests/integration/operations.test.ts
test('kill-switch engage: requires typed-CONFIRM token', async () => {
  const app = await startTestPortal({ daemonStatus: 'healthy' });
  // 1. Generate token
  const tokRes = await app.request('/ops/confirm-token', {
    method: 'POST',
    body: JSON.stringify({ action: 'kill-switch.engage' }),
  });
  const { token } = await tokRes.json();
  // 2. Engage with valid token
  const res = await app.request('/ops/kill-switch/engage', {
    method: 'POST',
    body: JSON.stringify({ reason: 'test', confirmationToken: token }),
  });
  expect(res.status).toBe(200);
  expect(mockIntake.engageKillSwitch).toHaveBeenCalledWith({ reason: 'test' });
});

test('kill-switch engage: rejects without token', async () => {
  const res = await app.request('/ops/kill-switch/engage', { method: 'POST', body: JSON.stringify({ reason: 'x' }) });
  expect(res.status).toBe(400);
});

test('kill-switch engage: rejects expired token', async () => {
  // generate token, fast-forward 61s, attempt engage
});

test('kill-switch engage: rejects token from different action', async () => {
  // generate for circuit-breaker.reset, attempt to use for kill-switch.engage
});

test('kill-switch engage: 503 when daemon dead', async () => {
  const app = await startTestPortal({ daemonStatus: 'dead' });
  const res = await app.request('/ops/kill-switch/engage', { method: 'POST', body: '{}' });
  expect(res.status).toBe(503);
});

test('circuit-breaker reset: full happy path', async () => { /* ... */ });
test('SSE broadcast on successful kill-switch engage', async () => { /* ... */ });
test('audit entry written on successful operation', async () => { /* ... */ });
```

### Audit Page Integration Tests

```typescript
// tests/integration/audit.test.ts
test('GET /audit: page 1 of 3', async () => {
  await seedAuditLog(150);                  // 150 entries → 3 pages of 50
  const res = await app.request('/audit?page=1');
  const html = await res.text();
  expect(html).toContain('entries 1-50');
  expect(html).toContain('Page 1 of 3');
});

test('GET /audit: HTMX pagination preserves filters', async () => {
  const res = await app.request('/audit?page=2&operatorId=alice', { headers: { 'HX-Request': 'true' } });
  const html = await res.text();
  expect(html).toContain('hx-get="/audit?page=3&operatorId=alice"');  // next link preserves filter
});

test('GET /audit: integrity indicator green when chain intact', async () => {
  await seedAuditLog(50, { tampered: false });
  const res = await app.request('/audit');
  expect(await res.text()).toContain('class="integrity integrity--verified"');
});

test('GET /audit: integrity indicator red when entry tampered', async () => {
  await seedAuditLog(50, { tampered: true });
  expect(await res.text()).toContain('class="integrity integrity--error"');
});

test('GET /audit: filter by date range', async () => { /* ... */ });
test('GET /audit: filter by action substring', async () => { /* ... */ });
test('GET /audit: malformed entry skipped, others displayed', async () => { /* ... */ });
```

### Daemon-Down Integration Tests

```typescript
// tests/integration/daemon-down.test.ts
test('mutation endpoint: 503 with body when daemon dead', async () => {
  const res = await app.request('/ops/kill-switch/engage', { method: 'POST', body: '{}' });
  expect(res.status).toBe(503);
  expect((await res.json()).error).toMatch(/daemon is unavailable/i);
});

test('read-only page: renders with banner when daemon dead', async () => {
  const res = await app.request('/audit');
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('class="banner banner--error"');
  expect(html).toContain('aria-live="assertive"');
});

test('read-only page: no banner when daemon healthy', async () => {
  const app = await startTestPortal({ daemonStatus: 'healthy' });
  const res = await app.request('/audit');
  const html = await res.text();
  expect(html).not.toContain('banner banner--');
});

test('banner severity transitions on heartbeat update via SSE', async () => {
  // Connect SSE, transition healthy→stale→dead, assert events received
});
```

### CLI audit-verify Tests

```typescript
// tests/cli/audit-verify.test.ts
test('audit-verify: clean log exits 0', async () => {
  await seedAuditLog(100, { tampered: false });
  const proc = Bun.spawnSync(['bun', 'run', 'bin/audit-verify.ts', auditPath]);
  expect(proc.exitCode).toBe(0);
  expect(new TextDecoder().decode(proc.stdout)).toContain('100 entries verified');
});

test('audit-verify: tampered log exits 2', async () => {
  await seedAuditLog(100, { tamperedAt: 50 });
  const proc = Bun.spawnSync(['bun', 'run', 'bin/audit-verify.ts', auditPath]);
  expect(proc.exitCode).toBe(2);
  expect(new TextDecoder().decode(proc.stderr)).toMatch(/HMAC mismatch at sequence 50/);
});

test('audit-verify: --verbose shows per-entry status', async () => { /* ... */ });
test('audit-verify: missing key file exits 1 with clear error', async () => { /* ... */ });
test('audit-verify: detects sequence gap', async () => { /* ... */ });
```

### Mock Intake Client

```typescript
// tests/helpers/mock-intake-client.ts
export class MockIntakeClient {
  engageKillSwitch = mock(async (_opts: { reason: string }) => ({ success: true }));
  resetKillSwitch = mock(async () => ({ success: true }));
  resetCircuitBreaker = mock(async () => ({ success: true }));

  reset(): void {
    this.engageKillSwitch.mockClear();
    this.resetKillSwitch.mockClear();
    this.resetCircuitBreaker.mockClear();
  }

  failNext(error: Error): void {
    this.engageKillSwitch.mockImplementationOnce(() => Promise.reject(error));
  }
}
```

## Acceptance Criteria

- [ ] All four DaemonStatus classifications tested (healthy/stale/dead/unknown) with deterministic fixtures
- [ ] Status-change SSE broadcasts verified
- [ ] StaleDataHandler banner truth-table fully covered (4 statuses × 3 outputs each)
- [ ] Mutation allowed/blocked by status (4 cases) all tested
- [ ] Kill-switch engage flow: 5+ scenarios (happy, no token, expired, wrong-action, daemon-dead)
- [ ] Circuit-breaker reset flow: same scenario coverage
- [ ] Audit pagination: at least 3 pages of test data, filter combinations, integrity green + red
- [ ] Daemon-down preservation: read-only pages render with banner; mutation 503s
- [ ] CLI audit-verify: 5+ scenarios (clean, tampered, gap, missing key, verbose)
- [ ] All tests deterministic (no real timers, network, or filesystem outside `mkdtempSync`)
- [ ] Coverage ≥90% on the modules under test
- [ ] All tests run in <60s total wall-clock on a typical CI runner

## Dependencies

- **SPEC-015-4-01, SPEC-015-4-02, SPEC-015-4-03**: implementations under test
- **SPEC-014-3-03**: HMAC-chained audit log (provides the format and verifier the CLI exercises)
- **SPEC-015-1-02**: SSE event bus mock for broadcast verification
- Bun test runner (built-in, no extra dep)

## Notes

- Test fixtures keep heartbeat ages in absolute past (`Date.now() - ageMs`) rather than mocking timers — simpler, no library needed.
- `MockIntakeClient` is shared across the operations tests AND PLAN-015-2's settings tests (cross-spec helper).
- Audit-page HTMX tests use the `HX-Request: true` header to verify partial-vs-full-page rendering per SPEC-013-3-02.
- The CLI test invokes the real `bin/audit-verify.ts` via `Bun.spawnSync` — true black-box test of the operator-facing tool.
- Tests deliberately exclude E2E browser automation (Playwright) — that's a follow-up effort once the operator portal stabilizes.
- Failure-injection tests (`MockIntakeClient.failNext`) cover the "intake-router unreachable" path that triggers retry/escalation in SPEC-015-2-03.
