# SPEC-014-1-04: OAuth Authorization Code + PKCE, Sessions, and Logout

## Metadata
- **Parent Plan**: PLAN-014-1
- **Tasks Covered**: Task 4 (OAuth provider foundation), Task 5 (session management), Task 7 (OAuth flow integration), portions of Task 6 (TLS gating for non-localhost), Task 10 (security tests)
- **Estimated effort**: 14 hours

## Description
Implement the OAuth 2.0 Authorization Code flow with PKCE (RFC 7636) for GitHub and Google providers, signed/encrypted session cookies, file-backed session storage, and the three public auth routes (`/auth/login`, `/auth/callback`, `/auth/logout`). The OAuth mode is the only mode that supports browser-based access from the public internet, so it carries the strictest security requirements: PKCE-mandatory token exchange, cryptographic CSRF state, session-ID regeneration after authentication (defeats fixation), `httpOnly` + `SameSite=Strict` + `Secure` + signed cookies, and 24h-idle / 30d-absolute timeouts. This spec also covers the comprehensive security test suite for the full PLAN-014-1 (Task 10) since most attack scenarios involve the OAuth flow.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `server/auth/oauth/oauth-auth.ts` | Create | `OAuthAuthProvider` implementing `AuthProvider`; orchestrates session lookup |
| `server/auth/oauth/pkce-utils.ts` | Create | `generateCodeVerifier()`, `deriveCodeChallenge(verifier)` per RFC 7636 §4.1-4.2 |
| `server/auth/oauth/oauth-state.ts` | Create | `OAuthStateStore` — short-lived store mapping `state → {code_verifier, return_to, created_at}` |
| `server/auth/oauth/token-exchange.ts` | Create | `exchangeCodeForToken(provider, code, code_verifier)` — fetch + parse |
| `server/auth/oauth/providers/github-provider.ts` | Create | GitHub-specific URL builders + user-info fetch |
| `server/auth/oauth/providers/google-provider.ts` | Create | Google-specific URL builders + user-info fetch |
| `server/auth/session/session-manager.ts` | Create | Public API: `create`, `validate`, `regenerate`, `destroy` |
| `server/auth/session/file-session-store.ts` | Create | Atomic-write JSON files in `${session_dir}/<session_id>.json` |
| `server/auth/session/session-cookie.ts` | Create | Signed cookie encode/decode using HMAC-SHA256 + timing-safe compare |
| `server/auth/session/session-cleanup.ts` | Create | Hourly background sweep that deletes expired session files |
| `server/routes/auth.ts` | Create | Hono routes: GET `/auth/login`, GET `/auth/callback`, POST `/auth/logout` |
| `server/auth/__tests__/oauth-flow.test.ts` | Create | End-to-end OAuth flow + attack scenarios (Task 10) |
| `server/auth/__tests__/session-security.test.ts` | Create | Cookie tamper, fixation, timeout tests |
| `server/auth/__tests__/pkce-utils.test.ts` | Create | RFC 7636 vector tests |

## Implementation Details

### Task 4.1: PKCE Utilities (`server/auth/oauth/pkce-utils.ts`)

Exports per RFC 7636:
- `generateCodeVerifier()` — 32 random bytes from `crypto.getRandomValues` → base64url-encode → strip padding (43 chars). Charset: `[A-Za-z0-9_-]`.
- `deriveCodeChallenge(verifier)` — `base64UrlEncode(SHA256(ASCII(verifier)))`.
- `base64UrlEncode` (private) — base64 standard then `+` → `-`, `/` → `_`, strip `=`.

Verify against RFC 7636 Appendix B vector: verifier `"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"` → challenge `"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"`.

### Task 4.2: OAuth State Store (`server/auth/oauth/oauth-state.ts`)

`OAuthStateStore` (in-memory `Map<string, OAuthStateRecord>`):
- `OAuthStateRecord = { code_verifier, return_to, created_at, used }`.
- `generate(returnTo)`: state = 256-bit base64url (32 random bytes); pairs with a freshly generated `code_verifier`; record stored with `used=false`. Returns `{state, code_verifier}`.
- `consume(state)`: returns null if missing, used, or > 10-min old (TTL). Otherwise marks `used=true` BEFORE returning, schedules deletion via `queueMicrotask`. Replay attempts return null and the record is invalidated immediately.
- `cleanupExpired()` invoked from the hourly cleanup sweep.

`return_to` validation rule (Task 4.8): only paths beginning with `/` and containing none of `//`, `\`, `:`, `?` are accepted; everything else collapses to `/`. Defeats open-redirect.

### Task 4.3: Token Exchange (`server/auth/oauth/token-exchange.ts`)

`exchangeCodeForToken(provider, code, code_verifier)`:
- POST to `provider.token_url` with `Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`.
- Body fields: `grant_type=authorization_code`, `client_id`, `client_secret`, `code`, `code_verifier`, `redirect_uri`.
- Non-2xx response throws `SecurityError('OAUTH_TOKEN_EXCHANGE_FAILED', 'Token endpoint returned {status}')` — status only, never response body.
- Missing `access_token` field throws `OAUTH_NO_ACCESS_TOKEN`.
- Returns `{ access_token, token_type, scope? }`.

CRITICAL: NEVER log `code`, `code_verifier`, `access_token`, or `client_secret`. Logs include only status codes and provider name.

### Task 4.4: Provider Modules

`server/auth/oauth/providers/github-provider.ts`:

```ts
export const GITHUB_PROVIDER = {
  authorize_url: 'https://github.com/login/oauth/authorize',
  token_url: 'https://github.com/login/oauth/access_token',
  user_url: 'https://api.github.com/user',
  user_email_url: 'https://api.github.com/user/emails',
  scope: 'read:user user:email',
};

export function buildAuthorizeUrl(cfg: OAuthProviderConfig, state: string, code_challenge: string): string {
  const u = new URL(GITHUB_PROVIDER.authorize_url);
  u.searchParams.set('client_id', cfg.client_id);
  u.searchParams.set('redirect_uri', cfg.redirect_uri);
  u.searchParams.set('scope', GITHUB_PROVIDER.scope);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', code_challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export async function fetchUserProfile(token: string): Promise<{ login: string; email: string; name: string }> {
  // GET user, then GET user/emails to find primary verified email
  // Bearer auth header. Throw SecurityError('OAUTH_USER_FETCH_FAILED') on non-200.
}
```

`server/auth/oauth/providers/google-provider.ts`:

```ts
export const GOOGLE_PROVIDER = {
  authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_url: 'https://oauth2.googleapis.com/token',
  user_url: 'https://www.googleapis.com/oauth2/v2/userinfo',
  scope: 'openid email profile',
};
// buildAuthorizeUrl: same shape but adds access_type=online and prompt=select_account
// fetchUserProfile: returns { login: id, email, name }
```

### Task 4.5: Session Manager (`server/auth/session/session-manager.ts`)

```ts
export interface Session {
  session_id: string;
  user_id: string;
  email: string;
  display_name: string;
  provider: 'github' | 'google';
  created_at: number;
  last_activity: number;
}

const IDLE_MS     = 24 * 60 * 60 * 1000;
const ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

export class SessionManager {
  constructor(private readonly store: SessionStore) {}

  async create(profile: ProfilePayload): Promise<Session> {
    const session_id = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const now = Date.now();
    const session = { session_id, ...profile, created_at: now, last_activity: now };
    await this.store.put(session);
    return session;
  }

  async validate(session_id: string): Promise<Session | null> {
    const s = await this.store.get(session_id);
    if (!s) return null;
    const now = Date.now();
    if (now - s.created_at > ABSOLUTE_MS)  { await this.store.delete(session_id); return null; }
    if (now - s.last_activity > IDLE_MS)  { await this.store.delete(session_id); return null; }
    s.last_activity = now;
    await this.store.put(s);
    return s;
  }

  async regenerate(old_id: string): Promise<Session> {
    const old = await this.store.get(old_id);
    if (!old) throw new SecurityError('SESSION_NOT_FOUND', 'Cannot regenerate missing session');
    const new_id = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const updated: Session = { ...old, session_id: new_id, created_at: Date.now() };
    await this.store.put(updated);
    await this.store.delete(old_id);
    return updated;
  }

  async destroy(session_id: string): Promise<void> { await this.store.delete(session_id); }
}
```

`regenerate()` is called immediately after successful OAuth callback — before issuing the cookie — to defeat session fixation.

### Task 4.6: File Session Store (`server/auth/session/file-session-store.ts`)

- Path: `${config.oauth.session_dir ?? '${CLAUDE_PLUGIN_DATA}/sessions'}/<session_id>.json`
- `put`: write to `<id>.json.tmp` then `rename()` to `<id>.json` for atomicity.
- `get`: read JSON; missing file returns null; corrupt JSON returns null and deletes the file.
- `delete`: `unlink` ignoring ENOENT.
- File mode: `0o600` (owner read/write only). The directory MUST be created with mode `0o700` if missing.
- `session_id` MUST be validated as `^[A-Za-z0-9_-]{43}$` before constructing the path (no traversal).

### Task 4.7: Session Cookie (`server/auth/session/session-cookie.ts`)

```ts
const COOKIE_NAME = 'portal_session';

export function encodeCookie(session_id: string, secret: string): string {
  const mac = hmacSha256(secret, session_id);                       // hex
  return `${session_id}.${mac}`;
}

export function decodeCookie(value: string, secret: string): string | null {
  const [id, mac, ...rest] = value.split('.');
  if (!id || !mac || rest.length) return null;
  const expected = hmacSha256(secret, id);
  if (!timingSafeEqualHex(mac, expected)) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  return id;
}

export function buildSetCookieHeader(value: string, isSecure: boolean): string {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000` +
         (isSecure ? '; Secure' : '');
}
```

`isSecure` is `true` whenever `config.bind_host !== '127.0.0.1'`. Localhost-dev OAuth (rare but supported per validator) drops the `Secure` flag because the browser will refuse to send `Secure` cookies over `http://127.0.0.1`.

### Task 4.8: Routes (`server/routes/auth.ts`)

```ts
export function registerAuthRoutes(app: Hono, deps: AuthRouteDeps): void {
  app.get('/auth/login', async (c) => {
    if (deps.config.auth_mode !== 'oauth-pkce') return c.json({ error: 'OAUTH_DISABLED' }, 404);
    const returnTo = sanitizeReturnTo(c.req.query('return_to'));
    const { state, code_verifier } = deps.stateStore.generate(returnTo);
    const challenge = deriveCodeChallenge(code_verifier);
    const url = deps.providerAdapter.buildAuthorizeUrl(state, challenge);
    return c.redirect(url, 302);
  });

  app.get('/auth/callback', async (c) => {
    const state = c.req.query('state');
    const code  = c.req.query('code');
    const err   = c.req.query('error');
    if (err)  return deps.errorPage(c, 'OAUTH_PROVIDER_ERROR', err);
    if (!state || !code) return deps.errorPage(c, 'OAUTH_BAD_CALLBACK', 'missing state or code');
    const rec = deps.stateStore.consume(state);
    if (!rec) return deps.errorPage(c, 'OAUTH_INVALID_STATE', 'state mismatch or expired');

    const tokens = await deps.tokenExchange(code, rec.code_verifier); // throws on failure
    const profile = await deps.providerAdapter.fetchUserProfile(tokens.access_token);
    const session = await deps.sessionManager.create({
      user_id: profile.login, email: profile.email, display_name: profile.name, provider: deps.config.oauth!.provider,
    });
    // Session regeneration: brand-new session, but defeats any prior pre-login cookie attempt by the attacker
    const regenerated = await deps.sessionManager.regenerate(session.session_id);
    const cookie = encodeCookie(regenerated.session_id, deps.cookieSecret);
    c.header('Set-Cookie', buildSetCookieHeader(cookie, deps.isSecure));
    return c.redirect(rec.return_to || '/', 302);
  });

  app.post('/auth/logout', async (c) => {
    const cookieHeader = c.req.header('cookie') ?? '';
    const id = parseSessionCookie(cookieHeader, deps.cookieSecret);
    if (id) await deps.sessionManager.destroy(id);
    c.header('Set-Cookie', `portal_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` + (deps.isSecure ? '; Secure' : ''));
    return c.redirect('/', 302);
  });
}

function sanitizeReturnTo(input: string | undefined): string {
  if (!input) return '/';
  if (!input.startsWith('/')) return '/';
  if (input.includes('//') || input.includes('\\') || input.includes(':') || input.includes('?')) return '/';
  return input;
}
```

Logout MUST be POST to mitigate logout-via-image-tag CSRF. Document in the migration guide.

### Task 4.9: OAuthAuthProvider (`server/auth/oauth/oauth-auth.ts`)

```ts
export class OAuthAuthProvider extends BaseAuthProvider implements AuthProvider {
  readonly mode = 'oauth-pkce' as const;

  async init(): Promise<void> {
    // Verify session_dir exists, create with 0o700 if missing.
    // Verify cookie_secret meets minimum entropy (>= 32 bytes / 256 bits when base64-decoded).
  }

  async evaluate(request: Request, _peerIp: string): Promise<AuthDecision> {
    const cookie = request.headers.get('cookie') ?? '';
    const session_id = parseSessionCookie(cookie, this.cookieSecret);
    if (!session_id) return { kind: 'redirect', location: '/auth/login' };
    const session = await this.sessionManager.validate(session_id);
    if (!session) return { kind: 'redirect', location: '/auth/login' };
    return {
      kind: 'allow',
      context: {
        authenticated: true,
        mode: 'oauth-pkce',
        source_user_id: session.user_id,
        display_name: session.display_name,
        details: { email: session.email, provider: session.provider, session_id },
      },
    };
  }
}
```

### Task 4.10: Background Cleanup (`server/auth/session/session-cleanup.ts`)

A `setInterval` (1 hour) that scans `${session_dir}` for files older than `ABSOLUTE_MS` since `mtime` and deletes them. Registered during server startup, cleared on shutdown via the existing graceful-shutdown hook.

### Task 4.11: Security Test Suite (Task 10)

`server/auth/__tests__/oauth-flow.test.ts`:

| Scenario | Expected |
|----------|----------|
| Happy path (login → callback with valid state+code → cookie set) | 302 redirect, valid session in store |
| Callback with `state=<garbage>` | error page `OAUTH_INVALID_STATE`, no session created |
| Callback with replayed valid state (used twice) | second call returns `OAUTH_INVALID_STATE` |
| Callback with expired state (>10min old) | `OAUTH_INVALID_STATE` |
| Callback with `code` for which token exchange returns `error: invalid_grant` | error page, no session created |
| Token exchange with mutated code_verifier (PKCE mismatch — provider rejects) | `OAUTH_TOKEN_EXCHANGE_FAILED` |
| `return_to=//evil.com/path` | sanitized to `/`; no open redirect |
| `return_to=https://evil.com` | sanitized to `/` |
| Concurrent two browsers, same user, both login: two distinct sessions exist | passes |

`server/auth/__tests__/session-security.test.ts`:

| Scenario | Expected |
|----------|----------|
| Cookie HMAC tampered (last char flipped) | `evaluate` returns `redirect /auth/login`, NOT 500 |
| Cookie session_id format invalid (`../etc/passwd`) | `decodeCookie` returns null; no file read attempted |
| Session age > 30d | validate returns null; file deleted |
| Session idle > 24h | validate returns null; file deleted |
| Session fixation: pre-set `portal_session=attacker_id`, complete OAuth | post-callback cookie has DIFFERENT id (regenerate succeeded) |
| Set-Cookie attributes (when isSecure=true) | contains `HttpOnly`, `SameSite=Strict`, `Secure` |
| Set-Cookie attributes (when isSecure=false / localhost) | contains `HttpOnly`, `SameSite=Strict`, NO `Secure` |
| Logout via GET | 405 or no-op (POST required) |
| Logout via POST clears cookie and deletes session file | cookie max-age=0; file gone |
| Concurrent validate() calls don't double-update last_activity into corrupt state | atomic write holds |

`server/auth/__tests__/pkce-utils.test.ts`:

| Scenario | Expected |
|----------|----------|
| RFC 7636 Appendix B vector | challenge matches |
| `generateCodeVerifier()` produces 43-char [A-Za-z0-9_-] | always |
| Two consecutive calls produce different verifiers | passes (256 bits entropy makes collision negligible) |

Coverage target: ≥95% on all `server/auth/oauth/**` and `server/auth/session/**` files.

## Acceptance Criteria

- [ ] `generateCodeVerifier` returns 43-char URL-safe base64 strings; RFC 7636 Appendix B vector matches `deriveCodeChallenge`
- [ ] OAuth state is 256-bit, one-time-use, 10-min TTL; replay rejected
- [ ] `return_to` query parameter is sanitized: only paths starting with `/` and containing none of `//`, `\`, `:`, `?` are accepted; everything else collapses to `/`
- [ ] `exchangeCodeForToken` POSTs `application/x-www-form-urlencoded` to the provider with `grant_type`, `client_id`, `client_secret`, `code`, `code_verifier`, `redirect_uri`; never logs `client_secret`, `code`, `code_verifier`, or `access_token`
- [ ] `SessionManager.create` produces 256-bit session IDs (43-char base64url)
- [ ] `SessionManager.regenerate` is called after successful callback; the cookie set on the response uses the NEW session ID
- [ ] `SessionManager.validate` enforces idle (24h) and absolute (30d) timeouts, deleting the file on expiry
- [ ] File session store uses atomic rename; files have mode `0o600`; directory has mode `0o700`
- [ ] `session_id` is validated against `^[A-Za-z0-9_-]{43}$` before any filesystem operation (no path traversal)
- [ ] `encodeCookie` uses HMAC-SHA256; `decodeCookie` uses timing-safe comparison; tampered MAC returns null
- [ ] `Set-Cookie` includes `HttpOnly`, `SameSite=Strict`, `Path=/`; includes `Secure` when `bind_host !== '127.0.0.1'`
- [ ] `/auth/login` returns 404 when `auth_mode !== 'oauth-pkce'` (no leakage)
- [ ] `/auth/callback` rejects missing/expired/replayed `state` with an error page; never creates a session
- [ ] `/auth/logout` accepts POST only; clears cookie (Max-Age=0) and deletes session file
- [ ] `OAuthAuthProvider.evaluate` returns `{kind:'redirect', location:'/auth/login'}` for missing or invalid cookies
- [ ] `OAuthAuthProvider.init()` rejects `cookie_secret_env` values shorter than 32 bytes (after base64 decode if present, else raw byte length); throws `SecurityError('OAUTH_WEAK_COOKIE_SECRET')`
- [ ] Background cleanup runs hourly; deletes session files where `mtime` indicates absolute timeout reached
- [ ] All scenarios in the three test matrices pass; coverage ≥95% on `server/auth/oauth/**` and `server/auth/session/**`
- [ ] Open-redirect tests (`return_to=//evil.com`, `return_to=https://evil.com`) result in redirect to `/`
- [ ] Session-fixation test: pre-set cookie value differs from post-callback cookie value
- [ ] No `client_secret`, `code`, `code_verifier`, `access_token`, or `cookie_secret` value appears in any log line under any test scenario
- [ ] `tsc --strict` passes; no `any` in public signatures

## Dependencies

- `AuthProvider`, `AuthDecision`, `AuthContext`, `SecurityError`, `BaseAuthProvider` from SPEC-014-1-01
- `validateAuthConfig` enforcement of `oauth.cookie_secret_env` and `oauth.client_secret_env` from SPEC-014-1-01
- Hono routing from PLAN-013-2
- Bun's built-in `fetch`, `crypto.subtle`, `crypto.getRandomValues`
- No new npm dependencies (PKCE, HMAC, base64url all implementable from Web Crypto + Node `crypto`)

## Notes

- We deliberately do NOT use a generic OAuth library (passport, openid-client). Reasons: (1) the surface area is small enough to audit directly, (2) third-party libs frequently have drift between their assumed flow and ours (e.g., implicit grant defaults), (3) keeping `client_secret` handling in our own code makes redaction guarantees easier to verify.
- The session storage is file-backed rather than DB-backed because the portal is single-process and the homelab/single-user deployment target does not require multi-replica session sharing. Memory-backed is also supported for tests via `memory-session-store.ts` (omitted from this spec — straightforward Map wrapper).
- Session-ID regeneration after auth is non-negotiable per OWASP A1 Broken Auth. The implementation deliberately destroys the OLD file via `store.delete(old_id)` to prevent a parallel-session race.
- `SameSite=Strict` (rather than `Lax`) is intentional: the portal is admin/operator-only and there is no cross-site flow that needs to send the cookie. This blocks an entire class of CSRF attacks at the cookie layer (PLAN-014-2 will layer additional CSRF tokens on top for defense-in-depth).
- The `Secure` flag is conditionally omitted ONLY for `bind_host=127.0.0.1` because browsers require HTTPS to send `Secure` cookies, and forcing developers through TLS for local OAuth-mode testing is an obstacle without a security gain (loopback is not network-observable).
- This spec is the largest of the four because the OAuth flow has the most security-critical surface area. If implementation reveals further decomposition is needed, splitting along the seam at "session/cookie" vs "OAuth flow/state/exchange" is the natural cut.
