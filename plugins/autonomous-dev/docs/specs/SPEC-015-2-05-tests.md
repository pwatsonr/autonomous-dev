# SPEC-015-2-05: Tests — Approval Flow with Mocked Router, Settings Round-Trip, HTTP-Client Retry

## Metadata
- **Parent Plan**: PLAN-015-2
- **Tasks Covered**: Task 11 (end-to-end integration tests) plus the unit-test bundles for SPEC-015-2-01 through SPEC-015-2-04
- **Estimated effort**: 6 hours

## Description

Build the test harness and the comprehensive test suites for PLAN-015-2 deliverables: a `MockIntakeRouter` HTTP server fixture, an in-memory state.json factory, and three top-level test suites covering (1) the approval gate end-to-end flow, (2) the settings editor round-trip with validation and daemon-reload signaling, and (3) the HTTP client's retry/timeout/error-classification behavior. Tests run against the real portal server (Bun + Hono) bound to a random ephemeral port, with the mock intake router on another ephemeral port. No browser is launched; HTMX behavior is verified via fragment HTML inspection and CustomEvent simulation in jsdom for the modal flow.

This spec defines the test contract — the fixtures, the assertions, and the coverage targets. It is the canonical place to look up "where does X feature get tested?" for any of the four sibling specs.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `tests/portal/fixtures/mock-intake-router.ts` | Create | Standalone Hono app with command recording |
| `tests/portal/fixtures/state-factory.ts` | Create | `createState({...})` helper writes valid state.json on disk |
| `tests/portal/fixtures/portal-test-server.ts` | Create | Boots the real portal pointing at the mock router |
| `tests/portal/fixtures/jsdom-setup.ts` | Create | Lightweight DOM env for modal/CustomEvent tests |
| `tests/portal/approval-gate-flow.test.ts` | Create | Suite 1 — approve/reject/changes integration |
| `tests/portal/settings-mutation-flow.test.ts` | Create | Suite 2 — settings round-trip + reload |
| `tests/portal/intake-router-client.test.ts` | Create | Suite 3 — HTTP client retry/timeout/error mapping |
| `tests/portal/gate-confirmation-modal.test.ts` | Create | Modal lifecycle in jsdom |
| `tests/portal/idempotent-rerender.test.ts` | Create | Reload-after-action behavior |
| `package.json` | Modify | Add `test:portal` script |

## Implementation Details

### MockIntakeRouter Fixture

```typescript
// tests/portal/fixtures/mock-intake-router.ts
import { Hono } from 'hono';
import { serve } from 'bun';

export interface RecordedCommand {
  command: string;
  body: any;
  receivedAt: number;
  responseStatus: number;
}

export class MockIntakeRouter {
  private server: ReturnType<typeof serve> | null = null;
  private commands: RecordedCommand[] = [];
  private behavior: 'ok' | 'fail-permanent' | 'fail-transient' | 'fail-then-ok' = 'ok';
  private failuresRemaining = 0;

  port = 0;

  async start(): Promise<void> {
    const app = new Hono();
    app.post('/router/command', async (c) => {
      const body = await c.req.json();
      const status = this.computeStatus();
      this.commands.push({ command: body.command, body, receivedAt: Date.now(), responseStatus: status });
      if (status >= 200 && status < 300) {
        return c.json({ commandId: `mock-${this.commands.length}`, data: {} }, status);
      }
      return c.json({ error: this.computeErrorMessage(status), errorCode: this.computeErrorCode(status) }, status);
    });
    app.get('/router/health', (c) => c.json({ version: '1.0-mock' }));

    this.server = serve({ port: 0, fetch: app.fetch });
    this.port = this.server.port;
  }

  async stop(): Promise<void> {
    this.server?.stop();
    this.server = null;
  }

  // Test API
  setBehavior(b: typeof this.behavior, count = 1): void {
    this.behavior = b;
    this.failuresRemaining = count;
  }

  getReceivedCommands(): RecordedCommand[] { return [...this.commands]; }
  reset(): void { this.commands = []; this.behavior = 'ok'; this.failuresRemaining = 0; }

  private computeStatus(): number {
    if (this.behavior === 'ok') return 200;
    if (this.behavior === 'fail-permanent') return 422;
    if (this.behavior === 'fail-transient') return 503;
    if (this.behavior === 'fail-then-ok') {
      if (this.failuresRemaining > 0) { this.failuresRemaining--; return 503; }
      return 200;
    }
    return 200;
  }

  private computeErrorMessage(status: number): string {
    return status === 422 ? 'Mock validation error' : status === 503 ? 'Mock service unavailable' : `HTTP ${status}`;
  }

  private computeErrorCode(status: number): string {
    return status === 422 ? 'INVALID_TRANSITION' : status === 503 ? 'SERVICE_UNAVAILABLE' : `HTTP_${status}`;
  }
}
```

### State Factory

```typescript
// tests/portal/fixtures/state-factory.ts
export interface StateOverrides {
  status?: 'queued' | 'pending-approval' | 'approved' | 'rejected' | 'changes-requested' | 'cancelled' | 'completed';
  cost?: number;
  ageHours?: number;        // simulates created_at = now - ageHours
  escalatedAt?: string;
  phaseHistory?: any[];
}

export async function createState(repoDir: string, requestId: string, overrides: StateOverrides = {}): Promise<string> {
  const createdAt = new Date(Date.now() - (overrides.ageHours ?? 0) * 3_600_000).toISOString();
  const state = {
    schema_version: 1,
    request_id: requestId,
    status: overrides.status ?? 'pending-approval',
    priority: 'normal',
    description: `Test request ${requestId}`,
    repository: 'test-repo',
    source: { kind: 'cli' },
    adapter_metadata: {},
    created_at: createdAt,
    updated_at: createdAt,
    phase_history: overrides.phaseHistory ?? [],
    current_phase_metadata: {},
    cost_accrued_usd: overrides.cost ?? 0,
    turn_count: 0,
    escalation_count: 0,
    blocked_by: [],
    error: null,
    last_checkpoint: null,
    ...(overrides.escalatedAt ? { escalated_at: overrides.escalatedAt } : {}),
  };
  const dir = `${repoDir}/.autonomous-dev/requests/${requestId}`;
  await mkdir(dir, { recursive: true });
  const path = `${dir}/state.json`;
  await writeFile(path, JSON.stringify(state, null, 2));
  return path;
}
```

### Portal Test Server

```typescript
// tests/portal/fixtures/portal-test-server.ts
export async function startPortal(opts: { intakePort: number; repoRoot: string }): Promise<{ url: string; stop: () => Promise<void> }> {
  // Construct portal app with injected IntakeRouterClient pointing at opts.intakePort
  // Use ephemeral port for portal itself
  // Return base URL like http://127.0.0.1:54321
}
```

### Suite 1: Approval Gate Flow

```typescript
describe('Approval gate flow', () => {
  let mockRouter: MockIntakeRouter;
  let portal: { url: string; stop: () => Promise<void> };
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp('/tmp/portal-test-');
    mockRouter = new MockIntakeRouter();
    await mockRouter.start();
    portal = await startPortal({ intakePort: mockRouter.port, repoRoot });
  });
  afterEach(async () => {
    await portal.stop();
    await mockRouter.stop();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('approve: low cost, happy path, single intake call, audit entry, resolved panel', async () => {
    await createState(repoRoot, 'REQ-1', { status: 'pending-approval', cost: 25 });
    const formData = new URLSearchParams();
    formData.append('action', 'approve');
    formData.append('comment', 'LGTM');
    const response = await fetch(`${portal.url}/repo/test-repo/request/REQ-1/gate/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': await fetchCsrfToken(portal.url) },
      body: formData,
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Approved by');
    expect(html).not.toContain('class="gate-actions"');

    const cmds = mockRouter.getReceivedCommands();
    expect(cmds).toHaveLength(1);
    expect(cmds[0].body.command).toBe('approve');
    expect(cmds[0].body.targetRequestId).toBe('REQ-1');
    expect(cmds[0].body.source).toBe('portal');
  });

  it('reject high-cost without token returns 428', async () => {
    await createState(repoRoot, 'REQ-2', { status: 'pending-approval', cost: 75 });
    const response = await postGate(portal.url, 'test-repo', 'REQ-2', 'reject', {});
    expect(response.status).toBe(428);
    expect(mockRouter.getReceivedCommands()).toHaveLength(0);
  });

  it('reject high-cost with valid token submits and consumes token', async () => {
    await createState(repoRoot, 'REQ-3', { status: 'pending-approval', cost: 100 });
    const tokenResp = await fetch(`${portal.url}/repo/test-repo/request/REQ-3/gate/confirm-token`, {
      method: 'POST', body: JSON.stringify({ action: 'reject' }),
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await fetchCsrfToken(portal.url) },
    });
    const { token } = await tokenResp.json();
    const response = await postGate(portal.url, 'test-repo', 'REQ-3', 'reject', { confirmationToken: token, comment: 'too expensive' });
    expect(response.status).toBe(200);

    // Reusing the same token must fail
    const replay = await postGate(portal.url, 'test-repo', 'REQ-3', 'reject', { confirmationToken: token });
    expect(replay.status).toBe(200);   // already-resolved (idempotent)
    expect(mockRouter.getReceivedCommands()).toHaveLength(1);   // only the first call hit intake
  });

  it('idempotent re-render: POST approve on already-approved returns resolved without calling intake', async () => {
    await createState(repoRoot, 'REQ-4', { status: 'approved' });
    const response = await postGate(portal.url, 'test-repo', 'REQ-4', 'approve', {});
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Approved');
    expect(mockRouter.getReceivedCommands()).toHaveLength(0);
  });

  it('request-changes without comment returns 422', async () => {
    await createState(repoRoot, 'REQ-5', { status: 'pending-approval' });
    const response = await postGate(portal.url, 'test-repo', 'REQ-5', 'request-changes', { comment: '' });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain('Comment is required');
    expect(mockRouter.getReceivedCommands()).toHaveLength(0);
  });

  it('intake transient failure returns 503 with serviceError', async () => {
    await createState(repoRoot, 'REQ-6', { status: 'pending-approval', cost: 10 });
    mockRouter.setBehavior('fail-transient');
    const response = await postGate(portal.url, 'test-repo', 'REQ-6', 'approve', {});
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('service-error');
  });

  it('escalation badge shown when age > 24h on pending request', async () => {
    await createState(repoRoot, 'REQ-7', { status: 'pending-approval', ageHours: 25 });
    const html = await fetch(`${portal.url}/repo/test-repo/request/REQ-7`).then(r => r.text());
    expect(html).toContain('escalation-badge');
    expect(html).toMatch(/Escalated/i);
  });
});
```

### Suite 2: Settings Mutation Flow

```typescript
describe('Settings mutation flow', () => {
  it('valid cost-cap change → config-set + daemon-reload', async () => {
    const formData = new URLSearchParams();
    formData.append('costCaps.daily', '25');
    formData.append('costCaps.monthly', '700');
    const response = await fetch(`${portal.url}/settings`, { method: 'POST', body: formData, headers: csrfHeaders });
    expect(response.status).toBe(200);
    const cmds = mockRouter.getReceivedCommands();
    expect(cmds.find(c => c.body.command === 'config-set')).toBeTruthy();
    expect(cmds.find(c => c.body.command === 'daemon-reload')).toBeTruthy();
  });

  it('invalid daily cap (zero) returns 422 with sticky values', async () => {
    const formData = new URLSearchParams();
    formData.append('costCaps.daily', '0');
    formData.append('costCaps.monthly', '300');
    const response = await fetch(`${portal.url}/settings`, { method: 'POST', body: formData, headers: csrfHeaders });
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain('value="0"');
    expect(html).toContain('field-error');
    expect(mockRouter.getReceivedCommands()).toHaveLength(0);
  });

  it('notifications-only change does NOT call daemon-reload', async () => {
    const formData = new URLSearchParams();
    formData.append('notifications.email.to', 'op@example.com');
    const response = await fetch(`${portal.url}/settings`, { method: 'POST', body: formData, headers: csrfHeaders });
    expect(response.status).toBe(200);
    const cmds = mockRouter.getReceivedCommands();
    expect(cmds.filter(c => c.body.command === 'daemon-reload')).toHaveLength(0);
    expect(cmds.filter(c => c.body.command === 'config-set')).toHaveLength(1);
  });

  it('allowlist non-git path returns 422', async () => {
    const formData = new URLSearchParams();
    formData.append('allowlist[]', repoRoot);   // exists but no .git
    const response = await fetch(`${portal.url}/settings`, { method: 'POST', body: formData, headers: csrfHeaders });
    expect(response.status).toBe(422);
    expect(await response.text()).toMatch(/not a git repository/i);
  });

  it('allowlist outside allowed-roots returns 422', async () => {
    const formData = new URLSearchParams();
    formData.append('allowlist[]', '/etc/passwd');
    const response = await fetch(`${portal.url}/settings`, { method: 'POST', body: formData, headers: csrfHeaders });
    expect(response.status).toBe(422);
  });

  it('audit log captures changedKeys but not values', async () => {
    const formData = new URLSearchParams();
    formData.append('costCaps.daily', '50');
    await fetch(`${portal.url}/settings`, { method: 'POST', body: formData, headers: csrfHeaders });
    const auditEntries = await readAuditLog();
    const last = auditEntries[auditEntries.length - 1];
    expect(last.changedKeys).toContain('costCaps.daily');
    expect(JSON.stringify(last)).not.toContain('"50"');
  });
});
```

### Suite 3: HTTP Client Retry

```typescript
describe('IntakeRouterClient retry behavior', () => {
  let mockRouter: MockIntakeRouter;
  let client: IntakeRouterClient;
  beforeEach(async () => {
    mockRouter = new MockIntakeRouter();
    await mockRouter.start();
    client = new IntakeRouterClient({ port: mockRouter.port });
  });
  afterEach(async () => { await mockRouter.stop(); });

  it('happy path: single attempt', async () => {
    const r = await client.submitCommand({ command: 'approve', requestId: 'C1', source: 'portal', sourceUserId: 'op1' });
    expect(r.success).toBe(true);
    expect(mockRouter.getReceivedCommands()).toHaveLength(1);
  });

  it('retries on 503 then succeeds (fail-then-ok)', async () => {
    mockRouter.setBehavior('fail-then-ok', 2);
    const start = Date.now();
    const r = await client.submitCommand({ command: 'approve', requestId: 'C2', source: 'portal', sourceUserId: 'op1' });
    const elapsed = Date.now() - start;
    expect(r.success).toBe(true);
    expect(mockRouter.getReceivedCommands()).toHaveLength(3);   // 2 failures + 1 success
    expect(elapsed).toBeGreaterThanOrEqual(150);   // some backoff occurred
  });

  it('exhausts 3 retries on persistent 503', async () => {
    mockRouter.setBehavior('fail-transient');
    const r = await client.submitCommand({ command: 'approve', requestId: 'C3', source: 'portal', sourceUserId: 'op1' });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('NETWORK_TRANSIENT');
    expect(mockRouter.getReceivedCommands()).toHaveLength(3);
  });

  it('does not retry 422', async () => {
    mockRouter.setBehavior('fail-permanent');
    const r = await client.submitCommand({ command: 'approve', requestId: 'C4', source: 'portal', sourceUserId: 'op1' });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('INVALID_TRANSITION');
    expect(mockRouter.getReceivedCommands()).toHaveLength(1);
  });

  it('client-side validation rejects bad source', async () => {
    const r = await client.submitCommand({ command: 'approve', requestId: 'C5', source: 'cli' as any, sourceUserId: 'op1' });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('CLIENT_VALIDATION');
    expect(mockRouter.getReceivedCommands()).toHaveLength(0);
  });

  it('healthCheck returns latency', async () => {
    const h = await client.healthCheck();
    expect(h.healthy).toBe(true);
    expect(h.latencyMs).toBeGreaterThanOrEqual(0);
    expect(h.version).toBe('1.0-mock');
  });

  it('healthCheck does not retry on failure', async () => {
    await mockRouter.stop();
    const h = await client.healthCheck();
    expect(h.healthy).toBe(false);
  });

  it('timeout aborts after 5s', async () => {
    // Replace mockRouter with one that hangs
    // Use a Bun test fixture that delays response indefinitely
    // Assert: error received within 5.5s, classified transient, retried
  }, 20_000);
});
```

### Suite 4: Modal in jsdom

```typescript
describe('GateConfirmationController', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form data-repo="test-repo" action="/repo/test-repo/request/REQ-X/gate/reject" method="post">
        <button type="submit" name="action" value="reject" data-requires-confirm="true">Reject</button>
      </form>
      ${confirmModalHTML}
    `;
  });

  it('opens modal when gate:requires-confirm dispatched', () => { /* ... */ });
  it('disables submit until typed text matches', () => { /* ... */ });
  it('cancel returns focus to originating button', () => { /* ... */ });
  it('successful confirm injects token and triggers htmx submit', () => { /* ... */ });
  it('case-sensitive matching: "reject" does not enable submit', () => { /* ... */ });
});
```

### Suite 5: Idempotent Re-render

```typescript
describe('Idempotent re-render', () => {
  it('reload after approve shows resolved panel', async () => {
    await createState(repoRoot, 'REQ-IR1', { status: 'pending-approval', cost: 10 });
    await postGate(portal.url, 'test-repo', 'REQ-IR1', 'approve', {});
    await createState(repoRoot, 'REQ-IR1', { status: 'approved' });   // Simulate intake-side commit
    const html = await fetch(`${portal.url}/repo/test-repo/request/REQ-IR1`).then(r => r.text());
    expect(html).toContain('Approved');
    expect(html).not.toContain('class="gate-approve"');
  });

  it('double-click race: second POST returns resolved without intake call', async () => {
    await createState(repoRoot, 'REQ-IR2', { status: 'approved' });
    const r = await postGate(portal.url, 'test-repo', 'REQ-IR2', 'approve', {});
    expect(r.status).toBe(200);
    expect(mockRouter.getReceivedCommands()).toHaveLength(0);
  });
});
```

## Acceptance Criteria

- [ ] `MockIntakeRouter` boots on a random port and records all `POST /router/command` bodies
- [ ] `MockIntakeRouter.setBehavior('fail-then-ok', N)` returns 503 for the first N requests then 200
- [ ] `MockIntakeRouter.reset()` clears recorded commands and resets behavior to `'ok'`
- [ ] `createState(repoRoot, requestId, overrides)` writes a syntactically valid `state.json` to `<repoRoot>/.autonomous-dev/requests/<requestId>/state.json`
- [ ] `startPortal({intakePort, repoRoot})` returns a portal URL and wires the real `IntakeRouterClient` to the mock router port
- [ ] Suite 1 has at least 7 tests covering: approve happy path, reject low-cost, reject high-cost no-token (428), reject high-cost with-token, idempotent re-render, request-changes empty comment, transient intake failure, escalation badge
- [ ] Suite 2 has at least 6 tests covering: cost-cap change → daemon-reload, invalid value 422, notifications-only no-reload, non-git path 422, outside-roots 422, audit log key-only
- [ ] Suite 3 has at least 7 tests covering: happy path, retry-then-success, retry exhaustion, 422 no-retry, client validation, healthCheck happy + failure, 5s timeout
- [ ] Suite 4 has at least 5 tests covering modal lifecycle in jsdom
- [ ] Suite 5 has at least 2 tests covering reload-after-action and double-click race
- [ ] `bun test tests/portal/` runs all suites and exits 0 on a clean repo
- [ ] `bun test tests/portal/intake-router-client.test.ts` finishes in under 20 seconds (the timeout test allows ~10s)
- [ ] CSRF token fetching is wrapped in a `fetchCsrfToken(baseUrl)` helper used by all suites
- [ ] No test reaches the real `~/.claude/autonomous-dev.json` — settings tests redirect via `userConfigPath` constructor option

## Test Cases

This spec IS test cases for the other specs. The acceptance criteria above enumerate them. The unique invariants verified by THIS spec (the test infrastructure itself) are:

1. **Mock router records bodies verbatim** — POST `{a: 1, b: 'x'}` and assert `getReceivedCommands()[0].body` deep-equals.
2. **Mock router fail-then-ok N=2** — Three sequential POSTs return [503, 503, 200].
3. **State factory ageHours=25** — `created_at` is exactly `now - 25h ± 1s`.
4. **State factory escalatedAt** — Setting `escalatedAt: '2026-04-27T10:00Z'` writes that value to the file.
5. **Portal test server isolated** — Two parallel `startPortal` calls return different URLs and do not interfere.
6. **CSRF token reusable** — `fetchCsrfToken` returns a token that subsequent POSTs accept.
7. **jsdom CustomEvent dispatch** — Dispatching `gate:requires-confirm` is observable by listeners attached after dispatch (capture phase test).

## Dependencies

- Bun's built-in test runner (`bun test`)
- Bun's `serve` for the mock router
- jsdom (already in devDependencies)
- All four sibling specs (SPEC-015-2-01 through SPEC-015-2-04) — tests verify their behavior
- Existing CSRF middleware test helpers from PLAN-014-2

## Notes

- We deliberately do NOT use Playwright or other browser drivers. HTMX's behavior is the server's response; verifying the rendered fragment HTML is sufficient. The modal flow uses jsdom because the only DOM behavior is the modal itself, not full page rendering.
- The mock intake router is intentionally minimal. We resist the urge to model its full state machine; tests assert on submitted commands and on the portal's response to canned router replies.
- `fail-then-ok` is critical for retry tests because it lets us verify both that retries happen AND that we eventually surface success when the underlying issue resolves.
- Audit log assertions read from the same on-disk path the real audit logger writes to. Tests reset the directory in `beforeEach`, so cross-test contamination is impossible.
- We assert on HTML substrings (`'class="gate-actions"'`, `'Approved by'`) rather than parsing DOM. This is brittle if templates change — but it's also the most direct way to verify the user-facing output. When templates change, tests will fail loudly and the diff will be obvious.
- The 5-second timeout test is gated by Bun test's `timeout` option (set to 20 000) to allow the AbortController to fire and one retry to complete. Total test time is bounded.
- We do NOT run these tests in parallel with other portal tests in the same Bun process because they bind real ports. Bun's test parallelism is per-file, which is sufficient — these files are mutually independent.
- `redirect via userConfigPath` is the testing-mode escape hatch for the IntakeRouterClient: passing `{ userConfigPath: '/tmp/test-userConfig.json' }` to the constructor lets tests place a fake config without touching the real one. Production code does not pass this option.
- Coverage targets: 95%+ line coverage for `intake-router-client.ts`, `confirmation-token-store.ts`, `escalation.ts`, `panel-context-builder.ts`, `form-parser.ts`, and `config-validator.ts`. Lower thresholds are acceptable for handler files where the integration tests exercise the orchestration paths.
