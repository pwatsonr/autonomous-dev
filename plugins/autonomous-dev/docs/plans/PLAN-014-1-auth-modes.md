# PLAN-014-1: Authentication Modes (Localhost / Tailscale / OAuth+PKCE)

## Metadata
- **Parent TDD**: TDD-014-portal-security-auth
- **Estimated effort**: 4-5 days (security-critical)
- **Dependencies**: ["PLAN-013-2"]
- **Blocked by**: []
- **Priority**: P0

## Objective
Implement comprehensive authentication system supporting three security modes per TDD-014 §4-8: Localhost (development, bind 127.0.0.1 only), Tailscale (network-level via tailnet CIDR + whois verification per §22.1 BINDING), OAuth+PKCE (production with GitHub/Google providers, secure session cookies, 24h idle / 30d absolute timeouts). Includes TLS enforcement and refusal to bind 0.0.0.0 without TLS+auth.

## Scope
### In Scope
- Auth middleware factory dispatching on `auth_mode` userConfig (localhost | tailscale | oauth)
- **Localhost mode**: bind 127.0.0.1 only; no auth required; refuse to listen on 0.0.0.0 even with localhost mode
- **Tailscale mode** (per §22.1 BINDING): bind only to Tailscale interface IP via `tailscale ip --4`; verify peer IP within tailnet CIDR via `tailscale status --json`; defense-in-depth via `tailscale whois` for high-value mutating ops; refuse start if `tailscale` CLI unavailable
- **OAuth+PKCE mode**: Authorization Code + PKCE flow per RFC 7636; GitHub + Google providers; session cookies (httpOnly, SameSite=Strict, Secure, signed, 24h idle / 30d absolute); session storage at `${CLAUDE_PLUGIN_DATA}/sessions/`
- TLS for non-localhost: cert via userConfig OR via reverse proxy (X-Forwarded-Proto); refuse non-localhost bind without TLS or trusted reverse proxy
- Auth context propagation via Hono context (`c.get('auth')` returns operator identity for FR-S05 audit attribution)

### Out of Scope
- CSRF (PLAN-014-2), XSS (PLAN-014-2)
- Path validation (PLAN-014-3), audit log integrity (PLAN-014-3)
- Multi-factor auth, custom OAuth providers beyond GitHub/Google
- Concurrent session limits, "remember me" features

## Tasks

1. **Auth middleware factory + core types** -- Factory dispatches based on auth_mode; AuthProvider interface; AuthContext shape.
   - Files: `server/auth/middleware-factory.ts`, `server/auth/types.ts`, `server/auth/base-auth.ts` (new)
   - Acceptance: factory throws on invalid auth_mode; all modes implement AuthProvider; AuthContext typed for Hono.
   - Effort: 4h

2. **Localhost mode + binding enforcement** -- Bind 127.0.0.1 only; no auth checks; reject 0.0.0.0 explicitly.
   - Files: `server/auth/localhost-auth.ts`, `server/auth/network-binding.ts` (new)
   - Acceptance: bind 192.168.x.x or 0.0.0.0 throws SecurityError; localhost requests pass without auth; clear error messages on insecure bind attempts.
   - Effort: 3h

3. **Tailscale mode** -- Tailscale CLI integration, peer IP CIDR validation, whois defense-in-depth.
   - Files: `server/auth/tailscale-auth.ts`, `server/auth/tailscale-client.ts`, `server/auth/cidr-utils.ts` (new)
   - Acceptance: refuses start if `tailscale` not in PATH; binds only to Tailscale interface IP; rejects non-tailnet peer IPs; whois verification for write operations; mocked CLI tests cover forged-header attacks.
   - Effort: 6h

4. **OAuth provider foundation** -- PKCE state management, provider abstraction, token exchange.
   - Files: `server/auth/oauth/{oauth-provider,pkce-utils,oauth-state,token-exchange}.ts`, `server/auth/oauth/providers/{github,google}-provider.ts` (new)
   - Acceptance: PKCE code-verifier 32-byte URL-safe base64; SHA256 challenge per RFC 7636; cryptographic state generation; token exchange handles success and error cases per provider.
   - Effort: 5h

5. **Session management** -- Secure storage, cookies, timeouts, cleanup.
   - Files: `server/auth/session/{session-manager,session-store,file-session-store,memory-session-store,session-cookie,session-cleanup}.ts` (new)
   - Acceptance: file-based store at `${CLAUDE_PLUGIN_DATA}/sessions/` with atomic writes; cookies httpOnly+SameSite=Strict+Secure+signed; 24h idle / 30d absolute timeouts; background cleanup hourly; **session ID regenerated after auth** (defeats fixation); concurrent sessions per user supported.
   - Effort: 4h

6. **TLS certificate management** -- File loading + reverse proxy detection.
   - Files: `server/auth/tls/{cert-manager,cert-validator,reverse-proxy-detector,tls-config}.ts` (new)
   - Acceptance: loads certs from userConfig paths; auto-detects reverse proxy via X-Forwarded-Proto; cert validation (expiry, key match); refuses non-localhost bind without TLS or trusted-proxy detection; chain support.
   - Effort: 4h

7. **OAuth flow integration** -- End-to-end Authorization Code + PKCE.
   - Files: `server/auth/oauth/oauth-auth.ts`, `server/routes/auth.ts` (new)
   - Acceptance: `/auth/login?provider=X` initiates flow with cryptographic state; `/auth/callback` validates state (CSRF), exchanges code for tokens with PKCE, fetches user profile, creates session; `/auth/logout` clears session; rate-limited.
   - Effort: 5h

8. **Auth context middleware** -- Propagate identity through request lifecycle.
   - Files: `server/auth/middleware/{auth-context,require-auth}.ts` (new)
   - Acceptance: `c.get('auth')` available in all handlers; `requireAuth()` middleware returns 401 for unauthenticated; audit context populated for FR-S05; public routes (health, login) bypass auth.
   - Effort: 3h

9. **Binding security enforcement** -- Startup-time validation of mode + bind + TLS.
   - Files: `server/auth/security/{binding-enforcer,security-validator,network-scanner}.ts` (new)
   - Acceptance: each mode validates bind target; localhost mode refuses 0.0.0.0; tailscale refuses non-Tailscale IPs; oauth refuses 0.0.0.0 without TLS; clear errors guide operator to correct config.
   - Effort: 3h

10. **Comprehensive security testing** -- Attack scenario coverage per mode.
    - Files: `server/auth/tests/security/*.test.ts` (new)
    - Acceptance: forged Tailscale header rejected (peer IP CIDR check); OAuth state-mismatch rejected (CSRF); session fixation prevented (regen after auth); session timeout enforced; binding-bypass attempts blocked; mocks for Tailscale CLI + OAuth providers; 95%+ coverage.
    - Effort: 8h

11. **Documentation + deployment guide** -- Per-mode setup with security threat model.
    - Files: `docs/authentication/{README,localhost-mode,tailscale-mode,oauth-mode,security-considerations,troubleshooting,migration-guide}.md`, `examples/auth-config/` (new)
    - Acceptance: each mode has setup guide; security considerations section with threat model; troubleshooting covers common errors; migration guide for switching between modes.
    - Effort: 4h

## Test Plan

### Per-mode Security Tests
- **Localhost**: refuse 0.0.0.0 binding; refuse 192.168.x bind; allow all 127.0.0.1 requests without auth
- **Tailscale**: forged X-Forwarded-For with tailnet IP rejected (peer IP must match); CIDR boundary tests; whois failure handling; CLI unavailable fails-fast
- **OAuth**: invalid state rejected; expired authorization code rejected; PKCE code-verifier mismatch rejected; session regeneration after auth verified
- **Session**: idle timeout enforced; absolute timeout enforced; secure cookie flags applied; session fixation prevented
- **TLS**: refuse non-localhost without TLS; reverse-proxy detection allows TLS-disabled mode behind proxy

### Performance Benchmarks
- localhost auth <1ms
- tailscale auth <50ms
- 100 concurrent session validations succeed

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Tailscale header forgery | High | Peer IP CIDR validation against `tailscale status` output; whois for high-value ops |
| OAuth CSRF via state manipulation | High | Cryptographic state; server-side validation; one-time use |
| Session fixation | High | Regenerate session ID after auth (mandatory) |
| Insecure bind exposing dev server | High | Multi-layer validation; fail-secure defaults; refuse 0.0.0.0 in localhost mode |
| TLS misconfiguration | Medium | Comprehensive cert validation; clear error messages; fallback patterns |

## Acceptance Criteria

- [ ] All three auth modes work end-to-end with documented config
- [ ] Localhost mode refuses bind to non-127.0.0.1 addresses
- [ ] Tailscale mode validates peer IP against tailnet CIDR
- [ ] OAuth flow uses PKCE per RFC 7636
- [ ] Sessions: httpOnly + SameSite=Strict + Secure + signed; 24h idle / 30d absolute
- [ ] Session ID regenerated after successful auth (defeats fixation)
- [ ] TLS required for non-localhost OR trusted reverse proxy detected
- [ ] Auth context propagates identity through Hono middleware chain
- [ ] All security tests pass (95%+ coverage)
- [ ] Documentation complete for each mode with threat model
- [ ] Performance: localhost <1ms, tailscale <50ms, OAuth <5s end-to-end
