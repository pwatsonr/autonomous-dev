# SPEC-014-1-01: Auth Mode Selector and Config Schema

## Metadata
- **Parent Plan**: PLAN-014-1
- **Tasks Covered**: Task 1 (auth middleware factory + core types), Task 8 (auth context middleware), portions of Task 9 (mode-aware binding gate)
- **Estimated effort**: 6 hours

## Description
Establish the foundation for the portal's three authentication modes (`localhost`, `tailscale`, `oauth-pkce`) by introducing a typed configuration schema, a startup validator, an `AuthProvider` interface that each mode implements, and a `createAuthMiddleware` factory that dispatches to the active provider. The factory wires a single `c.set('auth', AuthContext)` propagation point used by every downstream handler for FR-S05 audit attribution. This spec does NOT implement the provider bodies — those are SPEC-014-1-02 (localhost), SPEC-014-1-03 (tailscale), and SPEC-014-1-04 (oauth-pkce). It DOES implement: schema validation, mode dispatch, the `AuthContext` shape, the `requireAuth()` gate, and the public-route bypass list (`/health`, `/auth/login`, `/auth/callback`, `/auth/logout`, `/static/*`).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `server/auth/types.ts` | Create | `AuthMode`, `AuthContext`, `AuthProvider`, `AuthDecision`, `SecurityError` |
| `server/auth/middleware-factory.ts` | Create | `createAuthMiddleware(config, providers)` + provider registry |
| `server/auth/base-auth.ts` | Create | Abstract `BaseAuthProvider` with shared logging + context-set helpers |
| `server/auth/middleware/auth-context.ts` | Create | Hono-compatible middleware that calls the active provider and stores result |
| `server/auth/middleware/require-auth.ts` | Create | Gate that returns 401 unless `c.get('auth').authenticated === true`; bypass list configurable |
| `server/lib/config.ts` | Modify | Extend `PortalConfig` with `auth_mode` and per-mode option blocks; widen mode union to include `oauth-pkce` |
| `server/lib/validation.ts` | Modify | Add `validateAuthConfig(config)` invoked from startup checks |
| `config/portal-defaults.json` | Modify | Add `auth_mode: "localhost"` default and empty `tailscale`/`oauth` blocks |

## Implementation Details

### Task 1.1: Type Definitions (`server/auth/types.ts`)

```ts
export type AuthMode = 'localhost' | 'tailscale' | 'oauth-pkce';

export interface AuthContext {
  authenticated: boolean;
  mode: AuthMode;
  /** stable identifier used for FR-S05 audit attribution (e.g. 'localhost', 'user@tailnet', github user login) */
  source_user_id: string;
  /** human-readable display name; falls back to source_user_id */
  display_name: string;
  /** mode-specific extras (peer IP for tailscale, provider+email for oauth) — opaque to other layers */
  details: Record<string, unknown>;
}

export type AuthDecision =
  | { kind: 'allow'; context: AuthContext }
  | { kind: 'deny'; status: 401 | 403; error_code: string; message: string }
  | { kind: 'redirect'; location: string };

export interface AuthProvider {
  readonly mode: AuthMode;
  /** Called once at startup; throws SecurityError on misconfiguration. */
  init(): Promise<void>;
  /** Called per request; pure function of headers/config — no side effects on the response object. */
  evaluate(request: Request, peerIp: string): Promise<AuthDecision>;
}

export class SecurityError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}
```

### Task 1.2: Config Schema (`server/lib/config.ts`)

Extend the existing `PortalConfig` interface:

```ts
export interface PortalConfig {
  // ... existing fields ...
  auth_mode: AuthMode;                             // default: 'localhost'
  bind_host: string;                               // default: '127.0.0.1'
  port: number;
  tailscale?: {
    require_whois_for_writes: boolean;             // default: true
    cli_path?: string;                             // default: 'tailscale' from PATH
  };
  oauth?: {
    provider: 'github' | 'google';
    client_id: string;
    client_secret_env: string;                     // env var name; never inline secret
    redirect_url: string;                          // must be HTTPS unless localhost
    cookie_secret_env: string;                     // env var holding HMAC key for signed session cookies
    session_dir?: string;                          // default: ${CLAUDE_PLUGIN_DATA}/sessions
  };
  tls?: { cert_path: string; key_path: string };
  trusted_reverse_proxy?: boolean;                 // default: false
}
```

### Task 1.3: Startup Validator (`server/lib/validation.ts`)

Add `validateAuthConfig(config: PortalConfig): void`:

1. `auth_mode` MUST be one of `localhost | tailscale | oauth-pkce`. Otherwise throw `SecurityError('INVALID_AUTH_MODE', ...)` listing valid values.
2. If `auth_mode === 'localhost'`: `bind_host` MUST equal `'127.0.0.1'`. Reject `'0.0.0.0'`, `'localhost'`, and any other IP with `SecurityError('LOCALHOST_REQUIRES_LOOPBACK', ...)`.
3. If `auth_mode === 'tailscale'`: `tailscale` block must be present (object, may be empty for defaults). `bind_host` MUST NOT be `'0.0.0.0'` (SPEC-014-1-03 narrows it further to the Tailscale interface IP).
4. If `auth_mode === 'oauth-pkce'`:
   - `oauth` block required with `provider`, `client_id`, `client_secret_env`, `redirect_url`, `cookie_secret_env`.
   - `redirect_url` MUST start with `https://` UNLESS `bind_host === '127.0.0.1'` (dev). Otherwise throw `'OAUTH_REQUIRES_HTTPS'`.
   - `process.env[client_secret_env]` and `process.env[cookie_secret_env]` MUST be set and non-empty. Throw `'OAUTH_MISSING_SECRET'` naming the missing variable. NEVER log the secret values.
   - `tls` block OR `trusted_reverse_proxy === true` required when `bind_host !== '127.0.0.1'`. Throw `'OAUTH_REQUIRES_TLS_OR_PROXY'` otherwise.
5. For all non-localhost modes: refuse `bind_host === '0.0.0.0'` unless TLS configured OR `trusted_reverse_proxy === true`. Throw `'INSECURE_BIND'`.

The validator MUST NOT mutate config. All error messages MUST include the exact config field that failed and an actionable suggestion.

### Task 1.4: Middleware Factory (`server/auth/middleware-factory.ts`)

```ts
export interface AuthProviderRegistry {
  localhost: AuthProvider;
  tailscale: AuthProvider;
  'oauth-pkce': AuthProvider;
}

export async function createAuthMiddleware(
  config: PortalConfig,
  providers: AuthProviderRegistry,
): Promise<MiddlewareHandler> {
  const provider = providers[config.auth_mode];
  if (!provider) throw new SecurityError('UNKNOWN_AUTH_MODE', `No provider registered for mode: ${config.auth_mode}`);
  await provider.init();
  return authContextMiddleware(provider);
}
```

Selects strictly by `config.auth_mode` (no fallback). Calls `provider.init()` exactly once and surfaces thrown `SecurityError` to startup. Does NOT implement per-request logic — that belongs to Task 1.5.

### Task 1.5: Auth Context Middleware (`server/auth/middleware/auth-context.ts`)

```ts
export function authContextMiddleware(provider: AuthProvider): MiddlewareHandler {
  return async (c, next) => {
    const peerIp = extractPeerIp(c);
    const decision = await provider.evaluate(c.req.raw, peerIp);

    switch (decision.kind) {
      case 'allow':
        c.set('auth', decision.context);
        return next();
      case 'redirect':
        return c.redirect(decision.location, 302);
      case 'deny':
        return c.json({ error: decision.error_code, message: decision.message }, decision.status);
    }
  };
}
```

`extractPeerIp(c)`:
- Returns `c.env.incoming?.socket?.remoteAddress` (Bun) OR `c.req.raw.headers.get('x-forwarded-for')?.split(',')[0]?.trim()` IF AND ONLY IF `config.trusted_reverse_proxy === true`. Otherwise IGNORE forwarded headers entirely. This prevents header spoofing in localhost mode.
- If no IP is available, return the literal string `'unknown'` and rely on the provider to deny.

### Task 1.6: Require-Auth Gate (`server/auth/middleware/require-auth.ts`)

```ts
export const PUBLIC_ROUTES: ReadonlyArray<string | RegExp> = [
  '/health',
  '/auth/login',
  '/auth/callback',
  '/auth/logout',
  /^\/static\//,
];

export function requireAuth(extraPublic: ReadonlyArray<string | RegExp> = []): MiddlewareHandler {
  const publicSet = [...PUBLIC_ROUTES, ...extraPublic];
  return async (c, next) => {
    if (isPublic(c.req.path, publicSet)) return next();
    const auth = c.get('auth') as AuthContext | undefined;
    if (!auth?.authenticated) {
      return c.json({ error: 'UNAUTHENTICATED', message: 'Authentication required' }, 401);
    }
    return next();
  };
}
```

### Task 1.7: Default Config Update (`config/portal-defaults.json`)

Add the keys (preserve existing structure):

```json
{
  "auth_mode": "localhost",
  "bind_host": "127.0.0.1",
  "trusted_reverse_proxy": false
}
```

Do NOT inline `tailscale` or `oauth` blocks — those are populated via user config only.

## Acceptance Criteria

- [ ] `validateAuthConfig` throws `SecurityError('INVALID_AUTH_MODE')` for any value not in the enum (including `'oauth'`, `'OAUTH-PKCE'`, empty string)
- [ ] `validateAuthConfig` throws `SecurityError('LOCALHOST_REQUIRES_LOOPBACK')` when `auth_mode='localhost'` and `bind_host='0.0.0.0'`
- [ ] `validateAuthConfig` throws `SecurityError('OAUTH_MISSING_SECRET')` naming the env var when either secret env is unset
- [ ] `validateAuthConfig` throws `SecurityError('OAUTH_REQUIRES_HTTPS')` when `redirect_url` starts with `http://` and `bind_host !== '127.0.0.1'`
- [ ] `validateAuthConfig` throws `SecurityError('INSECURE_BIND')` when `auth_mode !== 'localhost'`, `bind_host='0.0.0.0'`, and neither TLS nor trusted proxy is configured
- [ ] `createAuthMiddleware` throws `SecurityError('UNKNOWN_AUTH_MODE')` if a provider for the configured mode is not registered
- [ ] `createAuthMiddleware` calls `provider.init()` exactly once, before returning the middleware
- [ ] `authContextMiddleware` sets `c.get('auth')` to the `AuthContext` returned by `evaluate({kind:'allow'})`
- [ ] `authContextMiddleware` returns 302 redirect for `{kind:'redirect'}` decisions and JSON `{error,message}` with the specified status for `{kind:'deny'}`
- [ ] `extractPeerIp` IGNORES `X-Forwarded-For` when `trusted_reverse_proxy === false` (returns socket address only)
- [ ] `requireAuth()` allows requests to `/health`, `/auth/login`, `/auth/callback`, `/auth/logout`, and `/static/*` without an auth context
- [ ] `requireAuth()` returns 401 `{error:'UNAUTHENTICATED'}` for any non-public route when `c.get('auth')` is undefined or `authenticated:false`
- [ ] Unit tests cover all enumerated `validateAuthConfig` error codes plus the happy path for each mode (localhost, tailscale, oauth-pkce)
- [ ] No `any` in exported type signatures; `tsc --strict` passes

## Dependencies

- `server/lib/config.ts` from PLAN-013-2 — extended, not replaced.
- `server/lib/validation.ts` from PLAN-013-2 — `validateAuthConfig` added to the existing validation chain called by `validateStartupConditions`.
- Hono `MiddlewareHandler` type from PLAN-013-2's pinned `hono@^3.12.0`.
- No new npm dependencies.

## Notes

- The mode literal is `oauth-pkce` (with hyphen) to make PKCE mandatory; older PRD text reads `oauth` but this spec is canonical.
- The bypass list is hardcoded constants exported from `require-auth.ts`. New public routes require a code change in security review — no runtime flag by design.
- `extractPeerIp` never trusts forwarded headers without explicit `trusted_reverse_proxy=true` opt-in. Foundation for SPEC-014-1-02's spoof defense.
- The factory takes a fully-instantiated `AuthProviderRegistry` rather than constructing providers itself, keeping DI seams clean for SPEC-014-1-02/03/04 isolation tests.
