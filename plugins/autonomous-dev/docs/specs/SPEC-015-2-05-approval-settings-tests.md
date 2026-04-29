# SPEC-015-2-05: Approval Flow, Settings Editor & HTTP Client Tests

## Metadata
- **Parent Plan**: PLAN-015-2
- **Tasks Covered**: Approval flow tests, settings round-trip tests, HTTP-client retry tests, idempotency tests
- **Estimated effort**: 8 hours

## Description
Test coverage for the approval-gate, settings-editor, intake-router HTTP client, and approval-state-persistence layers from PLAN-015-2. Tests use Bun's built-in runner with deterministic fixtures: real HTTP via a mock intake-router server (not stubs), real filesystem in `mkdtempSync` directories, mocked timers for TTL/delay/retry-backoff scenarios. Coverage target ≥90% on each module.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `tests/unit/approval-state-reader.test.ts` | Create | Schema mapping + idempotency-key determinism |
| `tests/unit/idempotency-cache.test.ts` | Create | Cache hit/miss, GC, error eviction |
| `tests/unit/intake-http-client.test.ts` | Create | Retry logic, error mapping, timeout |
| `tests/integration/approval-flow.test.ts` | Create | UI submit → mock daemon → SSE → re-render |
| `tests/integration/settings-roundtrip.test.ts` | Create | Load → edit → validate → save → reload |
| `tests/integration/approval-page-reload.test.ts` | Create | Reload mid-flow preserves state |
| `tests/helpers/mock-intake-server.ts` | Create | Real HTTP server with configurable responses |
| `tests/helpers/approval-fixtures.ts` | Create | state.json builders for each approval state |

## Implementation Details

### Mock Intake Server

```typescript
// tests/helpers/mock-intake-server.ts
export class MockIntakeServer {
  private responses = new Map<string, Response>();
  private requests: Array<{ method: string; path: string; body: any }> = [];
  private failuresRemaining = 0;

  async start(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
    const server = Bun.serve({
      port,
      fetch: async (req) => {
        const url = new URL(req.url);
        const body = req.method !== 'GET' ? await req.json().catch(() => ({})) : null;
        this.requests.push({ method: req.method, path: url.pathname, body });
        if (this.failuresRemaining > 0) {
          this.failuresRemaining--;
          return new Response('intake unavailable', { status: 503 });
        }
        const key = `${req.method} ${url.pathname}`;
        const resp = this.responses.get(key) ?? new Response('not configured', { status: 500 });
        return resp.clone();
      },
    });
    return { url: `http://localhost:${server.port}`, close: () => Promise.resolve(server.stop()) };
  }

  setResponse(method: string, path: string, response: Response): void {
    this.responses.set(`${method} ${path}`, response);
  }

  failNext(count: number): void {
    this.failuresRemaining = count;
  }

  getRequests() { return this.requests; }
  reset() { this.responses.clear(); this.requests = []; this.failuresRemaining = 0; }
}
```

### Approval State Reader Tests

```typescript
test('idempotency key: deterministic across reads', async () => {
  const fixture = approvalFixture({ requestId: 'REQ-1', gate: 'prd', emittedAt: 1234567890 });
  const reader = new ApprovalStateReader(fixture.accessor);
  const a = await reader.getApproval('REQ-1');
  const b = await reader.getApproval('REQ-1');
  expect(a!.idempotencyKey).toBe(b!.idempotencyKey);
});

test('idempotency key: differs across emitted_at', async () => {
  const a = await reader.getApproval('REQ-1');                          // emittedAt=1234
  fixture.update({ emittedAt: 5678 });
  const b = await reader.getApproval('REQ-1');                          // emittedAt=5678
  expect(a!.idempotencyKey).not.toBe(b!.idempotencyKey);
});

test('returns null when no approval pending', async () => { /* ... */ });
test('approved status surfaces decision metadata', async () => { /* ... */ });
test('expired status returns even with no decision', async () => { /* ... */ });
test('delay state: delay_expires_at from state.json maps to ApprovalState', async () => { /* ... */ });
```

### Idempotency Cache Tests

```typescript
test('same key + simultaneous calls: returns same Promise', async () => {
  const fn = mock(async () => ({ approved: true }));
  const a = submitWithIdempotency('k1', fn);
  const b = submitWithIdempotency('k1', fn);
  await Promise.all([a, b]);
  expect(fn).toHaveBeenCalledTimes(1);
});

test('different keys: independent calls', async () => { /* ... */ });
test('error: cache evicted, retry succeeds', async () => {
  const fn = mock().mockRejectedValueOnce(new Error('once')).mockResolvedValue({ approved: true });
  await expect(submitWithIdempotency('k1', fn)).rejects.toThrow();
  await expect(submitWithIdempotency('k1', fn)).resolves.toEqual({ approved: true });
});

test('GC: cache cleared after 60s', async () => { /* mocked timer */ });
```

### HTTP Client Tests

```typescript
test('retry: succeeds after 2 transient 503s', async () => {
  mockServer.failNext(2);
  mockServer.setResponse('POST', '/approvals/REQ-1', new Response('{"ok":true}'));
  const client = new IntakeHttpClient(mockServer.url, { retries: 3 });
  const result = await client.submitApproval('REQ-1', { decision: 'approve' });
  expect(result).toEqual({ ok: true });
  expect(mockServer.getRequests()).toHaveLength(3);
});

test('retry: gives up after configured retries', async () => { /* ... */ });
test('error mapping: 400 → InvalidRequest', async () => { /* ... */ });
test('error mapping: 503 → DaemonUnavailable', async () => { /* ... */ });
test('error mapping: ETIMEDOUT → NetworkError', async () => { /* ... */ });
test('non-retryable: 400 does not retry', async () => { /* ... */ });
test('exponential backoff: 200ms / 400ms / 800ms', async () => { /* mocked timer */ });
```

### Approval Flow Integration Test

```typescript
test('submit approve → daemon writes decision → SSE notifies client → page re-renders', async () => {
  const portal = await startTestPortal();
  // Initial state: approval pending
  await writeStateFixture(approvalFixture({ status: 'approval_pending' }));
  let resp = await portal.fetch('/repo/test/request/REQ-1');
  expect(await resp.text()).toContain('Approve</button>');

  // Submit approval (idempotency key from rendered fragment)
  const idempotencyKey = extractIdempotencyKey(await resp.text());
  resp = await portal.fetch('/approvals/REQ-1', {
    method: 'POST',
    body: JSON.stringify({ decision: 'approve', idempotencyKey }),
  });
  expect(resp.status).toBe(200);

  // Daemon updates state.json
  await writeStateFixture(approvalFixture({ status: 'approval_decided', decidedBy: 'alice' }));
  // Page reload: shows decision summary
  resp = await portal.fetch('/repo/test/request/REQ-1');
  expect(await resp.text()).toContain('Approved by alice');
});
```

### Settings Round-Trip Test

```typescript
test('settings: load → edit → validate → save → reload preserves change', async () => {
  const config = { trust: { system_default_level: 1 } };
  await writeConfigFile(config);
  let resp = await portal.fetch('/settings');
  expect(await resp.text()).toContain('value="1"');

  resp = await portal.fetch('/settings/save', {
    method: 'POST',
    body: JSON.stringify({ 'trust.system_default_level': '2' }),
  });
  expect(resp.status).toBe(200);

  // File on disk updated
  const saved = await readConfigFile();
  expect(saved.trust.system_default_level).toBe(2);

  // Re-render shows new value
  resp = await portal.fetch('/settings');
  expect(await resp.text()).toContain('value="2"');
});

test('settings: invalid value rejected with 422 and field error', async () => { /* ... */ });
test('settings: atomic save (temp + rename) prevents partial writes', async () => { /* ... */ });
test('settings: backup file created before save', async () => { /* ... */ });
```

### Page Reload Mid-Flow Test

```typescript
test('reload mid-flow: same idempotency key, same DOM, no double-submit', async () => {
  // 1. Render approval prompt
  const resp1 = await portal.fetch('/repo/test/request/REQ-1');
  const key1 = extractIdempotencyKey(await resp1.text());

  // 2. Reload (new request, same state.json)
  const resp2 = await portal.fetch('/repo/test/request/REQ-1');
  const key2 = extractIdempotencyKey(await resp2.text());

  // 3. Keys match
  expect(key1).toBe(key2);

  // 4. Two submissions with same key → single daemon call
  await Promise.all([
    portal.fetch('/approvals/REQ-1', { method: 'POST', body: JSON.stringify({ decision: 'approve', idempotencyKey: key1 }) }),
    portal.fetch('/approvals/REQ-1', { method: 'POST', body: JSON.stringify({ decision: 'approve', idempotencyKey: key2 }) }),
  ]);
  expect(mockIntakeServer.getRequests().filter(r => r.path === '/approvals/REQ-1')).toHaveLength(1);
});
```

## Acceptance Criteria

- [ ] Approval state reader: 6+ test cases covering all transitions
- [ ] Idempotency cache: 4 cases (same-key dedup, different-key independence, error eviction, GC)
- [ ] HTTP client: 7 cases covering retry, error mapping, backoff, non-retryable
- [ ] Approval flow integration: end-to-end from submit through SSE re-render
- [ ] Settings round-trip: load + edit + validate + save + reload, plus 3 negative cases
- [ ] Page reload: idempotency key stable across reloads; double-submit suppressed
- [ ] All tests deterministic (mocked timers, real HTTP via mock server, temp dirs)
- [ ] Coverage ≥90% on approval-state-reader, idempotency, http-client, settings
- [ ] Total wall-clock <60s

## Dependencies

- **SPEC-015-2-01..04**: implementations under test
- **SPEC-015-1-03**: state.json reader (used by ApprovalStateReader)
- Bun test runner + `Bun.serve` for the mock intake server

## Notes

- The mock intake server uses real HTTP (not function stubs) so the http-client's actual behavior is exercised — including timeout, real retry, and connection-level errors.
- `failNext(count)` is the canonical pattern for transient-error testing; reused across PLAN-015-2 and PLAN-024-* test suites.
- Settings tests verify atomic-write behavior by killing the process mid-write (via `setTimeout` + `process.kill`) and asserting no partial config file remains.
- Page-reload test is critical: it's the highest-leverage UX safety check. Operators routinely close laptops mid-flow.
- E2E browser tests (Playwright) are out of scope here. The integration tests cover server-side correctness; visual regression is a follow-up.
