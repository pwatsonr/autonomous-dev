# TDD-030: Closeout Backfill — TDD-014 Security Tests, TDD-015 Portal Pipelines, TDD-019 Plugin-Reload CLI

| Field          | Value                                                                |
|----------------|----------------------------------------------------------------------|
| **Title**      | Closeout Backfill — TDD-014 Security Tests, TDD-015 Portal Pipelines, TDD-019 Plugin-Reload CLI |
| **TDD ID**     | TDD-030                                                              |
| **Version**    | 1.0                                                                  |
| **Date**       | 2026-05-02                                                           |
| **Status**     | Draft                                                                |
| **Author**     | Patrick Watson                                                       |
| **Parent PRD** | PRD-016: Test-Suite Stabilization & Jest Harness Migration           |
| **Plugin**     | autonomous-dev, autonomous-dev-portal                                |
| **Sibling TDDs** | TDD-029 (harness migration + CI gate), TDD-031 (SPEC reconciliation) |
| **Depends on** | TDD-029 must merge first (closeout tests must run under a clean jest gate) |

---

## 1. Summary

TDD-030 closes three concrete gaps that prior monolithic landings (TDD-014, TDD-015,
TDD-019) left behind. Unlike its sibling TDD-029 — which is purely a test-runner concern
— this TDD ships **production code**: three portal live-data pipelines, the
plugin-reload CLI surface, and nine security-critical test files for code that is
already in production but currently has zero coverage.

The three FR groups are independent in scope but share a common shape: each is "X is
referenced by an existing TDD's spec but not present in the tree." The audit traced 51
missing files against TDD-014, ~87 against TDD-015, and ~5 against TDD-019. This TDD
focuses on the **load-bearing** subset of those: the production code and tests required
to make the auth/portal/CLI surfaces honest about what they ship.

The design is split into three independent feature areas (§5, §6, §7), each with its own
contract and risk profile, then unified under shared cross-cutting concerns (§8). Each
area becomes one Implementation Plan (§13).

---

## 2. Goals & Non-Goals

### Goals

- **G-3001** Ship 9 missing security test files under
  `plugins/autonomous-dev-portal/server/auth/__tests__/` covering the public surface of
  every module the auth layer ships today, with ≥90% line coverage on
  `server/auth/*.ts`.
- **G-3002** Ship the 3 missing portal live-data pipeline production files
  (`cost-pipeline.ts`, `heartbeat-pipeline.ts`, `log-pipeline.ts`) under
  `plugins/autonomous-dev-portal/server/integration/`, each with at least one
  unit test exercising the public emit/subscribe surface and one error/recovery path.
- **G-3003** Ship the plugin-reload CLI surface — `bin/reload-plugins.js`,
  `intake/cli/commands/plugin.ts`, and the dispatcher wiring — plus a single integration
  test that exercises the reload path end-to-end.
- **G-3004** Make every backfilled test runnable under the post-TDD-029 jest gate (no
  `process.exit`, idiomatic `describe`/`it`, included in
  `npx jest --runInBand`'s summary).
- **G-3005** Surface real auth bugs *if they exist*, but not block the backfill on them
  per PRD-016 R-03 — finding becomes a separate hotfix PR.

### Non-Goals

| ID      | Non-Goal                                                                          | Rationale                                                                         |
|---------|-----------------------------------------------------------------------------------|-----------------------------------------------------------------------------------|
| NG-3001 | Redesigning the auth surface                                                      | Per PRD-016 §13, security tests cover what shipped; design changes ship separately |
| NG-3002 | Adding new auth providers (additional OAuth issuers, SSO, etc.)                   | Out of scope; backfill ≠ feature work                                              |
| NG-3003 | Adding new portal live-data signals (e.g., new event types beyond cost/heartbeat/log) | Closeout of TDD-015's three named pipelines only                              |
| NG-3004 | Refactoring `server/integration/state-pipeline.ts` to share a base class with the new pipelines | Premature abstraction; shared pattern is documented (§6.1) but no parent class extracted |
| NG-3005 | Adding new CLI commands beyond `plugin reload`                                    | TDD-019 closeout = the named command, nothing else                                 |
| NG-3006 | Hot-reload semantics for non-plugin daemon state (config, standards, hooks)       | Plugin reload only; broader hot-reload is a separate PRD                           |
| NG-3007 | A real Tailscale daemon in CI                                                      | Mock at the client interface (PRD-016 OQ-05); real-daemon coverage is integration  |
| NG-3008 | Tests for harness-migrated files                                                   | Owned by TDD-029                                                                   |
| NG-3009 | SPEC text amendments referencing the new files                                    | Owned by TDD-031                                                                   |

---

## 3. Background

### 3.1 Why these gaps exist

TDDs 002–015 were authored during a phase that produced large monolithic SPECs without
a follow-through audit step. The audit on 2026-05-03 identified per-TDD missing-file
counts:

| TDD     | Missing files | Of which: production code | Of which: tests |
|---------|---------------|---------------------------|-----------------|
| TDD-014 | 51            | 0                         | 9 (this TDD)    |
| TDD-015 | 87            | 3 (this TDD)              | ~84 (mostly scaffolding; see §6.4) |
| TDD-019 | 5             | 3 (this TDD)              | 1 (this TDD)    |

The TDD-014 case is the most acute: every module under
`plugins/autonomous-dev-portal/server/auth/` ships to operators today
(`base-auth.ts`, `localhost-auth.ts`, `network-binding.ts`, `cidr-utils.ts`,
`tailscale-auth.ts`, `tailscale-client.ts`, `oauth/oauth-auth.ts`,
`oauth/pkce-utils.ts`, `session/session-manager.ts`, plus CSRF in
`security/binding-enforcer.ts`-adjacent code). None has a unit test. The 9 missing files
in `server/auth/__tests__/` are a known gap, not a discovery.

### 3.2 What's in the tree right now

Confirmed against `main@2937725`:

```
plugins/autonomous-dev-portal/server/auth/
├── base-auth.ts
├── cidr-utils.ts
├── localhost-auth.ts
├── middleware/{auth-context.ts, require-auth.ts}
├── middleware-factory.ts
├── network-binding.ts
├── oauth/{oauth-auth.ts, oauth-bootstrap.ts, oauth-state.ts, pkce-utils.ts, providers/, token-exchange.ts}
├── registry-factory.ts
├── security/binding-enforcer.ts
├── session/{file-session-store.ts, session-cookie.ts, session-manager.ts}
├── tailscale-auth.ts
├── tailscale-client.ts
└── types.ts
```

The portal's `package.json` declares `"test": "bun test"`, not jest. This is a
non-trivial complication that §5.4 addresses.

```
plugins/autonomous-dev-portal/server/integration/
└── state-pipeline.ts          ← only one of four pipelines exists
```

```
plugins/autonomous-dev/intake/cli/
├── commands/
│   ├── chains_*.ts
│   ├── cred_proxy_command.ts
│   ├── deploy_*.ts
│   └── reconcile_command.ts
└── (no dispatcher.ts; no plugin.ts; no bin/reload-plugins.js anywhere)
```

(Note: PRD-016 cites `src/cli/commands/plugin.ts` and `src/cli/dispatcher.ts`, but the
as-built path is `intake/cli/...`. This TDD uses the as-built path; TDD-031 amends the
SPEC.)

### 3.3 Why backfill now

Two reasons. First, the auth surface has been live without coverage for the duration
between TDD-014 landing and PRD-016 — every week of delay extends that window. Second,
TDD-029 unblocks the runner; the moment that lands, the CI gate becomes "all suites
pass," and the security tests become a hard requirement to keep that gate green at the
coverage threshold.

---

## 4. Architecture (joint)

This TDD is three independent feature areas glued by a shared jest configuration and
shared coding conventions. The architecture diagram is therefore three boxes plus the
contracts that connect each to the rest of the system.

```
                ┌──────────────────────────────────────┐
                │   plugins/autonomous-dev-portal      │
                │                                       │
                │  ┌─────────────────┐  consumed by     │
                │  │ server/auth/*.ts │ ────► HTTP       │
                │  │  (existing code) │       middleware │
                │  └────────▲────────┘                   │
                │           │                            │
                │  ┌────────┴────────┐                   │
                │  │  __tests__/*.ts │  ← TDD-030 §5    │
                │  │  (NEW: 9 files) │     (jest under  │
                │  └─────────────────┘     a portal-     │
                │                          local config) │
                │                                       │
                │  ┌─────────────────┐                   │
                │  │ server/integration│ ◄── SSE bus,   │
                │  │  state-pipeline   │     readers     │
                │  │  cost-pipeline    │  ← NEW          │
                │  │  heartbeat-pipeline│ ← NEW          │
                │  │  log-pipeline     │  ← NEW          │
                │  └─────────────────┘                   │
                └──────────────────────────────────────┘

                ┌──────────────────────────────────────┐
                │   plugins/autonomous-dev              │
                │                                       │
                │  bin/reload-plugins.js  ←── operator  │
                │      │                       invokes  │
                │      ▼                                │
                │  intake/cli/dispatcher.ts ←── routes  │
                │      │                                │
                │      ▼                                │
                │  intake/cli/commands/plugin.ts        │
                │      │                                │
                │      ▼                                │
                │  Daemon plugin registry  ←── reload   │
                │  (existing TDD-019 hook)              │
                └──────────────────────────────────────┘
```

The auth tests and the pipeline production code live in the **portal** plugin; the CLI
work lives in the **autonomous-dev** plugin. The two plugins share no runtime state
beyond what the daemon mediates.

---

## 5. TDD-014 Security Test Backfill

### 5.1 File list and target modules

| Test file (NEW, under `server/auth/__tests__/`)   | Production module covered                                                |
|---------------------------------------------------|--------------------------------------------------------------------------|
| `localhost-auth.test.ts`                          | `server/auth/localhost-auth.ts`                                          |
| `network-binding.test.ts`                         | `server/auth/network-binding.ts` + `server/auth/security/binding-enforcer.ts` |
| `cidr-utils.test.ts`                              | `server/auth/cidr-utils.ts`                                              |
| `tailscale-auth.test.ts`                          | `server/auth/tailscale-auth.ts`                                          |
| `tailscale-client.test.ts`                        | `server/auth/tailscale-client.ts`                                        |
| `oauth-flow.test.ts`                              | `server/auth/oauth/{oauth-auth.ts,oauth-bootstrap.ts,oauth-state.ts,token-exchange.ts}` |
| `pkce-utils.test.ts`                              | `server/auth/oauth/pkce-utils.ts`                                        |
| `session-security.test.ts`                        | `server/auth/session/{session-manager.ts,session-cookie.ts,file-session-store.ts}` |
| `csrf-protection.test.ts`                         | CSRF middleware (currently in `server/auth/middleware/` and adjacent)    |

### 5.2 Test scope per file (FR-1622–FR-1628)

The PRD names specific scenarios per file. Restated as test plans:

**`localhost-auth.test.ts`**
- IPv4 loopback (`127.0.0.1`) → allowed.
- IPv6 loopback (`::1`) → allowed.
- IPv4-mapped IPv6 loopback (`::ffff:127.0.0.1`) → allowed.
- Non-loopback (`10.0.0.5`) → rejected with 401.
- Localhost-only mode disabled → all requests allowed regardless of source.
- Spoofed `X-Forwarded-For: 127.0.0.1` from a non-loopback peer → rejected (the test
  asserts that the peer-address check, not the header, drives the decision).

**`network-binding.test.ts`**
- Server bound to `127.0.0.1:PORT` does not accept connections on `0.0.0.0`.
- Misconfigured CIDR allowlist (`"not-a-cidr"`) → startup throws, server does not listen.
- Empty allowlist + `bind: 0.0.0.0` → startup throws (no permissive fallback).
- Valid CIDR allowlist + matching peer → request accepted; non-matching peer → rejected.

**`cidr-utils.test.ts`**
- IPv4: `10.0.0.0/8` membership for `10.1.2.3` (true), `192.168.1.1` (false).
- IPv6: `2001:db8::/32` membership for `2001:db8:1::1` (true), `2001:db9::1` (false).
- `/32` exact-match for IPv4; `/128` exact-match for IPv6.
- Malformed input: empty string, `not-a-cidr`, `10.0.0.0/33`, `::1/129` → throws.
- Empty allowlist → `isAllowed` returns false (deny by default).

**`tailscale-auth.test.ts` + `tailscale-client.test.ts`**
- Happy path: client returns identity object, auth resolves user.
- Daemon socket missing (`ENOENT` on `/var/run/tailscale/...`) → typed error.
- Malformed identity payload (`{}` instead of expected shape) → typed error.
- Expired token (server returns 401 from Tailscale API) → typed error.
- Tailscale client is mocked at the **interface boundary** (PRD-016 OQ-05) — no real
  daemon in CI.

**`oauth-flow.test.ts` + `pkce-utils.test.ts`**
- PKCE `code_verifier` length within RFC-7636 bounds (43–128 chars).
- `code_challenge` = `BASE64URL(SHA256(verifier))`; verified byte-for-byte against the
  RFC-7636 example vectors.
- S256 method only (plain rejected).
- Authorization-code flow: state issued → redirect → callback validates state → token
  exchange.
- State replay (same state value reused) → rejected.
- Wrong state value → rejected.
- Token exchange failure (mocked OAuth provider returns 4xx) → typed error.

**`session-security.test.ts`**
- New session cookie has `HttpOnly; Secure; SameSite=Strict` (assert via `Set-Cookie`
  header parsing).
- Session fixation: post-login session id differs from pre-login session id.
- Idle timeout: a session unused for `idleMs+1` is rejected on next request.
- Absolute timeout: a session older than `absoluteMs+1` is rejected even if recently
  used.
- Logout invalidates the session id server-side (subsequent use returns 401).

**`csrf-protection.test.ts`**
- Token issued on first GET with `Set-Cookie: csrf=<token>`.
- POST with matching `X-CSRF-Token` header → accepted.
- POST with missing token → rejected with 403.
- POST with mismatched token → rejected with 403.
- GET / HEAD / OPTIONS → token check skipped (safe methods).
- Cross-origin POST without token → rejected (Origin/Referer check supplements double
  submit).

### 5.3 Coverage target (FR-1621)

`npx jest --coverage --collectCoverageFrom='server/auth/**/*.ts'` reports ≥90% line
coverage on the auth tree. Branches not exercised at 90% must be either (a) explicitly
tested, (b) marked with an `/* istanbul ignore next */` comment with rationale, or (c)
deleted as dead code in a separate PR. Option (c) is preferred where applicable.

### 5.4 The bun-vs-jest problem

The portal currently runs tests via `bun test`. The 9 new tests cannot use Bun-specific
APIs because PRD-016 G-02 requires `npx jest --runInBand` to be the canonical gate.

Two options:

| Option                                             | Pros                                                       | Cons                                                                        |
|----------------------------------------------------|------------------------------------------------------------|-----------------------------------------------------------------------------|
| **A. Add a portal-local `jest.config.cjs`** that the autonomous-dev plugin's jest run includes via `roots` | Tests run under both bun and jest; one source of truth | Two test runners on the same files = double-maintenance; bun and jest diverge on edge cases (timer mocks, ESM resolution) |
| **B. Move portal tests under autonomous-dev's jest config; deprecate `bun test`** | One runner; PRD-016 G-02 met cleanly                       | Larger change; out of PRD-016 scope (we'd be migrating away from bun, not just adding tests) |
| **C. Keep portal tests on bun; add a separate jest-only shim layer that re-imports the auth modules and asserts via jest** | No portal code change                                      | The "shim" layer is a parallel test corpus that diverges from the bun tests; double-maintenance with extra indirection |

**Decision:** A. The portal's existing `bun test` covers a different set of files
(integration tests under `tests/integration/`, etc.); the new auth `__tests__` are
additive and only need jest (PRD-016 §11 declares jest the canonical gate). The
portal-local `jest.config.cjs` is included via `roots` in
`plugins/autonomous-dev/jest.config.cjs` (the same way the deploy plugins are already
included).

The auth tests use plain Node primitives (`http.createServer`, `crypto.subtle`, `node:net`),
no Bun-specific APIs, so they are runnable under both runners — though only jest
participates in the PRD-016 G-02 gate.

### 5.5 Mocking strategy

| Boundary                          | Strategy                                                                        |
|-----------------------------------|----------------------------------------------------------------------------------|
| Tailscale daemon                  | Mock the client interface (`tailscale-client.ts`'s exported functions) per OQ-05 |
| OAuth provider HTTP               | `nock` or `msw/node` to intercept fetches; no real OAuth provider in CI         |
| Filesystem (session store)        | Real fs in a per-test `mkdtempSync` directory; cleaned up in `afterEach`        |
| Network (peer address)            | Real `http.createServer` bound to `127.0.0.1`; the test's HTTP client is the peer |
| Time                              | `jest.useFakeTimers({ doNotFake: ['nextTick'] })` for idle/absolute timeout tests |

The pattern matches `tests/audit/log-archival.test.ts:28` (real fs in `mkdtempSync`)
which is already established in the codebase.

---

## 6. TDD-015 Portal Pipeline Closeout

### 6.1 Reference: existing pipeline

`server/integration/state-pipeline.ts` is the reference implementation. The three new
pipelines follow the same shape (no extracted base class — see NG-3004):

- **Reader** subscribes to a file watcher (`server/watchers/`) for the relevant
  artifact (e.g., `cost.json`, `heartbeat.jsonl`, `<request>/log.jsonl`).
- **Pipeline** ingests reader events, applies redaction (re-uses
  `server/readers/redaction.ts`), validates the schema (re-uses
  `server/readers/schemas/`), and emits to the SSE bus.
- **Subscriber** is the SSE route handler under `server/sse/`, which the live-data
  settings UI consumes.

### 6.2 Per-pipeline contract

| Pipeline                    | Source                                                | Schema                                                  | Redaction                              | Emit topic              |
|-----------------------------|-------------------------------------------------------|---------------------------------------------------------|----------------------------------------|-------------------------|
| `cost-pipeline.ts`          | `<request>/.autonomous-dev/cost.json` watcher        | `server/readers/schemas/cost.schema.ts` (or new equivalent) | Strip API keys from any embedded URLs | `cost-update`           |
| `heartbeat-pipeline.ts`     | `<request>/.autonomous-dev/heartbeat.jsonl` watcher | `server/readers/schemas/heartbeat.schema.ts`            | None (no PII in heartbeat)            | `heartbeat`             |
| `log-pipeline.ts`           | `<request>/log.jsonl` watcher                         | `server/readers/schemas/log.schema.ts`                  | `redaction.redactLog(entry)` for PII   | `log-line`              |

### 6.3 Public surface

Each pipeline exports the same three-method interface:

```ts
export interface Pipeline<E> {
  start(): Promise<void>;
  stop(): Promise<void>;
  on(event: 'data' | 'error' | 'recovered', listener: (e: E) => void): void;
}
```

Tests (one per pipeline, under `server/integration/__tests__/`):

- **Happy path:** writing a valid JSON line to the watched file emits one `data` event
  with the parsed/redacted payload.
- **Error path:** writing a malformed line emits an `error` event but does not stop the
  pipeline (subsequent valid lines still emit `data`).
- **Recovery path:** simulating a transient watcher error (e.g., the watched file is
  briefly unlinked then recreated) emits an `error` followed by a `recovered`.

### 6.4 Scaffolding files (FR-1632, FR-1633)

The audit's "87 missing files" set for TDD-015 includes test scaffolding (fixtures,
mock providers, helpers) that the SPEC enumerated but that may not all make sense
post-migration. The disposition rules per FR-1633:

- If the scaffolding is a fixture used by the new pipeline tests (§6.3), ship it.
- If it's a fixture for a test that doesn't exist (and won't exist per NG-3003), do
  **not** ship an empty stub; record the SPEC entry as obsolete and leave the
  amendment to TDD-031.

The expected scaffolding file count is in single digits, not 84. The audit's "84"
includes fixtures for tests that were never authored; the design here is to ship
fixtures only for tests we ship.

---

## 7. TDD-019 Plugin-Reload CLI Closeout

### 7.1 File list

| Path                                                              | Type           | Purpose                                                               |
|-------------------------------------------------------------------|----------------|-----------------------------------------------------------------------|
| `plugins/autonomous-dev/bin/reload-plugins.js`                    | NEW (executable) | Operator-invokable shebang script; thin wrapper that imports and calls the dispatcher |
| `plugins/autonomous-dev/intake/cli/dispatcher.ts`                 | NEW            | Shared CLI dispatcher; routes `plugin reload` to `commands/plugin.ts` |
| `plugins/autonomous-dev/intake/cli/commands/plugin.ts`            | NEW            | Implements `plugin reload`; returns structured exit codes (0/1/2)     |
| `plugins/autonomous-dev/tests/integration/plugin-reload.test.ts`  | NEW            | End-to-end integration test (§7.4)                                    |

(PRD-016 cites `src/cli/...`; the as-built path is `intake/cli/...`. TDD-031 amends the
SPEC to match the tree.)

### 7.2 `bin/reload-plugins.js` shape

```js
#!/usr/bin/env node
// Thin shebang wrapper. Operators invoke this directly via PATH.
import { dispatch } from '../intake/cli/dispatcher.js';
dispatch(['plugin', 'reload', ...process.argv.slice(2)])
  .then((code) => process.exit(code))
  .catch((err) => { console.error(err); process.exit(2); });
```

`chmod +x` enforced via a `npm prepare` hook or a `.gitattributes` line. (`process.exit`
in `bin/` is permitted; PRD-016 FR-1660 forbids it only in `**/tests/**`.)

### 7.3 Exit code contract

| Code | Meaning                  | Example trigger                                                       |
|------|--------------------------|------------------------------------------------------------------------|
| 0    | Reload succeeded         | Daemon ack received, new plugin version observable                    |
| 1    | Transient failure        | Daemon unreachable; retry might succeed                                |
| 2    | Configuration error      | Plugin path invalid; manifest unparseable; permanent failure          |

### 7.4 Integration test (FR-1643)

The test boots a daemon in a temp dir, installs a plugin at version 1.0.0, modifies the
plugin's manifest to version 1.1.0, invokes `plugin reload`, and asserts:

1. The CLI exits 0.
2. A subsequent daemon RPC reports the plugin version as 1.1.0.
3. No daemon restart occurred (the daemon's PID is unchanged).

Per PRD-016 R-06, the reload mechanism uses **deterministic invalidation** (an explicit
"reload" message to the daemon) rather than file-watcher-driven reload. The
file-watcher path is documented as a P2 follow-up in §13.

The test runs under jest. It uses `child_process.spawn` for the daemon and the CLI;
both are killed in `afterAll`. Total runtime budget: ≤10 s.

---

## 8. Cross-Cutting Concerns (joint)

### 8.1 Security

This TDD's primary security value is **negative result protection**: the auth surface
ships today with zero coverage; backfilling tests doesn't make it more secure but does
make regressions detectable. Specific concerns:

- **Test-discovered vulnerabilities (R-03):** If a test reveals a real vulnerability
  (e.g., `localhost-auth.test.ts` shows that `X-Forwarded-For: 127.0.0.1` from a
  non-loopback peer is currently accepted), the finding is escalated per PRD-016 R-03
  to a separate hotfix PR. The TDD-030 PR documents the finding in its description and
  links the hotfix; merging is not blocked on the hotfix unless the maintainer judges
  the issue critical.
- **CSRF tests:** Verifying the double-submit-cookie pattern is itself a security
  test; failures here are higher priority than failures in the other suites.
- **Mock vs. real Tailscale (OQ-05):** Mocking at the client interface boundary means
  the integration with the real daemon is untested by this TDD. That's an accepted
  trade-off; real-daemon coverage is integration scope (separate PRD).
- **Pipeline redaction:** `log-pipeline.ts` re-uses `server/readers/redaction.ts`
  rather than reimplementing redaction. The pipeline test asserts that a log line
  containing a known PII pattern (e.g., a synthetic email address) emerges with the
  email replaced.

### 8.2 Privacy

The portal handles potentially sensitive operator data (cost figures, log entries with
user prompts). Pipeline tests use synthetic fixtures that do not include real PII. The
log-pipeline test's redaction assertion is the primary privacy guardrail.

The plugin-reload integration test creates a temp dir per test run and removes it in
`afterAll`; no per-developer data leaks across runs.

### 8.3 Scalability

- **Auth tests:** Each test is independent and uses `mkdtempSync` per case for
  filesystem isolation. ~40 test cases at ~100 ms each = ~4 s total. Fits jest's
  default 5 s suite timeout.
- **Pipeline tests:** File-watcher tests have inherent latency (debounce intervals).
  Each pipeline test budget: ~500 ms. Three pipelines × 3 cases = ~5 s.
- **Plugin-reload integration:** ~10 s budget per §7.4. Worst case in the gate.

Total added test runtime: ~20 s, well within the post-TDD-029 budget (§11.3).

### 8.4 Reliability

- **Mock drift (auth tests):** Mocks of `tailscale-client.ts` and the OAuth provider
  drift from reality if the production code's interfaces change. Mitigation: the mocks
  are typed against the production interfaces (TypeScript catches drift at compile
  time); a separate integration test (out of scope) would catch wire-format drift.
- **Pipeline file-watcher flakes:** File-watcher events are inherently asynchronous;
  flaky-on-CI is a known pattern. Mitigation: each pipeline test uses an explicit
  "wait for event" promise with a 500 ms timeout, not arbitrary `setTimeout`.
- **Plugin-reload race:** The reload's "deterministic invalidation" (§7.4) prevents
  the file-watcher race that PRD-016 R-06 flags.

### 8.5 Observability

- **Auth tests:** Each suite emits a coverage line that the CI's coverage report
  surfaces. The 90% threshold is enforced via Jest's `coverageThreshold` config.
- **Pipelines:** Each pipeline emits structured events on `data`/`error`/`recovered`;
  these are observable via the SSE bus in production (already wired by TDD-015).
- **Plugin-reload:** The CLI's exit code is itself the observability signal; the
  integration test asserts on it.

### 8.6 Cost

- **Auth tests:** No new dependencies (`nock` is already in the portal's devDeps).
  ~4 s of CI time per run.
- **Pipelines:** No new dependencies; reuses existing reader/redaction infrastructure.
  ~5 s of CI time per run.
- **Plugin-reload:** No new dependencies; uses Node's built-in `child_process`.
  ~10 s of CI time per run.

Total CI cost increment: ~20 s per CI run × ~50 CI runs/week = ~17 min/week of runner
time. Negligible.

Engineer-hour cost: ~24 hours for auth tests, ~8 hours for pipelines, ~6 hours for the
CLI = ~38 engineer-hours. The auth test investment is highest because the surface is
broadest.

---

## 9. Alternatives Considered

### 9.1 Skip the auth tests; rely on integration coverage

**Approach:** Argue that an end-to-end portal test exercises the auth path
transitively, so unit tests are redundant.

**Advantages:**
- Less code to write
- Integration tests are closer to user behavior

**Disadvantages:**
- The end-to-end path covers the happy case; auth's value is in the unhappy paths
  (rejected requests, invalid tokens, replayed state). Integration tests rarely
  exercise these exhaustively.
- A 90% line-coverage target is unreachable without unit tests for the auth tree —
  the failure paths only trigger from specific malformed inputs.
- PRD-016 G-04 explicitly mandates unit tests on the auth surface.

**Why rejected:** PRD-016 specifies unit-level coverage (FR-1620, FR-1621). The
alternative violates the goal directly.

### 9.2 Single base class for all four pipelines

**Approach:** Extract `AbstractPipeline<E>` from `state-pipeline.ts` and have
`cost-pipeline.ts`, `heartbeat-pipeline.ts`, `log-pipeline.ts` extend it.

**Advantages:**
- Less duplication
- Behavioral consistency by construction

**Disadvantages:**
- The four pipelines have meaningfully different semantics (heartbeat is
  monotonic-stream, log is appendable-jsonl, cost is rewritable-json, state is
  patch-based). Forcing a common base produces an interface that's awkward for each.
- The refactor of `state-pipeline.ts` is out of scope per NG-3004.

**Why rejected:** Premature abstraction. The duplication is small (~30 LOC each); a
shared interface (§6.3) plus a documentation note is sufficient. If a fifth pipeline
appears with the same shape, revisit.

### 9.3 File-watcher-driven plugin reload

**Approach:** Run a `chokidar` watcher on plugin manifests; auto-reload on change
without an explicit CLI invocation.

**Advantages:**
- More magical / better DX

**Disadvantages:**
- Inherent races (PRD-016 R-06): the reload may fire while a write is in progress.
- Operators want explicit control: silent reloads have caused incidents in similar
  systems (e.g., Webpack's hot module replacement).
- Out of scope for TDD-019 closeout per NG-3006.

**Why rejected:** The CLI is the explicit, deterministic mechanism PRD-016 names.
Auto-reload is a tracked-but-deferred follow-up.

### 9.4 Test the CLI surface only (no integration test)

**Approach:** Unit-test `commands/plugin.ts` against a mocked daemon RPC; skip the
end-to-end integration test.

**Advantages:**
- Faster CI
- Simpler test setup

**Disadvantages:**
- The integration test is the only place that catches a wiring bug between
  `bin/reload-plugins.js`, `dispatcher.ts`, and `commands/plugin.ts`.
- Mock-only tests have a long history of passing while production breaks.

**Why rejected:** The 10 s integration test cost is a fair price for end-to-end
confidence. PRD-016 FR-1643 mandates the integration test.

---

## 10. Operational Readiness

### 10.1 Rollout sequence

This TDD splits cleanly into three independent phases:

1. **Phase A (auth tests):** No production code changes. Lowest risk; merges first.
2. **Phase B (pipelines):** New production files; changes the live-data SSE bus.
   Requires manual verification that the live-data UI still renders correctly.
3. **Phase C (plugin-reload CLI):** New CLI surface + new daemon entry point. Requires
   manual verification that `autonomous-dev plugin reload` works against a running
   daemon.

Phases B and C can run in parallel after Phase A merges (or independently of it; they
share no code).

### 10.2 Rollback

- **Auth tests:** Pure additive; revert the test files. No production rollback.
- **Pipelines:** Each pipeline is a new file. Revert the file + the SSE wiring commit
  to roll back. The live-data UI degrades gracefully (the topic just stops emitting)
  per TDD-015's existing degradation behavior.
- **Plugin-reload CLI:** The CLI is new; no existing operators depend on it. Revert
  the three files to roll back.

### 10.3 Feature flags

None for tests. The pipelines are gated by config (per TDD-015's existing settings
UI); the default is **off** until an operator enables them. The CLI is gated by being
a new command (operators don't invoke it unless they know about it).

### 10.4 Canary criteria

- **Auth coverage:** `npx jest --coverage` shows ≥90% for `server/auth/**/*.ts`.
- **Pipelines:** A manual smoke test on a developer laptop confirms each pipeline
  emits events to the SSE bus when its watched file is touched.
- **CLI:** A manual `autonomous-dev plugin reload <test-plugin>` against a running
  daemon returns exit 0.

---

## 11. Test Strategy

### 11.1 Coverage matrix

| Area                      | Unit tests | Integration tests | Coverage target |
|---------------------------|------------|-------------------|-----------------|
| Auth (TDD-014 backfill)   | 9 files    | 0 (per NG-3007)   | ≥90% lines on `server/auth/**/*.ts` |
| Pipelines (TDD-015 closeout) | 3 files | 0 (covered by TDD-015's existing E2E) | ≥80% lines on the three new files |
| Plugin reload (TDD-019)   | 0          | 1                 | E2E happy path + 1 error path |

### 11.2 Mocking inventory

- `nock` for OAuth HTTP — already in portal devDeps.
- Hand-written `tailscale-client.ts` mock — interface-typed, lives next to the test.
- `jest.useFakeTimers` for session-timeout tests.
- Real fs (`mkdtempSync`) for filesystem-touching tests.
- `child_process.spawn` for plugin-reload integration; no mocks.

### 11.3 Runtime budget

Total added jest runtime: ~20 s (auth ~4 s + pipelines ~5 s + CLI integration ~10 s
+ overhead ~1 s). The post-TDD-029 baseline is ~10 min wall-clock for the full run; a
20 s addition is <4% growth.

### 11.4 What's not tested

- Real Tailscale daemon integration (NG-3007).
- File-watcher-based plugin reload (NG-3006).
- Cross-pipeline interaction (each pipeline is independent; no test for "what if both
  cost and log emit at the same time").
- Auth + pipeline interaction (the SSE auth check is covered by TDD-013, not here).

---

## 12. Open Questions

| ID    | Question                                                                                                       | Recommendation                                                                                                                                |
|-------|----------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------|
| OQ-30-01 | The portal currently uses `bun test`. Do the new auth tests run under bun, jest, or both?                      | Jest only (§5.4 Option A). Bun coverage is a non-goal of PRD-016.                                                                              |
| OQ-30-02 | The audit reports 87 missing files for TDD-015; we ship far fewer. Is the audit wrong?                          | The audit lists scaffolding for tests that were never authored. We ship scaffolding only for tests we ship; the rest is amended in TDD-031.    |
| OQ-30-03 | If a security test reveals a real vulnerability, do we hold the TDD-030 PR until the fix?                      | No, per PRD-016 R-03. Document the finding in the PR description and link the hotfix.                                                          |
| OQ-30-04 | The PRD cites `src/cli/...` paths; the as-built is `intake/cli/...`. Which wins?                               | As-built (`intake/cli/...`). TDD-031 amends the SPEC to match.                                                                                 |
| OQ-30-05 | Do we wire the plugin-reload CLI into `package.json`'s `bin` field for `npm install -g` discoverability?       | Yes. Adds `"reload-plugins": "./bin/reload-plugins.js"` to the autonomous-dev plugin's `bin` map.                                              |
| OQ-30-06 | Should the auth coverage threshold (90%) be enforced via Jest's `coverageThreshold` config or only spot-checked? | Enforce via `coverageThreshold` in `jest.config.cjs` so CI fails on regression. Manual spot-checks are insufficient.                            |
| OQ-30-07 | If a pipeline test reveals that the existing `state-pipeline.ts` has a redaction bug, do we fix here?           | No (NG-3004). Document the finding; the fix ships as a separate PR referencing PRD-016 (per PRD-016 NG-01).                                    |

---

## 13. Implementation Plan (high-level)

| Plan ID    | Title                          | Scope                                                                                       | Estimate | Depends on |
|------------|--------------------------------|---------------------------------------------------------------------------------------------|----------|------------|
| Plan 030-A | TDD-014 security test backfill | 9 jest test files under `server/auth/__tests__/`; portal-local jest config; coverage threshold | L        | TDD-029    |
| Plan 030-B | TDD-015 portal pipeline closeout | 3 production pipelines + 3 unit tests under `server/integration/`; SSE wiring                | M        | TDD-029    |
| Plan 030-C | TDD-019 plugin-reload CLI closeout | `bin/reload-plugins.js` + `intake/cli/dispatcher.ts` + `commands/plugin.ts` + integration test | M        | TDD-029    |

All three plans depend on TDD-029 because they need a clean jest gate to land under.
Plans 030-A, 030-B, 030-C are independent of each other; they can ship in parallel
PRs or as a single TDD-030 PR with three commits.

---

## 14. References

- **PRD-016:** Test-Suite Stabilization & Jest Harness Migration —
  `plugins/autonomous-dev/docs/prd/PRD-016-test-suite-stabilization.md`
- **TDD-014:** Portal Security & Auth — production code under
  `plugins/autonomous-dev-portal/server/auth/`
- **TDD-015:** Portal Live-Data & Settings — reference pipeline at
  `plugins/autonomous-dev-portal/server/integration/state-pipeline.ts`
- **TDD-019:** Extension Hook System — daemon hot-reload hook used by
  `commands/plugin.ts`
- **TDD-029:** Sibling — must merge before this TDD's tests can run under the gate
- **TDD-031:** Sibling — amends SPEC paths (e.g., `src/cli/...` → `intake/cli/...`)
- **OWASP ASVS:** for the auth test plan (§5.2) — `https://owasp.org/asvs/`
- **RFC 7636:** PKCE specification (referenced in §5.2 oauth tests)

---

**END TDD-030**
