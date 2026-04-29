# SPEC-014-2-05: Security Tests (CSRF Bypass + XSS Payloads + CSP Violation Reporting)

## Metadata
- **Parent Plan**: PLAN-014-2
- **Tasks Covered**: TASK-013 (XSS Attack Vector Testing), TASK-014 (CSRF Rejection Testing), TASK-015 (CSP Violation Testing), TASK-016 (Security Integration Testing)
- **Estimated effort**: 19 hours

## Description
Build the comprehensive security test suite that validates the implementations from SPEC-014-2-01 through SPEC-014-2-04. The suite covers 50+ XSS payload scenarios (OWASP Top 10, mutation XSS, encoding bypasses), CSRF bypass attempts (missing token, replay, mismatched session, timing attacks), CSP enforcement (inline script blocking, eval blocking, frame-ancestors), and end-to-end multi-layer attack scenarios. All tests run in CI and gate merge. Performance tests verify the NFR ceilings (100ms sanitization for 10KB; <0.1% false-positive CSRF rejection).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `tests/security/xss-payload-tests.spec.ts` | Create | 8 describe blocks × 50+ payloads — covers script tags, event handlers, JS URLs, SVG, CSS, encoding bypasses, OWASP filter evasion, markdown-specific |
| `tests/security/xss-payloads.json` | Create | Externalized payload corpus, versioned and citable in advisories |
| `tests/security/csrf-attack-tests.spec.ts` | Create | Origin/Referer mismatches, missing tokens, replay, timing analysis, double-submit verification |
| `tests/security/csrf-scenarios.ts` | Create | Reusable scenario builders (forge request from another origin, etc.) |
| `tests/security/csp-enforcement-tests.spec.ts` | Create | Verifies CSP header presence, nonce uniqueness, violation report flow |
| `tests/security/csp-violation-scenarios.ts` | Create | Templates for violation reports the endpoint must accept/reject |
| `tests/security/secure-diff-tests.spec.ts` | Create | Diff renderer XSS resistance |
| `tests/security/security-regression.spec.ts` | Create | Historical CVE-driven regression cases |
| `tests/integration/security-integration.spec.ts` | Create | End-to-end multi-layer attack chains via supertest |
| `tests/integration/attack-scenarios.ts` | Create | Reusable multi-step attack flows (login → forge CSRF → XSS injection → confirm bypass) |
| `tests/helpers/attack-vectors.ts` | Create | Pure helpers: payload loader, request forgery utilities |
| `tests/helpers/attack-simulation.ts` | Create | Test client with cookie jars, session manipulation, header injection |
| `tests/helpers/security-test-helpers.ts` | Create | App fixture, route registration, in-memory session store for tests |
| `tests/helpers/browser-automation.ts` | Create | Playwright wrappers for CSP browser verification |
| `package.json` | Modify | Add scripts: `test:security`, `test:xss`, `test:regression`, `test:performance` (security subset) |

## Implementation Details

### XSS Payload Tests (`xss-payload-tests.spec.ts`)

Use Jest `test.each` with payloads loaded from `xss-payloads.json`. Each describe block targets one attack class. Minimum coverage:

| Class | Min Payloads | Examples |
|-------|--------------|----------|
| Script Tag Variants | 9 | `<script>`, case variants, broken tags, whitespace tricks (`<script\x20`, `<script\x09`) |
| Event Handlers | 12 | `onerror`, `onload`, `onmouseover`, autofocus tricks, formaction, meta-refresh |
| JS URL Schemes | 8 | `javascript:`, `vbscript:`, `data:text/html`, both link and image markdown forms |
| SVG-based | 8 | `<svg onload>`, `<svg><script>`, foreignObject, animate/set with onbegin |
| CSS-based | 9 | `<style>` with `url(javascript:)`, expression(), behavior, @import, list-style-image |
| Encoding Bypasses | 7 | HTML entities, hex entities, double-encoded, Unicode escapes, percent-encoded, fromCharCode |
| Data URI | 5 | `data:text/html`, `data:application/javascript`, `data:image/svg+xml` with onload |
| OWASP Filter Evasion | 20 | Full OWASP cheat sheet sample (case mixing, quote variants, null byte, HTML mangling) |
| Markdown-specific | 14 | `[link](javascript:)`, `![img](x onerror=)`, table XSS, blockquote XSS, footnote, code block tricks |
| Mutation XSS (mXSS) | 6 | `<noscript><p title="</noscript><script>alert(1)//">`, namespace confusion |

**Test pattern**:
```typescript
import payloads from './xss-payloads.json';

describe('XSS - Script Tag Variants', () => {
  let sanitizer: MarkdownSanitizationPipeline;
  beforeEach(() => {
    sanitizer = createSanitizationPipeline({ enableCaching: false });
  });

  test.each(payloads.scriptTagAttacks)('blocks: %s', async (payload) => {
    const result = await sanitizer.sanitizeMarkdown(payload);
    expect(result.sanitized).not.toMatch(/<script\b/i);
    expect(result.sanitized).not.toContain('alert(');
    expect(result.sanitized).not.toContain('javascript:');
    expect(validateSafeContent(result)).toBe(false);  // payload is unsafe input
  });
});
```

**False-positive coverage** (15 legitimate-content cases that MUST PASS):
- Plain headers, paragraphs, links to https URLs
- Code fences containing the LITERAL word "script" (must render, not block)
- Documentation prose mentioning "javascript", "onclick", "onerror" as words
- Tables with normal content
- Email addresses, plain URLs

**Performance tests**:
- 10KB sanitization completes in < 100ms (averaged over 10 runs)
- 50KB long-input plus payload completes in < 500ms
- 1000-deep nested HTML does NOT stack-overflow
- ReDoS pattern inputs complete in < 1s each

### CSRF Attack Tests (`csrf-attack-tests.spec.ts`)

Build an Express app fixture in `security-test-helpers.ts` with the full security middleware stack and a single `POST /protected` route returning 200. Use `supertest` to issue requests.

**Cases**:

```typescript
describe('CSRF - Missing Credentials', () => {
  test('missing token AND signature returns 403', async () => {
    const r = await request(app).post('/protected').send({ data: 'x' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('CSRF_TOKEN_INVALID');
  });
  test('missing token only returns 403', async () => { /* ... */ });
  test('missing signature only returns 403', async () => { /* ... */ });
});

describe('CSRF - Origin/Referer Validation', () => {
  test('Origin from disallowed host returns 403', async () => { /* ... */ });
  test('Referer fallback when Origin missing', async () => { /* ... */ });
  test('Both missing on POST returns 403', async () => { /* ... */ });
  test('Wildcard origin in production rejected', async () => { /* ... */ });
});

describe('CSRF - Token Lifecycle', () => {
  test('valid token + signature + matching session passes', async () => { /* ... */ });
  test('token from different session rejected', async () => { /* ... */ });
  test('expired token (>24h) rejected and cleaned up', async () => {
    jest.useFakeTimers();
    const { token, signature } = service.generateTokenForSession('s1');
    jest.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    expect(service.validateToken(token, signature, 's1')).toBe(false);
    expect(service['tokenStore'].has(token)).toBe(false);
  });
  test('token modified by even one byte rejected', async () => { /* ... */ });
  test('signature modified by even one byte rejected', async () => { /* ... */ });
});

describe('CSRF - Timing Attack Resistance', () => {
  test('comparison time independent of mismatch position', async () => {
    // Statistical: 100 iterations, measure validateToken with sigs differing at byte 0 vs byte 31
    const times0 = [];
    const times31 = [];
    for (let i = 0; i < 100; i++) {
      const { token, signature } = service.generateTokenForSession('s');
      const fakeEarly = '00' + signature.slice(2);
      const fakeLate = signature.slice(0, -2) + '00';
      times0.push(measure(() => service.validateToken(token, fakeEarly, 's')));
      times31.push(measure(() => service.validateToken(token, fakeLate, 's')));
    }
    const meanDiff = Math.abs(mean(times0) - mean(times31));
    const stdDev = Math.max(stddev(times0), stddev(times31));
    // Diff should be within 2 sigma — timing-safe equality should not leak position
    expect(meanDiff).toBeLessThan(2 * stdDev);
  });
});

describe('CSRF - HTMX vs Browser Response', () => {
  test('HX-Request header gets JSON 403', async () => {
    const r = await request(app).post('/protected').set('HX-Request', 'true');
    expect(r.status).toBe(403);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(r.body.code).toBe('SECURITY_VIOLATION');
  });
  test('regular browser gets HTML error page', async () => {
    const r = await request(app).post('/protected').set('Accept', 'text/html');
    expect(r.status).toBe(403);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.text).toContain('Security Error');
  });
});

describe('CSRF - Replay Resistance for Confirmation Tokens', () => {
  test('confirmation token cannot be replayed after use', async () => {
    // From SPEC-014-2-02 — included here for cross-spec coverage
    const t = await requestConfirmation('kill-switch');
    await validateConfirmation(t.token, 'EMERGENCY STOP'); // 200
    const replay = await validateConfirmation(t.token, 'EMERGENCY STOP'); // 400
    expect(replay.body.error).toBe('invalid-or-expired-token');
  });
});
```

### CSP Enforcement Tests (`csp-enforcement-tests.spec.ts`)

**Header verification** (no browser needed):
```typescript
test('production CSP header contains expected directives', async () => {
  process.env.NODE_ENV = 'production';
  const r = await request(app).get('/');
  const csp = r.headers['content-security-policy'];
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self' 'nonce-");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("base-uri 'self'");
  expect(csp).not.toContain("'unsafe-inline'");  // not in script-src
  expect(csp).not.toContain("'unsafe-eval'");
});

test('development uses Report-Only header', async () => {
  process.env.NODE_ENV = 'development';
  const r = await request(app).get('/');
  expect(r.headers['content-security-policy-report-only']).toBeDefined();
  expect(r.headers['content-security-policy']).toBeUndefined();
});

test('nonce differs between requests', async () => {
  const r1 = await request(app).get('/');
  const r2 = await request(app).get('/');
  const n1 = extractNonce(r1.headers['content-security-policy']);
  const n2 = extractNonce(r2.headers['content-security-policy']);
  expect(n1).not.toBe(n2);
  expect(n1).toMatch(/^[A-Za-z0-9+/=]{20,}$/);
});
```

**Violation report endpoint**:
```typescript
test('accepts valid CSP report and returns 204', async () => {
  const r = await request(app)
    .post('/csp-violation-report')
    .set('Content-Type', 'application/csp-report')
    .send({ 'csp-report': { 'document-uri': 'https://x', 'violated-directive': 'script-src' } });
  expect(r.status).toBe(204);
});

test('malformed report returns 400', async () => {
  const r = await request(app)
    .post('/csp-violation-report')
    .send({ totally: 'wrong' });
  expect(r.status).toBe(400);
});

test('rate limit triggers at 100 reports per minute', async () => {
  for (let i = 0; i < 100; i++) await postValidReport();
  const r = await postValidReport();
  expect(r.status).toBe(429);
});

test('no CSRF token required for report endpoint', async () => {
  // No cookies, no token, no session — should still be 204
  const r = await request(app).post('/csp-violation-report').send(validReport);
  expect(r.status).toBe(204);
});
```

**Browser-based CSP enforcement** (Playwright, in `browser-automation.ts`):
- Render a page that attempts inline `<script>alert(1)</script>` without nonce → assert violation report received
- Render a page that loads an external script from disallowed origin → assert blocked
- Attempt `eval('1+1')` from page JS → assert SecurityError thrown
- Try to embed page in `<iframe>` → assert blocked by `frame-ancestors 'none'`

### Security Integration Tests (`security-integration.spec.ts`)

End-to-end attack chains:

1. **CSRF → XSS combo**: Forge a CSRF-bypass attempt that smuggles XSS payload in body. Verify both layers reject it independently.
2. **Confirmation bypass attempt**: Try to call destructive endpoint without confirmation token. Verify 403 + log entry.
3. **Token replay across sessions**: Generate confirmation token for session A, attempt to use from session B. Verify rejection.
4. **CSP + sanitization combo**: User input contains `<script>` → sanitizer strips it → even if it slipped through, CSP would block. Test sanitizer step in isolation.
5. **Rate limit cascade**: Spam confirmation requests → first 3 succeed, 4th returns 429. Spam CSP reports → first 100 succeed, 101st returns 429.
6. **Recovery after attack**: Trigger 50 CSRF rejections. Verify legitimate requests still pass (no DoS-by-attack-volume).

### Test Helpers

`security-test-helpers.ts`:
- `buildSecuredApp(overrides?: Partial<SecurityConfig>) -> Express` — returns an app with full security stack mounted, `/protected` POST route, in-memory session store. Used by all integration specs.
- `mintValidCSRF(app, sessionId)` — gets cookies + token by hitting a test login endpoint; returns headers/cookies usable in subsequent requests.

`attack-vectors.ts`:
- `loadXssPayloads(): {[category: string]: string[]}` — JSON loader.
- `forgeRequest(target: string, method: string, opts: {origin?, referer?, cookies?, body?})` — supertest builder for cross-origin simulation.

`browser-automation.ts`:
- `withBrowser(callback: (page: Page) => Promise<void>)` — Playwright fixture that boots app + headless Chromium, captures CSP violations via `page.on('console')` and the `/csp-violation-report` endpoint.

## Acceptance Criteria

- [ ] `tests/security/xss-payloads.json` contains ≥ 50 distinct payloads across at least 8 categories
- [ ] All XSS payload tests pass — sanitizer blocks every payload
- [ ] All 15 legitimate-content false-positive tests pass — sanitizer permits safe markdown
- [ ] XSS performance NFR met: 10KB sanitizes in < 100ms (averaged 10 runs)
- [ ] XSS performance NFR met: deeply nested HTML (1000 levels) does not stack-overflow
- [ ] XSS performance NFR met: ReDoS pattern inputs each complete in < 1s
- [ ] CSRF tests cover: missing token, missing signature, missing both, mismatched session, expired token, modified token, modified signature
- [ ] CSRF Origin/Referer tests cover: disallowed Origin, missing Origin with valid Referer, both missing, wildcard rejected in production
- [ ] CSRF timing-safety test passes: mean timing difference between mismatched-position signatures is within 2 standard deviations of intra-group variation
- [ ] CSRF HTMX response test passes: HX-Request header → JSON 403; without → HTML error page
- [ ] CSP header test verifies all production directives present, no `unsafe-inline` in script-src, no `unsafe-eval`
- [ ] CSP nonce uniqueness test passes: 10 successive requests yield 10 distinct nonces
- [ ] CSP report endpoint test: accepts valid reports (204), rejects malformed (400), rate limits at 100/min (429)
- [ ] CSP report endpoint test: accessible without CSRF token
- [ ] Browser-based Playwright test: inline script without nonce blocked + violation report received
- [ ] Browser-based Playwright test: external script from disallowed origin blocked
- [ ] Browser-based Playwright test: `eval()` blocked
- [ ] Browser-based Playwright test: iframe embedding blocked by `frame-ancestors 'none'`
- [ ] Confirmation token replay test: token cannot be re-used after successful validation
- [ ] Confirmation token cross-session test: token from session A rejected when presented by session B
- [ ] Integration test: CSRF + XSS smuggling chain rejected by both layers independently
- [ ] Integration test: 50 CSRF rejections do not break legitimate requests (no DoS-by-attack)
- [ ] All tests run in CI; failure blocks merge
- [ ] `npm run test:security` exits 0 with all suites green
- [ ] Test coverage report shows ≥ 95% line coverage on `src/portal/security/**`

## Dependencies

- **Inbound**: SPEC-014-2-01, SPEC-014-2-02, SPEC-014-2-03, SPEC-014-2-04 (the implementations under test).
- **Libraries**: `jest@~29.x`, `supertest@~6.x`, `@playwright/test@~1.40.x`, `jest-extended` (for matchers).
- **Existing modules**: Logger from PLAN-002 ecosystem (mocked in tests); session middleware from PLAN-014-1.
- **CI**: GitHub Actions workflow `security-tests.yml` runs the suite on every PR; coverage report uploaded as artifact.

## Notes

- **Why externalize payloads to JSON?** So security researchers can review and contribute without touching test code. CVE-driven additions go through a single PR to the JSON file.
- **Timing test reliability**: CI environments are noisy. The 2-sigma threshold is forgiving. If flake rate exceeds 1%, increase iteration count to 500 (longer test, more stable signal).
- **Browser tests are the slowest**: Run them in a separate CI job (`security-browser-tests.yml`) with caching of Playwright browsers. Total budget: 5 minutes.
- **False-positive prevention**: Critical to test BOTH that bad content is blocked AND good content passes. A sanitizer that returns empty string for everything is "safe" but useless.
- **Why not fuzz?** Fuzzing is a separate effort (security-research scope, out-of-band). The 50+ curated payloads are the regression suite — known-bad cases that must always be caught.
- **Adding payloads**: Process documented in `tests/security/CONTRIBUTING.md` (out of scope for this spec but referenced). New payloads require a CVE/advisory link.
- **Test environment isolation**: All tests run with `NODE_ENV=test` and a separate in-memory session store. No real network calls. Playwright browser is sandboxed.
- **Security scanner exemptions**: The OWASP payloads in `xss-payloads.json` will trigger most network IDS. Document for ops: GitHub Actions runners exempt this repo path; local devs may see WAF alerts running these tests.
- **Future**: Schedule monthly review of OWASP cheat sheet for new payload categories. Subscribe to https://github.com/cure53/H5SC for new mXSS vectors.
