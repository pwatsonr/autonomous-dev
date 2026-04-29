# SPEC-014-1-03: Tailscale Mode and Peer Identity Verification

## Metadata
- **Parent Plan**: PLAN-014-1
- **Tasks Covered**: Task 3 (Tailscale mode), portions of Task 9 (Tailscale binding enforcement)
- **Estimated effort**: 8 hours

## Description
Implement Tailscale authentication mode per TDD-014 §22.1. The provider binds the portal exclusively to the host's Tailscale interface IP (resolved via `tailscale ip --4`), validates that incoming peer IPs fall within the tailnet CIDR (resolved via `tailscale status --json`), and applies a defense-in-depth `tailscale whois` lookup for high-value mutating operations (write methods on routes annotated as sensitive). The mode refuses to start if the `tailscale` CLI is not on the PATH or returns a non-zero exit code. All header-based identity claims (`Tailscale-User-Login`, `Tailscale-User-Name`) are accepted ONLY after the peer-IP CIDR check passes — this is the core defense against forged-header attacks.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `server/auth/tailscale-auth.ts` | Create | `TailscaleAuthProvider` implementing `AuthProvider` |
| `server/auth/tailscale-client.ts` | Create | Typed wrapper around `tailscale ip` / `tailscale status --json` / `tailscale whois` (subprocess, no library) |
| `server/auth/cidr-utils.ts` | Create | `parseCIDR(s)` and `ipInCIDR(ip, cidr)` for IPv4 and IPv6/100.x ranges |
| `server/auth/network-binding.ts` | Modify | Extend `enforceBinding` (from SPEC-014-1-02) to gate Tailscale mode against `0.0.0.0` and resolve interface IP |
| `server/auth/__tests__/tailscale-auth.test.ts` | Create | Provider tests with mocked CLI client |
| `server/auth/__tests__/tailscale-client.test.ts` | Create | Subprocess-fixture tests (recorded JSON/stdout golden files) |
| `server/auth/__tests__/cidr-utils.test.ts` | Create | CIDR boundary tests |

## Implementation Details

### Task 3.1: TailscaleClient (`server/auth/tailscale-client.ts`)

Strict typed wrapper around `Bun.spawn` (NEVER `exec` with shell interpolation):

```ts
export interface TailscaleClient {
  ensureAvailable(): Promise<void>;                                          // throws TAILSCALE_CLI_UNAVAILABLE
  getInterfaceIp(): Promise<string>;                                          // throws TAILSCALE_NO_INTERFACE_IP
  getTailnetCIDRs(): Promise<string[]>;                                       // returns ['100.64.0.0/10','fd7a:115c:a1e0::/48']
  whois(peerIp: string): Promise<{ login: string; display_name: string } | null>;
}
```

Implementation rules (CliTailscaleClient):
- `ensureAvailable`: runs `tailscale version`; non-zero exit OR ENOENT throws `TAILSCALE_CLI_UNAVAILABLE`.
- `getInterfaceIp`: runs `tailscale ip --4`, takes first line, validates `/^100\.\d+\.\d+\.\d+$/`. Mismatched output throws `TAILSCALE_NO_INTERFACE_IP`.
- `getTailnetCIDRs`: runs `tailscale status --json` to confirm the daemon is up but returns the Tailscale-documented CGNAT range and IPv6 ULA range as constants. Hard-coding is more robust than parsing the JSON, whose schema has changed across releases.
- `whois`: runs `tailscale whois --json <peerIp>` (peerIp validated as IP literal first); returns null on non-zero exit or missing `UserProfile.LoginName`.
- All calls use array-arg `Bun.spawn`, 5-second timeout, throw `TAILSCALE_CLI_TIMEOUT` on hang.

### Task 3.2: CIDR Utilities (`server/auth/cidr-utils.ts`)

Exports: `parseCIDR(s)`, `ipInCIDR(ip, range)`, `ipInAnyCIDR(ip, ranges)`. `CIDRRange` shape: `{ kind: 'v4'|'v6', bytes: Uint8Array, prefixLen: number }`.

Rules:
- `parseCIDR` throws `SecurityError('INVALID_CIDR')` on malformed input (missing slash, prefix > 32 for v4 or > 128 for v6, non-numeric octets).
- `ipInCIDR` does byte-wise prefix comparison after AND-ing with the prefix mask. Cross-family comparisons (v4 ip vs v6 range) return `false`.
- IPv4-mapped IPv6 addresses (`::ffff:100.64.0.1`) are normalized to IPv4 before comparison.

Test boundaries (in `cidr-utils.test.ts`):

| ip | cidr | expected |
|----|------|----------|
| `100.64.0.0` | `100.64.0.0/10` | `true` (lower bound) |
| `100.127.255.255` | `100.64.0.0/10` | `true` (upper bound) |
| `100.128.0.0` | `100.64.0.0/10` | `false` (one above) |
| `100.63.255.255` | `100.64.0.0/10` | `false` (one below) |
| `192.168.1.1` | `100.64.0.0/10` | `false` |
| `fd7a:115c:a1e0::1` | `fd7a:115c:a1e0::/48` | `true` |
| `fd7a:115c:a1e1::1` | `fd7a:115c:a1e0::/48` | `false` |
| `127.0.0.1` | `100.64.0.0/10` | `false` |

### Task 3.3: TailscaleAuthProvider (`server/auth/tailscale-auth.ts`)

`init()`:
1. `await client.ensureAvailable()` — fail-fast if CLI absent.
2. Resolve and cache `interfaceIp = await client.getInterfaceIp()`.
3. Resolve `cidrs = (await client.getTailnetCIDRs()).map(parseCIDR)`.
4. Log `tailscale.auth.initialized {interface_ip, cidrs}`.

`evaluate(request, peerIp)`:
1. If `!ipInAnyCIDR(peerIp, cidrs)`: log `tailscale.auth.peer_not_in_tailnet` and return `deny 403 NOT_IN_TAILNET`.
2. Read `Tailscale-User-Login` / `Tailscale-User-Name` headers (may be absent).
3. Compute `isMutating = !['GET','HEAD','OPTIONS'].includes(request.method)` and `requireWhois = config.tailscale?.require_whois_for_writes ?? true`.
4. If `isMutating && requireWhois`: call `await client.whois(peerIp)`. If null → return `deny 403 WHOIS_FAILED`. Otherwise OVERWRITE login/displayName from whois result — header values are NEVER trusted for mutating operations.
5. If no identity present after step 4: synthesize `source_user_id = 'tailnet-peer:' + peerIp` (read-only anonymous tailnet peer is allowed).
6. Return `allow` with `mode='tailscale'`, `details: { peer_ip, whois_verified: isMutating && requireWhois }`.

Security property: forged-header attack (peer sets `Tailscale-User-Login: admin@evil`) is defeated because mutating-op whois lookup overwrites the header value with the daemon's authoritative identity for that peer IP.

### Task 3.4: Binding Extension (`server/auth/network-binding.ts`)

Extend `enforceBinding` (from SPEC-014-1-02) for tailscale mode:
1. Reject `bind_host` of `'0.0.0.0'` or `'::'` with `TAILSCALE_FORBIDDEN_BIND`.
2. Throw `TAILSCALE_BINDING_NO_CLIENT` if no `TailscaleClient` was injected.
3. Resolve `tsIp = await client.getInterfaceIp()`.
4. If `bind_host !== tsIp` AND `bind_host !== 'auto'`: throw `TAILSCALE_BIND_MISMATCH` with both values in the error.
5. `bind_host: 'auto'` is the recommended setting; `server.ts` substitutes the resolved interface IP before `serve(...)`.

### Task 3.5: Subprocess Fixtures (`server/auth/__tests__/tailscale-client.test.ts`)

Tests run against a stub `Bun.spawn` that returns recorded fixtures from `tests/fixtures/tailscale/`:
- `ip-v4.stdout`: `100.64.10.5\n`
- `status.json`: minimal but valid `tailscale status --json` output
- `whois-success.json`: shape `{ "UserProfile": { "LoginName": "alice@example.com", "DisplayName": "Alice" } }`
- `whois-not-found.stdout`: empty (with exitCode 1)
- `version.stdout`: `1.62.0\n`

Each fixture file is committed to the repo. The test harness wires `Bun.spawn` to read from these fixtures based on argv pattern matching.

### Task 3.6: Provider Test Matrix (`server/auth/__tests__/tailscale-auth.test.ts`)

| Scenario | Method | peer IP | header `Tailscale-User-Login` | whois result | Expected |
|----------|--------|---------|-------------------------------|--------------|----------|
| GET from tailnet, no header | GET | `100.64.10.5` | (none) | n/a | allow `source_user_id='tailnet-peer:100.64.10.5'` |
| GET from tailnet, with header | GET | `100.64.10.5` | `alice@x` | n/a (whois NOT called for read) | allow `source_user_id='alice@x'` (header trusted for reads) |
| POST from tailnet, header forged, whois returns alice | POST | `100.64.10.5` | `admin@evil` | `{login:'alice@x', ...}` | allow `source_user_id='alice@x'` (header IGNORED) |
| POST from tailnet, whois fails | POST | `100.64.10.5` | `alice@x` | `null` | deny 403 `WHOIS_FAILED` |
| GET from non-tailnet | GET | `192.168.1.5` | `alice@x` | n/a | deny 403 `NOT_IN_TAILNET` |
| GET from boundary 100.128.0.0 | GET | `100.128.0.0` | (none) | n/a | deny 403 `NOT_IN_TAILNET` |
| `require_whois_for_writes: false`, POST | POST | `100.64.10.5` | `alice@x` | (not called) | allow `source_user_id='alice@x'` (whois disabled) |

Init failure tests:
- `client.ensureAvailable()` throws → `TailscaleAuthProvider.init()` propagates `TAILSCALE_CLI_UNAVAILABLE`
- `client.getInterfaceIp()` returns garbage → propagates `TAILSCALE_NO_INTERFACE_IP`

## Acceptance Criteria

- [ ] `CliTailscaleClient.ensureAvailable()` throws `TAILSCALE_CLI_UNAVAILABLE` when subprocess exits non-zero or binary missing
- [ ] `CliTailscaleClient` uses array-arg form to `Bun.spawn` (no shell interpolation); peerIp argument validated as IP literal before passing to `whois`
- [ ] Each subprocess call has a 5-second timeout; hang throws `TAILSCALE_CLI_TIMEOUT`
- [ ] `parseCIDR` throws `INVALID_CIDR` for malformed input
- [ ] `ipInCIDR` correctly handles all CIDR boundary tests in §Task 3.2
- [ ] `ipInCIDR` returns false for cross-family comparisons (v4 ip vs v6 range)
- [ ] `TailscaleAuthProvider.init()` calls `ensureAvailable`, `getInterfaceIp`, and `getTailnetCIDRs` exactly once
- [ ] `evaluate()` denies 403 `NOT_IN_TAILNET` for peer IPs outside the tailnet CIDRs
- [ ] `evaluate()` for mutating methods (POST/PUT/DELETE/PATCH) calls `whois(peerIp)` and IGNORES `Tailscale-User-Login` / `Tailscale-User-Name` headers
- [ ] `evaluate()` for mutating methods denies 403 `WHOIS_FAILED` when `whois` returns null
- [ ] `evaluate()` for read methods (GET/HEAD/OPTIONS) trusts header identity if peer IP is in tailnet
- [ ] `evaluate()` for read methods with no identity header sets `source_user_id` to `tailnet-peer:<ip>`
- [ ] `require_whois_for_writes: false` skips whois even for mutating methods (operator opt-out)
- [ ] Forged-header attack test passes: POST with `Tailscale-User-Login: admin@evil` and whois returning `alice@x` results in `source_user_id='alice@x'`
- [ ] `enforceBinding` for tailscale mode rejects `bind_host=0.0.0.0` with `TAILSCALE_FORBIDDEN_BIND`
- [ ] `enforceBinding` for tailscale mode rejects `bind_host` mismatched with the resolved interface IP (when not `'auto'`)
- [ ] `bind_host: 'auto'` resolves to the Tailscale interface IP at startup
- [ ] All subprocess interactions are tested via recorded fixtures; no live `tailscale` CLI required for tests
- [ ] `tsc --strict` passes; no `any` in public signatures

## Dependencies

- `AuthProvider`, `AuthDecision`, `AuthContext`, `SecurityError`, `BaseAuthProvider` from SPEC-014-1-01
- `extractPeerIp` from SPEC-014-1-01
- `enforceBinding` baseline from SPEC-014-1-02 (extended here)
- Tailscale CLI installed on the deployment host (runtime requirement, not a build dep)
- No new npm dependencies; uses Bun's built-in `Bun.spawn` for subprocess

## Notes

- We deliberately call `tailscale whois` per mutating request rather than caching results. Cache invalidation is a security risk: a revoked node's identity could persist beyond the revocation window. The 5-second timeout caps worst-case latency at 5s; typical whois calls are <50ms.
- Hard-coding the tailnet CIDRs (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) is more robust than parsing per-node IPs from `status --json` because the JSON schema has changed multiple times across Tailscale releases. The CGNAT range is RFC-stable.
- Read-only requests trust the `Tailscale-User-Login` header *after* the peer-IP CIDR check passes. The TDD-014 §22.1 threat model explicitly allows this: a peer in the tailnet has already been authenticated by `tailscaled`, so its IP is a strong identifier; spoofing the header from inside the tailnet implies a compromised tailnet member, which is a different threat.
- We do NOT implement `tailscale serve` integration here — operators run their own Funnel/serve config externally. This spec is purely about the portal's auth gate.
- The `require_whois_for_writes: false` opt-out exists for ops who want minimum-latency writes from a known-safe tailnet (e.g., single-user homelab). Default is `true` (defense-in-depth).
