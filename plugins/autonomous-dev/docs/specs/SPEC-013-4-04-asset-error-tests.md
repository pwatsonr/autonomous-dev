# SPEC-013-4-04: Asset and Error Tests with Cache-Header Verification

## Metadata
- **Parent Plan**: PLAN-013-4
- **Tasks Covered**: TASK-004 (static serving tests), TASK-005 (compression tests), TASK-009 (error template tests), TASK-010 (asset hashing tests), TASK-012 (build system tests)
- **Estimated effort**: 6 hours

## Description
Implement the comprehensive test suite that proves SPEC-013-4-01, -02, and -03 meet their acceptance criteria. Cover MIME-type detection, cache-control header policies, ETag round-trips, range requests, gzip/brotli negotiation, path-traversal blocking, asset-manifest resolution, error sanitization, and HTMX fragment rendering. Performance test validates static-asset response under p95 <500ms with 100 concurrent requests. Accessibility tests validate ARIA roles and color contrast on rendered HTML fixtures.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `tests/unit/static-serving.test.ts` | Create | MIME, cache-control, ETag, 304, range, traversal |
| `tests/unit/compression.test.ts` | Create | br/gzip negotiation, threshold, allowlist |
| `tests/unit/asset-hashing.test.ts` | Create | Hash generation, manifest resolve, dev fallback |
| `tests/unit/error-templates.test.ts` | Create | 403/404/422/500/503 rendering + sanitization |
| `tests/unit/error-sanitization.test.ts` | Create | Stack-trace redaction, home-path replacement |
| `tests/integration/htmx-error-fragments.test.ts` | Create | `HX-Request` returns fragment, full page otherwise |
| `tests/integration/build-system.test.ts` | Create | `build-assets.sh` end-to-end validation |
| `tests/security/directory-traversal.test.ts` | Create | `../`, NUL byte, encoded traversal blocked |
| `tests/performance/asset-load.test.ts` | Create | 100 concurrent requests, p95 <500ms |
| `tests/accessibility/error-pages.test.ts` | Create | ARIA roles, heading hierarchy, focus order |
| `tests/fixtures/heartbeat-samples/healthy.json` | Create | Recent timestamp |
| `tests/fixtures/heartbeat-samples/stale.json` | Create | 90s old |
| `tests/fixtures/heartbeat-samples/malformed.json` | Create | Invalid JSON |

## Implementation Details

### Static Serving Tests (`tests/unit/static-serving.test.ts`)

```typescript
describe('Static Asset Serving', () => {
  test('serves CSS with text/css content-type and 24h cache for unhashed', async () => { ... });
  test('serves hashed asset with immutable + 1y cache', async () => { ... });
  test('returns ETag matching size-mtime format', async () => { ... });
  test('returns 304 when If-None-Match matches', async () => { ... });
  test('returns 200 with new ETag when If-None-Match mismatches', async () => { ... });
  test('serves 206 Partial Content for valid Range header', async () => { ... });
  test('returns 200 (not 206) for malformed Range header', async () => { ... });
  test('returns 404 for missing asset', async () => { ... });
  test('returns 404 for path containing ..', async () => { ... });
  test('sets X-Content-Type-Options: nosniff on every response', async () => { ... });
});
```

Test pattern:
```typescript
const app = new Hono();
app.use('/static/*', staticAssets({ rootDir: 'tests/fixtures/static', urlPrefix: '/static' }));
const res = await app.request('/static/sample.css');
expect(res.status).toBe(200);
expect(res.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
```

ETag round-trip:
```typescript
const first = await app.request('/static/sample.css');
const etag = first.headers.get('ETag')!;
const second = await app.request('/static/sample.css', { headers: { 'If-None-Match': etag } });
expect(second.status).toBe(304);
expect(await second.text()).toBe('');
```

### Compression Tests (`tests/unit/compression.test.ts`)

```typescript
test('prefers br when both br and gzip in Accept-Encoding', async () => {
  const res = await app.request('/static/portal.css', { headers: { 'Accept-Encoding': 'gzip, br' } });
  expect(res.headers.get('Content-Encoding')).toBe('br');
});

test('falls back to gzip when only gzip supported', async () => {
  const res = await app.request('/static/portal.css', { headers: { 'Accept-Encoding': 'gzip' } });
  expect(res.headers.get('Content-Encoding')).toBe('gzip');
});

test('does not compress assets <1KB', async () => {
  // fixture: tiny.css is 200 bytes
  const res = await app.request('/static/tiny.css', { headers: { 'Accept-Encoding': 'gzip' } });
  expect(res.headers.get('Content-Encoding')).toBeNull();
});

test('does not compress png images', async () => { ... });
test('does not compress when client sends no Accept-Encoding', async () => { ... });
test('sets Vary: Accept-Encoding when compression applied', async () => { ... });
```

### Asset Hashing Tests (`tests/unit/asset-hashing.test.ts`)

```typescript
test('hash-assets.sh produces valid manifest JSON', async () => {
  await Bun.spawn({ cmd: ['./scripts/hash-assets.sh'], cwd: TEST_DIR }).exited;
  const manifest = JSON.parse(await Bun.file('static/asset-manifest.json').text());
  expect(manifest['portal.css']).toMatch(/^portal-[a-f0-9]{8}\.css$/);
});

test('AssetManifest.resolve returns hashed name in production', () => {
  const m = new AssetManifest('tests/fixtures/manifest.json');
  expect(m.resolve('portal.css')).toBe('portal-a1b2c3d4.css');
});

test('AssetManifest.resolve falls back to logical name in development', () => {
  process.env.NODE_ENV = 'development';
  const m = new AssetManifest('nonexistent.json');
  expect(m.resolve('portal.css')).toBe('portal.css');
});

test('AssetManifest.resolve throws MissingAssetError in production for unknown name', () => {
  process.env.NODE_ENV = 'production';
  const m = new AssetManifest('tests/fixtures/manifest.json');
  expect(() => m.resolve('unknown.css')).toThrow(MissingAssetError);
});

test('manifest refresh is atomic', async () => {
  // Write a partial manifest mid-read; verify resolver never sees half-state
});
```

### Error Template Tests (`tests/unit/error-templates.test.ts`)

```typescript
test('renders 404 with NavigationSuggestions', () => {
  const html = renderToString(<ErrorPage statusCode={404} message="Page not found" requestPath="/missing"/>);
  expect(html).toContain('Error 404');
  expect(html).toContain('Portfolio Dashboard');
  expect(html).toContain('href="/"');
});

test('renders 503 with TroubleshootingSteps when daemonHealth provided', () => {
  const html = renderToString(<ErrorPage statusCode={503} message="..."
    daemonHealth={{ status: 'unreachable', message: 'Heartbeat missing' }}/>);
  expect(html).toContain('claude daemon start');
  expect(html).toContain('Heartbeat missing');
});

test('does not render ErrorDetails when details is undefined (production)', () => {
  const html = renderToString(<ErrorPage statusCode={500} message="..."/>);
  expect(html).not.toContain('Technical Details');
  expect(html).not.toContain('<details');
});

test('renders ErrorDetails when details is defined (development)', () => {
  const html = renderToString(<ErrorPage statusCode={500} message="..." details="Stack at line 42"/>);
  expect(html).toContain('Technical Details');
  expect(html).toContain('Stack at line 42');
});
```

### Error Sanitization Tests (`tests/unit/error-sanitization.test.ts`)

```typescript
test('production mode strips err.message from unknown errors', () => {
  const result = sanitizeError(new Error('DB password is hunter2'), 'production');
  expect(result.message).toBe('Internal Server Error');
  expect(result.message).not.toContain('hunter2');
  expect(result.details).toBeUndefined();
});

test('production mode preserves userMessage from known error subclasses', () => {
  class ValidationError extends Error { userMessage = 'Email is required'; }
  const result = sanitizeError(new ValidationError(), 'production');
  expect(result.message).toBe('Email is required');
});

test('development mode includes stack with home directory replaced by ~', () => {
  const err = new Error('boom');
  err.stack = 'Error: boom\n    at /Users/alice/proj/file.ts:10';
  const result = sanitizeError(err, 'development');
  expect(result.details).toContain('~/proj/file.ts');
  expect(result.details).not.toContain('/Users/alice');
});

test('development mode truncates message at 500 chars', () => { ... });
```

### HTMX Fragment Tests (`tests/integration/htmx-error-fragments.test.ts`)

```typescript
test('HX-Request: true returns ErrorDetails fragment only', async () => {
  const res = await app.request('/route-that-throws', { headers: { 'HX-Request': 'true' } });
  const html = await res.text();
  expect(html).not.toContain('<html');
  expect(html).not.toContain('<body');
  expect(html).toContain('<details');
});

test('non-HTMX request returns full ErrorPage layout', async () => {
  const res = await app.request('/route-that-throws');
  const html = await res.text();
  expect(html).toContain('<html');
  expect(html).toContain('Error 500');
});
```

### Directory Traversal Security Tests (`tests/security/directory-traversal.test.ts`)

```typescript
const ATTACK_PATHS = [
  '/static/../package.json',
  '/static/..%2Fpackage.json',           // URL-encoded
  '/static/%2e%2e/package.json',         // double-encoded
  '/static/foo/../../package.json',
  '/static/foo%00.css',                  // NUL byte injection
  '/static//etc/passwd',                 // double-slash
];

test.each(ATTACK_PATHS)('blocks traversal attempt: %s', async (attackPath) => {
  const res = await app.request(attackPath);
  expect(res.status).toBe(404);
});
```

### Performance Test (`tests/performance/asset-load.test.ts`)

```typescript
test('p95 latency <500ms with 100 concurrent requests', async () => {
  const start = performance.now();
  const reqs = Array.from({ length: 100 }, () => app.request('/static/portal.css'));
  const responses = await Promise.all(reqs);
  const elapsed = performance.now() - start;

  const latencies = responses.map((_, i) => /* per-request timing */);
  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.floor(latencies.length * 0.95)];

  expect(responses.every(r => r.status === 200)).toBe(true);
  expect(p95).toBeLessThan(500);
});
```

### Build System Test (`tests/integration/build-system.test.ts`)

```typescript
test('build:assets in production produces all expected outputs', async () => {
  const proc = Bun.spawn({ cmd: ['bun', 'run', 'build:assets'], cwd: TEST_FIXTURE });
  const code = await proc.exited;
  expect(code).toBe(0);

  expect(await Bun.file('static/htmx.min.js').exists()).toBe(true);
  expect(await Bun.file('static/portal.css').exists()).toBe(true);
  expect(await Bun.file('static/asset-manifest.json').exists()).toBe(true);

  const cssSize = (await Bun.file('static/portal.css').text()).length;
  const gzipped = Bun.gzipSync(new TextEncoder().encode(/*css*/)).byteLength;
  expect(gzipped).toBeLessThan(3072);
});
```

### Accessibility Test (`tests/accessibility/error-pages.test.ts`)

```typescript
test('error page has role=main and labelled h1', () => {
  const html = renderToString(<ErrorPage statusCode={404} message="..."/>);
  expect(html).toMatch(/role="main"\s+aria-labelledby="error-heading"/);
  expect(html).toMatch(/<h1\s+id="error-heading">/);
});

test('error message has role=alert', () => {
  const html = renderToString(<ErrorPage statusCode={500} message="..."/>);
  expect(html).toContain('class="error-message" role="alert"');
});

test('Return to Dashboard button has autofocus', () => {
  const html = renderToString(<ErrorPage statusCode={404} message="..."/>);
  expect(html).toMatch(/<a[^>]+href="\/"[^>]+autofocus/);
});
```

## Acceptance Criteria

- [ ] All test files run via `bun test` and exit 0
- [ ] `bun test tests/unit/static-serving.test.ts` covers: MIME detection, cache-control unhashed (`max-age=86400`) and hashed (`immutable, max-age=31536000`), ETag round-trip (200→304), Range request 206, traversal 404, missing 404, `nosniff` on every response
- [ ] `bun test tests/unit/compression.test.ts` covers: br preferred, gzip fallback, no compression <1KB, no compression on png/woff2, `Vary: Accept-Encoding` header
- [ ] `bun test tests/unit/asset-hashing.test.ts` covers: hash script produces valid manifest, production resolve returns hashed name, dev resolve falls back, missing name throws `MissingAssetError`, atomic refresh
- [ ] `bun test tests/unit/error-templates.test.ts` covers all five status codes (403/404/422/500/503) rendering correct titles and icons
- [ ] `bun test tests/unit/error-sanitization.test.ts` proves production mode never leaks `err.message`/`err.stack`/home paths and dev mode replaces home dir with `~`
- [ ] `bun test tests/integration/htmx-error-fragments.test.ts` proves `HX-Request: true` returns fragment-only HTML and absent header returns full layout
- [ ] `bun test tests/security/directory-traversal.test.ts` blocks all 6 listed attack vectors with 404
- [ ] `bun test tests/performance/asset-load.test.ts` measures p95 <500ms across 100 concurrent CSS requests
- [ ] `bun test tests/integration/build-system.test.ts` runs `build-assets.sh` and verifies all expected outputs (htmx, css ≤3KB gzipped, manifest)
- [ ] `bun test tests/accessibility/error-pages.test.ts` verifies `role="main"`, `aria-labelledby`, `role="alert"`, and `autofocus` on action button
- [ ] Combined coverage report shows ≥90% line coverage for `server/middleware/static-assets.ts`, `server/middleware/compression.ts`, `server/lib/error-context.ts`, `server/templates/pages/error.tsx`
- [ ] No test depends on network access (all builds use vendored fixtures)

## Dependencies

- **Upstream**: SPEC-013-4-01, SPEC-013-4-02, SPEC-013-4-03 (units under test must exist)
- **Test runtime**: Bun's built-in test runner (`bun test`); no jest/vitest
- **Fixtures**: `tests/fixtures/static/sample.css`, `tests/fixtures/static/tiny.css` (<1KB), `tests/fixtures/static/portal-a1b2c3d4.css`, `tests/fixtures/heartbeat-samples/*`
- **External tools**: `shasum`, `gzip` (system binaries), `Bun.gzipSync` for in-test compression
- **No CI dependencies introduced** — tests are runnable on any developer workstation with Bun installed

## Notes

- Performance test runs in-process against the Hono app, NOT a real HTTP server. This eliminates kernel/network noise and produces stable p95 measurements. Production performance is validated separately by k6/load tests outside this spec's scope.
- Directory traversal test cases come from OWASP path-traversal cheat sheet plus URL-encoding variants the team has seen in real attacks. Adding new variants is encouraged when discovered.
- Error sanitization tests are the most security-critical; they MUST run in CI on every PR. Failing these blocks merge.
- Atomic manifest refresh test simulates a partial write by holding a lock on `asset-manifest.json` mid-read and asserting the resolver returns the previous valid state, never a half-loaded one.
- Accessibility tests validate STRUCTURE (roles, attributes, IDs) rather than visual rendering. Visual contrast/keyboard testing is performed manually via the axe-core scripts referenced in PLAN-013-4 TASK-002, not automated here.
- Coverage threshold (90%) excludes templates that are pure JSX with no branching. Branching logic in `error-context.ts` and `static-assets.ts` requires near-100%.
