# PLAN-021: Cypress UI Coverage for the autonomous-dev Portal

| Field | Value |
|-------|-------|
| **Plan ID** | PLAN-021 |
| **Title** | Cypress UI Coverage for the autonomous-dev Portal |
| **Version** | 1.0 |
| **Date** | 2026-05-16 |
| **Status** | Draft |
| **Parent PRD** | `plugins/autonomous-dev/docs/prd/PRD-021-cypress-ui-coverage.md` |
| **Parent TDD** | `plugins/autonomous-dev/docs/tdd/TDD-021-cypress-ui-coverage.md` |
| **Plugin** | autonomous-dev-portal |
| **Target branch** | `feat/cypress-ui-coverage` |

> **Source authority.** Section references like "TDD §9" point at the TDD-021 sections explicitly named in the parent's dispatch (e.g. §9 — webhook intercept, §15 — implementation phases). When a TDD section is not yet pinned, the PRD-021 functional requirement (`FR-021-NN`) is cited instead. The Spec Author for each task is expected to reconcile any drift.

---

## 1. Goal

Translate PRD-021 / TDD-021 into time-boxed, agent-executable tasks that yield a Cypress end-to-end suite running in CI on every PR touching `plugins/autonomous-dev-portal/`. The plan is structured so an autonomous agent (or human) can pick up the next task from the queue without re-reading the entire PRD/TDD each time.

## 2. Operating Assumptions

1. **Runtime.** Cypress runs on Node.js (PRD §6, Option A). `bun` remains the portal's primary runtime; we add a `node`/`npm` execution path solely for the Cypress harness.
2. **Port.** Test portal binds to `localhost:19282` (one above the dev-time 19281 used by Playwright, two above the default 19280) to avoid clashes with a running daemon's portal.
3. **State isolation.** A per-run `AUTONOMOUS_DEV_STATE_DIR=$(mktemp -d)` is exported by the `start-server-and-test` wrapper; cleaned up in afterAll.
4. **Daemon strategy.** Phase 1 / 2 use a **mock daemon** — fixture JSON written into the state dir + `cy.intercept()` for daemon-bound POSTs. A future "integration-cypress" suite (out of scope here) will wire a real daemon.
5. **Debug reset endpoint.** A `POST /__test/reset` route, gated by `process.env.PORTAL_TEST_MODE === '1'`, truncates the state dir and reloads in-memory caches between specs.
6. **CI runner.** GitHub Actions, `ubuntu-latest`, Node 20, with the Cypress binary cached at `~/.cache/Cypress`.
7. **Bug catalog.** Phase 3 reads from `plugins/autonomous-dev/docs/triage/PORTAL-BUG-CATALOG-2026-05-16.md` (currently being authored by a parallel agent). Phase 3 task IDs are reserved; concrete sub-tasks are filed when each bug is triaged.

---

## 3. Task Conventions

- **Task ID** format: `T-021-<phase>-<seq>` (e.g. `T-021-1A-03`).
- **Effort** is wall-clock agent time including tool calls — 30/45/60/75/90 minute buckets.
- **Acceptance** is always a copy-pasteable command or a grep that returns 0/1.
- **Suggested agent**: `autonomous-dev:code-executor` for code that compiles/runs; `autonomous-dev:test-executor` for tasks whose primary deliverable is a green test; `autonomous-dev:doc-author` for docs-only.
- All file paths are relative to repo root unless noted.

---

## 4. Phase 1A — Infrastructure (one PR, 8 tasks)

**Phase goal.** A developer can clone the repo, `cd plugins/autonomous-dev-portal`, run `npm run cypress:ci`, and watch a single nav-smoke spec pass. CI does the same on every PR touching the portal.

**Phase exit criteria.**
- `npm run cypress:ci` (from portal root) exits 0 on a clean checkout.
- `.github/workflows/portal-cypress.yml` runs green on a draft PR.
- `cypress/e2e/01-nav-smoke.cy.ts` exists and asserts `/` returns 200, renders `<h1>`, logs no `console.error`.

| Field | Value |
|---|---|
| **Task ID** | `T-021-1A-01` |
| **Title** | Add Cypress + start-server-and-test as devDependencies and wire npm scripts |
| **Inputs** | `plugins/autonomous-dev-portal/package.json`; PRD §6 (Bun vs Node); TDD §15 Phase 1A |
| **Outputs** | `plugins/autonomous-dev-portal/package.json` (new devDeps: `cypress@^13`, `start-server-and-test@^2`, `@types/node` already present; new scripts: `cypress:open`, `cypress:run`, `cypress:ci`, `portal:test-mode`); `package-lock.json` regenerated |
| **Acceptance** | `cd plugins/autonomous-dev-portal && npm pkg get scripts.cypress:ci` prints a non-null string; `node_modules/.bin/cypress --version` runs |
| **Effort** | 45 min |
| **Depends on** | — |
| **Agent** | `autonomous-dev:code-executor` |

| Field | Value |
|---|---|
| **Task ID** | `T-021-1A-02` |
| **Title** | Scaffold cypress directory tree and tsconfig |
| **Inputs** | Cypress 13 docs; TDD §15 Phase 1A |
| **Outputs** | `plugins/autonomous-dev-portal/cypress/e2e/.gitkeep`; `cypress/fixtures/.gitkeep`; `cypress/support/e2e.ts` (empty hook file with `// loaded for every spec`); `cypress/support/commands.ts` (stub `Cypress.Commands.add` registry); `cypress/tsconfig.json` (extends portal root tsconfig, adds `"types": ["cypress", "node"]`) |
| **Acceptance** | `tree plugins/autonomous-dev-portal/cypress -L 2` shows `e2e/ fixtures/ support/ tsconfig.json`; `cd plugins/autonomous-dev-portal && npx tsc -p cypress/tsconfig.json --noEmit` exits 0 |
| **Effort** | 30 min |
| **Depends on** | `T-021-1A-01` |
| **Agent** | `autonomous-dev:code-executor` |

| Field | Value |
|---|---|
| **Task ID** | `T-021-1A-03` |
| **Title** | Author cypress.config.ts with baseUrl 19282 and retries |
| **Inputs** | `plugins/autonomous-dev-portal/playwright.config.ts` (pattern reference); PRD §6 (port choice rationale); TDD §15 Phase 1A |
| **Outputs** | `plugins/autonomous-dev-portal/cypress.config.ts` exporting `defineConfig({ e2e: { baseUrl: 'http://localhost:19282', specPattern: 'cypress/e2e/**/*.cy.ts', supportFile: 'cypress/support/e2e.ts', video: false, screenshotOnRunFailure: true, retries: { runMode: 1, openMode: 0 } } })` |
| **Acceptance** | `grep -q "19282" plugins/autonomous-dev-portal/cypress.config.ts`; `npx cypress verify` (from portal root) prints "Cypress verified" |
| **Effort** | 30 min |
| **Depends on** | `T-021-1A-02` |
| **Agent** | `autonomous-dev:code-executor` |

| Field | Value |
|---|---|
| **Task ID** | `T-021-1A-04` |
| **Title** | Add gated POST /__test/reset endpoint to the portal server |
| **Inputs** | `plugins/autonomous-dev-portal/server/server.ts` and `server/routes/index.ts`; PRD §6 (Portal Orchestration); TDD §9 (debug surface) and TDD §11 (test isolation) |
| **Outputs** | New route module `plugins/autonomous-dev-portal/server/routes/__test-reset.ts`: exports a Hono router mounted iff `process.env.PORTAL_TEST_MODE === '1'`; truncates `AUTONOMOUS_DEV_STATE_DIR` to a known-empty layout and clears in-memory caches; integration in `server/routes/index.ts` behind the env guard; unit test under `tests/unit/__test-reset.test.ts` that exercises both the gate-off (404) and gate-on (200) paths |
| **Acceptance** | `PORTAL_TEST_MODE=1 bun run start &` then `curl -s -o /dev/null -w '%{http_code}' -X POST localhost:19280/__test/reset` returns `200`; without env var, same curl returns `404`; `bun test tests/unit/__test-reset.test.ts` passes |
| **Effort** | 75 min |
| **Depends on** | `T-021-1A-01` |
| **Agent** | `autonomous-dev:code-executor` |

| Field | Value |
|---|---|
| **Task ID** | `T-021-1A-05` |
| **Title** | Wire start-server-and-test orchestration with PORTAL_TEST_MODE=1 |
| **Inputs** | Output of `T-021-1A-01` (cypress:ci script stub); `T-021-1A-04` (test mode env); TDD §15 Phase 1A |
| **Outputs** | `plugins/autonomous-dev-portal/scripts/cypress-ci.sh` (POSIX sh wrapper that sets `PORT=19282 PORTAL_TEST_MODE=1 AUTONOMOUS_DEV_STATE_DIR=$(mktemp -d)`, then execs `start-server-and-test`); `package.json` `cypress:ci` script updated to `scripts/cypress-ci.sh`; `start-server-and-test` config inside `package.json` (`"start-server-and-test": { "command": "bun run start", "url": "http://localhost:19282/healthz", "test": "cypress run" }`) |
| **Acceptance** | From a clean clone: `cd plugins/autonomous-dev-portal && npm run cypress:ci` boots the portal on 19282, hits `/healthz`, runs cypress (empty spec set OK at this point — `--spec 'cypress/e2e/**/*.cy.ts'`), shuts portal down, exits 0 |
| **Effort** | 60 min |
| **Depends on** | `T-021-1A-03`, `T-021-1A-04` |
| **Agent** | `autonomous-dev:code-executor` |

| Field | Value |
|---|---|
| **Task ID** | `T-021-1A-06` |
| **Title** | Author typed fixture builders in cypress/support/builders.ts |
| **Inputs** | `plugins/autonomous-dev-portal/server/types/` (request, gate, cost, agent type definitions); PRD §11 (test data fixtures); TDD §9 — webhook intercept signatures |
| **Outputs** | `plugins/autonomous-dev-portal/cypress/support/builders.ts` exporting typed factories: `buildRequest({ id?, phase?, repo?, ... })`, `buildGate(...)`, `buildAgentSnapshot(...)`, `buildCostLedgerEntry(...)`, `buildWebhookConfig(...)`. Each builder returns the exact shape the portal server reads from disk; defaults compose into a "happy path" fixture set when no overrides are passed |
| **Acceptance** | `npx tsc -p plugins/autonomous-dev-portal/cypress/tsconfig.json --noEmit` exits 0; `grep -c "export function build" plugins/autonomous-dev-portal/cypress/support/builders.ts` ≥ 5 |
| **Effort** | 75 min |
| **Depends on** | `T-021-1A-02` |
| **Agent** | `autonomous-dev:code-executor` |

| Field | Value |
|---|---|
| **Task ID** | `T-021-1A-07` |
| **Title** | Write 01-nav-smoke.cy.ts (single-route smoke) |
| **Inputs** | `cypress/support/builders.ts` (T-021-1A-06); PRD FR-021-01; TDD §15 Phase 1A acceptance |
| **Outputs** | `plugins/autonomous-dev-portal/cypress/e2e/01-nav-smoke.cy.ts` with one `describe('nav smoke', ...)` covering `/`: visits, asserts response 200 (via `cy.request` first, then `cy.visit`), asserts `cy.get('h1')` is visible, registers `cy.on('window:before:load', win => ...)` to fail on `console.error`. `beforeEach` posts `/__test/reset` and seeds via `cy.writeFile` of builder output |
| **Acceptance** | `cd plugins/autonomous-dev-portal && npm run cypress:ci` exits 0; the cypress report lists exactly 1 passing test |
| **Effort** | 60 min |
| **Depends on** | `T-021-1A-05`, `T-021-1A-06` |
| **Agent** | `autonomous-dev:test-executor` |

| Field | Value |
|---|---|
| **Task ID** | `T-021-1A-08` |
| **Title** | Add .github/workflows/portal-cypress.yml |
| **Inputs** | Existing portal CI workflows under `.github/workflows/`; `T-021-1A-05` orchestration script; TDD §15 Phase 1A acceptance ("CI runs green on PR") |
| **Outputs** | `.github/workflows/portal-cypress.yml`: triggers on `pull_request` paths-filter `plugins/autonomous-dev-portal/**`; job uses `actions/setup-node@v4` (node 20), caches `~/.cache/Cypress` and `node_modules`, installs portal deps (`npm ci` inside the portal dir), runs `npm run cypress:ci`, uploads `cypress/screenshots` and `cypress/videos` as artifacts on failure |
| **Acceptance** | A draft PR that touches `plugins/autonomous-dev-portal/README.md` shows the new `portal-cypress` check; it passes. `gh workflow view portal-cypress.yml` lists the job |
| **Effort** | 60 min |
| **Depends on** | `T-021-1A-07` |
| **Agent** | `autonomous-dev:code-executor` |

**Phase 1A total effort.** 435 min (~7.25 h).

---

## 5. Phase 1B — Navigation Matrix (one PR, 1 task)

**Phase goal.** Every route returns 200, renders an `<h1>`, and logs no console errors. This is the lowest-fidelity but broadest safety net — it would have caught the four broken routes referenced in the PRD problem statement.

| Field | Value |
|---|---|
| **Task ID** | `T-021-1B-01` |
| **Title** | Expand 01-nav-smoke.cy.ts to all 12 portal routes |
| **Inputs** | `plugins/autonomous-dev-portal/server/routes/index.ts` (canonical route list); `cypress/e2e/01-nav-smoke.cy.ts` from `T-021-1A-07`; PRD FR-021-01 (12-route list); TDD §15 Phase 1B |
| **Outputs** | Rewritten `cypress/e2e/01-nav-smoke.cy.ts` using `it.each` (or a forEach over a route table) covering: `/`, `/approvals`, `/requests`, `/costs`, `/ops`, `/logs`, `/agents`, `/settings`, `/repos`, `/audit`, `/repo/:repo/request/:id` (with seeded fixture), `/design-system`. For each: assert HTTP 200 via `cy.request`, then `cy.visit`, assert `cy.get('h1').should('be.visible')`, no console.error. Seed fixtures via builders for the parameterized route |
| **Acceptance** | `npm run cypress:ci` reports 12 passing tests; spec runtime <60 s; `grep -c "it(" cypress/e2e/01-nav-smoke.cy.ts` ≥ 12 |
| **Effort** | 90 min |
| **Depends on** | `T-021-1A-08` (merged) |
| **Agent** | `autonomous-dev:test-executor` |

**Phase 1B total effort.** 90 min.

---

## 6. Phase 2 — Per-FR Specs (operator-pain priority)

**Ordering rationale.** Sorted by operator-pain frequency in the 2026-05-15 audit: settings persistence and webhooks were the loudest, gate flow is the most-used daily workflow, kill switch is highest-stakes, request lifecycle and data consistency catch silent-failure classes, auto-refresh, error states, and agent management close the long tail.

Each task in this phase is a standalone PR. Each produces one `0N-XYZ.cy.ts` spec.

| Field | Value |
|---|---|
| **Task ID** | `T-021-2-01` |
| **Title** | Spec — Settings persistence (FR-021-02) |
| **Inputs** | PRD FR-021-02; portal route `/settings`; `server/routes/settings*.ts`; TDD §9 (intercept), TDD §11 (state reset); builders from `T-021-1A-06` |
| **Outputs** | `cypress/e2e/02-settings-persistence.cy.ts`. Cases: (a) change trust level → submit → reload → value persists; (b) edit cost cap inputs (daily, weekly, monthly) → reload → values persist; (c) add then remove an allowlist entry; (d) set Discord webhook URL → reload → value persists; (e) set Slack webhook URL → reload → value persists; (f) set default notification method → reload → persists; (g) toggle DND + set start/end times → reload → persists |
| **Acceptance** | `npx cypress run --spec 'cypress/e2e/02-settings-persistence.cy.ts'` exits 0 with ≥7 passing tests; deliberately break the settings POST handler in a scratch branch and verify the spec fails |
| **Effort** | 75 min |
| **Depends on** | `T-021-1B-01` (merged) |
| **Agent** | `autonomous-dev:test-executor` |

| Field | Value |
|---|---|
| **Task ID** | `T-021-2-02` |
| **Title** | Spec — Gate approval flow (FR-021-04) |
| **Inputs** | PRD FR-021-04; portal `/approvals` route; `server/routes/approvals*.ts`; TDD §9 (intercept on POST /api/gates/:id/approve) |
| **Outputs** | `cypress/e2e/04-gate-approval.cy.ts`. Cases: (a) seed a pending gate → `/approvals` lists it; (b) click Approve → POST fires (intercepted) → gate disappears; (c) dashboard "Awaiting approval" tile decrements; (d) request advances to next phase in the requests list |
| **Acceptance** | Spec passes; `grep -q "cy.intercept('POST', '/api/gates" cypress/e2e/04-gate-approval.cy.ts` |
| **Effort** | 75 min |
| **Depends on** | `T-021-2-01` (merged) |
| **Agent** | `autonomous-dev:test-executor` |

| Field | Value |
|---|---|
| **Task ID** | `T-021-2-03` |
| **Title** | Spec — Kill switch flow (FR-021-06) |
| **Inputs** | PRD FR-021-06; portal `/ops` route; kill-switch widget; TDD §9 (intercept POST /api/ops/kill-switch) |
| **Outputs** | `cypress/e2e/06-kill-switch.cy.ts`. Cases: (a) idle → click "Kill switch" → confirmation banner appears; (b) Cancel returns to idle without POST; (c) type CONFIRM in the input → submit → engaged state visible; (d) engaged → Reset → idle |
| **Acceptance** | Spec passes; spec explicitly asserts a Cancel path exists (this is one of the audit findings — see PRD §1) |
| **Effort** | 60 min |
| **Depends on** | `T-021-2-02` (merged) |
| **Agent** | `autonomous-dev:test-executor` |

| Field | Value |
|---|---|
| **Task ID** | `T-021-2-04` |
| **Title** | Spec — Webhook lifecycle (FR-021-05) |
| **Inputs** | PRD FR-021-05; portal `/settings` webhooks panel; TDD §9 — webhook intercept (POST `/api/settings/notifications/test/{discord,slack,send}`) |
| **Outputs** | `cypress/e2e/05-webhook-lifecycle.cy.ts`. Cases per channel (Discord, Slack): (a) enter URL → "Test" button enables; (b) click Test → POST intercepted with stub 200 → success message; (c) click Test → POST stub 500 → failure message displayed; (d) "Send notification" path round-trip |
| **Acceptance** | Spec passes; spec uses `cy.intercept` to fake both 200 and 500 responses; ≥4 cases per channel × 2 channels |
| **Effort** | 75 min |
| **Depends on** | `T-021-2-03` (merged) |
| **Agent** | `autonomous-dev:test-executor` |

| Field | Value |
|---|---|
| **Task ID** | `T-021-2-05` |
| **Title** | Spec — Request lifecycle (FR-021-03) |
| **Inputs** | PRD FR-021-03; `server/routes/requests*.ts`, dashboard "Active requests" tile; TDD §9 (file-seeded fixtures) |
| **Outputs** | `cypress/e2e/03-request-lifecycle.cy.ts`. Cases: (a) seed a request-action JSON + initial state file → request appears in dashboard within one poll interval (`cy.tick` or `cy.clock`); (b) mutate state file to advance phases (intake → triage → plan → code) → status badge updates across dashboard, `/requests`, `/repo/:repo/request/:id`; (c) terminal `done` state renders the success summary |
| **Acceptance** | Spec passes; ≥3 phase transitions exercised |
| **Effort** | 90 min |
| **Depends on** | `T-021-2-04` (merged) |
| **Agent** | `autonomous-dev:test-executor` |

| Field | Value |
|---|---|
| **Task ID** | `T-021-2-06` |
| **Title** | Spec — Dashboard data consistency (FR-021-07) |
| **Inputs** | PRD FR-021-07 (MTD spend disagreement bug); `/`, `/requests`, `/costs`, `/approvals`; TDD §9 (cost ledger fixture) |
| **Outputs** | `cypress/e2e/07-data-consistency.cy.ts`. Cases: (a) seed a deterministic cost ledger → MTD spend value on dashboard equals value on `/requests` equals value on `/costs` (within a $0.01 tolerance); (b) seed N pending gates → dashboard "Awaiting approval" tile = `cy.get('[data-testid=gate-row]')` count on `/approvals` |
| **Acceptance** | Spec passes; deliberately mutate one of the cost endpoints to a wrong constant and confirm the spec fails on the consistency assertion |
| **Effort** | 75 min |
| **Depends on** | `T-021-2-05` (merged) |
| **Agent** | `autonomous-dev:test-executor` |

| Field | Value |
|---|---|
| **Task ID** | `T-021-2-07` |
| **Title** | Spec — Auto-refresh polling (FR-021-08) |
| **Inputs** | PRD FR-021-08; `plugins/autonomous-dev-portal/tests/integration/auto-refresh-polling.test.ts` (pinned contract); TDD §9 (polling intervals) |
| **Outputs** | `cypress/e2e/08-auto-refresh.cy.ts`. Cases: (a) foreground tab — `cy.intercept` counts `/api/dashboard` requests over a `cy.clock`-advanced window; observed count matches contract; (b) simulate `document.visibilityState='hidden'` via `cy.stub` on the document — request count stays at 0; (c) restore visibility — polling resumes within one interval |
| **Acceptance** | Spec passes; spec cites the integration-test contract path in a top-of-file comment |
| **Effort** | 75 min |
| **Depends on** | `T-021-2-06` (merged) |
| **Agent** | `autonomous-dev:test-executor` |

| Field | Value |
|---|---|
| **Task ID** | `T-021-2-08` |
| **Title** | Spec — Error handling (FR-021-09) |
| **Inputs** | PRD FR-021-09; 404 page; `/repo/:repo/request/:id` missing-state handling (PRD §1 — "500-on-missing-id" bug); TDD §9 |
| **Outputs** | `cypress/e2e/09-error-handling.cy.ts`. Cases: (a) visit `/totally-bogus` → 404 page renders → "back to dashboard" link works; (b) trigger a server 500 via `cy.intercept` on a known endpoint → friendly error visible; (c) `/repo/test/request/nonexistent` → page renders an "unknown request" empty state, NOT a 500 |
| **Acceptance** | Spec passes; case (c) explicitly references the PRD-020 / portal-redesign reality-pass regression class |
| **Effort** | 60 min |
| **Depends on** | `T-021-2-07` (merged) |
| **Agent** | `autonomous-dev:test-executor` |

| Field | Value |
|---|---|
| **Task ID** | `T-021-2-09` |
| **Title** | Spec — Agent management (FR-021-10) |
| **Inputs** | PRD FR-021-10; `/agents` route; TDD §9 (intercept POST `/api/agents/:id/{promote,shadow,freeze}`) |
| **Outputs** | `cypress/e2e/10-agent-management.cy.ts`. Cases: (a) click an agent row → inspect modal opens; (b) click Shadow → POST intercepted → modal reflects shadow mode (or closes) → agent list shows new mode; (c) repeat for Promote and Freeze |
| **Acceptance** | Spec passes; ≥3 action paths exercised |
| **Effort** | 60 min |
| **Depends on** | `T-021-2-08` (merged) |
| **Agent** | `autonomous-dev:test-executor` |

**Phase 2 total effort.** 645 min (~10.75 h).

---

## 7. Phase 3 — Bug-Driven Expansion (recurring template)

Phase 3 is **template-driven, not pre-enumerated**, because the bug catalog is being authored in parallel.

### 7.1 The template

For every P0/P1 entry filed in `plugins/autonomous-dev/docs/triage/PORTAL-BUG-CATALOG-2026-05-16.md`, a Phase-3 sub-task is filed and queued. Each follows this shape:

| Field | Value |
|---|---|
| **Task ID** | `T-021-3-<NN>` (sequentially assigned when the bug is triaged) |
| **Title** | "Regression spec — <bug catalog ID>: <short title>" |
| **Inputs** | The bug catalog entry (steps to reproduce, observed vs expected, affected route(s)); the relevant builder factory; the relevant TDD §9 intercept signature |
| **Outputs** | One new `cypress/e2e/regression-<bug-id>.cy.ts` containing **at minimum** a test that fails against the bug's pre-fix state and passes against the fix; OR (if the fix has already shipped) a guard test that pins the current correct behavior |
| **Acceptance** | (1) The new spec passes on `main`. (2) Checking out the parent commit (pre-fix) and running the spec produces a red bar with a message that names the bug catalog ID. (3) `grep -q "<bug-id>" cypress/e2e/regression-<bug-id>.cy.ts` |
| **Effort** | 30–90 min depending on bug complexity |
| **Depends on** | Phase 2 complete (so the harness is mature); the corresponding bug catalog entry being in `triaged` or later state |
| **Agent** | `autonomous-dev:test-executor` |

### 7.2 Operating rule

> **For every new portal bug filed at P0 or P1 severity, a Phase-3 regression task is created BEFORE the bug is closed.** The fix PR and the regression spec PR may be the same PR or separate PRs, but the spec MUST land on `main` no later than the fix.

### 7.3 Phase 3 exit criteria

There is no fixed exit — Phase 3 is an ongoing discipline. The plan considers Phase 3 "established" once the first three bug-driven regression specs have shipped via the template above. After that, the template is incorporated into the standard bug-triage workflow.

---

## 8. Dependency Graph

```
T-021-1A-01 ─┬─> T-021-1A-02 ─> T-021-1A-03 ─┐
             └─> T-021-1A-04 ────────────────┼─> T-021-1A-05 ─┐
             └─> T-021-1A-06 ─────────────────────────────────┼─> T-021-1A-07 ─> T-021-1A-08
                                                              │
                                                              └─> T-021-1B-01
                                                                      │
                                                                      v
                                T-021-2-01 ─> T-021-2-02 ─> T-021-2-03 ─> T-021-2-04
                                                                      │
                                                                      v
                                T-021-2-05 ─> T-021-2-06 ─> T-021-2-07 ─> T-021-2-08 ─> T-021-2-09
                                                                      │
                                                                      v
                                                              Phase 3 (template, recurring)
```

**Critical path.** `T-021-1A-01 → 1A-02 → 1A-03 → 1A-05 → 1A-07 → 1A-08 → 1B-01 → 2-01 → 2-02 → 2-03 → 2-04 → 2-05 → 2-06 → 2-07 → 2-08 → 2-09`.

**Critical-path duration.** 30 + 30 + 30 + 60 + 60 + 60 + 90 + 75 + 75 + 60 + 75 + 90 + 75 + 75 + 60 + 60 = **1005 min ≈ 16.75 agent-hours**.

**Parallelism available within Phase 1A.** `T-021-1A-04` (debug endpoint) and `T-021-1A-06` (builders) can run in parallel with each other once `T-021-1A-01`/`02` land. Two agents working in parallel shave ~75 min off the critical path.

---

## 9. Milestones

| Milestone | Tasks | Wall clock (single-agent) | Exit criteria |
|---|---|---|---|
| **M1 — Cypress harness alive** | T-021-1A-01 .. 1A-08 | ~7.25 h | `npm run cypress:ci` exits 0 locally and in CI; 1 nav smoke test passes |
| **M2 — 12-route smoke** | T-021-1B-01 | ~1.5 h | All 12 routes verified for HTTP 200 + `<h1>` + no console.error |
| **M3 — Operator-pain coverage** | T-021-2-01 .. 2-04 | ~4.75 h | Settings, gate, kill switch, webhooks specs landed and green |
| **M4 — Full FR coverage** | T-021-2-05 .. 2-09 | ~6.0 h | All FR-021-02 through FR-021-10 have a spec; full suite runtime <5 min (NFR-021-01) |
| **M5 — Regression discipline established** | First 3 Phase-3 specs | variable | Bug-triage workflow includes the Phase-3 template; ≥3 regression specs on `main` |

---

## 10. Risks & Mitigations

| Risk | Probability | Impact | Affected tasks | Mitigation | Contingency |
|---|---|---|---|---|---|
| **R1 — Bun/Cypress runtime incompatibility** beyond simple npm-script glue (e.g. some portal startup code that fails under bun-as-server-launched-by-node) | Medium | High | T-021-1A-05 | Run portal via `bun run start` from inside the node-launched orchestrator (we never load Cypress's hooks under Bun); explicitly document the boundary | Fall back to `node` execution of the portal server for the test harness only; production stays on Bun |
| **R2 — `POST /__test/reset` introduces a security footgun** if env gate is misconfigured in a real deployment | Low | High | T-021-1A-04 | The gate checks `process.env.PORTAL_TEST_MODE === '1'` (strict equality, not truthy); unit test in T-021-1A-04 explicitly covers the gate-off case returning 404 | Add a CI check that grep-fails the build if `PORTAL_TEST_MODE` appears in any production-bound config |
| **R3 — Flaky tests** from poll-based UI assertions | High | Medium | All Phase 2 specs | Standardize on `cy.clock()` + `cy.tick()` for time-based assertions; configure `retries.runMode: 1`; per-spec `defaultCommandTimeout` budget | If a spec flakes >2× in 30 days, escalate to a redesign of the assertion (not just a longer timeout) |
| **R4 — Fixture drift** as the portal server types evolve | Medium | Medium | T-021-1A-06 and all consumers | Builders import the portal's runtime types directly (no hand-rolled shapes); typecheck runs in CI | Quarterly review of `cypress/support/builders.ts` against `server/types/` |
| **R5 — TDD-021 doesn't exist under the expected filename yet** ("TDD-021-cypress-ui-coverage.md") — the slot is occupied by `TDD-021-standards-dsl-auto-detection.md` | High | Low | All tasks that cite TDD §N | Spec Author for each task reconciles section references against the actually-named TDD-021 (whatever its final filename); PRD-021 FRs are the canonical fallback | If the TDD is never written, the plan is still executable directly from PRD-021 + the phase definitions in this plan |
| **R6 — CI cost / runtime budget breach** (NFR-021-01 < 5 min) once Phase 3 grows | Medium | Medium | Phase 3 | Spec sharding via `cypress run --spec` patterns and a matrix job; baseline budget tracked in CI logs | If budget breached, split the workflow into "fast" (Phase 1A/1B/2) and "regression" (Phase 3) jobs; fast must stay <5 min, regression can be <10 min |

---

## 11. Out of Scope

- Visual regression — covered by `playwright.config.ts` + `tests/visual-regression/`.
- Accessibility (axe-core) — separate initiative (PRD §2 Non-Goals, §12).
- Real-daemon integration suite — explicitly deferred (PRD §6 Recommendation).
- Cross-browser (Firefox/Safari) — Chrome only for this iteration (PRD §12).
- Cypress component tests — open question Q-021-03; deferred to a future PRD.

---

## 12. Definition of Done (whole plan)

1. All Phase 1A tasks merged; `npm run cypress:ci` exits 0 on `main`.
2. Phase 1B nav matrix green for all 12 routes.
3. Phase 2 specs (FR-021-02 .. FR-021-10) all merged and green; full suite runtime <5 min (NFR-021-01).
4. Phase 3 template documented and at least 3 regression specs filed by following it.
5. `.github/workflows/portal-cypress.yml` runs on every PR touching `plugins/autonomous-dev-portal/**` and is a required check.
6. AC-021-01 through AC-021-08 each map to ≥1 Cypress test (traceability matrix appended to the TDD or the plan's appendix at completion).

---

## 13. Open Questions for the Spec Author

1. **Builders' source of truth.** Should `cypress/support/builders.ts` import portal types from `server/types/` directly, or should we publish a `@autonomous-dev/portal-fixtures` workspace package? (Default: direct import; revisit if other test surfaces want the same builders.)
2. **State reset granularity.** `POST /__test/reset` — full wipe per test, or per-suite? Per-test is safest, per-suite is faster. PRD Q-021-04 left this open. Default: per-test for Phase 1/2, with a `cy.task('resetSuiteOnly')` escape hatch.
3. **Visibility-state stubbing.** Cypress doesn't natively flip `document.visibilityState`. T-021-2-07 assumes `cy.stub(document, 'visibilityState', ...)`; the Spec Author should confirm this works against the portal's actual implementation of the polling pause.
4. **Bug-catalog cadence.** Phase 3 assumes the bug catalog is the system of record. If catalog entries are mirrored into Jira/GitHub Issues, the trigger for filing a `T-021-3-NN` task may need to fire on issue creation instead of catalog entry.

---

**End of PLAN-021.**
