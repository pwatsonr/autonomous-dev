# SPEC-030-1-03: Network-Bound Auth Tests — `localhost-auth`, `network-binding`, `tailscale-{client,auth}`

## Metadata
- **Parent Plan**: PLAN-030-1 (TDD-014 security test backfill)
- **Parent TDD**: TDD-030 §5.2 (localhost-auth, network-binding, tailscale blocks), §5.5
- **Tasks Covered**: TASK-004 (localhost-auth.test.ts), TASK-005 (network-binding.test.ts), TASK-006 (tailscale-client.test.ts + tailscale-auth.test.ts + co-located mock)
- **Estimated effort**: 3.5 days (1 + 1 + 1.5)
- **Depends on**: SPEC-030-1-01 phase A merged; SPEC-030-1-02 (cidr-utils.test.ts) merged for `network-binding.test.ts`'s CIDR baseline
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-030-1-03-network-bound-auth-tests-localhost-network-binding-tailscale.md`

## Description

Ship four test files (and one typed mock) covering the network-touching auth surfaces: localhost peer-address checks, server-bind + CIDR allowlist enforcement, and Tailscale identity resolution. These are the highest-acuity security tests in PLAN-030-1 because they cover request-admission decisions.

The Tailscale tests use a hand-written mock typed against the production `tailscale-client.ts` exports, co-located in `__tests__/__mocks__/` (TDD-030 §5.5, OQ-05). The mock implements the same TypeScript interface the real client exports, so a production-side rename or signature change breaks the mock at compile time.

No production auth code is modified by this spec. If a test reveals a real vulnerability, document the finding in the PR description and ship the fix as a separate hotfix PR (TDD-030 §8.1, PRD-016 R-03).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-portal/server/auth/__tests__/localhost-auth.test.ts` | Create | Real `http.createServer`; peer-address vs `X-Forwarded-For` |
| `plugins/autonomous-dev-portal/server/auth/__tests__/network-binding.test.ts` | Create | Server-bind invariant + CIDR allowlist enforcement |
| `plugins/autonomous-dev-portal/server/auth/__tests__/tailscale-client.test.ts` | Create | Client-boundary error handling |
| `plugins/autonomous-dev-portal/server/auth/__tests__/tailscale-auth.test.ts` | Create | Auth resolution against the mocked client |
| `plugins/autonomous-dev-portal/server/auth/__tests__/__mocks__/tailscale-client.ts` | Create | Typed mock; `implements` the production interface |

No production code modifications. No `package.json` changes (`nock` is not used in this spec; reserved for SPEC-030-1-04).

## Implementation Details

### `localhost-auth.test.ts`

Read `plugins/autonomous-dev-portal/server/auth/localhost-auth.ts` to confirm exports.

Test setup pattern:

```ts
import http from 'node:http';
// import the production middleware/handler from ../localhost-auth

let server: http.Server;
let port: number;

beforeEach(async () => {
  server = http.createServer(/* mounts the localhost-auth middleware */);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});
```

Test cases (`describe('localhost-auth')`):

| Case | Peer | Headers | Expected |
|------|------|---------|----------|
| IPv4 loopback | `127.0.0.1` | none | 200 |
| IPv6 loopback | `::1` | none | 200 (skip if test env cannot bind ::1; document) |
| IPv4-mapped IPv6 loopback | `::ffff:127.0.0.1` | none | 200 |
| Non-loopback peer | `10.0.0.5` (simulate via mocked req `socket.remoteAddress`) | none | 401 |
| Localhost-only mode disabled | any peer | none | 200 |
| **Spoofed XFF from non-loopback** | `10.0.0.5` socket | `X-Forwarded-For: 127.0.0.1` | **401** (the security assertion) |

Key constraint: bind to port `0` so CI cannot collide. Read `server.address().port` after `listen`. The "non-loopback peer" cases that cannot be reached via real TCP (because the test client is on the same loopback) are exercised by injecting a request whose `socket.remoteAddress` is overridden, OR by passing an explicit IP into the middleware's pure helper if such a helper exists; prefer the helper-form when available.

### `network-binding.test.ts`

Read `plugins/autonomous-dev-portal/server/auth/network-binding.ts` and `plugins/autonomous-dev-portal/server/auth/security/binding-enforcer.ts` to confirm exports. Both files are covered by this one suite.

Test cases:

| Case | Config | Expectation |
|------|--------|-------------|
| Bound to 127.0.0.1 | `bind: '127.0.0.1', allowlist: ['127.0.0.1/32']` | A `net.connect({ host: '0.0.0.0', port })` either rejects with `ECONNREFUSED` or times out within 200 ms; treat both as pass |
| Misconfigured allowlist | `allowlist: ['not-a-cidr']` | `start()` (or factory) throws synchronously; server is never `.listening === true` |
| Empty allowlist + 0.0.0.0 | `bind: '0.0.0.0', allowlist: []` | Throws synchronously; no permissive fallback |
| Valid allowlist + matching peer | `allowlist: ['127.0.0.0/8']`, peer 127.0.0.1 | 200 |
| Valid allowlist + non-matching peer | `allowlist: ['10.0.0.0/8']`, peer 127.0.0.1 | 403 |

Use `net.createConnection` with a 200 ms timeout for the "no listener on 0.0.0.0" assertion (TDD-030 §5.2, mitigation in PLAN-030-1 TASK-005). The test passes if EITHER:
- the connection emits an `error` whose `error.code === 'ECONNREFUSED'`, OR
- the timeout fires before any `connect` event.

Both branches indicate "no listener on 0.0.0.0:port"; CI flake risk is mitigated by accepting either.

### `tailscale-client.test.ts` and `tailscale-auth.test.ts`

Read `plugins/autonomous-dev-portal/server/auth/tailscale-client.ts` and `plugins/autonomous-dev-portal/server/auth/tailscale-auth.ts` first. Identify the smallest TypeScript interface that the auth module imports from the client module — that interface (or its inferred shape) is what the mock implements.

`__tests__/__mocks__/tailscale-client.ts`:

```ts
import type { TailscaleClient /* or whatever the production interface is named */ } from '../../tailscale-client';

export function createMock(overrides: Partial<TailscaleClient> = {}): TailscaleClient {
  return {
    getIdentity: jest.fn().mockResolvedValue({ /* default valid identity shape */ }),
    // …all required methods, defaulted to passing implementations…
    ...overrides,
  };
}
```

Constraints:
- The mock module MUST import the type from the production file. A production-side rename or signature change therefore breaks the mock at TypeScript compile time (TDD-030 §8.4 mitigation).
- If the production module does not export a TypeScript interface (only concrete functions), define a structural interface inside the mock file that mirrors the exports and have the test import from the mock-defined interface AND the production module — TypeScript will surface drift as an assignability error.
- Default mock returns a valid identity object so the happy-path test does not have to override.

`tailscale-client.test.ts` cases:

| Case | Mock setup | Expected |
|------|-----------|----------|
| Daemon socket missing | `getIdentity` rejects with `{ code: 'ENOENT', path: '/var/run/tailscale/...' }` | Production wrapper throws a typed error; assertion is on `error.code` (or instanceof) |
| Malformed identity payload | `getIdentity` resolves with `{}` | Typed error |
| Expired token | `getIdentity` rejects with a 401-like error | Typed error |
| Happy path | default mock | Resolves to identity |

`tailscale-auth.test.ts` cases:

| Case | Mock setup | Expected |
|------|-----------|----------|
| Happy path | valid identity | Auth resolves user; no exception |
| Identity with no user mapping | identity object with unknown user | Typed error (depending on production semantics; verify) |
| Underlying client rejection | client throws | Auth re-throws or wraps; assertion on typed property |

Both test files use `jest.mock('../tailscale-client')` to substitute the typed mock; the mock is loaded automatically by Jest when both the production path and the `__mocks__/` co-location match.

## Acceptance Criteria

### `localhost-auth.test.ts`

- AC-1: `npx jest plugins/autonomous-dev-portal/server/auth/__tests__/localhost-auth.test.ts` exits 0.
- AC-2: All six rows in the test-cases table are present as `it()` blocks and pass.
- AC-3: The "spoofed XFF from non-loopback" case asserts the response is 401 — this is the security assertion. A passing test where the response is 200 is a real vulnerability (escalate per TDD-030 §8.1).
- AC-4: Server is bound to port 0 (NOT a hard-coded port). `server.address().port` is read after `listen`.
- AC-5: Line coverage of `localhost-auth.ts` ≥ 90 %.

### `network-binding.test.ts`

- AC-6: All five rows in the test-cases table are present and pass.
- AC-7: The "no listener on 0.0.0.0" assertion accepts either `ECONNREFUSED` or a 200 ms timeout; both branches are exercised in code review (visible `||` in the assertion).
- AC-8: The misconfigured-allowlist case asserts `server.listening === false` (or the equivalent — never enters listening state).
- AC-9: Combined line coverage of `network-binding.ts` + `security/binding-enforcer.ts` ≥ 90 %.

### `tailscale-{client,auth}.test.ts`

- AC-10: `__tests__/__mocks__/tailscale-client.ts` imports a type from `../../tailscale-client`. A `grep "from '\\.\\./\\.\\./tailscale-client'"` against the mock returns at least one hit.
- AC-11: All four `tailscale-client.test.ts` cases pass; all three `tailscale-auth.test.ts` cases pass.
- AC-12: Every error assertion uses a typed property — no `error.message` substring matching.
- AC-13: Combined line coverage of `tailscale-auth.ts` + `tailscale-client.ts` ≥ 90 %.
- AC-14: Renaming a method on the production `tailscale-client.ts` (one-shot dev experiment, NOT committed) breaks `tsc --noEmit` for the mock file. Verify and document in the PR description that this experiment was performed and reverted.

### Given/When/Then (security-critical)

```
Given a server bound to 127.0.0.1
When the localhost-auth middleware receives a request from socket peer 10.0.0.5
And the request carries header X-Forwarded-For: 127.0.0.1
Then the response status is 401
And the response body indicates "not from loopback" (or equivalent)

Given the server is configured with allowlist ['not-a-cidr']
When the auth subsystem starts
Then startup throws a typed error
And the underlying http server never enters the listening state

Given the Tailscale daemon socket does not exist (ENOENT)
When tailscale-client.getIdentity is invoked
Then it rejects with an error whose error.code === 'ENOENT' (or the equivalent typed property)
And no string-matching against error.message is required to detect the case
```

## Test Requirements

The four files together must:
1. Pass under `npx jest --runInBand` from the autonomous-dev plugin root.
2. Pass in isolation per file.
3. Reach the per-file coverage targets above when run with `--coverage`.
4. Not introduce any test-time port collisions (port 0 binding only).

## Implementation Notes

- For `localhost-auth.test.ts`, IPv6 loopback (`::1`) testing depends on the CI host's IPv6 configuration. If `server.listen(0, '::1', ...)` fails with `EADDRNOTAVAIL`, mark that single `it` as `it.skip` with a TODO comment referencing TDD-030 §5.2. Do not use a `try/catch` around `expect`.
- The `network-binding` "no listener on 0.0.0.0" assertion is timing-sensitive on busy CI; the 200 ms accept-either-branch design is the explicit mitigation.
- The Tailscale mock co-location follows the established portal convention; if the portal does not currently use `__mocks__/` directories, this is the first instance — document the precedent in the PR description.
- Do NOT use `nock` here. Tailscale auth flows do not go over HTTP from the portal's perspective (they speak the local socket); HTTP mocking is a SPEC-030-1-04 concern (OAuth).

## Rollout Considerations

Pure additive. Revert the five files to roll back. The mock co-location is a new convention — if a portal-wide test guideline forbids `__mocks__/`, raise in review; otherwise this spec sets the precedent.

## Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Real auth vulnerability surfaced (e.g., XFF accepted) | Medium | High (security) | TDD-030 §8.1: document in PR, separate hotfix; do not block merge unless critical |
| Port collision on CI | Low | Medium | Bind to port 0 always |
| Tailscale mock drifts from production interface | Low | Medium | Mock imports the production type; TS catches drift at compile time |
| IPv6 loopback unavailable on CI | Medium | Low | `it.skip` with documented TODO |
| Timing flake on "no listener" assertion | Medium | Medium | Accept ECONNREFUSED OR 200 ms timeout |
