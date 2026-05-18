# CSRF Test-Mode Bypass

**Status:** Active feature, opt-in via environment variable.
**Introduced:** PR #312 (CSRF middleware wiring for the portal).
**Audience:** Operators running the portal, plugin developers writing
end-to-end tests.

The portal's CSRF middleware honors a single, explicit bypass that lets
Cypress (and other E2E harnesses) issue state-mutating requests without
performing the double-submit cookie dance. This document captures the
exact conditions under which the bypass fires, the threat model that
justifies it, and the guardrails that keep it from being a production
risk.

## 1. What the bypass does

When **both** of the following are true, the portal's CSRF issuer and
enforcer middleware short-circuit and call `next()` immediately:

| Condition       | Source                              | Value required           |
|-----------------|-------------------------------------|--------------------------|
| Server env var  | `process.env.PORTAL_TEST_MODE`      | `"1"`, `"true"`, `"yes"` (case-insensitive, trimmed) |
| Request header  | `X-Cypress-Test`                    | exactly `"1"`            |

Both checks live in `server/security/csrf-wiring.ts`:

- The env var is read **once at startup** by `isTestModeEnabled()` and
  captured on the `PortalCsrf` instance returned from `buildPortalCsrf`.
  Changing the env at runtime has no effect — the server must restart.
- The header is checked **per request** by `portalCsrfIssuer` and
  `portalCsrfEnforcer`. Any other value (missing, empty, `"0"`,
  `"true"`, anything other than the literal string `"1"`) leaves the
  full CSRF flow in place.

Both gates must pass. There is no other bypass path. If `PORTAL_TEST_MODE`
is unset (the default), the header is ignored on every request.

### Outcome matrix

| `PORTAL_TEST_MODE` | `X-Cypress-Test` header | CSRF enforced? |
|--------------------|-------------------------|----------------|
| unset / empty / `"0"` | any value              | yes            |
| set (`"1"`/`"true"`/`"yes"`) | absent           | yes            |
| set                | `"2"`, `"true"`, `""`   | yes            |
| set                | `"1"`                   | **no — bypass** |

## 2. Threat model

For an external attacker to weaponize the bypass against a portal
instance, they would need **all** of the following:

1. **`PORTAL_TEST_MODE=1` (or equivalent) set in the running server's
   environment.** This is the operator-controlled toggle. The default
   build, the default install script, and the launchd plist template
   shipped with the plugin do not set it. The operator has to do it
   on purpose.
2. **Network reach to the portal.** The default `auth_mode: localhost`
   binds the portal to loopback (`127.0.0.1` / `localhost`) and
   constrains the CORS + Origin allowlist to those addresses. A
   remote attacker is fenced out before the CSRF layer is ever
   consulted.
3. **The ability to send a request with `X-Cypress-Test: 1`.** From a
   browser, this is a non-CORS-safelisted header, so the request
   triggers a preflight that must pass the portal's CORS allowlist.
   On `auth_mode: localhost`, only loopback origins are allowed; on
   other modes, only operator-supplied `allowed_origins` are.

Practically, exploiting the bypass requires the attacker to **already
be running code on the operator's host** (to read/forge headers via a
local agent, or to set the env var). At that point CSRF is the smaller
of the operator's problems: the attacker has the same filesystem and
process access as the portal itself.

This is the standard rationale for opt-in test bypasses: shifting the
trust boundary from "any web request" to "any process able to set my
env vars" is a meaningful escalation of the attack cost.

## 3. Defense in depth

Even with the bypass enabled and active, the following protections
remain in force:

| Layer                       | Still active when bypass fires? | Notes |
|-----------------------------|---------------------------------|-------|
| Loopback-only bind (default) | yes                            | `auth_mode: localhost` binds to `127.0.0.1` / `localhost` only. |
| CORS allowlist              | yes                             | Cross-origin browsers cannot send `X-Cypress-Test` without a passing preflight. |
| Origin / Referer validator (`OriginValidator`) | **no — gated by the bypass** | The origin fence runs inside the CSRF enforcer; the bypass skips both. |
| Double-submit cookie / token signature | **no — gated by the bypass** | Skipped along with the rest of the enforcer. |
| HttpOnly + SameSite=Strict cookies | yes                       | Cookie attributes are set independently of the CSRF check itself. |
| CSP (per-request nonce)     | yes                             | `cspMiddleware` runs earlier in the chain. |
| Security headers (HSTS, X-Frame-Options, Referrer-Policy) | yes | Run earlier in the chain. |
| Auth middleware (when configured) | yes                       | The bypass is scoped to CSRF; auth checks elsewhere still gate access. |

The CSRF-specific protections (origin fence + double-submit token) are
the layers that fall off. Everything outside the CSRF pair — including
the network fence that keeps remote callers out — keeps running.

## 4. Operational guidance

### Production checklist

- **Never set `PORTAL_TEST_MODE` in production environments.** The
  plugin's installer scripts, plist templates, and systemd units do
  not set it. If you see it in a wrapper script, a docker-compose
  `environment:` block, a `.env` file, or a launchd `EnvironmentVariables`
  dict on a production host, remove it.
- The variable is read at process startup. A change requires a
  daemon restart (`autonomous-dev daemon stop && start`) to take
  effect, in either direction.

### Verifying it is not set on a running portal

On the host running the portal:

```bash
# macOS / Linux: inspect the env of the running portal process
ps -eo pid,command | grep -i portal
cat /proc/<PID>/environ 2>/dev/null | tr '\0' '\n' | grep PORTAL_TEST_MODE
# (no output ⇒ not set)
```

On macOS, where `/proc` is absent:

```bash
launchctl print gui/$(id -u)/com.autonomous-dev.portal 2>/dev/null \
  | grep -i PORTAL_TEST_MODE
# (no output ⇒ not set in the launchd job)
```

You can also confirm at the application level by issuing a state-changing
request without a CSRF token and asserting a 403:

```bash
curl -i -X POST http://127.0.0.1:<port>/api/requests \
  -H 'Origin: http://127.0.0.1:<port>' \
  -H 'Content-Type: application/json' \
  --data '{}'
# Expect: HTTP/1.1 403 Forbidden (CSRF token missing/invalid)
```

If you receive any 2xx/4xx other than a CSRF rejection, the bypass may
be in effect — or some other middleware shape has changed.

## 5. Test setup (for plugin developers)

If you are writing Cypress, Playwright, or similar end-to-end tests
against the portal, opt in as follows:

1. **Start the portal with the env var set.** Locally:

   ```bash
   PORTAL_TEST_MODE=1 bun run --cwd plugins/autonomous-dev-portal start
   ```

   In CI, export it on the job that starts the portal before tests.

2. **Send `X-Cypress-Test: 1` on every state-mutating request.** In
   Cypress:

   ```js
   Cypress.Commands.overwrite('request', (orig, opts) => {
     opts = typeof opts === 'string' ? { url: opts } : { ...opts };
     opts.headers = { ...(opts.headers ?? {}), 'X-Cypress-Test': '1' };
     return orig(opts);
   });
   ```

3. **Do not leave the env var set after the run.** CI jobs that scope
   env vars to a single step (GitHub Actions `env:` on the relevant
   `run:` step, not job-level) are preferred. Local developers should
   not export it in their shell profile.

4. **Unit / integration tests do not need the bypass.** They construct
   the CSRF middleware directly and inject a valid token. The bypass
   exists only for browser-driven tests where executing the full
   double-submit handshake from a test runner is impractical.

## 6. References

- `plugins/autonomous-dev-portal/server/security/csrf-wiring.ts` —
  bypass implementation (`isTestModeEnabled`, `portalCsrfIssuer`,
  `portalCsrfEnforcer`).
- `plugins/autonomous-dev-portal/server/middleware/index.ts` —
  middleware chain ordering, where CSRF is mounted relative to CORS.
- `plugins/autonomous-dev-portal/server/security/csrf-protection.ts` —
  the underlying CSRFProtection / OriginValidator primitives.
- `plugins/autonomous-dev-portal/docs/env-vars.md` — operator-facing
  reference for `PORTAL_TEST_MODE` and other portal env vars.
- PR #312 — wired the CSRF middleware into the portal chain.
