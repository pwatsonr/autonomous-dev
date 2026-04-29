# SPEC-014-2-01: CSRF Protection (Origin Header + Per-Session Token)

## Metadata
- **Parent Plan**: PLAN-014-2
- **Tasks Covered**: TASK-001 (CSRF Token Infrastructure), TASK-002 (Origin Header Validation), TASK-003 (CSRF Middleware Integration), TASK-004 (HTMX CSRF Integration)
- **Estimated effort**: 12 hours

## Description
Implement defense-in-depth CSRF protection for the autonomous-dev portal combining Origin/Referer header validation, double-submit cookie pattern, and per-session signed tokens. Validation runs as Express middleware on every state-changing method (POST/PUT/DELETE/PATCH). Tokens are HMAC-signed with a server secret, stored in-memory with 24h TTL, and compared in timing-safe fashion. HTMX requests receive `X-CSRF-Token` headers automatically via injected client script; non-HTMX requests get the token via hidden form field. Two failure modes: CSRF rejection returns JSON 403 for HTMX, rendered error page for browsers.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/portal/security/types.ts` | Create | Shared interfaces (`CSRFConfig`, `CSRFToken`, `OriginValidationResult`) and Express request augmentation |
| `src/portal/security/crypto-utils.ts` | Create | `randomToken(bytes)`, `hmacSign(secret, payload)`, `timingSafeCompare(a, b)` |
| `src/portal/security/csrf-protection.ts` | Create | `CSRFProtection` class with `generateTokenForSession`, `validateToken`, `invalidateToken`, `cleanupExpiredTokens`, `middleware()` |
| `src/portal/security/origin-validation.ts` | Create | `OriginValidator` class with `validateRequest(req)` returning `{valid, reason}`; LRU cache for parsed origins |
| `src/portal/config/security-config.ts` | Create | Centralized security config loader with env-var overrides and Zod schema validation |
| `src/portal/middleware/csrf-middleware.ts` | Create | Express middleware wiring CSRF + Origin validators with HTMX-aware error responses |
| `src/portal/middleware/security-middleware.ts` | Create | Composite security middleware stack registration helper |
| `src/portal/routes/middleware-registration.ts` | Create | `registerSecurityMiddleware(app, config)` that mounts middleware in correct order |
| `src/portal/public/js/csrf-integration.js` | Create | Client-side HTMX hook injecting `X-CSRF-Token` and refreshing on 403 |
| `src/portal/views/layouts/base.hbs` | Modify | Add `<meta name="csrf-token">` and load `csrf-integration.js` |
| `src/portal/helpers/csrf-helpers.ts` | Create | Handlebars helpers `{{csrfToken}}` and `{{csrfMetaTag}}` for templates |

## Implementation Details

### Token Infrastructure (TASK-001)

`CSRFConfig` interface:
- `tokenTTL: number` — milliseconds, default `24 * 60 * 60 * 1000` (24h)
- `cookieName: string` — default `__csrf_signature`
- `headerName: string` — default `X-CSRF-Token`
- `excludePaths: string[]` — default `['/api/public', '/health', '/metrics', '/csp-violation-report']`
- `secretKey: string` — required, MUST throw at startup if `=== 'change-me-in-production'` and `NODE_ENV === 'production'`
- `maxTokensInMemory: number` — default `10_000` (LRU eviction beyond this)

`CSRFProtection.generateTokenForSession(sessionId: string) -> {token, signature}`:
1. Generate `token = crypto.randomBytes(32).toString('hex')` (64 hex chars)
2. Compute `signature = HMAC-SHA256(secretKey, token + ':' + sessionId).toString('hex')`
3. Store `{value: token, createdAt: Date.now(), sessionId}` in `Map<token, CSRFToken>`
4. If store size exceeds `maxTokensInMemory`, evict oldest 10% by `createdAt`
5. Return `{token, signature}`

`CSRFProtection.validateToken(token, signature, sessionId) -> boolean`:
1. Look up `storedToken = tokenStore.get(token)`. Return `false` if missing.
2. Return `false` if `storedToken.sessionId !== sessionId`.
3. Return `false` if `Date.now() - storedToken.createdAt > tokenTTL`. Also delete from store.
4. Compute `expectedSignature = HMAC-SHA256(secretKey, token + ':' + sessionId)`.
5. Return `false` if `signature.length !== expectedSignature.length`.
6. Return result of `crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'))`.

Cleanup runs every 5 minutes via `setInterval` deleting all entries older than `tokenTTL`.

### Origin Validation (TASK-002)

`OriginValidator.validateRequest(req) -> {valid: boolean, reason?: string}`:
1. Skip non-state-changing methods (GET, HEAD, OPTIONS) — return `{valid: true}`.
2. Read `origin = req.headers.origin`. If absent, fall back to `req.headers.referer`.
3. If both absent and method is state-changing, return `{valid: false, reason: 'missing-origin-and-referer'}`.
4. Parse the URL. If invalid URL, return `{valid: false, reason: 'malformed-origin'}`.
5. Normalize to `${protocol}//${hostname}${port !== defaultForProto ? ':' + port : ''}`.
6. Match against `config.allowedOrigins: string[]`:
   - Exact match: pass
   - Wildcard match `*.example.com` allowed only when `NODE_ENV !== 'production'`
   - In production wildcards REJECTED — log warning, return `{valid: false, reason: 'wildcard-rejected-in-production'}`
7. Cache normalized origin in LRU (max 256 entries, 5-minute TTL) keyed by raw header value.

Default `allowedOrigins`:
- Production: read from `PORTAL_ALLOWED_ORIGINS` env var (comma-separated)
- Development: `['http://localhost:3000', 'http://127.0.0.1:3000']`

### CSRF Middleware (TASK-003)

`csrfMiddleware(config) -> RequestHandler`:
1. If method ∈ `{GET, HEAD, OPTIONS}`: call `next()`.
2. If `config.excludePaths.some(p => req.path.startsWith(p))`: call `next()`.
3. Run `originValidator.validateRequest(req)`. If invalid: call `sendCSRFError(req, res, reason)`, return.
4. If `!req.session?.id`: call `sendCSRFError(req, res, 'no-valid-session')`, return.
5. Extract token: priority order `req.headers[headerName.toLowerCase()]`, then `req.body?._csrf`, then `req.query._csrf`.
6. Extract signature: `req.cookies?.[cookieName]`.
7. If either missing: call `sendCSRFError(req, res, 'missing-token-or-signature')`, return.
8. If `!csrfProtection.validateToken(token, signature, req.session.id)`: call `sendCSRFError(req, res, 'invalid-csrf-token')`, return.
9. Set `req.csrfToken = token; req.isCSRFValid = true;` and call `next()`.

`sendCSRFError(req, res, reason)`:
1. Log to security logger: `{event: 'csrf_violation', reason, method, path, ip, sessionId}`.
2. Detect HTMX: `isHTMX = req.headers['hx-request'] === 'true' || req.headers['x-requested-with'] === 'XMLHttpRequest'`.
3. If HTMX: `res.status(403).json({error: 'CSRF_TOKEN_INVALID', message: 'Security token validation failed. Please refresh the page.', code: 'SECURITY_VIOLATION'})`.
4. Else: `res.status(403).render('errors/security-error', {title: 'Security Error', message: 'Your request could not be processed due to a security check failure. Please refresh the page and try again.', errorCode: 'CSRF_INVALID'})`.

`setCSRFCookie(res, signature, config)` — helper to set the double-submit cookie:
- `httpOnly: true`
- `secure: process.env.NODE_ENV === 'production'`
- `sameSite: 'strict'`
- `maxAge: config.tokenTTL`
- `path: '/'`

### HTMX Integration (TASK-004)

`csrf-integration.js` (client-side, ≤2KB minified):
```javascript
(function() {
  function getCsrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : null;
  }
  document.body.addEventListener('htmx:configRequest', function(evt) {
    var token = getCsrfToken();
    if (token) evt.detail.headers['X-CSRF-Token'] = token;
  });
  document.body.addEventListener('htmx:responseError', function(evt) {
    if (evt.detail.xhr.status === 403) {
      try {
        var body = JSON.parse(evt.detail.xhr.responseText);
        if (body.error === 'CSRF_TOKEN_INVALID') window.location.reload();
      } catch (e) {}
    }
  });
})();
```

`base.hbs` additions (top of `<head>`):
```handlebars
<meta name="csrf-token" content="{{csrfToken}}">
<script src="/js/csrf-integration.js" defer></script>
```

`csrfHelpers.register(handlebars)`:
- `{{csrfToken}}` — emits the current request's signed token (assumes middleware set `res.locals.csrfToken`)
- `{{csrfMetaTag}}` — emits the full meta tag
- `{{csrfHiddenInput}}` — emits `<input type="hidden" name="_csrf" value="...">` for non-HTMX forms

`registerSecurityMiddleware(app, config)` registers in this order:
1. `cookieParser()` (must precede CSRF for cookie reading)
2. `securityHeaders` (SPEC-014-2-04)
3. `cspMiddleware` (SPEC-014-2-04)
4. `originValidator + csrfMiddleware` (this spec)
5. Token refresh middleware: on every authenticated GET, call `csrfProtection.generateTokenForSession(req.session.id)` and set `res.locals.csrfToken = token` plus `setCSRFCookie(res, signature, config)`.

## Acceptance Criteria

- [ ] `crypto.randomBytes(32)` used for token generation; tokens are 64 hex chars
- [ ] `crypto.timingSafeEqual` used for signature comparison; differing-length signatures rejected before `timingSafeEqual` call (avoids buffer length error)
- [ ] Origin validation rejects wildcards when `NODE_ENV === 'production'`
- [ ] Origin validation falls back to Referer when Origin absent
- [ ] CSRF middleware allows GET/HEAD/OPTIONS without token check
- [ ] CSRF middleware rejects POST/PUT/DELETE/PATCH without token, signature, or with mismatched session
- [ ] Expired tokens (>24h) deleted from store on validation attempt and rejected
- [ ] Cleanup interval evicts expired tokens every 5 minutes
- [ ] LRU eviction kicks in at `maxTokensInMemory` threshold
- [ ] HTMX requests (HX-Request: true) get JSON 403 response on failure
- [ ] Standard browser requests get rendered `errors/security-error.hbs` on failure
- [ ] CSRF cookie set with `httpOnly`, `secure` (prod), `sameSite=strict`, `path=/`
- [ ] HTMX client script injects `X-CSRF-Token` header on every `htmx:configRequest`
- [ ] HTMX client reloads page on 403 with `CSRF_TOKEN_INVALID` error code
- [ ] Startup throws if `CSRF_SECRET_KEY === 'change-me-in-production'` and `NODE_ENV === 'production'`
- [ ] All CSRF rejections logged via security-logger with structured event payload

## Dependencies

- **Inbound**: Express session middleware (must run before CSRF middleware), cookie-parser
- **Outbound**: SPEC-014-2-02 consumes `CSRFProtection.invalidateToken` after destructive confirms
- **Outbound**: SPEC-014-2-05 imports `CSRFProtection` for unit tests
- **Libraries**: `express`, `cookie-parser`, `zod` (config validation), Node `crypto` builtin
- **Existing modules**: Session middleware from PLAN-014-1 (`src/portal/middleware/session.ts`)

## Notes

- **Secret key rotation**: Out of scope. Document that rotating `CSRF_SECRET_KEY` invalidates all live tokens (acceptable — forces re-auth).
- **Multi-instance deployments**: In-memory token store is single-instance. PLAN-014-3 will introduce shared store. For now, document as a known limitation.
- **Timing-safe comparison gotcha**: `crypto.timingSafeEqual` throws if buffers differ in length. Always check `signature.length !== expectedSignature.length` BEFORE calling.
- **Cookie size**: Signature is 64 hex chars (256-bit HMAC) = ~64 bytes. Well under 4KB cookie limit.
- The token is sent in two places (header + cookie) intentionally — that IS the double-submit pattern. An attacker cannot read the httpOnly cookie or set the header cross-origin.
- HTMX detection MUST tolerate header injection by hostile proxies — fall back to `X-Requested-With` and finally to `Accept: application/json` heuristic.
