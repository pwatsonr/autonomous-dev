# SPEC-014-1-02: Localhost-Only Enforcement

## Parent Plan
- **Parent Plan**: PLAN-014-1
- **Tasks Covered**: Task 2 (localhost mode + binding enforcement), portions of Task 9 (binding security enforcer)
- **Estimated effort**: 4 hours

## Description
Implement the localhost authentication mode and the network-binding gate that protects it. The provider grants access to all requests originating from the loopback interface and denies everything else — even when reverse-proxy headers claim a localhost source. The binding enforcer runs at startup and refuses to bring the server up on any address other than `127.0.0.1` when `auth_mode='localhost'`. Together these two layers guarantee that the localhost mode cannot be accidentally exposed to a network — neither via misconfiguration (`bind_host=0.0.0.0`) nor via header spoofing (`X-Forwarded-For: 127.0.0.1` from a remote attacker).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `server/auth/localhost-auth.ts` | Create | `LocalhostAuthProvider` implementing `AuthProvider` from SPEC-014-1-01 |
| `server/auth/network-binding.ts` | Create | `enforceBinding(config)` startup gate + loopback IP detection helpers |
| `server/auth/security/binding-enforcer.ts` | Create | Wraps `enforceBinding` and emits structured logs at startup |
| `server/server.ts` | Modify | Call `enforceBinding(config)` before `serve(...)` |
| `server/auth/__tests__/localhost-auth.test.ts` | Create | Unit tests per the test matrix below |
| `server/auth/__tests__/network-binding.test.ts` | Create | Unit tests for binding refusals |

## Implementation Details

### Task 2.1: `LocalhostAuthProvider` (`server/auth/localhost-auth.ts`)

```ts
export class LocalhostAuthProvider extends BaseAuthProvider implements AuthProvider {
  readonly mode = 'localhost' as const;
  constructor(private readonly config: PortalConfig, private readonly logger: Logger) { super(); }

  async init(): Promise<void> {
    if (this.config.bind_host !== '127.0.0.1') {
      throw new SecurityError(
        'LOCALHOST_REQUIRES_LOOPBACK',
        `auth_mode='localhost' requires bind_host='127.0.0.1' (got '${this.config.bind_host}')`,
      );
    }
  }

  async evaluate(_request: Request, peerIp: string): Promise<AuthDecision> {
    if (!isLoopbackIp(peerIp)) {
      this.logger.warn('localhost.auth.rejected_non_loopback', { peer_ip: peerIp });
      return { kind: 'deny', status: 403, error_code: 'NON_LOOPBACK', message: 'Localhost mode requires loopback origin' };
    }
    return {
      kind: 'allow',
      context: {
        authenticated: true,
        mode: 'localhost',
        source_user_id: 'localhost',
        display_name: 'Local Operator',
        details: { peer_ip: peerIp },
      },
    };
  }
}
```

The `peerIp` value is what `extractPeerIp` from SPEC-014-1-01 returned. Because that helper IGNORES `X-Forwarded-For` unless `trusted_reverse_proxy=true`, this provider naturally rejects header-spoofing attacks. CRITICAL: this provider MUST NOT call into request headers itself — its decision MUST be a pure function of the `peerIp` argument.

### Task 2.2: Loopback Detection (`server/auth/network-binding.ts`)

```ts
export function isLoopbackIp(ip: string): boolean {
  if (!ip) return false;
  // IPv4 loopback: exactly 127.0.0.1 (NOT the entire 127.0.0.0/8 — be strict)
  if (ip === '127.0.0.1') return true;
  // IPv6 loopback: ::1 and the IPv4-mapped form ::ffff:127.0.0.1
  if (ip === '::1') return true;
  if (ip === '::ffff:127.0.0.1') return true;
  return false;
}
```

Strictness rationale: matching the entire `127.0.0.0/8` range would allow a malicious local container with `127.10.0.5` to claim loopback identity in some kernel configurations. Pinning to the exact loopback IPs is safer and matches Bun's default loopback bind.

### Task 2.3: Binding Enforcer (`server/auth/network-binding.ts`)

```ts
export const FORBIDDEN_HOSTS_FOR_LOCALHOST_MODE = ['0.0.0.0', '::', 'localhost'];

export function enforceBinding(config: PortalConfig): void {
  if (config.auth_mode !== 'localhost') return; // other modes have their own enforcers

  if (FORBIDDEN_HOSTS_FOR_LOCALHOST_MODE.includes(config.bind_host)) {
    throw new SecurityError(
      'LOCALHOST_FORBIDDEN_BIND',
      `auth_mode='localhost' refuses to bind to '${config.bind_host}'. ` +
      `Use bind_host='127.0.0.1', or switch to auth_mode='tailscale' / 'oauth-pkce' for network exposure.`,
    );
  }
  if (config.bind_host !== '127.0.0.1') {
    throw new SecurityError(
      'LOCALHOST_REQUIRES_LOOPBACK',
      `auth_mode='localhost' requires bind_host='127.0.0.1' (got '${config.bind_host}'). ` +
      `Refusing to start to avoid accidental exposure.`,
    );
  }
  if (config.trusted_reverse_proxy === true) {
    throw new SecurityError(
      'LOCALHOST_REJECTS_PROXY',
      `auth_mode='localhost' is incompatible with trusted_reverse_proxy=true. ` +
      `A reverse proxy implies network exposure; switch to a network mode.`,
    );
  }
}
```

The third check (`trusted_reverse_proxy=true`) is essential: it closes the trust-the-proxy loophole that would otherwise let `X-Forwarded-For: 127.0.0.1` spoof loopback through `extractPeerIp`. In localhost mode, we refuse to trust ANY proxy.

### Task 2.4: Server Integration (`server/server.ts`)

Insert immediately after `validateStartupConditions(config)` and before `serve({...})`:

```ts
import { enforceBinding } from './auth/network-binding';
// ...
await validateStartupConditions(config);
enforceBinding(config); // <-- new gate; throws before any port is opened
// ... continue to serve()
```

The binding enforcer is intentionally redundant with `validateAuthConfig` (SPEC-014-1-01). Defense-in-depth: if a future refactor weakens the validator, the enforcer still blocks the bind.

### Task 2.5: Test Matrix

`server/auth/__tests__/localhost-auth.test.ts`:

| Scenario | peerIp | Expected decision |
|----------|--------|-------------------|
| Bun loopback v4 | `127.0.0.1` | `allow` |
| IPv6 loopback | `::1` | `allow` |
| IPv4-mapped IPv6 loopback | `::ffff:127.0.0.1` | `allow` |
| LAN address | `192.168.1.50` | `deny status=403 NON_LOOPBACK` |
| External | `203.0.113.5` | `deny status=403 NON_LOOPBACK` |
| Empty string | `''` | `deny status=403 NON_LOOPBACK` |
| Literal `'unknown'` (no socket info) | `'unknown'` | `deny status=403 NON_LOOPBACK` |
| Spoofed `127.0.0.1` after trim with whitespace | `' 127.0.0.1 '` | `deny status=403 NON_LOOPBACK` (no normalization in this layer) |
| Other 127/8 address (e.g. `127.0.0.2`) | `127.0.0.2` | `deny status=403 NON_LOOPBACK` |

`server/auth/__tests__/network-binding.test.ts`:

| Scenario | Expected |
|----------|----------|
| `auth_mode=localhost, bind_host=127.0.0.1` | passes silently |
| `auth_mode=localhost, bind_host=0.0.0.0` | throws `LOCALHOST_FORBIDDEN_BIND` |
| `auth_mode=localhost, bind_host=::` | throws `LOCALHOST_FORBIDDEN_BIND` |
| `auth_mode=localhost, bind_host=localhost` | throws `LOCALHOST_FORBIDDEN_BIND` |
| `auth_mode=localhost, bind_host=192.168.1.50` | throws `LOCALHOST_REQUIRES_LOOPBACK` |
| `auth_mode=localhost, trusted_reverse_proxy=true` | throws `LOCALHOST_REJECTS_PROXY` |
| `auth_mode=tailscale, bind_host=0.0.0.0` | passes (other mode's enforcer handles it) |
| `auth_mode=oauth-pkce, bind_host=0.0.0.0` | passes (other mode's enforcer handles it) |

The "other mode" tests guard against scope creep: this enforcer is strictly the localhost gate; the tailscale enforcer lives in SPEC-014-1-03, the oauth one is part of SPEC-014-1-01's `validateAuthConfig`.

### Task 2.6: Integration Test (Spoof Defense)

In `server/auth/__tests__/localhost-auth.test.ts` add an end-to-end test that drives the full middleware chain:

1. Start a Hono app with `auth_mode='localhost'`, `trusted_reverse_proxy=false`, `LocalhostAuthProvider` registered.
2. Issue a request with `X-Forwarded-For: 127.0.0.1` from a peer socket of `192.168.1.50`.
3. Assert response status `403`, body `{ error: 'NON_LOOPBACK' }`.
4. Confirm structured log `localhost.auth.rejected_non_loopback` was emitted with `peer_ip: '192.168.1.50'`.

This test is the canonical regression guard for "reject non-loopback even when proxied."

## Acceptance Criteria

- [ ] `LocalhostAuthProvider.init()` throws `SecurityError('LOCALHOST_REQUIRES_LOOPBACK')` for any non-loopback `bind_host`
- [ ] `LocalhostAuthProvider.evaluate()` returns `allow` exclusively for `127.0.0.1`, `::1`, and `::ffff:127.0.0.1`
- [ ] `LocalhostAuthProvider.evaluate()` returns `deny status=403 error_code='NON_LOOPBACK'` for ALL other peer IPs including LAN, external, empty, `'unknown'`, and other `127/8` addresses
- [ ] `LocalhostAuthProvider` does NOT read any HTTP headers — its decision is a pure function of `(_request, peerIp)`
- [ ] All allow decisions populate `AuthContext.source_user_id='localhost'`, `mode='localhost'`, `display_name='Local Operator'`
- [ ] `isLoopbackIp` returns `false` for `127.0.0.2`, `127.10.0.5`, and any other 127/8 address that is not exactly `127.0.0.1`
- [ ] `enforceBinding` throws `LOCALHOST_FORBIDDEN_BIND` for each of `0.0.0.0`, `::`, `localhost`
- [ ] `enforceBinding` throws `LOCALHOST_REQUIRES_LOOPBACK` for any non-loopback IP
- [ ] `enforceBinding` throws `LOCALHOST_REJECTS_PROXY` when `trusted_reverse_proxy=true`
- [ ] `enforceBinding` is a no-op for `auth_mode='tailscale'` and `auth_mode='oauth-pkce'`
- [ ] `server.ts` calls `enforceBinding` before opening the listening socket; failure aborts startup with exit code 1 and a clear stderr message
- [ ] Spoof defense integration test: request from peer `192.168.1.50` with `X-Forwarded-For: 127.0.0.1` returns 403 `NON_LOOPBACK`
- [ ] All unit-test scenarios in the test matrices pass
- [ ] `tsc --strict` passes; no `any` in public signatures

## Dependencies

- `AuthProvider`, `AuthDecision`, `AuthContext`, `SecurityError` from SPEC-014-1-01
- `BaseAuthProvider` from SPEC-014-1-01
- `extractPeerIp` from SPEC-014-1-01 (consumes its output)
- `PortalConfig` from PLAN-013-2 (extended in SPEC-014-1-01)
- Existing logger from PLAN-013-2 — used for `localhost.auth.rejected_non_loopback`

## Notes

- The decision to NOT match all of `127.0.0.0/8` is deliberate. On Linux containers and certain kernel configurations, IPs like `127.0.0.2` may be reachable from outside the host's loopback intent. We accept the marginal pain of breaking unusual setups in exchange for a sharp, auditable trust boundary.
- The triple-redundant rejection of network exposure (validator + provider + binding enforcer) is intentional. If any single layer is bypassed by a future refactor, the others still hold the line. Do NOT consolidate them.
- `trusted_reverse_proxy=true` is rejected outright in localhost mode rather than silently ignored: silent ignore would leave operators with a broken mental model. The explicit error guides them to the correct mode.
- This spec deliberately does not introduce HTTPS, certificates, or external auth — localhost mode is for trusted local development only. Production deployments use SPEC-014-1-03 or SPEC-014-1-04.
