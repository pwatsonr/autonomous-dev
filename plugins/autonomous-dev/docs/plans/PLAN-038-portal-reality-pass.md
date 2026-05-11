# PLAN-038: Portal Reality Pass — Implementation Plan

| Field          | Value                                                         |
|----------------|---------------------------------------------------------------|
| **Plan ID**    | PLAN-038                                                      |
| **Title**      | Portal Reality Pass — Implementation Plan                     |
| **Version**    | 1.0                                                           |
| **Date**       | 2026-05-11                                                    |
| **Parent TDD** | TDD-037-portal-reality-pass                                   |
| **Parent PRD** | PRD-018-portal-visual-redesign                                |
| **Plugin**     | autonomous-dev-portal                                         |
| **Authoring**  | Synthesized from 3 parallel planning agents via `/universal-dev:taskPlan` |
| **Version**    | 1.1 (open-questions resolved 2026-05-11; see `PLAN-038-open-questions-resolutions.md`) |

---

## Overview

TDD-037 closes the residual gap left by PRD-018's earlier TDDs (foundations, shell+primitives, surfaces). The visual kit is in place but every operator surface renders stub fixtures, four routes 404, one route 500s, the brand SVGs are not served, and the static-root duplication from PLAN-037 still hasn't been swept. This plan decomposes the work into **22 tasks across 4 parallel tracks** with explicit dependencies, agent assignments, and acceptance-criteria-linked tests.

**Total estimated effort**: 9–11 engineering days for one author. Three tracks can run in parallel for the first ~3 days; the surface-wiring track (Track D) is the long pole.

**Key planning agent findings synthesized into this plan**:
- Agent 2 (Architecture) identified a **badge data-flow gap** in the TDD — `ShellProps` doesn't carry badge counts today. Added as TASK-018 (explicit `ShellProps` extension) before TASK-019 (rail-nav consumer).
- Agent 2 flagged **type-system friction** between TDD-proposed `RepoSummary` and the existing one in `render.ts`. Resolved: extend existing types where possible (TASK-008), add net-new types (`AgentsPageData`, `ReposPageData`) for the new surfaces.
- Agent 3 (Risk) raised **6 open questions** that need answers before some tasks can start (listed in §Open Questions below).
- Agent 3 produced the **12-test matrix** integrated into the AC column of every task.

---

## Context

- **TDD reference**: `plugins/autonomous-dev/docs/tdd/TDD-037-portal-reality-pass.md`
- **Branch this plan lives on**: `docs/plan/portal-reality-pass`
- **Implementation branch suggestion**: `feat/portal-reality-pass-PLAN-038` (or per-task feature branches; see Parallel Tracks)
- **Estimated complexity**: Large (9–11 days, 22 tasks)
- **Lint command** (all tasks): `bun run lint` (eslint) + `bun run typecheck` (tsc --noEmit)
- **Test runner**: `bun test`
- **Visual regression** (when applicable): `npm run test:visual` (Playwright, currently scoped to `/design-system` only — extend as part of TASK-022)

---

## Agent Assignment Note

The codebase is **TypeScript on Bun + Hono** (server-side JSX). No `python-expert`, `java-dgs-expert`, etc. directly match. All implementation tasks are assigned to **`code-executor`** (the generic implementer in the universal-dev plugin set) with the TDD as the authoritative spec. Code-review on every PR uses **`code-reviewer`**. CSS / asset / cleanup tasks where no language specialist applies are also `code-executor`. Tasks involving server topology decisions (route registration, static-root sweep) consult **`system-architect`** as secondary.

---

## Parallel Tracks

Four tracks run in parallel for the first 3 days; Track D depends on Tracks A–C completing their foundation tasks.

| Track | Theme                          | Tasks                                | Days | Depends on                  |
|-------|--------------------------------|--------------------------------------|------|-----------------------------|
| A     | Assets + CSS (low risk)        | TASK-001, 002, 005                   | 0.5  | nothing                     |
| B     | Routes + 500→404 fix           | TASK-003, 004, 006                   | 1    | nothing                     |
| C     | Data layer (atomic + composition) | TASK-007, 008, 009, 010, 011      | 3    | nothing initially; needs O.Q. answered |
| D     | Surface wiring + nav badges    | TASK-012..020                        | 5    | C complete                  |
| E     | Tests + screenshots            | TASK-021, 022                        | 1    | D complete                  |

---

## Tasks

### Track A — Assets + CSS

#### TASK-001 — Copy brand SVGs to served static root
- **Description**: Copy `wordmark.svg`, `wordmark-dark.svg`, `mark.svg` from `/tmp/portal-design-v2/autonomous-dev-design-system/project/assets/` (also present in `server/static/brand/`) into `plugins/autonomous-dev-portal/static/brand/`. Build a 32×32 `favicon.svg` from `mark.svg` (or use `mark.svg` directly with `<link rel="icon">` — favicon-as-mark is acceptable per TDD §5.4). Add `<link rel="icon" type="image/svg+xml" href="/favicon.svg">` to `server/components/shell.tsx`'s `<head>`.
- **Owner Agent**: `code-executor`
- **Files**:
  - `plugins/autonomous-dev-portal/static/brand/wordmark.svg` (new)
  - `plugins/autonomous-dev-portal/static/brand/wordmark-dark.svg` (new)
  - `plugins/autonomous-dev-portal/static/brand/mark.svg` (new)
  - `plugins/autonomous-dev-portal/static/favicon.svg` (new)
  - `plugins/autonomous-dev-portal/server/components/shell.tsx` (edit `<head>`)
- **Dependencies**: None
- **Lint**: `bun run lint`
- **Test**: `bun test server/__tests__/brand-assets-served.test.ts` (new file). Curl-style integration: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:19280/static/brand/wordmark.svg` → 200; same for `mark.svg`, `wordmark-dark.svg`, `/favicon.svg`.
- **Acceptance Criteria**:
  - [ ] AC-3701 — all four asset paths return 200
  - [ ] `<link rel="icon">` present in shell `<head>`
- **Estimate**: 1 hr

#### TASK-002 — Static-root sweep + delete `server/static/`
- **Description**: Per-file authority is now known (O.Q. #4 resolved). Procedure: (1) `cp server/static/gate-actions.js static/gate-actions.js`, (2) `cp server/static/shell.css static/shell.css`, (3) `cp server/static/modal.js static/modal.js`, (4) `cp server/static/icons/sliders.svg static/icons/sliders.svg`, (5) **leave `static/theme-toggle.js` untouched** (already newer than server/static/), (6) `git rm -r server/static/`, (7) rewrite refs with `git grep -l 'server/static' | xargs sed -i ''`. Smoke-test all critical assets after.
- **Owner Agent**: `code-executor` (consult `system-architect` for cascade/authority decisions)
- **Files**:
  - `plugins/autonomous-dev-portal/server/static/` (delete entire tree)
  - 20+ files in `server/`, `docs/`, `specs/` rewriting `server/static` → `static`
- **Dependencies**: TASK-001 (so brand assets land in canonical location first)
- **Lint**: `bun run lint`
- **Test**: `bun test server/__tests__/static-root-sweep-smoke.test.ts` (new). Asserts: `ls server/static` errors, `git grep 'server/static' -- server/ docs/ specs/` empty, key assets serve 200.
- **Acceptance Criteria**:
  - [ ] AC-3712 — `server/static/` deleted, no live grep references
  - [ ] No regressions: all CSS/JS/SVG assets still 200 (smoke test passes)
- **Estimate**: 1.5 hr

#### TASK-003 — CTA `--brand` audit + fix
- **Description**: Grep `static/{app,portal,shell}.css` for the dashboard `+ New request` button rule and any other primary-button rule. If the rule hard-codes a hex or references an undefined variable, route through `var(--brand)`. Per TDD §5.6 step 5, verify on `/design-system`. **Constraint** (TDD risk row): do not edit `app.css` if the rule is in the vendored kit CSS — override in `portal.css` at the same specificity instead.
- **Owner Agent**: `code-executor`
- **Files**:
  - `plugins/autonomous-dev-portal/static/portal.css` (likely edit)
  - `plugins/autonomous-dev-portal/static/shell.css` (possible edit)
  - `plugins/autonomous-dev-portal/static/app.css` (read-only inspection — do not edit, vendored)
- **Dependencies**: TASK-002 (sweep first so we know `static/` is canonical)
- **Lint**: `bun run lint`
- **Test**: `bun test server/__tests__/brand-token-consumption.test.ts` (new) + headless Chrome `cta-color-computed-style.test.ts` (Playwright extension).
- **Acceptance Criteria**:
  - [ ] AC-3711 — `getComputedStyle(html).getPropertyValue('--brand')` non-empty in both themes
  - [ ] CTA button computed `background-color` equals `--brand` value
  - [ ] No `--accent*` tokens introduced (`git grep '\-\-accent' static/` empty)
- **Estimate**: 1 hr

### Track B — Routes + 500→404 fix

#### TASK-004 — Fix `/repo/:repo/request/:id` 500 → 404
- **Description**: `server/routes/request-detail.ts` currently throws when the request is not in the store. Wrap the lookup in try/catch (or use the existing safe-load pattern) and return `c.notFound()` on missing. Integration test pins both the regex-rejected case (still 404 via the regex guard) and the store-miss case (404 via the new branch).
- **Owner Agent**: `code-executor`
- **Files**:
  - `plugins/autonomous-dev-portal/server/routes/request-detail.ts`
- **Dependencies**: None
- **Lint**: `bun run lint`
- **Test**: `bun test server/__tests__/request-detail-500-to-404.test.ts` (new). Pins:
  - `GET /repo/no-such-repo/request/REQ-999999` → 404 with 404 surface body
  - `GET /repo/__bad__/request/__bad__` → 404 via regex guard
- **Acceptance Criteria**:
  - [ ] AC-3705 — both 404 paths exercised, no 500
- **Estimate**: 1 hr

#### TASK-005 — Add `/agents`, `/repos`, `/api/agents` route stubs (empty-data scaffolding)
- **Description**: Register the three new routes in `server/routes/index.ts` and create `server/routes/agents.tsx`, `server/routes/repos.tsx`, and the JSON handler. Initially return `Promise.resolve(emptyAgentsPageData)` / `emptyReposPageData` so the routes land before the readers are written (Agent 1's sequencing). The view files (which render the data) come next.
- **Owner Agent**: `code-executor`
- **Files**:
  - `plugins/autonomous-dev-portal/server/routes/agents.tsx` (new)
  - `plugins/autonomous-dev-portal/server/routes/repos.tsx` (new)
  - `plugins/autonomous-dev-portal/server/routes/index.ts` (register 3 routes)
- **Dependencies**: TASK-007 (needs `AgentsPageData`/`ReposPageData` types)
- **Lint**: `bun run lint && bun run typecheck`
- **Test**: `bun test server/__tests__/new-routes-404-to-200.test.ts` (new). Pins:
  - `GET /agents` → 200
  - `GET /repos` → 200
  - `GET /api/agents` → 200 with `Content-Type: application/json` and `[]` body
- **Acceptance Criteria**:
  - [ ] AC-3702/AC-3703/AC-3704 — all three routes 200 (data wiring comes later)
- **Estimate**: 1.5 hr

#### TASK-006 — Fix rail-nav `Agents` href + relabel `Ops` → `Operations`
- **Description**: In `server/components/rail-nav.tsx`, change the Agents nav item from `href="/settings#agents"` to `href="/agents"`. Confirm the SYSTEM section label still reads `Agents` (no change). Per TDD §3.3, the kit shows `Operations` (not `Ops`) — update the label if it's safe to do so without breaking existing tests; otherwise document as a deferred copy fix.
- **Owner Agent**: `code-executor`
- **Files**:
  - `plugins/autonomous-dev-portal/server/components/rail-nav.tsx`
- **Dependencies**: TASK-005 (so `/agents` is a real route when the nav points there)
- **Lint**: `bun run lint`
- **Test**: Snapshot/DOM test in `rail-nav.test.tsx` (new or extended) asserts `href="/agents"`.
- **Acceptance Criteria**:
  - [ ] Rail-nav `Agents` `href` equals `/agents` (per AC-3702)
- **Estimate**: 30 min

### Track C — Data layer (atomic + composition readers)

#### TASK-007 — Add `AgentsPageData`, `ReposPageData`, `RepoSummary` extensions to `render.ts`
- **Description**: Per TDD §5.1.1a + O.Q. #3 resolution, add the typed sketches. Agent 2's recommendation: **extend** the existing `RepoSummary` (if present) with optional new fields rather than introducing a parallel type; introduce new `AgentsPageData` and `ReposPageData` only for the net-new surfaces. **AgentsPageData fields `runs30d`, `fpRate`, `lastDispatchAt` MUST be optional** (`?: number | null`) — the daemon does not track these. View renders `—` when absent. Pin all field types.
- **Owner Agent**: `code-executor`
- **Files**:
  - `plugins/autonomous-dev-portal/server/types/render.ts`
- **Dependencies**: None
- **Lint**: `bun run typecheck`
- **Test**: `bun test server/types/__tests__/render-types.test.ts` (extend if exists, new otherwise). Type-only assertions.
- **Acceptance Criteria**:
  - [ ] `AgentsPageData`, `ReposPageData`, `RepoSummary` exports present
  - [ ] `tsc --noEmit` passes
- **Estimate**: 1 hr

#### TASK-008 — Extend `state-paths.ts` with new paths
- **Description**: Per O.Q. #2/#3 resolution: add `agentStatesPath()` returning `~/.autonomous-dev/agent-states.json` and `kitParityFixtureRoot()` returning `server/fixtures/kit-parity/` (resolved relative to the package). `requestActionsDir()` and `gateDecisionsDir()` already exist — no new exports needed for the request-ledger reader. **Do not** add a `requestLedgerPath()` (the daemon does not write that file; v1.1 of the TDD was wrong).
- **Owner Agent**: `code-executor`
- **Files**:
  - `plugins/autonomous-dev-portal/server/wiring/state-paths.ts`
- **Dependencies**: O.Q. #2 + O.Q. #3 resolved (✓ — see resolutions doc)
- **Lint**: `bun run typecheck`
- **Test**: `bun test server/wiring/__tests__/state-paths.test.ts` (new). Pin default paths; pin `AUTONOMOUS_DEV_STATE_DIR` override behavior (already verified to work).
- **Acceptance Criteria**:
  - [ ] Two new path functions exported (`agentStatesPath`, `kitParityFixtureRoot`)
  - [ ] Default paths match daemon-written paths
- **Estimate**: 30 min

#### TASK-009 — Commit `server/fixtures/kit-parity/` directory
- **Description**: Create the five canonical JSON fixture files matching the kit screenshot exactly (`Active 9 across 6 repos`, `Awaiting 3`, `MTD $153.60`, `Agents 14`, 6 repo allowlist). Document provenance in `README.md`. **Risk** (Agent 3): fixture schema must match what the readers parse — write fixture-schema-validation tests alongside.
- **Owner Agent**: `code-executor`
- **Files** (all new):
  - `plugins/autonomous-dev-portal/server/fixtures/kit-parity/agent-states.json`
  - `plugins/autonomous-dev-portal/server/fixtures/kit-parity/approvals-queue.json`
  - `plugins/autonomous-dev-portal/server/fixtures/kit-parity/requests-ledger.json`
  - `plugins/autonomous-dev-portal/server/fixtures/kit-parity/cost-ledger.json`
  - `plugins/autonomous-dev-portal/server/fixtures/kit-parity/portal-settings.json`
  - `plugins/autonomous-dev-portal/server/fixtures/kit-parity/README.md`
- **Dependencies**: TASK-008 (for path constants); O.Q. #2/#3 answered (for schema)
- **Lint**: JSON validity (`jq . <file>`)
- **Test**: `bun test server/fixtures/__tests__/fixture-schema-validation.test.ts` (new). Asserts each fixture parses, has minimum keys, and the counts match the kit screenshot (`agent-states.json` has 14 entries, `approvals-queue.json` has 3, etc.).
- **Acceptance Criteria**:
  - [ ] All five JSON files valid and committed
  - [ ] Counts match kit screenshot
- **Estimate**: 2 hr

#### TASK-010 — Implement atomic readers
- **Description**: Write the three atomic readers per TDD §5.1.1 (v1.2 amendments applied):
  - `wiring/request-ledger-reader.ts` — **aggregates** from `requestActionsDir()/*.json` + `gateDecisionsDir()/<repo>/<id>.json`. For each request id, the latest action wins; gate-decision joins in the in-gate/decided state. Returns deduped `RequestRow[]`.
  - `wiring/repo-aggregation-reader.ts` — reduces request ledger + cost ledger by repo. Returns `Map<RepoId, RepoSummary>`.
  - `wiring/agent-states-reader.ts` — scans `plugins/autonomous-dev/agents/*.md` for the canonical agent list (read filename as name; frontmatter for `description`), overlays `frozen[]` and `shadowed[]` from `agent-states.json`. Returns `AgentState[]` with `runs30d`, `fpRate`, `lastDispatchAt` as `null` (daemon does not track these).
  All readers must default to safe empty state on ENOENT / parse error (Agent 3's resilience requirement).
- **Owner Agent**: `code-executor`
- **Files**:
  - `plugins/autonomous-dev-portal/server/wiring/request-ledger-reader.ts` (new)
  - `plugins/autonomous-dev-portal/server/wiring/repo-aggregation-reader.ts` (new)
  - `plugins/autonomous-dev-portal/server/wiring/agent-states-reader.ts` (new)
- **Dependencies**: TASK-007, TASK-008, TASK-009
- **Lint**: `bun run lint && bun run typecheck`
- **Test**: `bun test server/wiring/__tests__/file-backed-reader-edge-cases.test.ts` (new). Each reader: missing file → empty, corrupt JSON → empty + warning, perm error → empty + warning. Plus golden-path tests against `kit-parity` fixtures.
- **Acceptance Criteria**:
  - [ ] All three readers handle missing/corrupt/perm-error gracefully
  - [ ] Against `kit-parity`, output matches fixture counts
- **Estimate**: 3 hr

#### TASK-011 — Implement composition readers
- **Description**: Write the three composition readers per TDD §5.1.2:
  - `wiring/dashboard-readers.ts` — composes daemon + approvals + request-ledger + repo-aggregation → `DashboardData`
  - `wiring/agents-readers.ts` — composes agent-states + manifest → `AgentsPageData`
  - `wiring/repos-readers.ts` — composes repo-aggregation + portal-settings → `ReposPageData`
  Each takes `{ stateRoot?: string }`, is async, returns the view-input type. Honest zeros on empty state. Agent 2's gap: explicitly map atomic outputs to view-input shape (don't assume identity).
- **Owner Agent**: `code-executor`
- **Files**:
  - `plugins/autonomous-dev-portal/server/wiring/dashboard-readers.ts` (new)
  - `plugins/autonomous-dev-portal/server/wiring/agents-readers.ts` (new)
  - `plugins/autonomous-dev-portal/server/wiring/repos-readers.ts` (new)
- **Dependencies**: TASK-010
- **Lint**: `bun run lint && bun run typecheck`
- **Test**: `bun test server/wiring/__tests__/composition-readers.test.ts` (new). Empty-state honesty: with empty fixture dir, all KPIs are 0. With `kit-parity`, output matches kit screenshot values.
- **Acceptance Criteria**:
  - [ ] Each composition reader returns the correct view-input type
  - [ ] Empty-state honesty contract satisfied
- **Estimate**: 3 hr

### Track D — Surface wiring (depends on Track C complete)

#### TASK-012 — Wire Dashboard route to `readDashboardData`
- **Description**: Swap `server/routes/dashboard.ts` from `dashboardStub()` to `await readDashboardData()`. Update the route handler signature if needed (must be async). Honest empty-state copy when KPIs are zero.
- **Owner Agent**: `code-executor`
- **Files**: `plugins/autonomous-dev-portal/server/routes/dashboard.ts`
- **Dependencies**: TASK-011
- **Lint**: `bun run lint && bun run typecheck`
- **Test**: `bun test server/__tests__/dashboard-real-vs-fixture-data.test.ts` (new). With empty state-dir: KPI strip shows `0 active`, `$0.00 MTD`. With `kit-parity` fixtures: matches kit screenshot.
- **Acceptance Criteria**:
  - [ ] AC-3706 — dashboard KPIs come from real readers
  - [ ] No `REQ-000001..3`, `acme`, `beta`, `REQ-2041..2044` in `git grep` of `server/routes/dashboard.ts`
- **Estimate**: 1 hr

#### TASK-013 — Wire Approvals route to `approvals-store`
- **Description**: Swap `server/routes/approvals.ts` from `stubs/approvals.ts` to `wiring/approvals-store.tsx`. Empty-state copy: "No approvals waiting".
- **Owner Agent**: `code-executor`
- **Files**: `plugins/autonomous-dev-portal/server/routes/approvals.ts`
- **Dependencies**: TASK-011 (uses the same store; no new wiring needed but the route handler swap pattern is shared)
- **Lint**: `bun run lint`
- **Test**: `bun test server/__tests__/surface-empty-states.test.ts::approvals` (new). Empty store → empty-state copy. `kit-parity` → 3 approvals.
- **Acceptance Criteria**:
  - [ ] AC-3707 — empty state honest; REQ-2041..2044 not reachable from route
- **Estimate**: 1 hr

#### TASK-014 — Wire Requests route to `readRequestsData`
- **Description**: Swap `server/routes/requests.ts` from stubs to a new `readRequestsData()` composition (or inline use of `request-ledger-reader`). Empty-state copy.
- **Owner Agent**: `code-executor`
- **Files**: `plugins/autonomous-dev-portal/server/routes/requests.ts`
- **Dependencies**: TASK-011
- **Lint**: `bun run lint`
- **Test**: `bun test server/__tests__/surface-empty-states.test.ts::requests`.
- **Acceptance Criteria**:
  - [ ] Real request-ledger drives the surface; no stub references in route handler
- **Estimate**: 1 hr

#### TASK-015 — Wire `/agents` and `/repos` to real readers (replaces TASK-005 stubs)
- **Description**: Swap the empty-data placeholders in `server/routes/agents.tsx` and `server/routes/repos.tsx` for `await readAgentsData()` and `await readReposData()`. Wire the JSON `/api/agents` handler to return the same agent list as a JSON array.
- **Owner Agent**: `code-executor`
- **Files**:
  - `plugins/autonomous-dev-portal/server/routes/agents.tsx`
  - `plugins/autonomous-dev-portal/server/routes/repos.tsx`
- **Dependencies**: TASK-011, TASK-005
- **Lint**: `bun run lint && bun run typecheck`
- **Test**: Extend `new-routes-404-to-200.test.ts` to assert content: 14 agent names from `kit-parity/agent-states.json` on `/agents`; 6 repos on `/repos`; JSON `[{name,version,status,mode}, ...]` on `/api/agents`.
- **Acceptance Criteria**:
  - [ ] AC-3702 — `/agents` lists all 14 fixture agents
  - [ ] AC-3703 — `/repos` lists every allowlist entry
  - [ ] AC-3704 — `/api/agents` returns JSON content-type
- **Estimate**: 1.5 hr

#### TASK-016 — Wire Costs route (multi-reader composition)
- **Description**: Swap `server/routes/costs.tsx` to use the cost-ledger reader for KPIs and daily-spend chart (data-driven from the real `daily: {date: {total_usd}}` shape). Reviewer table is **empty-state by default** on a normal install (O.Q. #6 resolved: cost-ledger does not track per-reviewer data). Render the table headers with an empty body and a "Reviewer-level cost tracking not enabled" message that links to Settings. With `kit-parity` fixtures, the table populates from the fixture's richer reviewer schema so the kit screenshot regression still works. Daily-spend chart data shape: `[{date, total_usd}, ...]` mapped from `Object.entries(cost-ledger.daily)`.
- **Owner Agent**: `code-executor`
- **Files**: `plugins/autonomous-dev-portal/server/routes/costs.tsx`, possibly new `server/wiring/costs-readers.ts`
- **Dependencies**: TASK-011, O.Q. #6 answered
- **Lint**: `bun run lint && bun run typecheck`
- **Test**: `bun test server/__tests__/costs-surface.test.ts` (new). With `kit-parity`: reviewer table lists the plugin's real `.claude/agents/` names; daily-spend chart has 30 entries from cost-ledger. Empty state: chart is empty, reviewer table is empty.
- **Acceptance Criteria**:
  - [ ] AC-3708 — no `qa-edge-case`, `ux-ui`, `accessibility`, `rule-set` in route handler imports
  - [ ] Reviewer table sourced from `.claude/agents/` manifest scan
- **Estimate**: 3 hr (1.5 days per TDD §8 — split if needed)

#### TASK-017 — Wire Ops route (multi-reader composition)
- **Description**: Swap `server/routes/ops.tsx` for real readers: daemon-status (existing), plugin-manifest scan (read `.claude-plugin/plugin.json` from this and adjacent plugins), MCP probe (HTTP HEAD against configured MCP servers from settings), and a daemon-log tail. The log tail is a new reader — opens the daemon log file (path from `state-paths.ts`), reads last N lines, returns as `LogEntry[]`.
- **Owner Agent**: `code-executor` (consult `system-architect` for MCP probe design)
- **Files**:
  - `plugins/autonomous-dev-portal/server/routes/ops.tsx`
  - `plugins/autonomous-dev-portal/server/wiring/ops-readers.ts` (new)
  - `plugins/autonomous-dev-portal/server/wiring/daemon-log-tail.ts` (new)
- **Dependencies**: TASK-011
- **Lint**: `bun run lint && bun run typecheck`
- **Test**: `bun test server/__tests__/ops-surface.test.ts` (new). With daemon down: PID `—`, uptime `daemon stopped`, plugin version from real manifest. With `kit-parity`: matches fixture values. MCP probe failure: returns `degraded` status, doesn't crash.
- **Acceptance Criteria**:
  - [ ] AC-3709 — no `pid 18472`, `4d 12h`, `autonomous-dev@2.4.0` strings in route handler
- **Estimate**: 3 hr (1.5 days per TDD §8 — split if needed)

#### TASK-018 — Extend `ShellProps` to carry badge counts (architecture gap, Agent 2)
- **Description**: Agent 2 identified that `ShellProps` doesn't include badge counts today; this is the missing data-flow piece for TASK-019. Add `badges?: { approvals?: number; requests?: number; agents?: number }` to `ShellProps` in `server/components/shell.tsx`. Every route handler that renders the shell must pass `badges` from its composition reader (single source of truth per TDD §5.1.3).
- **Owner Agent**: `code-executor`
- **Files**:
  - `plugins/autonomous-dev-portal/server/components/shell.tsx` (extend props)
  - `plugins/autonomous-dev-portal/server/routes/*.{ts,tsx}` (every route that renders shell — pass badges)
- **Dependencies**: TASK-011
- **Lint**: `bun run lint && bun run typecheck`
- **Test**: `bun test server/components/__tests__/shell-props.test.tsx` (new or extended). Pin the new prop signature.
- **Acceptance Criteria**:
  - [ ] `ShellProps` accepts optional `badges`
  - [ ] All route handlers pass badge counts from the same readers as KPIs
- **Estimate**: 1.5 hr

#### TASK-019 — Implement nav badges in rail-nav
- **Description**: In `server/components/rail-nav.tsx`, add an optional `badge?: number` prop on the nav item template. Render the badge span only when `badge !== undefined && badge > 0`. Consume `props.badges` from the shell.
- **Owner Agent**: `code-executor`
- **Files**:
  - `plugins/autonomous-dev-portal/server/components/rail-nav.tsx`
- **Dependencies**: TASK-018
- **Lint**: `bun run lint`
- **Test**: `bun test server/components/__tests__/nav-badge-composition.test.tsx` (new). With `badges={approvals:3, requests:8, agents:14}`: three badges render with correct numbers. With `badges={approvals:0}`: no badge. Badge count matches destination surface's primary KPI (forced state-file value of N → both badge and KPI render N).
- **Acceptance Criteria**:
  - [ ] AC-3710 — badges hide when 0, show when > 0; match destination KPI
- **Estimate**: 1 hr

#### TASK-020 — Wire Settings route to real allowlist
- **Description**: Swap `server/routes/settings.ts` (and any settings-tab handlers in `settings-actions.tsx`) for the real portal-settings store. The allowlist comes from the same store. No more `/Users/op/repos/acme` fixture paths.
- **Owner Agent**: `code-executor`
- **Files**:
  - `plugins/autonomous-dev-portal/server/routes/settings.ts`
- **Dependencies**: TASK-011
- **Lint**: `bun run lint`
- **Test**: `bun test server/__tests__/settings-surface.test.ts` (new). With `kit-parity`: 6-repo allowlist matches fixture.
- **Acceptance Criteria**:
  - [ ] No fake repo paths in route handler
  - [ ] Real allowlist drives the surface
- **Estimate**: 1 hr

### Track E — Tests + Screenshots

#### TASK-021 — Reader performance integration test (p95 ≤ 50ms)
- **Description**: Per AC-3715: 10 cold dashboard renders against `kit-parity` fixtures, take p95, assert ≤50ms. Use `bun test` with a fresh `state-dir` per run. Agent 3 flagged this as risky — if 50ms is unrealistic with 5+ JSON reads, **relax to ≤100ms** (decision authority: spec author after empirical measurement).
- **Owner Agent**: `code-executor`
- **Files**:
  - `plugins/autonomous-dev-portal/server/__tests__/composition-reader-performance.test.ts` (new)
- **Dependencies**: TASK-011
- **Lint**: `bun run lint`
- **Test**: Self
- **Acceptance Criteria**:
  - [ ] AC-3715 — perf assertion green (or threshold adjusted with rationale in PR)
- **Estimate**: 1 hr

#### TASK-022 — Before/after screenshot bundle + CI diff job
- **Description**: Per AC-3713 + TDD G-3715: capture before/after screenshots for Dashboard, Approvals, Requests, Costs, Ops, Settings (each tab), `/agents`, `/repos`, `/repo/<valid>/request/<valid>`, `/repo/no-such-repo/request/REQ-999999`. All taken with `AUTONOMOUS_DEV_STATE_DIR=server/fixtures/kit-parity`. Bundle in PR. Add a CI job (extend Playwright config or write a small Bun script) that diffs new screenshots against committed baselines.
- **Owner Agent**: `code-executor` (consult `system-architect` for CI integration)
- **Files**:
  - `plugins/autonomous-dev-portal/tests/visual-regression/screenshots/` (new directory + baselines)
  - `plugins/autonomous-dev-portal/tests/visual-regression/portal-surfaces.spec.ts` (new Playwright spec)
  - Possibly `.github/workflows/portal-visual-regression.yml` (new)
- **Dependencies**: All Track D tasks (TASK-012..020)
- **Lint**: `bun run lint`
- **Test**: `npm run test:visual` extended to cover all surfaces
- **Acceptance Criteria**:
  - [ ] AC-3713 — every named surface has before/after pair in PR
  - [ ] AC-3714 — `git grep PORTAL_DEMO_MODE` returns no matches; no `if (DEMO_MODE)` branches in any route handler (self-review confirmed missing from earlier task ACs)
  - [ ] CI screenshot diff job runs
- **Estimate**: 2 hr

---

## Dependency Graph (Critical Path)

```
TASK-001 ─→ TASK-002 ─→ TASK-003                              (Track A: 3.5h)

TASK-004                                                      (Track B: 1h, no deps)
TASK-007 ──→ TASK-005 ──→ TASK-006                            (Track B/C interleave: 2h)

TASK-007 ──→ TASK-008 ──→ TASK-009 ──→ TASK-010 ──→ TASK-011  (Track C critical path: 10h)
                                                       │
                                                       ├─→ TASK-012 (Dashboard)        \
                                                       ├─→ TASK-013 (Approvals)         \
                                                       ├─→ TASK-014 (Requests)          ── parallel (5h max)
                                                       ├─→ TASK-018 → TASK-019 (badges) /
                                                       ├─→ TASK-020 (Settings)         /
                                                       │
                                                       ├─→ TASK-015 (/agents, /repos)
                                                       ├─→ TASK-016 (Costs)             \
                                                       └─→ TASK-017 (Ops)               ── 3h each sequential
                                                       
                                                       ├─→ TASK-021 (perf test)
                                                       └─→ TASK-022 (screenshots)       (after all D)
```

**Critical path** (longest sequence of dependencies): TASK-007 → 008 → 009 → 010 → 011 → 016 → 022 = **~13 hours single-threaded on critical items**, but with parallelism in Track D the wall-clock is ~9–11 days.

---

## Open Questions (must be resolved before listed tasks start)

These came out of Agent 3's risk review. Each blocks a specific task — do not proceed past that task without an answer.

| # | Question | Blocks | Suggested resolution path |
|---|----------|--------|---------------------------|
| O.Q. #1 | Is p95 ≤ 50ms realistic for the dashboard reader composing 5+ JSON files? Or should it be relaxed to ≤100ms? | TASK-021 | Measure empirically in TASK-010 (atomic readers) and TASK-011 (composition) — if 50ms is tight, document the threshold change in the PR before TASK-021. |
| O.Q. #2 | What is the actual daemon-written path for the request ledger? TDD says `~/.autonomous-dev/portal/requests-ledger.json` but this needs confirmation. | TASK-008, TASK-009, TASK-010 | Read the daemon's writer code (`autonomous-dev/cli` or daemon source) to confirm. If the daemon writes elsewhere, update `state-paths.ts` to match the daemon (NG-3707 — we don't change the daemon). |
| O.Q. #3 | What schema does `agent-states.json` actually use? TDD references the CLI bridge writing this file but the field set is unknown. | TASK-008, TASK-009, TASK-010 | Read the CLI bridge writer code or inspect a real `~/.autonomous-dev/agent-states.json` on a machine that has run `autonomous-dev agent freeze`. |
| O.Q. #4 | For the three differing static files (`gate-actions.js`, `shell.css`, `theme-toggle.js`), which version wins — `server/static/` or `static/`? | TASK-002 | Read both versions per file. Newer-by-design wins (e.g., `static/shell.css` if it carries PR #231's palette work). Document the decision per file in the TASK-002 PR. |
| O.Q. #5 | What exact empty-state copy matches the kit's voice? Examples needed: "No active requests", "No approvals waiting", "Daemon stopped", "No costs yet". | TASK-012..020 | Read the kit's `ui_kits/portal/*.jsx` files for empty-state placeholders. If absent, write strings aligned with R-23 (sentence case, no emoji, no exclamation marks) and ship in TASK-022's PR for visual review. |
| O.Q. #6 | How do cost-ledger entries map to `.claude/agents/*.md` files for the Costs reviewer table — is there a `reviewer_name` field on each entry, or do we aggregate by phase? | TASK-016 | Inspect a real `~/.autonomous-dev/cost-ledger.json` on a machine with run history. If `reviewer_name` is absent, document the aggregation strategy in the TASK-016 spec. |

**Recommendation**: Resolve O.Q. #2, #3, #4, #6 by reading existing code/data on this machine (~30 min total) before any data-layer task starts. O.Q. #1 resolves during implementation (empirical). O.Q. #5 resolves during TASK-022 review.

---

## Risk Register (synthesized from TDD §6 + Agent 3)

| Risk | Likelihood | Impact | Mitigation | Task |
|------|-----------|--------|------------|------|
| File I/O failures (missing/corrupt state files) | High | Medium | Every reader defaults to safe empty state. `file-backed-reader-edge-cases.test.ts` covers ENOENT, EACCES, JSON.parse. | TASK-010 |
| Perf p95 > 50ms | Medium | High | Empirical measurement in TASK-021. Relax threshold to 100ms if needed (document rationale). | TASK-021 |
| Fixture schema drift from daemon writes | Medium | High | Schema validation test loads each fixture and asserts reader output type. Reviewed alongside view-type changes. | TASK-009 |
| Static-root sweep asset breakage | Low | High | Smoke test runs after `git rm -r server/static/`. Three differing files inspected manually per O.Q. #4. | TASK-002 |
| Empty-state UX confusion ("operators see 0 and think it's broken") | Medium | Medium | Empty-state copy includes a CTA link to the action that populates the surface (e.g., "+ New request" on empty Requests). | TASK-012..020 |
| Vendored `app.css` cascade prevents primary-button fix | Low | Medium | Override in `portal.css` at same specificity — do not edit `app.css` (R-01 vendored). | TASK-003 |
| Badge data-flow gap (Agent 2) | High (if not addressed) | Medium | TASK-018 explicit `ShellProps` extension; every route handler passes `badges` from its reader. | TASK-018 |
| MCP probe failure cascades to Ops 500 | Medium | High | MCP probe catches errors → returns `degraded`. Never crashes the route handler. | TASK-017 |
| Performance test flakiness on slow CI | Medium | Low | 10 cold runs, take p95 (not max). Allow 2× slack on CI vs local. | TASK-021 |

---

## Lint & Test Commands Reference

All tasks use the same commands; per-task `Lint` and `Test` fields specify which test file to focus on.

- **Lint**: `cd plugins/autonomous-dev-portal && bun run lint && bun run typecheck`
- **Unit tests**: `cd plugins/autonomous-dev-portal && bun test <path>`
- **Visual regression**: `cd plugins/autonomous-dev-portal && npm run test:visual`
- **Smoke** (post-build, against running portal): `curl -fsS http://127.0.0.1:19280/<route>`
- **Kit-parity mode**: `AUTONOMOUS_DEV_STATE_DIR=$PWD/server/fixtures/kit-parity bun run server/server.ts`

---

## Recommended PR Strategy

The 22 tasks naturally split into **5 PRs** matching the tracks, each independently mergeable:

1. **PR-1: Assets + CSS** (Track A — TASK-001/002/003) — low risk, unblocks everything visual.
2. **PR-2: Routes + 500→404** (Track B — TASK-004/005/006) — small surface, easy review.
3. **PR-3: Types + state-paths + fixtures + atomic readers** (Track C foundation — TASK-007/008/009/010) — establishes the data contract.
4. **PR-4: Composition readers + all surface wiring + badges** (Tracks C-finish + D — TASK-011..020) — the biggest PR; consider splitting if review fatigue is a concern.
5. **PR-5: Tests + screenshot regression** (Track E — TASK-021/022) — closes out the AC bundle.

Alternative (more granular): one PR per task in Track D, each ~1–3 hours of review.

---

## Definition of Done

The PLAN-038 work is complete when **all 15 acceptance criteria from TDD-037 §7** are green (AC-3701..AC-3715) AND:

- [ ] All 22 tasks marked completed
- [ ] All 6 Open Questions resolved (or explicitly deferred with rationale)
- [ ] All risks in §Risk Register have evidence the mitigation is in place
- [ ] Screenshot bundle present in PR (TASK-022)
- [ ] `git grep` returns zero hits for any of: `REQ-000001`, `REQ-2041`, `qa-edge-case`, `pid 18472`, `/Users/op/repos`, `PORTAL_DEMO_MODE`, `server/static`, `--accent` (all the "shouldn't exist" markers from TDD §3)
- [ ] CI: lint, typecheck, unit tests, visual regression all pass

---

## Provenance

- **Synthesized from 3 parallel planning agents** dispatched 2026-05-11:
  - Agent 1 (Feature Decomposition): 20 tasks across 3 tracks, 16–18 hr critical path
  - Agent 2 (Technical Architecture): identified badge data-flow gap, type-system friction, static-file authority precedence
  - Agent 3 (Risk & Testing): 12-test matrix, 7 risks, 6 open questions
- **Author synthesis**: merged Agent 1's task spine with Agent 2's missing architecture (TASK-018) and Agent 3's risk-driven testing (TASK-021 perf), promoted Agent 3's open questions to plan-level blockers, expanded from 20 to 22 tasks.
- **TDD source**: `plugins/autonomous-dev/docs/tdd/TDD-037-portal-reality-pass.md` v1.1 (APPROVED by tdd-reviewer 2026-05-11).
