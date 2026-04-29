# SPEC-014-2-04: Content Security Policy (Strict CSP, Nonce-Based, No `unsafe-inline`)

## Metadata
- **Parent Plan**: PLAN-014-2
- **Tasks Covered**: TASK-006 (Content Security Policy Implementation), TASK-007 (Additional Security Headers)
- **Estimated effort**: 5 hours

## Description
Deploy a strict Content Security Policy and the supporting security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, X-XSS-Protection, HSTS) for the autonomous-dev portal. The CSP eliminates `unsafe-inline` for scripts entirely; necessary inline scripts (limited set: HTMX bootstrap, CSRF integration shim) carry a per-request nonce. Style retains `unsafe-inline` only because Handlebars rendering and HTMX swap dynamics depend on inline styles in some legacy templates — we accept this tradeoff and document it. The CSP runs in REPORT-ONLY mode in development (catches violations without breaking) and ENFORCING mode in production. A `/csp-violation-report` endpoint accepts and logs violation reports for monitoring.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/portal/security/csp-middleware.ts` | Create | `CSPMiddleware` class — generates nonce, builds directives, sets header |
| `src/portal/security/csp-config.ts` | Create | Environment-keyed CSP directive defaults; `buildCustomCSP` helper |
| `src/portal/security/security-headers.ts` | Create | Composite middleware setting all non-CSP security headers |
| `src/portal/config/header-config.ts` | Create | Centralized header configuration with environment overrides |
| `src/portal/routes/csp-violation-report.ts` | Create | `POST /csp-violation-report` endpoint with rate limiting and structured logging |
| `src/portal/helpers/nonce-helper.ts` | Create | `{{nonce}}` Handlebars helper exposing `req.nonce` to templates |
| `src/portal/views/layouts/base.hbs` | Modify | Add `nonce` attribute to all inline `<script>` tags |
| `src/portal/middleware/security-middleware.ts` | Modify | Wire CSP and header middleware into the security stack registration order |

## Implementation Details

### CSP Configuration (`csp-config.ts`)

```typescript
export interface CSPConfig {
  environment: 'development' | 'production' | 'test';
  reportOnly: boolean;
  reportUri?: string;
  enableNonce: boolean;
  allowUnsafeInlineStyles: boolean;  // accepted tradeoff
  customDirectives?: Partial<CSPDirectives>;
}

export interface CSPDirectives {
  'default-src':     string[];
  'script-src':      string[];
  'style-src':       string[];
  'img-src':         string[];
  'font-src':        string[];
  'connect-src':     string[];
  'object-src':      string[];
  'frame-ancestors': string[];
  'base-uri':        string[];
  'form-action':     string[];
  'media-src'?:      string[];
  'worker-src'?:     string[];
}

export const PRODUCTION_DIRECTIVES_BASE: CSPDirectives = Object.freeze({
  'default-src':     ["'self'"],
  'script-src':      ["'self'"],            // nonce appended at runtime
  'style-src':       ["'self'", "'unsafe-inline'"],   // documented tradeoff
  'img-src':         ["'self'", 'data:'],
  'font-src':        ["'self'"],
  'connect-src':     ["'self'"],
  'object-src':      ["'none'"],
  'frame-ancestors': ["'none'"],
  'base-uri':        ["'self'"],
  'form-action':     ["'self'"]
});

export const DEVELOPMENT_DIRECTIVES_BASE: CSPDirectives = Object.freeze({
  ...PRODUCTION_DIRECTIVES_BASE,
  'connect-src': ["'self'", 'localhost:*', '127.0.0.1:*', 'ws:', 'wss:']
  // NO 'unsafe-eval' even in dev — break early, fix at source
});
```

### `CSPMiddleware`

`generateNonce() -> string`:
- `return crypto.randomBytes(16).toString('base64')` (24 chars, URL-safe characters acceptable for CSP nonce per RFC 7636).

`buildDirectives(nonce: string) -> CSPDirectives`:
1. Clone `environment === 'production' ? PRODUCTION_DIRECTIVES_BASE : DEVELOPMENT_DIRECTIVES_BASE`.
2. If `enableNonce`: append `'nonce-${nonce}'` to `script-src`.
3. If `allowUnsafeInlineStyles === false`: remove `'unsafe-inline'` from `style-src`.
4. Apply `customDirectives` overrides — direct array replacement, not merge.

`directivesToString(directives) -> string`:
- `Object.entries(directives).filter(([_, v]) => v && v.length > 0).map(([k, v]) => '${k} ${v.join(' ')}').join('; ')`

`middleware()` returns a `RequestHandler`:
1. Generate nonce → `req.nonce = nonce`.
2. Set `res.locals.nonce = nonce` (templates read this via `{{nonce}}` helper).
3. Build directives, append `report-uri ${reportUri}` if configured.
4. Set header:
   - Production: `Content-Security-Policy: ${policyString}`
   - Development: `Content-Security-Policy-Report-Only: ${policyString}` (catches violations without breaking the app)
5. In development log the policy on first request startup ONLY (not per request — avoids log spam).
6. Call `next()`.

### CSP Violation Report Endpoint (`csp-violation-report.ts`)

`POST /csp-violation-report`:
- Body parser: `express.json({type: ['application/csp-report', 'application/json'], limit: '10kb'})`.
- Rate limit: max 100 reports per IP per 60 seconds (prevents log flooding from a misbehaving browser or attacker).
- No CSRF check (browsers post these without CSRF tokens — exempt path).
- No auth check (browsers post even from logged-out sessions).
- Body shape (per W3C CSP 2 spec):
  ```json
  {
    "csp-report": {
      "document-uri": "https://portal.example/admin",
      "referrer": "",
      "violated-directive": "script-src 'self'",
      "effective-directive": "script-src",
      "original-policy": "...",
      "blocked-uri": "inline",
      "status-code": 200,
      "source-file": "https://portal.example/admin",
      "line-number": 42,
      "column-number": 10
    }
  }
  ```
- Validate via Zod schema. Reject malformed reports with 400.
- Log via security-logger:
  ```json
  {
    "event": "csp_violation",
    "severity": "WARN",
    "documentUri": "...",
    "blockedUri": "...",
    "violatedDirective": "...",
    "effectiveDirective": "...",
    "sourceFile": "...",
    "line": ...,
    "column": ...,
    "userAgent": "...",
    "clientIp": "..."
  }
  ```
- Response: `204 No Content` always (don't leak info to attackers).
- Add to CSRF middleware `excludePaths` list.

### Other Security Headers (`security-headers.ts`)

`securityHeaders(config) -> RequestHandler`:

Headers set on every response (before route handlers):
- `X-Content-Type-Options: nosniff` — always
- `X-Frame-Options: DENY` — always (clickjacking)
- `Referrer-Policy: same-origin` — always
- `X-XSS-Protection: 1; mode=block` — always (legacy browsers)
- `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` — ONLY when `NODE_ENV === 'production'` AND `req.secure === true`. NEVER in development (would break localhost).
- `X-Permitted-Cross-Domain-Policies: none` — always
- `Cross-Origin-Opener-Policy: same-origin` — production only
- `Cross-Origin-Resource-Policy: same-origin` — production only
- `Cross-Origin-Embedder-Policy: require-corp` — production only

Headers REMOVED:
- `X-Powered-By` — Express default leaks framework identity. Call `app.disable('x-powered-by')` at startup.
- `Server` — strip via middleware.

`HeaderConfig`:
```typescript
export interface HeaderConfig {
  hstsEnabled: boolean;
  hstsMaxAge: number;
  hstsIncludeSubdomains: boolean;
  hstsPreload: boolean;
  frameOptions: 'DENY' | 'SAMEORIGIN';   // default DENY
  referrerPolicy: 'no-referrer' | 'same-origin' | 'strict-origin' | 'strict-origin-when-cross-origin';
  enableCOOP: boolean;
  enableCORP: boolean;
  enableCOEP: boolean;
}
```

### Nonce Helper (`nonce-helper.ts`)

```typescript
export function registerNonceHelper(handlebars, getRequest: () => Request) {
  handlebars.registerHelper('nonce', () => {
    const req = getRequest();
    return new handlebars.SafeString(req.nonce ?? '');
  });
}
```

Usage in templates:
```handlebars
<script nonce="{{nonce}}">
  // bootstrap inline JS
</script>
```

Templates without nonce on inline scripts will be blocked by CSP and emit a violation report — this is intentional. Audit all inline `<script>` blocks before merge.

### Middleware Registration Order

In `security-middleware.ts`, register in this exact order (each depends on prior):

1. `app.disable('x-powered-by')` — startup, not middleware
2. `securityHeaders(headerConfig)` — sets baseline headers
3. `cspMiddleware(cspConfig)` — sets CSP, generates nonce, populates `res.locals.nonce`
4. (CSRF, origin validation from SPEC-014-2-01 mount AFTER these)
5. `POST /csp-violation-report` route — registered with explicit body parser BEFORE the global CSRF middleware so it bypasses CSRF

## Acceptance Criteria

- [ ] CSP header set on every response in production via `Content-Security-Policy` header
- [ ] CSP header set on every response in development via `Content-Security-Policy-Report-Only` header
- [ ] Production policy contains: `default-src 'self'; script-src 'self' 'nonce-...'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; report-uri /csp-violation-report`
- [ ] Production policy contains NO `'unsafe-inline'` in `script-src`
- [ ] Production policy contains NO `'unsafe-eval'` in `script-src`
- [ ] Per-request nonce: 16 bytes from `crypto.randomBytes`, base64-encoded
- [ ] Nonce placed in `res.locals.nonce` and accessible via `{{nonce}}` Handlebars helper
- [ ] Nonce DIFFERS across requests (verified by issuing two requests and comparing)
- [ ] `X-Content-Type-Options: nosniff` set on every response
- [ ] `X-Frame-Options: DENY` set on every response
- [ ] `Referrer-Policy: same-origin` set on every response
- [ ] `X-XSS-Protection: 1; mode=block` set on every response
- [ ] HSTS header set ONLY when `NODE_ENV=production` AND request is HTTPS; never on localhost
- [ ] HSTS header includes `max-age=31536000; includeSubDomains; preload`
- [ ] `X-Powered-By` header NOT present in any response
- [ ] CSP violation report endpoint accepts `application/csp-report` and `application/json` content types
- [ ] CSP violation report endpoint rate-limits at 100 reports per IP per 60s; over-limit returns 429
- [ ] CSP violation report endpoint returns 204 even on success (no info leak)
- [ ] CSP violation report endpoint validates body against W3C schema; malformed reports return 400
- [ ] CSP violation report endpoint logs structured event via security-logger
- [ ] CSP violation report endpoint excluded from CSRF middleware
- [ ] All inline `<script>` blocks in templates carry `nonce="{{nonce}}"`
- [ ] Inline `<script>` without nonce is blocked by CSP in production (verified by browser console)
- [ ] Loading external scripts from non-self origins blocked by CSP

## Dependencies

- **Inbound**: SPEC-014-2-03 (XSS) — sanitization output must not contain inline scripts (CSP would block them anyway).
- **Outbound**: SPEC-014-2-05 (security tests) — verifies CSP header presence, nonce uniqueness, violation report flow.
- **Libraries**: Node `crypto` builtin, `zod` (report body validation), `express-rate-limit` (already in PLAN-013-2 stack).
- **Existing modules**: Logger from PLAN-002 ecosystem; Handlebars instance from PLAN-013-2.

## Notes

- **Why `'unsafe-inline'` for `style-src`?** HTMX swap operations and Handlebars partials emit some inline styles for animations and dynamic positioning. Removing this would require migrating to nonce-based styles, which is a much larger effort. Document this tradeoff prominently. Future: PLAN-014-3 followup to migrate styles to nonce or external sheets.
- **Why no `'unsafe-eval'` even in dev?** Forces us to use AOT-friendly code. Most modern dev tooling (Vite, etc.) doesn't need eval. Catching it early prevents surprises in production.
- **HSTS preload caution**: `preload` directive in HSTS header is a one-way ticket — submitting to the preload list is hard to reverse. Only enable when production deployment is confirmed permanent.
- **Report-only mode rationale**: Catching violations in dev without breaking lets us iterate on the policy. Production goes enforcing — no graceful degradation.
- **Nonce security model**: A unique nonce per request prevents an attacker from caching old responses and replaying inline scripts. Each response gets its own.
- **Browser support**: CSP Level 2 (nonce) supported in all modern browsers. Legacy IE 11 ignores CSP entirely — defense relies on the rest of the stack (origin validation, sanitization).
- **CDN compatibility**: If the portal is fronted by a CDN that injects analytics scripts, those will need their own nonce or be served from `'self'`. Document this in operator runbook.
- **CSP report fatigue**: Browsers may emit reports for benign extensions injecting scripts. Filter at the security-logger layer: ignore reports where `blocked-uri` matches known browser extension patterns (`chrome-extension://`, `moz-extension://`, `safari-extension://`).
- **Future hardening**: `require-trusted-types-for 'script'` — once Trusted Types API is widely adopted, add it. Currently Chrome/Edge only.
