# PLAN-030-1: TDD-014 Security Test Backfill (Auth Surface Unit Tests)

## Metadata
- **Parent TDD**: TDD-030-closeout-backfill-014-015-019 (§5)
- **Parent PRD**: PRD-016 Test-Suite Stabilization & Jest Harness Migration
- **Sibling plans**: PLAN-030-2 (portal pipelines), PLAN-030-3 (plugin-reload CLI)
- **Estimated effort**: 6-8 days (≈24 engineer-hours, per TDD-030 §8.6)
- **Dependencies**: ["TDD-029 merged"] — clean jest gate must exist before these tests can land
- **Blocked by**: []
- **Priority**: P0 (closes the highest-acuity gap; auth ships with zero coverage)

## Objective

Ship the nine missing security test files under
`plugins/autonomous-dev-portal/server/auth/__tests__/` that TDD-014's SPEC enumerated
but never landed. Bring `server/auth/**/*.ts` from 0% measured coverage to ≥90% line
coverage, enforced via Jest's `coverageThreshold` config so CI fails on regression.

This plan ships **tests only**. No production auth code is modified. If a test reveals
a real vulnerability (per PRD-016 R-03 / TDD-030 §8.1), the finding is documented in
the PR description and a separate hotfix PR is opened — merging this plan is **not**
blocked on auth fixes.

The nine new test files map 1:1 to the existing auth modules (TDD-030 §5.1):

| Test file (NEW) | Production module(s) covered |
|-----------------|------------------------------|
| `localhost-auth.test.ts` | `server/auth/localhost-auth.ts` |
| `network-binding.test.ts` | `server/auth/network-binding.ts` + `server/auth/security/binding-enforcer.ts` |
| `cidr-utils.test.ts` | `server/auth/cidr-utils.ts` |
| `tailscale-auth.test.ts` | `server/auth/tailscale-auth.ts` |
| `tailscale-client.test.ts` | `server/auth/tailscale-client.ts` |
| `oauth-flow.test.ts` | `server/auth/oauth/{oauth-auth,oauth-bootstrap,oauth-state,token-exchange}.ts` |
| `pkce-utils.test.ts` | `server/auth/oauth/pkce-utils.ts` |
| `session-security.test.ts` | `server/auth/session/{session-manager,session-cookie,file-session-store}.ts` |
| `csrf-protection.test.ts` | CSRF middleware adjacent to `server/auth/middleware/` |

## Scope

### In Scope

- 9 jest test files under `plugins/autonomous-dev-portal/server/auth/__tests__/`,
  scoped per TDD-030 §5.2 scenario lists.
- A portal-local `jest.config.cjs` (TDD-030 §5.4 Option A) included via `roots` in
  `plugins/autonomous-dev/jest.config.cjs` so the auth tests participate in the
  PRD-016 G-02 gate.
- A `coverageThreshold` config block enforcing ≥90% line coverage for
  `server/auth/**/*.ts` (TDD-030 OQ-30-06 → Yes).
- Mocking infrastructure: a hand-written `tailscale-client` mock typed against the
  production interface (TDD-030 §5.5); `nock` (already in portal devDeps) for OAuth
  HTTP; `mkdtempSync` per-test temp dirs for the file-session store; `jest.useFakeTimers`
  for session-timeout cases.
- A short `__tests__/README.md` explaining the bun-vs-jest split and the per-test
  mocking strategy (one paragraph each, not duplicating the TDD).

### Out of Scope

- Migrating the portal off `bun test` entirely (TDD-030 NG; deferred to a separate
  PRD).
- Integration tests against a real Tailscale daemon (TDD-030 NG-3007; covered by
  interface-boundary mocks per OQ-05).
- Adding new auth providers / SSO / additional OAuth issuers (TDD-030 NG-3002).
- Refactoring or rewriting the auth surface itself (TDD-030 NG-3001). If a test
  reveals a bug, the fix is a separate PR (TDD-030 §8.1, R-03).
- Test scaffolding for tests that won't ship (TDD-030 OQ-30-02; SPEC reconciliation
  is owned by TDD-031).
- Pipelines and CLI work (PLAN-030-2 and PLAN-030-3 respectively).

## Tasks

### TASK-001: Stand up portal-local jest config and wire into the gate

**Description:** Create `plugins/autonomous-dev-portal/jest.config.cjs` configured to
discover only the new `server/auth/__tests__/**/*.test.ts` files. Include this config
via `roots` (or `projects`, whichever matches the existing pattern for the deploy
plugins) in `plugins/autonomous-dev/jest.config.cjs`. Verify
`npx jest --runInBand --listTests` from the autonomous-dev plugin enumerates the
auth test files (initially zero, growing as later tasks add them).

**Files to create:**
- `plugins/autonomous-dev-portal/jest.config.cjs`
- `plugins/autonomous-dev-portal/server/auth/__tests__/README.md` (≤30 lines, links
  to TDD-030 §5)

**Files to modify:**
- `plugins/autonomous-dev/jest.config.cjs` (add the portal auth root)

**Dependencies:** []

**Acceptance Criteria:**
- `npx jest --runInBand --listTests` from `plugins/autonomous-dev/` includes the
  portal auth `__tests__/` directory in its scan paths.
- Adding a trivial `localhost-auth.test.ts` containing one passing `it("smoke", () =>
  expect(true).toBe(true))` is picked up and runs in the next task without further
  config.
- The portal's existing `bun test` continues to pass unchanged (the new jest config
  does not hijack bun's test discovery).
- TypeScript build of the portal continues to pass (`tsc --noEmit`).
- README references TDD-030 §5.4 Option A and §5.5 mocking strategy.

**Estimated Effort:** 0.5 day

**Track:** Infrastructure

**Risks:**
- **Medium:** Including a portal-local config via `roots` may cause module resolution
  surprises (portal uses Bun-style imports, autonomous-dev uses Node).
  - **Mitigation:** Use `projects` in the parent `jest.config.cjs` so each project gets
    its own `transform`, `moduleFileExtensions`, and `testEnvironment`.

---

### TASK-002: `cidr-utils.test.ts` (pure-function module — easiest first)

**Description:** Cover `server/auth/cidr-utils.ts`. Pure functions, no I/O, no mocks.
Acts as the canary for the jest setup from TASK-001.

**Files to create:**
- `plugins/autonomous-dev-portal/server/auth/__tests__/cidr-utils.test.ts`

**Dependencies:** [TASK-001]

**Acceptance Criteria** (per TDD-030 §5.2):
- IPv4 `10.0.0.0/8` → `10.1.2.3` matches; `192.168.1.1` does not.
- IPv6 `2001:db8::/32` → `2001:db8:1::1` matches; `2001:db9::1` does not.
- `/32` exact-match for IPv4 and `/128` exact-match for IPv6.
- Malformed inputs (`""`, `"not-a-cidr"`, `"10.0.0.0/33"`, `"::1/129"`) throw a typed
  error.
- Empty allowlist → `isAllowed` returns `false` (deny-by-default invariant).
- Line coverage of `cidr-utils.ts` ≥ 95% in the suite-local report.

**Estimated Effort:** 0.5 day

**Track:** Pure-function tests

**Risks:**
- **Low:** None — pure functions; if this task is hard, the jest config is wrong.

---

### TASK-003: `pkce-utils.test.ts` (pure crypto — RFC-7636 vectors)

**Description:** Cover `server/auth/oauth/pkce-utils.ts`. Pure crypto over
`crypto.subtle`. Asserts byte-for-byte against RFC-7636 example vectors so the test
is independent of implementation choice.

**Files to create:**
- `plugins/autonomous-dev-portal/server/auth/__tests__/pkce-utils.test.ts`

**Dependencies:** [TASK-001]

**Acceptance Criteria** (per TDD-030 §5.2):
- `code_verifier` length always within RFC-7636 bounds (43–128 chars).
- `code_challenge` = `BASE64URL(SHA256(verifier))`, asserted against the RFC-7636
  appendix-B verifier `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` →
  `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`.
- The S256 method is enforced; `plain` is rejected with a typed error.
- Generation is non-deterministic (two calls yield different verifiers; test 100
  iterations of uniqueness).
- Line coverage of `pkce-utils.ts` ≥ 95%.

**Estimated Effort:** 0.5 day

**Track:** Pure-function tests

**Risks:**
- **Low:** `crypto.subtle` is async; ensure `await` on every call.

---

### TASK-004: `localhost-auth.test.ts`

**Description:** Cover `server/auth/localhost-auth.ts`, including the security-critical
case that peer-address (not `X-Forwarded-For`) drives the decision.

**Files to create:**
- `plugins/autonomous-dev-portal/server/auth/__tests__/localhost-auth.test.ts`

**Dependencies:** [TASK-001]

**Acceptance Criteria** (per TDD-030 §5.2):
- IPv4 loopback `127.0.0.1` → allowed.
- IPv6 loopback `::1` → allowed.
- IPv4-mapped IPv6 loopback `::ffff:127.0.0.1` → allowed.
- Non-loopback `10.0.0.5` → 401.
- Localhost-only mode disabled → all requests allowed regardless of source.
- Spoofed `X-Forwarded-For: 127.0.0.1` from a non-loopback peer → 401 (asserts that
  the header does **not** override the peer check).
- Test uses a real `http.createServer` bound to `127.0.0.1`; the test client is the
  peer.
- Line coverage of `localhost-auth.ts` ≥ 90%.

**Estimated Effort:** 1 day

**Track:** Network-bound auth tests

**Risks:**
- **Low:** Port collisions in CI — bind to port `0` and read `server.address().port`.

---

### TASK-005: `network-binding.test.ts` (covers `network-binding.ts` + `security/binding-enforcer.ts`)

**Description:** Verify the bind-address invariants and CIDR allowlist enforcement.

**Files to create:**
- `plugins/autonomous-dev-portal/server/auth/__tests__/network-binding.test.ts`

**Dependencies:** [TASK-001, TASK-002 (cidr-utils)]

**Acceptance Criteria** (per TDD-030 §5.2):
- Server bound to `127.0.0.1:PORT` does not accept connections on `0.0.0.0`
  (assert ECONNREFUSED on a `0.0.0.0` connect attempt).
- Misconfigured CIDR allowlist (`["not-a-cidr"]`) → startup throws; the server never
  enters the listening state.
- Empty allowlist + `bind: "0.0.0.0"` → startup throws (no permissive fallback).
- Valid CIDR allowlist + matching peer → 200; non-matching peer → 403.
- Combined line coverage of `network-binding.ts` + `security/binding-enforcer.ts`
  ≥ 90%.

**Estimated Effort:** 1 day

**Track:** Network-bound auth tests

**Risks:**
- **Medium:** Asserting "no listener on 0.0.0.0" is timing-sensitive on busy CI hosts.
  - **Mitigation:** Use `net.connect` with a 200 ms timeout; treat ECONNREFUSED **or**
    timeout as the assertion-passing branch.

---

### TASK-006: `tailscale-client.test.ts` and `tailscale-auth.test.ts`

**Description:** Cover the Tailscale integration with a hand-written mock at the
client interface boundary (TDD-030 §5.5, OQ-05). The mock is typed against the
production `tailscale-client.ts` exports so TypeScript catches drift at compile time.

**Files to create:**
- `plugins/autonomous-dev-portal/server/auth/__tests__/tailscale-client.test.ts`
- `plugins/autonomous-dev-portal/server/auth/__tests__/tailscale-auth.test.ts`
- `plugins/autonomous-dev-portal/server/auth/__tests__/__mocks__/tailscale-client.ts`
  (typed mock; co-located per the existing portal convention)

**Dependencies:** [TASK-001]

**Acceptance Criteria** (per TDD-030 §5.2):
- Happy path: mock returns a valid identity object; `tailscale-auth` resolves the
  user.
- `ENOENT` on `/var/run/tailscale/...` → typed error (no swallowed exceptions, no
  string matching — assert on `error.code` or instance of a typed class).
- Malformed identity payload (`{}` instead of expected shape) → typed error.
- Expired token (mock returns 401 from the Tailscale API) → typed error.
- Mock import path resolves under jest's module resolver; the production code under
  test compiles unmodified.
- Combined line coverage of `tailscale-auth.ts` + `tailscale-client.ts` ≥ 90%.

**Estimated Effort:** 1.5 days (two files; mock authoring shared)

**Track:** Mocked-boundary tests

**Risks:**
- **Medium:** Hand-written mock drifts from the real `tailscale-client.ts`.
  - **Mitigation:** Mock implements the same interface (`implements
    TailscaleClient` style); a TypeScript change in the real module breaks the mock at
    compile time.

---

### TASK-007: `oauth-flow.test.ts` (oauth-auth + oauth-bootstrap + oauth-state + token-exchange)

**Description:** Cover the four OAuth modules as one suite (they're tightly coupled
by the auth-code flow). Use `nock` to intercept the OAuth provider's HTTP endpoints.

**Files to create:**
- `plugins/autonomous-dev-portal/server/auth/__tests__/oauth-flow.test.ts`

**Dependencies:** [TASK-001, TASK-003 (pkce baseline)]

**Acceptance Criteria** (per TDD-030 §5.2):
- Authorization-code flow happy path: state issued → redirect → callback validates
  state → token exchange succeeds.
- State replay (same state value reused twice) → second use rejected.
- Wrong state value at callback → rejected.
- Token-exchange HTTP failure (mocked OAuth provider returns 4xx) → typed error.
- All HTTP traffic intercepted by `nock`; no real network calls (assert via
  `nock.isDone()` / `nock.cleanAll()` per test).
- Combined line coverage of the four oauth files ≥ 90%.

**Estimated Effort:** 1.5 days

**Track:** Mocked-boundary tests

**Risks:**
- **Medium:** OAuth flows have many branches; reaching 90% on all four files in one
  suite is the largest single ask in this plan.
  - **Mitigation:** If 90% is unreachable without dead-code removal, file the dead
    code as a separate PR and add `/* istanbul ignore next */` comments with rationale
    only for genuinely defensive branches (per TDD-030 §5.3).

---

### TASK-008: `session-security.test.ts`

**Description:** Cover `server/auth/session/{session-manager,session-cookie,file-session-store}.ts`.
Real fs in `mkdtempSync`; `jest.useFakeTimers` for timeouts.

**Files to create:**
- `plugins/autonomous-dev-portal/server/auth/__tests__/session-security.test.ts`

**Dependencies:** [TASK-001]

**Acceptance Criteria** (per TDD-030 §5.2):
- New session cookie has `HttpOnly; Secure; SameSite=Strict` (assert via
  `Set-Cookie` header parsing — do not rely on a stringified comparison).
- Session-fixation: post-login session id differs from pre-login session id.
- Idle timeout: session unused for `idleMs + 1` is rejected on next request
  (uses fake timers; advances by `idleMs + 1`).
- Absolute timeout: session older than `absoluteMs + 1` is rejected even if recently
  used.
- Logout invalidates the session id server-side; subsequent use returns 401.
- File-session store cleans up its temp dir in `afterEach`; no leaked sessions
  between tests.
- Combined line coverage of the three session files ≥ 90%.

**Estimated Effort:** 1.5 days

**Track:** Stateful-boundary tests

**Risks:**
- **Medium:** Fake timers + fs operations can produce hangs.
  - **Mitigation:** Use `jest.useFakeTimers({ doNotFake: ['nextTick'] })` per
    TDD-030 §5.5; explicitly advance with `jest.advanceTimersByTimeAsync` and `await`
    every fs operation.

---

### TASK-009: `csrf-protection.test.ts`

**Description:** Cover the CSRF middleware adjacent to `server/auth/middleware/`.
Asserts the double-submit-cookie pattern and the safe-method skip rule.

**Files to create:**
- `plugins/autonomous-dev-portal/server/auth/__tests__/csrf-protection.test.ts`

**Dependencies:** [TASK-001]

**Acceptance Criteria** (per TDD-030 §5.2):
- First GET issues `Set-Cookie: csrf=<token>`.
- POST with matching `X-CSRF-Token` header → 200.
- POST with missing token → 403.
- POST with mismatched token → 403.
- GET / HEAD / OPTIONS → token check skipped (safe methods).
- Cross-origin POST without token → rejected (Origin/Referer check is the
  defense-in-depth supplement to double-submit).
- Line coverage of the CSRF middleware ≥ 90%.

**Estimated Effort:** 1 day

**Track:** Middleware tests

**Risks:**
- **Low:** The CSRF middleware path is shorter than session/oauth; mostly mechanical.

---

### TASK-010: Enforce coverage threshold and finalize

**Description:** Once TASKs 002–009 land, enable Jest's `coverageThreshold` so CI
fails if `server/auth/**/*.ts` line coverage drops below 90%. Document any
`/* istanbul ignore next */` comments and the rationale per branch.

**Files to modify:**
- `plugins/autonomous-dev-portal/jest.config.cjs` (add `coverageThreshold`)
- `plugins/autonomous-dev-portal/server/auth/__tests__/README.md` (record the final
  per-file coverage numbers from the last green CI run)

**Dependencies:** [TASK-002 through TASK-009]

**Acceptance Criteria:**
- `npx jest --coverage --runInBand` from the autonomous-dev plugin exits 0 with the
  threshold active.
- `coverageThreshold` is configured for the `server/auth/` glob specifically (not
  globally — the rest of the portal is out of scope).
- The README lists each module's line-coverage number; total is ≥ 90%.
- If any vulnerability was discovered in TASKs 004–009, the PR description links the
  hotfix PR per TDD-030 §8.1 / PRD-016 R-03.

**Estimated Effort:** 0.5 day

**Track:** Closeout

**Risks:**
- **Medium:** A flake in any one suite blocks the whole gate.
  - **Mitigation:** Tag flake-prone tests with explicit timeouts; the
    closeout PR runs CI three times before merging to confirm stability.

---

## Dependency Graph

```
TASK-001 (jest config + README)
├── TASK-002 (cidr-utils.test.ts)         ─┐
├── TASK-003 (pkce-utils.test.ts)          │
├── TASK-004 (localhost-auth.test.ts)      │
├── TASK-005 (network-binding.test.ts) ◄── depends on TASK-002
├── TASK-006 (tailscale-{client,auth}.test.ts)
├── TASK-007 (oauth-flow.test.ts) ◄────── depends on TASK-003
├── TASK-008 (session-security.test.ts)    │
├── TASK-009 (csrf-protection.test.ts)    ─┘
└── TASK-010 (enforce coverage threshold) ◄── depends on TASK-002..009
```

**Critical path:** TASK-001 → TASK-007 → TASK-010 (≈ 3 days)

**Parallelism:** Once TASK-001 lands, TASKs 002–009 are independent. With one
engineer the wall-clock is ≈ 8 days (sum of efforts). With two engineers splitting
the suite, ≈ 4-5 days.

## Testing Strategy

This plan **is** test code. The "test of the tests" is:

1. `npx jest --runInBand --coverage` exits 0 with the new threshold.
2. Each individual file passes `npx jest <path>` in isolation.
3. The portal's existing `bun test` continues to pass.
4. CI runs three times in a row green before merging (flake check).

## Risks

| Risk | Probability | Impact | Affected tasks | Mitigation |
|------|-------------|--------|----------------|------------|
| Tests reveal a real auth vulnerability | Medium | High (security) | TASK-004, 005, 007, 008, 009 | Per PRD-016 R-03 / TDD-030 §8.1: document in PR, open separate hotfix, do not block the backfill PR unless the issue is critical |
| Bun-vs-jest module resolution bites | Medium | Medium (schedule) | TASK-001 | Use `projects` config (separate transform/env per project); fall back to TDD-030 §5.4 Option B if resolution proves intractable (re-scope to a separate plan) |
| Coverage at 90% is unreachable | Medium | Low (schedule) | TASK-007, TASK-010 | Per TDD-030 §5.3: prefer dead-code removal in a separate PR, then `/* istanbul ignore next */` with rationale, only as last resort |
| Tailscale mock drifts from production interface | Low | Medium (false-green) | TASK-006 | Mock typed against the real exports; TS catches drift at compile time |
| OAuth nock fixtures drift from real provider | Low | Low | TASK-007 | Out of scope per TDD-030 §8.4; integration coverage is a separate PRD |
| Fake-timer + fs interaction hangs | Medium | Medium (CI) | TASK-008 | `doNotFake: ['nextTick']`; explicit `await jest.advanceTimersByTimeAsync(...)` |

## Definition of Done

- [ ] All 9 test files exist under `plugins/autonomous-dev-portal/server/auth/__tests__/`
      and pass under `npx jest --runInBand` from the autonomous-dev plugin root.
- [ ] `coverageThreshold` enforces ≥ 90% line coverage on `server/auth/**/*.ts`; the
      gate fails on regression.
- [ ] Portal-local `jest.config.cjs` exists and is included via `projects` in
      the autonomous-dev plugin's `jest.config.cjs`.
- [ ] The portal's existing `bun test` still passes (no regression).
- [ ] No production auth code has been modified by this plan (separate hotfix PRs
      for any findings).
- [ ] Each test file follows the mocking strategy in TDD-030 §5.5 (no Bun-specific
      APIs; `nock` for OAuth HTTP; `mkdtempSync` for fs; `useFakeTimers` for
      timeouts).
- [ ] `__tests__/README.md` records final per-module coverage numbers and links to
      TDD-030 §5.
- [ ] CI runs 3 consecutive green builds on the PR branch (flake check).
- [ ] If any test discovered a real vulnerability, the PR description links a
      separate hotfix PR (per PRD-016 R-03).
- [ ] PR description notes "depends on TDD-029 merged" and links the merge SHA.
