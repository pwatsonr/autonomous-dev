# TDD-021: Cypress UI Coverage — Technical Design

| Field | Value |
|-------|-------|
| **TDD ID** | TDD-021 |
| **Parent PRD** | [PRD-021](../prd/PRD-021-cypress-ui-coverage.md) |
| **Date** | 2026-05-16 |
| **Status** | Draft |

---

## 1. Architecture Overview

```
                   ┌────────────────────────┐
                   │   cypress (Node 20)    │
                   │   Electron / Chromium  │
                   └───────────┬────────────┘
                               │ HTTP (localhost:19282)
                               ▼
            ┌─────────────────────────────────────┐
            │  portal under test  (bun run        │
            │  server/server.ts, PORTAL_PORT=     │
            │  19282)                             │
            └───────────┬─────────────────────────┘
                        │ reads
                        ▼
            ┌─────────────────────────────────────┐
            │  $AUTONOMOUS_DEV_STATE_DIR (temp)   │
            │  per-test, populated by fixture     │
            │  builders. No daemon process.       │
            └─────────────────────────────────────┘
```

One portal instance, one state-dir-per-test-context, fresh fixtures per `beforeEach`. No daemon process — the portal reads files; the tests write files. Outbound calls (Discord webhook test) are intercepted with `cy.intercept()`.

## 2. Test-pyramid placement

| Layer | Runner | Responsibility |
|---|---|---|
| Unit | `bun test` | Pure functions, JSX rendering, single-file logic |
| Integration | `bun test` (`tests/integration/`) | Cross-module — readers + handlers + responses |
| **E2E (this TDD)** | **Cypress (Node)** | **User flows, button-click contract, form persistence, auto-refresh, error states** |
| Visual regression | Playwright (existing) | Pixel-accurate screenshots of key pages |

Cypress does not replace Playwright. Cypress = does the click do the thing. Playwright = does the pixel render right.

## 3. Resolved PRD open questions

- **Q-021-01 (real vs mock daemon):** **Mock via direct file manipulation.** The portal reads from `$AUTONOMOUS_DEV_STATE_DIR/{portal/request-actions,gate-decisions,...}` and `state.json` files in target repos. We seed these directly. No daemon process required. A separate (post-MVP) "integration" tier may run a real daemon against 1–2 end-to-end smoke flows.
- **Q-021-02 (file-seed vs CLI-sim):** **Direct file creation.** Deterministic, fast, no CLI startup overhead, no risk of CLI bugs masking portal bugs.
- **Q-021-03 (component vs e2e):** **E2e only for v1.** The portal renders server-side via Hono JSX; component-isolating it would require a synthetic JSX host. Defer.
- **Q-021-04 (isolation):** **Shared portal + per-test temp state-dir + portal reset.** Spinning a fresh portal per test is too slow (~1s × 30 tests = 30s overhead). Instead: portal starts once with `AUTONOMOUS_DEV_STATE_DIR=/tmp/cypress-state`; `beforeEach` resets that dir via a debug endpoint OR via filesystem op + brief portal cache flush.

## 4. Directory layout

```
plugins/autonomous-dev-portal/
├── cypress.config.ts                # cypress config (baseUrl, env, viewport)
├── cypress/
│   ├── e2e/                         # one .cy.ts per FR group
│   │   ├── 01-nav-smoke.cy.ts       # FR-021-01
│   │   ├── 02-settings-persist.cy.ts # FR-021-02
│   │   ├── 03-request-lifecycle.cy.ts # FR-021-03
│   │   ├── 04-gate-approval.cy.ts   # FR-021-04
│   │   ├── 05-webhook.cy.ts         # FR-021-05
│   │   ├── 06-kill-switch.cy.ts     # FR-021-06
│   │   ├── 07-data-consistency.cy.ts # FR-021-07
│   │   ├── 08-auto-refresh.cy.ts    # FR-021-08
│   │   ├── 09-error-states.cy.ts    # FR-021-09
│   │   └── 10-agents.cy.ts          # FR-021-10
│   ├── fixtures/
│   │   ├── requests/                # request-action JSON templates
│   │   ├── states/                  # daemon state.json templates
│   │   └── configs/                 # cost-ledger, allowlist, etc.
│   ├── support/
│   │   ├── builders.ts              # typed fixture builders
│   │   ├── commands.ts              # custom cy.* commands
│   │   ├── e2e.ts                   # global hooks, state-dir setup
│   │   └── portal.ts                # portal lifecycle helpers
│   └── tsconfig.json
└── package.json (new scripts: cypress, cypress:open, cypress:ci)
```

## 5. Runtime decision: Node, not Bun

Cypress 13 has an Electron-based GUI + Node-only install scripts. Bun's npm-compat layer doesn't yet handle Cypress's postinstall reliably (binary download, codesigning helpers on macOS). Recommendation: **install Cypress via `npm install` from `plugins/autonomous-dev-portal/` with `package.json` declaring `cypress` as a devDependency.** Portal source can still run under Bun.

CI: `setup-node@v4` action + `npm ci` + `npm run cypress:ci`.

## 6. Portal lifecycle

Adopt **`start-server-and-test`** (npm package). One-liner pattern:

```json
"scripts": {
  "portal:cypress": "PORTAL_PORT=19282 AUTONOMOUS_DEV_STATE_DIR=/tmp/cypress-state bun run server/server.ts",
  "cypress:ci": "start-server-and-test portal:cypress http://localhost:19282 'cypress run'"
}
```

Reasons over alternatives:
- **Custom `before:run` task spawning** would duplicate logic and complicate CI logs.
- **External wait-on + raw cypress** works but `start-server-and-test` already bundles wait-on + readiness probing.

## 7. State-dir orchestration

Two competing strategies:

**A. Filesystem-only reset per test.** `beforeEach`: `rm -rf $STATE_DIR/*`, write fixtures, hit `/__test/reset` (new debug endpoint) so portal flushes any in-memory caches. Fast but requires adding the endpoint.

**B. Per-suite portal restart.** `before(all)` per spec restarts the portal with a fresh state-dir. Simpler but adds ~1s × number-of-spec-files of overhead.

**Recommendation: A.** Add a `POST /__test/reset` endpoint gated by `NODE_ENV !== 'production'` AND by header `X-Cypress-Test: 1`. The endpoint clears in-memory caches and accepts a JSON payload of fixtures to write to disk.

## 8. Fixture strategy

Typed TypeScript builders, e.g.:

```ts
// cypress/support/builders.ts
export const aRequest = (overrides?: Partial<RequestActionFile>) => ({
  id: 'REQ-100001',
  repo: 'demo',
  title: 'Default fixture',
  phase: 'PRD',
  status: 'running' as const,
  cost: 0,
  variant: '',
  createdAt: '2026-05-16T00:00:00Z',
  ...overrides,
});

export const aGate = (overrides?: Partial<RequestActionFile>) =>
  aRequest({ status: 'gate', phase: 'CODE_REVIEW', ...overrides });

export const writeFixtures = (stateDir: string, fixtures: RequestActionFile[]) => {
  // posts to /__test/reset OR writes files directly via cy.task
};
```

Five base shapes — `aRequest`, `aGate`, `aFailed`, `aCancelled`, `aDone` — composed via spread for permutations.

## 9. Mocking strategy

- **Daemon process:** none — write files, don't run the daemon.
- **External HTTPS (Discord/Slack webhook):** `cy.intercept('POST', /discord\.com|hooks\.slack\.com/, { statusCode: 204 })`. Tests assert the request was made with the right URL/payload, not that it reached Discord.
- **Claude CLI:** N/A in the portal layer; portal never invokes claude.

## 10. CI integration

New file `.github/workflows/portal-cypress.yml`:

```yaml
name: portal-cypress
on:
  pull_request:
    paths:
      - 'plugins/autonomous-dev-portal/**'
jobs:
  cypress:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: plugins/autonomous-dev-portal/package-lock.json
      - run: cd plugins/autonomous-dev-portal && bun install
      - run: cd plugins/autonomous-dev-portal && npm ci
      - run: cd plugins/autonomous-dev-portal && npm run cypress:ci
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: cypress-artifacts
          path: plugins/autonomous-dev-portal/cypress/{videos,screenshots}
```

Failed runs auto-upload videos + screenshots — operator can diagnose flakes without a re-run.

## 11. Speed budget

- 25 tests × 6s avg = **2.5 min** test execution
- Portal startup (bun + listen) = **5–15 s**
- `cypress run` cold-start + browser launch = **~30 s**
- `npm ci` (cached) = **15–30 s**
- **Total CI overhead** ≈ 4 min on warm cache, 6 min cold

Comfortably under PRD's 5-min target on warm cache.

## 12. Per-FR test sketches

- **FR-021-01 Navigation smoke** — iterate over 12 routes, `cy.visit()`, assert status 200, `<h1>` exists, no console errors (use `cy.spy(console, 'error')`).
- **FR-021-02 Settings persistence** — for each of trust, cost caps, allowlist, webhook: set value → submit → reload → assert new value. CSRF token must be present in form.
- **FR-021-03 Request lifecycle** — write `request-actions/REQ-X.json` with status `running` → visit `/` → assert appears in Active table → mutate file to `phase: 'CODE'` → poll wait → assert phase chip updated.
- **FR-021-04 Gate approval** — write a gate fixture → visit `/approvals` → assert gate row present → click Approve → assert POST fired (intercept) → assert gate removed from list.
- **FR-021-05 Webhook** — type valid Discord URL → click Test → assert `POST /api/settings/notifications/test/discord` fired with the URL in the body → assert success indicator.
- **FR-021-06 Kill switch** — full state machine: idle → arm → assert banner; arm → Cancel → assert idle (HTMX swap); arm → type CONFIRM → submit → assert POST fired (intercept).
- **FR-021-07 Data consistency** — write fixtures yielding a known MTD ($X) → visit dashboard, requests, costs → assert all three KPI tiles show `$X`.
- **FR-021-08 Auto-refresh** — visit dashboard, wait 12 s, assert ≥ 1 polling fetch occurred (`cy.intercept('GET', '/')` count); set `document.visibilityState = 'hidden'` via stub, wait 12 s, assert no additional fetches.
- **FR-021-09 Error states** — visit `/repo/missing/request/REQ-999999` → assert 404 page renders + navigation back works.
- **FR-021-10 Agents** — click agent row → assert modal opens → click Close → assert modal gone. (Promote/Shadow/Freeze are no-op-tested with intercepts so we don't mutate real state.)

Each sketch is a one-paragraph hint; the Plan/Spec will turn it into concrete `it()` blocks.

## 13. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Polling races assertions ("the value flickered between renders") | High | Test mode disables polling via `?test=1` query param, OR Cypress stops the poll via `cy.intercept('GET', '/', { times: 1 })` |
| Cypress binary install fails in CI | Med | Pin Cypress version + cache via `cypress-io/github-action@v6` |
| Chromium availability on macOS runners | Low | Stick to ubuntu-latest in CI |
| Tests interfere with operator's live portal on :19280 | High locally | Cypress uses port `19282` exclusively; never touches `:19280` |
| Plugin-cache `node_modules` issue (today's bug) | Med | Cypress runs from source tree, not plugin cache; not affected |
| Test data leaks into operator's `~/.autonomous-dev/` | Med | All fixture writes go to `/tmp/cypress-state-XXXX`, never to `~/.autonomous-dev/` |

## 14. Backwards compatibility

- Existing `bun test` suite untouched
- Playwright visual regression continues running on its own
- New `package.json` scripts are additive (`cypress`, `cypress:open`, `cypress:ci`)
- New devDependency `cypress` adds ~150MB to portal `node_modules` (developer-only impact)

## 15. Migration / rollout

**Phase 1A — Infrastructure** (single PR):
- `cypress.config.ts`, `cypress/` directory, `package.json` scripts
- 1 smoke test (`01-nav-smoke.cy.ts` covering `/`)
- CI workflow file
- Goal: green CI run on the empty scaffold

**Phase 1B — Navigation matrix** (next PR):
- Expand `01-nav-smoke.cy.ts` to all 12 routes

**Phase 2 — Per-FR specs** (one PR per FR group, in priority order):
- FR-021-02 settings, FR-021-04 gate, FR-021-06 kill switch first (operator pain)
- Then FR-021-03, FR-021-07, FR-021-08
- Then FR-021-05, FR-021-09, FR-021-10

**Phase 3 — Bug-driven expansion:** as the catalog at `PORTAL-BUG-CATALOG-2026-05-16.md` grows, each P0/P1 bug spawns either a new test or a new assertion in an existing test.

---

**Summary:** Node-runtime Cypress, single portal + per-test temp state-dir, direct file-fixture seeding, `start-server-and-test` orchestration, new GH Actions workflow, 25 tests targeted, <5 min CI total, biggest risk is polling-vs-assertion races (mitigated by test-mode polling disable).
