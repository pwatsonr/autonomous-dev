# SPEC-015-1-05: File Watcher, SSE, and Accessor Test Suite

## Metadata
- **Parent Plan**: PLAN-015-1
- **Tasks Covered**: Task 14 (file-watcher tests), Task 15 (SSE backpressure tests), Task 16 (accessor validation tests), Task 17 (cross-platform behavior)
- **Estimated effort**: 8 hours

## Description
Comprehensive test coverage for the live data substrate: file-watcher debouncing and polling-fallback under fd pressure, SSE event-bus broadcast semantics including per-client backpressure handling, read-only data accessor schema validation against fixture state files, and cross-platform behavior verification (FSEvents on macOS vs inotify on Linux). Tests use Bun's built-in test runner with deterministic fixtures and mocked timers.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `tests/unit/file-watcher.test.ts` | Create | Watch + polling-fallback + debounce |
| `tests/unit/sse-event-bus.test.ts` | Create | Broadcast + backpressure + heartbeat |
| `tests/unit/state-accessor.test.ts` | Create | state.json reader + schema validation |
| `tests/unit/cost-heartbeat-log-accessor.test.ts` | Create | cost-ledger / heartbeat / log accessors |
| `tests/integration/live-data-flow.test.ts` | Create | End-to-end: file change → SSE delivery |
| `tests/fixtures/state/v1.1-feature-active.json` | Create | Sample state for happy-path accessor tests |
| `tests/fixtures/state/v1.1-bug-completed.json` | Create | Sample state for completed-request tests |
| `tests/fixtures/state/v1.1-corrupt-fields.json` | Create | Type-violation fixture for negative tests |

## Implementation Details

### File Watcher Tests

```typescript
// tests/unit/file-watcher.test.ts
test('debounce: rapid changes coalesce to one event after 200ms quiet', async () => {
  const onChange = mock(() => {});
  const watcher = new FileWatcher(path, onChange, { debounceMs: 200 });
  watcher.start();
  await Bun.write(path, 'a');
  await Bun.write(path, 'b');
  await Bun.write(path, 'c');
  await sleep(50);
  expect(onChange).not.toHaveBeenCalled();
  await sleep(200);
  expect(onChange).toHaveBeenCalledTimes(1);
});

test('polling fallback: triggered when fs.watch errors with EMFILE', async () => {
  // Mock fs.watch to throw EMFILE
  const watcher = new FileWatcher(path, onChange, { pollIntervalMs: 1000 });
  watcher.start();
  expect(watcher.mode).toBe('polling');
});

test('polling fallback: detects mtime change', async () => { /* ... */ });
test('switch back to native: when fd pressure resolves', async () => { /* ... */ });
test('multiple files: independent debounce per path', async () => { /* ... */ });
test('cleanup on stop: no listeners leaked', async () => { /* ... */ });
```

### SSE Event Bus Tests

```typescript
test('broadcast: all subscribed clients receive event', () => {
  const bus = new SseEventBus();
  const c1 = createMockClient();
  const c2 = createMockClient();
  bus.subscribe(c1);
  bus.subscribe(c2);
  bus.broadcast({ type: 'test', data: 1 });
  expect(c1.write).toHaveBeenCalledWith(expect.stringContaining('"type":"test"'));
  expect(c2.write).toHaveBeenCalledWith(expect.stringContaining('"type":"test"'));
});

test('backpressure: slow client gets disconnected after queue cap', async () => {
  const slowClient = createMockClient({ writeDelayMs: 1000 });
  bus.subscribe(slowClient);
  for (let i = 0; i < 200; i++) bus.broadcast({ type: 't', data: i });
  await sleep(50);
  expect(slowClient.disconnect).toHaveBeenCalled();
});

test('heartbeat: sends comment every 30s', async () => { /* mocked timer */ });
test('subscribe + unsubscribe: client count tracked correctly', () => { /* ... */ });
test('fast client unaffected by slow client backpressure', () => { /* ... */ });
```

### Accessor Tests

```typescript
test('state accessor: returns parsed state for valid v1.1 file', async () => {
  const state = await readState(fixturePath('v1.1-feature-active.json'));
  expect(state.id).toBe('REQ-000123');
  expect(state.request_type).toBe('feature');
});

test('state accessor: rejects v1.0 schema with migration hint', async () => {
  await expect(readState(fixturePath('v1.0.json'))).rejects.toThrow(/migration required/i);
});

test('state accessor: rejects type-violating fields', async () => { /* ... */ });
test('cost accessor: aggregates per-request totals', async () => { /* ... */ });
test('heartbeat accessor: returns parsed timestamp + age', async () => { /* ... */ });
test('log accessor: redacts secret patterns (Anthropic, Discord, Slack tokens)', async () => { /* ... */ });
test('log accessor: returns last N lines from ring buffer', async () => { /* ... */ });
```

### Integration Test

```typescript
test('live data flow: state.json change → SSE broadcast → client receives', async () => {
  const portal = await startTestPortal();
  const events: any[] = [];
  const sse = new EventSource(`${portal.url}/api/sse`);
  sse.addEventListener('state-changed', (e) => events.push(JSON.parse(e.data)));
  await Bun.write(statePath, JSON.stringify({ ...baseState, status: 'tdd_review' }));
  await waitFor(() => events.length === 1);
  expect(events[0].status).toBe('tdd_review');
  sse.close();
});
```

### Cross-Platform Behavior

```typescript
test('macOS FSEvents: directory-level events still trigger file-level callbacks', async () => {
  if (process.platform !== 'darwin') return test.skip();
  // ...
});

test('Linux inotify: respects fs.inotify.max_user_watches limit', async () => {
  if (process.platform !== 'linux') return test.skip();
  // ...
});
```

## Acceptance Criteria

- [ ] File watcher: 6+ test cases covering debounce, fallback, multi-file, cleanup
- [ ] SSE event bus: 5+ cases covering broadcast, backpressure, heartbeat
- [ ] State accessor: 3+ cases covering valid, version-mismatch, type-violation
- [ ] Cost/heartbeat/log accessors: 4+ cases including secret redaction
- [ ] Integration test: end-to-end file change → SSE delivery verified
- [ ] Cross-platform suite skips gracefully on non-target platforms
- [ ] All tests deterministic (mocked timers, temp dirs via `mkdtempSync`)
- [ ] Coverage ≥90% on file-watcher, sse-event-bus, accessor modules
- [ ] Total wall-clock <30s on CI

## Dependencies

- **SPEC-015-1-01..04**: implementations under test
- Bun test runner (built-in)
- `EventSource` polyfill or native (Bun supports natively)

## Notes

- The 200ms debounce is the most operator-visible knob; tests pin it explicitly to prevent regression.
- Backpressure test uses 200 events to deliberately exceed any reasonable client queue cap.
- Secret-redaction test uses synthetic but realistic-shaped tokens (e.g., `xoxb-1234567890-abcdef`) to verify pattern matching without leaking real secrets.
- Fixture state files match the schema from PLAN-018-1 (request types) — keeps SPEC-015 forward-compatible with PLAN-018 implementation.
