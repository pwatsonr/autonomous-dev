# TDD-037: Portal Reality Pass — Logo, Routes, Live Data

| Field          | Value                                                                       |
|----------------|-----------------------------------------------------------------------------|
| **Title**      | Portal Reality Pass — Logo, Routes, Live Data                               |
| **TDD ID**     | TDD-037                                                                     |
| **Version**    | 1.1                                                                         |
| **Date**       | 2026-05-11                                                                  |
| **Author**     | Patrick Watson                                                              |
| **Phase**      | tdd                                                                        |
| **Status**     | ready-for-review                                                           |
| **Parent PRD** | PRD-018-portal-visual-redesign (closes residual reality-gap from PLAN-037) |
| **Plugin**     | autonomous-dev-portal                                                       |
| **Depends on** | TDD-034 (foundations), TDD-035 (shell+primitives), TDD-036 (surfaces) — all merged |
| **Updated**    | 2026-05-11T01:30:00Z                                                        |

### Changelog

- **v1.1 (2026-05-11)** — Addresses TDD review feedback. §5.1 rewritten to specify the composition-module contract (the "one-file swap" claim in v1.0 was wrong; new `wiring/dashboard-readers.ts` etc. are net-new work, not pure imports). Dropped the made-up `--accent` token; the CTA consumes the existing `--brand` token from `design-tokens.css` (kit alignment: `#c8631a` light / `#e89255` dark) per PRD-018 R-09. Replaced the `PORTAL_DEMO_MODE` code-branch design with a `AUTONOMOUS_DEV_STATE_DIR`-pointed fixture directory at `server/fixtures/kit-parity/`. Added Section 14 PRD traceability matrix. Revised effort estimate from 6–7 days to 9–11 days (Costs and Ops are multi-reader compositions). Fixed AC-3705 to use a route-regex-valid slug pair. Dropped `rsync --ignore-existing` from the static-root sweep (would have left three differing files in drift).

---

## 1. Summary

The portal redesign (TDD-034 → TDD-036, PLAN-037) shipped the visual kit: tokens, primitives, shell, all surfaces. ~183 PRs are on `main` and every route returns its expected status code.

However, a live Chrome crawl on 2026-05-11 (dark theme, viewport 1470×747) found three classes of defects that prevent the portal from feeling "real":

1. **Brand assets not served**. The kit's `wordmark.svg` and `mark.svg` exist in the design system and in `server/static/brand/`, but the served `static/` tree omits them entirely. `GET /static/wordmark.svg` → 404. The rail wordmark is rendered as inline JSX (intentional per SPEC-035-1-04) but no SVG is available for the favicon, OG card, or any consumer that asks for it. There is no favicon at all.
2. **Broken or missing routes**. The rail nav points `Agents` at `/settings#agents` (a hash on a different surface, not its own page). `/agents`, `/repos`, `/api/agents`, and `/api/agents/list` all return 404. `/repo/:repo/request/:id` returns **500 Internal Server Error** for any request not in the in-memory ledger (verified with `/repo/acme/request/REQ-000001`). The "view all" affordance on the dashboard repos grid has no destination.
3. **Stub fixture data on every surface**. The five operator surfaces (Dashboard KPI strip, Approvals, Requests, Costs, Ops, Settings) all render hardcoded fixture data from `server/stubs/*.ts`. The real readers exist (`wiring/daemon-readers.ts`, `wiring/approvals-store.tsx`, `~/.autonomous-dev/{cost-ledger,heartbeat,approvals}.json`) and `/api/daemon-status` already returns `{status:"down", mtdSpend:0, approvalsCount:0}` — but the surfaces don't consume them. The rail-ops bar correctly shows `Daemon down` (real), while the dashboard KPI strip in the same view shows `Active requests: 2 across 2 repos` (fake). The contradiction is what the operator perceives as "still doesn't look right" even after parity work, because half the page tells the truth and half is fiction.

TDD-037 closes all three gaps. It is **not** another visual redesign pass. The kit shapes are correct; what's missing is wiring and assets.

This is also the implementation home for the **canonical-static-root sweep** that PLAN-037 deferred (handoff doc §"Static asset duplication") — pick `static/` as the served root, sync drift one final time, and remove `server/static/` so the duplication class of bug cannot recur.

---

## 2. Goals & Non-Goals

### Goals

| ID     | Goal                                                                                                                                                                 |
|--------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| G-3701 | Serve `wordmark.svg`, `wordmark-dark.svg`, `mark.svg`, and a `favicon.svg` (built from `mark.svg`) at `/static/brand/*` and `/favicon.svg`. Link the favicon from the shell `<head>`. |
| G-3702 | Add an `Agents` surface at `GET /agents` and fix the rail nav `Agents` link to point at it (not `/settings#agents`). The surface lists agents with state (frozen, shadow, baseline), version, and per-agent inspect/freeze/promote actions reusing the existing CLI bridge. |
| G-3703 | Add a `Repos` surface at `GET /repos` and wire the dashboard repos-grid "view all" affordance to it. The surface lists every repo from the allowlist with MTD spend, active count, last-activity timestamp, and a link to the per-repo dashboard. |
| G-3704 | Add `GET /api/agents` returning the agent list as JSON (delegates to the same reader the new `/agents` surface uses). |
| G-3705 | Fix `GET /repo/:repo/request/:id` so a missing request renders a 404 surface, not a 500. Add an integration test for the missing-id path. |
| G-3706 | Replace the dashboard KPI strip's fixture source (`server/stubs/*.ts`) with the real readers used by `/api/daemon-status` and the approvals/requests stores. When the daemon is down or empty, render the zero-state KPIs honestly (`0 active across 0 repos`, `$0.00 MTD`) rather than fake counts. |
| G-3707 | Replace the Approvals surface fixture source with `wiring/approvals-store.tsx`. Render an empty-state message when the store is empty. |
| G-3708 | Replace the Requests surface fixture source with the daemon's request ledger (`~/.autonomous-dev/portal/requests.json` or equivalent reader). Empty-state honestly. |
| G-3709 | Replace the Costs surface fixtures (KPI strip, daily spend chart, phase breakdown table, reviewer table) with the cost-ledger reader. The reviewer table uses the actual agent set the daemon dispatches, not the kit's `qa-edge-case / ux-ui / accessibility / rule-set` example agents. Empty-state honestly. |
| G-3710 | Replace the Ops surface fixtures (PID, uptime, plugin versions, MCP server status, live log) with real daemon-status, plugin-manifest reads, MCP probe, and a tail of the daemon log. |
| G-3711 | Replace the Settings repo-allowlist fixture (`/Users/op/repos/acme`) with the real allowlist from the portal settings store. |
| G-3712 | Add nav-badge slots to the rail (`Approvals`, `Requests`, `Agents`) and populate them from the same readers that feed the KPI strip. Badges hide when count is zero. |
| G-3713 | Verify the "+ New request" CTA and all primary action buttons consume the existing `--brand` token from `design-tokens.css` (kit: `#c8631a` light / `#e89255` dark, per PRD-018 R-09). Audit `app.css` / `portal.css` / `shell.css` for any primary-button rule that hard-codes a color or references an undefined variable, and route it through `var(--brand)`. **No new token is introduced** — the gap is consumption-side. |
| G-3714 | Pick `plugins/autonomous-dev-portal/static/` as the canonical served root, sync any drift from `server/static/` one final time (including the three differing files: `gate-actions.js`, `shell.css`, `theme-toggle.js`), then delete `server/static/` and update every spec/comment that references it. |
| G-3715 | Ship before/after screenshot pairs for every surface (Dashboard, Approvals, Requests, Costs, Ops, Settings, /agents, /repos, /repo/:repo/request/:id) bundled with the implementation PR. |
| G-3716 | Commit a canonical fixture state directory at `plugins/autonomous-dev-portal/server/fixtures/kit-parity/` containing pinned JSON files (`agent-states.json`, `approvals-queue.json`, `requests-ledger.json`, `cost-ledger.json`, `portal-settings.json`) that reproduce the kit screenshot's example data. CI screenshot regression points `AUTONOMOUS_DEV_STATE_DIR` at this directory and runs the real reader code path. |
| G-3717 | Net-new readers required (acknowledged as new work, not wire-through): `wiring/dashboard-readers.ts`, `wiring/agents-readers.ts`, `wiring/repos-readers.ts`, plus a request-ledger reader and a per-repo aggregation reader. Each is specified in §5.1 with its input state files and output type. |

### Non-Goals

| ID      | Non-Goal                                                                                            |
|---------|------------------------------------------------------------------------------------------------------|
| NG-3701 | New design tokens, primitives, or layout shell — TDD-034/035 are frozen.                            |
| NG-3702 | New surfaces beyond `/agents`, `/repos`, and the 500→404 fix on request-detail.                     |
| NG-3703 | Plugin contribution API for `autonomous-dev-homelab` — separate PRD/TDD as noted in the handoff.    |
| NG-3704 | Moving the portal out of `plugins/autonomous-dev-portal/` — host-plugin question deferred.          |
| NG-3705 | Mobile/responsive overhaul — desktop + laptop viewports only, per PRD-018 NG-06.                    |
| NG-3706 | Re-doing the voice/copy sweep — that's done (TDD-034, PR #228).                                     |
| NG-3707 | New daemon-state writers or new state file formats — the daemon's writes are out of scope. This TDD only adds **readers** that compose existing state files. (v1.0 said "every reader needed already exists" — wrong; see G-3717 for the inventory of new readers.) |
| NG-3708 | Browser cache-busting via `?v=hash` on stylesheet hrefs — already validated in handoff Step 2; if it resurfaces, separate ticket. |
| NG-3709 | Introducing an `--accent` token parallel to `--brand` — explicitly rejected; the kit's CTA color **is** `--brand` per PRD-018 R-09. |

---

## 3. Crawl Findings (the evidence base)

These are the concrete defects observed at `http://127.0.0.1:19280/` on 2026-05-11. Every fix in §5 maps back to one of these.

### 3.1 Brand assets

| Probe                                    | Result                                | Expected                                  |
|------------------------------------------|---------------------------------------|-------------------------------------------|
| `GET /static/wordmark.svg`               | 404                                   | 200 (kit ships this asset)                |
| `GET /static/mark.svg`                   | 404                                   | 200                                       |
| `GET /static/wordmark-dark.svg`          | 404                                   | 200                                       |
| `<link rel="icon">` in `<head>`          | absent                                | present, points at `favicon.svg`           |
| `document.querySelectorAll('img').length` | 0                                     | ≥1 (mark in favicon, or wordmark fallback)|
| `server/static/brand/wordmark.svg`        | **exists**                            | served from `static/`                      |
| `server/static/brand/wordmark-dark.svg`   | **exists**                            | served from `static/`                      |

The brand-wordmark component in `server/components/brand-wordmark.tsx` correctly renders inline JSX so the brackets pick up `var(--brand)` on theme switch. This is intentional and does not change. What changes is the asset availability for everything else (favicon, social-meta, anything that asks).

### 3.2 Routes

| Route                              | Live status                                     | Expected                  |
|------------------------------------|--------------------------------------------------|---------------------------|
| `/agents`                          | 404 (rail-nav target is `/settings#agents`)     | 200 surface OR honest nav |
| `/api/agents`                      | 404                                              | 200 JSON list             |
| `/api/agents/list`                 | 404                                              | 200 JSON list             |
| `/repos`                           | 404 (dashboard "view all" has no destination)   | 200 surface               |
| `/repo/acme/request/REQ-000001`    | **500 Internal Server Error**                   | 404 (request not in store)|
| `/api/daemon-status`               | 200 `{status:"down", mtdSpend:0, approvalsCount:0}` | unchanged             |
| `/design-system`                   | 200 (20 preview cards render)                   | unchanged                 |

### 3.3 Rail nav

Target (kit):

```
OPERATE
  Dashboard
  Approvals    [3]
  Requests     [8]
  Costs
SYSTEM
  Agents       [14]
  Settings
  Operations
```

Current:

```
OPERATE
  Dashboard
  Approvals
  Requests
  Costs
SYSTEM
  Agents       → /settings#agents  (wrong target)
  Settings
  Ops                              (label diverges from kit "Operations")
```

`document.querySelectorAll('.rail-nav-item').forEach(a => a.querySelector('.badge'))` returns no badges anywhere. The Lucide icons are correctly present.

### 3.4 Stub fixtures — surface-by-surface evidence

Every line item below was captured by reading the live DOM in Chrome and tracing back to the file that produces it. The "real reader" column names a module that already exists in the repo today.

| Surface          | Visible fixture                                              | File                          | Real reader to use                                   |
|------------------|--------------------------------------------------------------|-------------------------------|------------------------------------------------------|
| Dashboard KPI    | `Active requests 2 across 2 repos`                           | `server/stubs/requests.ts`    | request-ledger reader + repo-allowlist               |
| Dashboard KPI    | `Awaiting approval 1`                                        | `server/stubs/approvals.ts`   | `wiring/approvals-store.tsx`                         |
| Dashboard KPI    | `MTD spend $X` and rail-ops `$1,843`                         | `server/stubs/costs.ts`       | `wiring/daemon-readers.ts` → `cost-ledger.json`      |
| Dashboard repos  | 6 fake repos (`my-app`, `critical-service`, `docs-site`, …)  | `server/stubs/repos.ts`       | repo-allowlist + per-repo aggregates                 |
| Dashboard table  | `REQ-000001..3`, `acme`, `beta`                              | `server/stubs/requests.ts`    | request-ledger reader                                |
| Approvals        | `REQ-2041..2044`, "Migrate auth to OIDC", etc.               | `server/stubs/approvals.ts`   | `wiring/approvals-store.tsx`                         |
| Requests         | `REQ-000001..3`, `acme`, `beta`                              | `server/stubs/requests.ts`    | request-ledger reader                                |
| Costs            | `MTD $352.10`, `Reviewers $111.20`, `qa-edge-case/ux-ui/…`   | `server/stubs/costs.ts`       | cost-ledger reader (real agent names from manifest)  |
| Ops              | `pid 18472`, `4d 12h`, `autonomous-dev@2.4.0`, "prometheus degraded" | `server/stubs/ops.ts`  | daemon-status + plugin-manifest + MCP probe          |
| Ops live log     | `14:32:04Z INFO deploy REQ-20260408-e7c8 …`                  | `server/stubs/ops.ts`         | tail of daemon log (real path in `state-paths.ts`)   |
| Settings allow.  | `/Users/op/repos/acme` etc.                                  | `server/stubs/settings.ts`    | portal settings store                                |

The contradiction the operator sees: rail-ops correctly shows `Daemon down` (real), and dashboard simultaneously claims `2 active requests`, `MTD $1,843` (fake). That dissonance is the perceptual gap, not pixel drift.

### 3.5 CSS

| Probe                                                          | Result      | Expected                                    |
|----------------------------------------------------------------|-------------|---------------------------------------------|
| `getComputedStyle(html).getPropertyValue('--brand')`           | `#e89255`   | defined ✓ (dark theme)                       |
| `getComputedStyle(html).getPropertyValue('--brand-hover')`     | `#f1a572`   | defined ✓                                    |
| `getComputedStyle(html).getPropertyValue('--accent')`          | `""`        | should not be defined (no such kit token)    |
| `getComputedStyle(html).getPropertyValue('--bg-0')`            | `#14130f`   | matches kit (dark)                           |
| Stylesheets loaded                                             | 4 + 2 inline| 4 from `/static/` 200                        |

The "+ New request" CTA on the dashboard appears unaccented. `--brand` **is** defined (verified in `design-tokens.css` lines 89, 207). The CTA rule in `app.css` / `portal.css` / `shell.css` either hard-codes a color, references a token that does not exist, or is overridden by a higher-specificity rule. The fix is consumption-side (audit the CSS rule), not token-side (no new token needed). v1.0 of this TDD incorrectly proposed adding an `--accent` token; that proposal is withdrawn.

### 3.6 Asset duplication (canonical-root sweep)

`diff -rq plugins/autonomous-dev-portal/server/static/ plugins/autonomous-dev-portal/static/` on 2026-05-11:

```
Only in static/: .gitkeep
Only in static/: app.css                  (44 KB vendored kit CSS)
Only in static/: htmx.min.js
Only in static/: htmx.min.js.LICENSE
Only in static/: portal.css
Only in static/: segmented-filter.js
Only in static/: phase-artifact-modal.js
Only in static/: js
Only in static/icons: attention-needed.svg, cost-chart.svg, daemon-running.svg, …
Only in server/static/: modal.js
Only in server/static/icons: sliders.svg
Files server/static/gate-actions.js and static/gate-actions.js differ
Files server/static/shell.css and static/shell.css differ
Files server/static/theme-toggle.js and static/theme-toggle.js differ
```

PR #231 only synced palette-related CSS. The rest of the drift remains. The served root (`server/routes/index.ts` line 140) is `static/`, so anything only in `server/static/` is dead. Anything that differs is a coin-flip on which version the operator sees on next deploy.

---

## 4. Tenets

1. **Honesty over fidelity.** A surface that says `0 active requests` because the daemon is down is more correct than one that says `2 active requests` because of a fixture. Empty-state copy must be honest.
2. **One source of truth per data point.** The dashboard KPI strip, the rail-ops bar, and `/api/daemon-status` must agree about MTD spend and approvals count. They share a reader.
3. **No fixture data on operator surfaces.** `server/stubs/*.ts` is a development convenience; it should be reachable only behind an explicit `PORTAL_DEMO_MODE=1` flag for screenshots and tests, never the default.
4. **One canonical static root.** `static/` wins. `server/static/` is deleted.
5. **The 5xx surface is the bug.** A 500 on a missing request id is a bug; a 404 is correct.
6. **The visual kit is done.** This TDD touches data, not pixels. Any pixel change is incidental (favicon, accent CTA color).

---

## 5. Architecture

### 5.1 Reader composition — new modules and their contracts

**Correction to v1.0**: the v1.0 "one-file swap" claim was wrong. Today's stubs return objects shaped like the surface's `RenderProps`-typed view input (e.g. `DashboardData` in `server/types/render.ts:116`). The existing wiring modules (`daemon-readers.ts`, `approvals-store.tsx`) return state-file-shaped objects — `{ status, heartbeatAgeMs, mtdSpend, approvalsCount, killSwitchEngaged }`, `ApprovalItem[]`, etc. There is no module today that **composes** those into the `RenderProps` shape.

The composition layer is new work. This TDD specifies its API surface so the spec author can implement it without rediscovering the gap.

#### 5.1.1 New wiring modules

Each module sits at `plugins/autonomous-dev-portal/server/wiring/<name>.ts`, takes a single options object with `stateRoot?: string` (defaults to the existing `stateDirRoot()`), is fully async, and returns the existing view-input type unchanged.

| Module                  | Composes                                                                                                            | Returns                |
|-------------------------|---------------------------------------------------------------------------------------------------------------------|------------------------|
| `dashboard-readers.ts`  | `daemon-readers` + `approvals-store` + new `request-ledger-reader` + new `repo-aggregation-reader`                  | `DashboardData`        |
| `agents-readers.ts`     | new `agent-states-reader` + agent manifest scan (`.claude/agents/*.md` frontmatter)                                  | `AgentsPageData` (new) |
| `repos-readers.ts`      | new `repo-aggregation-reader` (per-repo MTD, active count, last-activity) + portal settings allowlist                | `ReposPageData` (new)  |
| `request-ledger-reader` | reads `~/.autonomous-dev/portal/requests-ledger.json` (new path on `state-paths.ts`)                                | `RequestRow[]`         |
| `repo-aggregation-reader` | reduces the request ledger and cost ledger by repo                                                                | `Map<RepoId, RepoSummary>` |
| `agent-states-reader`   | reads `~/.autonomous-dev/agent-states.json` (path **not** yet exported from `state-paths.ts`; this TDD adds it)      | `AgentState[]`         |

`AgentsPageData` and `ReposPageData` are new interfaces added to `server/types/render.ts` alongside the existing `DashboardData`, `RequestDetailData`, `CostsData`, `OpsData`, `SettingsData`.

#### 5.1.1a New types in `server/types/render.ts`

Sketch (final field set during implementation; this pins the shape so composition readers and view layer cannot drift):

```ts
// Identifier — slug form, matches the route-path regex used in request-detail.ts.
export type RepoId = string;  // ^[a-z0-9][a-z0-9-]{0,63}$

// Per-repo aggregate emitted by repo-aggregation-reader and consumed by the
// dashboard repos grid (R-12), the /repos surface, and the rail KPI strip.
export interface RepoSummary {
  id: RepoId;                       // "my-app"
  path: string;                     // "~/projects/my-app" (display only; never used for fs access)
  trustLevel: "L0" | "L1" | "L2" | "L3";
  activePhase: PhaseName | null;    // drives the 4px left-bar color (R-12); null → --muted
  variant: VariantName;             // "Feature (default)", "Security hardening", etc.
  tags: string[];                   // ["docker-local", "node-react"] — up to 2 displayed
  activeCount: number;              // requests currently RUNNING or GATE
  mtdSpend: number;                 // dollars, 2 decimals at view layer
  needsApprovalCount: number;       // shown as "N need approval" footer hint
  lastActivityAt: string | null;    // ISO 8601; view renders relative ("2m ago")
}

export interface AgentsPageData {
  kpis: {
    totalAgents: number;
    frozenCount: number;
    shadowCount: number;
  };
  agents: Array<{
    name: string;
    version: string;
    status: "baseline" | "frozen" | "shadow" | "promoted";
    mode: "active" | "disabled";
    lastDispatchAt: string | null;  // ISO 8601 or null
    runs30d: number;
    fpRate: number;                 // 0..1
  }>;
}

export interface ReposPageData {
  kpis: {
    totalRepos: number;
    activeRepos: number;            // at least one RUNNING/GATE request
    allowlistMisses: number;        // configured paths that fs.access() rejects
  };
  repos: RepoSummary[];             // same shape as dashboard, full list (no truncation)
}
```

The `repo-aggregation-reader` returns `Map<RepoId, RepoSummary>` for efficient lookup by composition modules (the dashboard reader pulls a subset; the `/repos` reader takes the whole map). Composition modules call `Array.from(map.values())` when emitting the view-input type. `PhaseName` and `VariantName` are existing type aliases in `server/types/render.ts` — no new tokens.

#### 5.1.2 Reader → view mapping (Dashboard example, fully specified)

```ts
// server/wiring/dashboard-readers.ts
import type { DashboardData } from "../types/render";

export interface DashboardReaderOptions {
  stateRoot?: string;
}

export async function readDashboardData(
  opts: DashboardReaderOptions = {}
): Promise<DashboardData> {
  const [daemon, approvals, requests, repos] = await Promise.all([
    readDaemonStatus(opts),          // existing daemon-readers
    readApprovalsQueue(opts),        // existing approvals-store
    readRequestLedger(opts),         // NEW
    readRepoAggregates(opts),        // NEW (reduces requests + costs)
  ]);
  return {
    kpis: {
      activeRequests: requests.filter(r => r.status === "RUNNING" || r.status === "GATE").length,
      activeRepos: new Set(requests.map(r => r.repo)).size,
      awaitingApproval: approvals.length,
      mtdSpend: daemon.mtdSpend,        // honest zero when daemon down
      standardsRulesCount: /* read manifest */ 0,
    },
    repos,                             // RepoSummary[]
    activeRequests: requests.slice(0, 20),
    approvalQueue: approvals.slice(0, 5),
    standardsDrift: { /* … */ },
  };
}
```

The same pattern repeats for the other surfaces. The route handler swap *is* a one-liner, but the composition module behind it is genuine engineering work.

#### 5.1.3 Honesty contract

Readers return truthful zeros when state files are absent or empty. View layer is responsible for empty-state copy ("No active requests yet"). The rail-ops bar, the dashboard KPI strip, and `/api/daemon-status` consume `mtdSpend` from the **same** `daemon-readers.readDaemonStatus()` call, so they cannot disagree.

#### 5.1.4 New paths added to `state-paths.ts`

Today's `state-paths.ts` exports `approvalsQueuePath`, `gateDecisionsDir`, `gateDecisionPath`, `requestActionsDir`, `requestActionPath`, `portalAuditPath`, `userConfigPath`. This TDD adds:

| Function                | Default path                                          | Reader                  |
|-------------------------|-------------------------------------------------------|-------------------------|
| `requestLedgerPath()`   | `~/.autonomous-dev/portal/requests-ledger.json`       | `request-ledger-reader` |
| `agentStatesPath()`     | `~/.autonomous-dev/agent-states.json`                 | `agent-states-reader`   |
| `costLedgerPath()`      | `~/.autonomous-dev/cost-ledger.json`                  | existing in `daemon-readers` — not re-declared |
| `kitParityFixtureRoot()`| `server/fixtures/kit-parity/` (resolved relative to package) | screenshot regression  |

The first three are read by the new readers; the daemon's writer for `requests-ledger.json` already exists (NG-3707 — out of scope).

### 5.2 New routes

```ts
// server/routes/index.ts
+ app.get("/agents", agentsHandler);
+ app.get("/repos", reposHandler);
+ app.get("/api/agents", agentsApiHandler);
```

- `agentsHandler` reads agent state from `~/.autonomous-dev/agent-states.json` (the same file the CLI bridge writes) merged with the agent manifest (`.claude/agents/*.md` frontmatter) to produce `{ name, version, status, mode }` rows.
- `reposHandler` reads the allowlist + per-repo aggregates from the cost ledger and request ledger.
- `agentsApiHandler` returns the agent list as JSON for the same reader output.

### 5.3 Request-detail 500 → 404

`server/routes/request-detail.ts` currently throws when the requested id is not in the store. Wrap the lookup, return `c.notFound()` on missing.

### 5.4 Brand assets

Add to `static/brand/`:
- `wordmark.svg` (copy from kit assets)
- `wordmark-dark.svg`
- `mark.svg`
- `favicon.svg` (32×32 build of `mark.svg`)

Link from `<head>`:

```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
```

Mount `/favicon.svg` either as a direct file route or by symlinking inside `static/`.

### 5.5 Nav badges

The rail-nav item template gains an optional `badge?: number` prop. The view skips the badge span when `badge` is undefined or 0. Badge counts come from the same reader the KPI strip uses (single source of truth).

### 5.6 CTA color — consume the existing `--brand` token

The kit defines `--brand: #c8631a` (light, `colors_and_type.css:25`) and `--brand: #e89255` (dark, line 139). `design-tokens.css` already vendors both (lines 89 and 207). PRD-018 R-09 explicitly says primary buttons use `--brand` background.

`getComputedStyle(document.documentElement).getPropertyValue('--brand')` resolves to `#e89255` in the live page — the token is fine. The "+ New request" CTA is unaccented because the CSS rule that styles it either hard-codes a color, references a missing token, or is overridden. Implementation:

1. Grep `static/{app,portal,shell}.css` for the rule that targets the dashboard `+ New request` button (`.head-actions .btn.primary`, `.head-actions [data-action="new-request"]`, or similar).
2. If the rule hard-codes a hex, replace with `background: var(--brand); border-color: var(--brand);`.
3. If the rule references an undefined variable (e.g. `--accent`), point it at `--brand` and delete the dangling reference.
4. If the rule is overridden by a later same-specificity rule, fix the cascade (one source for primary-button styling).
5. Run the `/design-system` page (R-21) after the fix — every "primary button" preview should render filled `--brand`. This is the regression surface.

No new tokens. No new CSS variables. No `--accent`.

### 5.7 Static-root sweep

One-shot script in spec. Note: `--ignore-existing` is **not** used (v1.0 had a bug here — it would have silently left the three differing files in drift):

```bash
cd plugins/autonomous-dev-portal
# 1) Inventory drift (review before sync)
diff -rq server/static/ static/ > /tmp/static-drift.txt
cat /tmp/static-drift.txt   # review

# 2) Authoritative copy: server/static/ wins for differing files (gate-actions.js,
#    shell.css, theme-toggle.js — confirm each by inspection before this step).
#    For files only in server/static/, pull them in.
rsync -av server/static/ static/

# 3) Verify static/ is now a superset of server/static/. The only remaining
#    differences should be files unique to static/ (which is fine; static/ wins).
diff -rq server/static/ static/ | grep -v '^Only in static/' || echo "clean"

# 4) Delete the duplicate tree (after the verify above shows clean)
git rm -r server/static/

# 5) Rewrite every reference. Use grep first to review what will change.
git grep -l 'server/static' -- server/ docs/ | tee /tmp/static-refs.txt
git grep -l 'server/static' -- server/ docs/ | xargs sed -i '' 's|server/static|static|g'

# 6) Build + serve smoke test
bun run server/server.tsx &
curl -fsS http://127.0.0.1:19280/static/wordmark.svg -o /dev/null -w "wordmark: %{http_code}\n"
curl -fsS http://127.0.0.1:19280/static/app.css -o /dev/null -w "app.css: %{http_code}\n"
```

Step 2's authority direction (server/ → static/) must be confirmed per differing file during the spec. If `static/shell.css` is newer (e.g. PR #231's palette work), that's the file to keep — the spec author makes the call after reading both.

### 5.8 Fixture state directory (replaces v1.0's `PORTAL_DEMO_MODE` flag)

v1.0 proposed a `PORTAL_DEMO_MODE=1` env flag that swapped stubs in at the route-handler level. That design tests two different code paths (stub path vs reader path) and the screenshot regression never exercises the production path. Replaced with:

```
plugins/autonomous-dev-portal/server/fixtures/kit-parity/
├── agent-states.json          # 14 agents matching kit "Agents 14" badge
├── approvals-queue.json       # 3 approvals matching kit "Approvals 3" badge
├── requests-ledger.json       # 8 active requests matching kit "Requests 8" badge
├── cost-ledger.json           # MTD $1,843 matching kit screenshot rail
├── portal-settings.json       # allowlist with the kit's 6 repo paths
└── README.md                  # provenance: derived from screenshots/dashboard.png
```

CI screenshot regression runs the production server with `AUTONOMOUS_DEV_STATE_DIR=$PWD/server/fixtures/kit-parity` (the existing `stateDirRoot()` already honors this env var; verify in `state-paths.ts:13`). The real reader code path executes against committed JSON. No conditional branch in production handlers.

Local development pointing at `~/.autonomous-dev/` continues to work unchanged; the env var is only set in CI and in the `npm run kit-parity` script.

`server/stubs/*.ts` is retained **only** for unit tests of the views (snapshot tests that need a hermetic fixture without touching disk). It is **not** reachable from any route handler.

---

## 6. Risks & Mitigations

| Risk                                                                                  | Mitigation                                                                                       |
|---------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------|
| Empty-state copy is unfamiliar to operators who got used to populated stub screens.   | Each surface ships a one-line "no X yet" message + a link to the operator action that creates X (e.g. `New request`). |
| Real reader is slower than stub; surfaces feel laggy on first hit.                    | Readers must be ≤50ms p95 on a cold load over the existing file-backed stores. Add a perf assertion in the integration test. |
| `agent-states.json` schema may not include every field the new `/agents` surface wants.| Reader returns `Partial<AgentRow>` and the view renders "—" for missing fields. No schema migration required. |
| Static-root sweep removes a file someone else's spec still references.                | Step 4 of the sweep script greps every reference and rewrites it; review the resulting diff before merge. |
| Favicon hex render diverges from kit on Windows browsers.                             | SVG favicon; Windows fallback is `mark.svg` rendered at the same color. Accept minor render diffs. |
| The primary-button CSS rule may turn out to be cascaded from `app.css` (vendored kit) and not safely editable in `portal.css`. | If `app.css` hard-codes the button color or references an unknown variable, override in `portal.css` at the same specificity with `background: var(--brand)`. Do not edit `app.css` (it is vendored verbatim per R-01). |
| Fixture JSON files in `server/fixtures/kit-parity/` drift from view-input types as the surfaces evolve.                  | Each composition reader has a unit test that loads the fixture and asserts the output type — failing build catches drift early. Fixtures are reviewed alongside any view-input change. |

---

## 7. Acceptance Criteria

| ID     | Criterion                                                                                                                                          |
|--------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| AC-3701 | `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:19280/static/wordmark.svg` returns `200`. Same for `mark.svg`, `wordmark-dark.svg`, `/favicon.svg`. The shell `<head>` contains `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`. |
| AC-3702 | `AUTONOMOUS_DEV_STATE_DIR=server/fixtures/kit-parity bun run server/server.tsx`; `curl http://127.0.0.1:19280/agents` returns `200`; the rendered surface contains all 14 agent names from `server/fixtures/kit-parity/agent-states.json` (the file pins the canonical fixture). The rail-nav `Agents` link `href` equals `/agents` (not `/settings#agents`). |
| AC-3703 | `curl http://127.0.0.1:19280/repos` returns `200`. The rendered surface lists every entry from the portal-settings allowlist. Dashboard "view all" link `href` equals `/repos`.                                                |
| AC-3704 | `curl http://127.0.0.1:19280/api/agents` returns `200` with `Content-Type: application/json` and a JSON array of `{name, version, status, mode}` objects. |
| AC-3705 | `curl http://127.0.0.1:19280/repo/no-such-repo/request/REQ-999999` returns `404` (not `500`). The slug pair is intentional: `no-such-repo` matches `^[a-z0-9][a-z0-9-]{0,63}$` and `REQ-999999` matches `^REQ-[0-9]{6}$`, so the request reaches the store lookup and the missing-id branch returns 404 (not the regex-guard 404). Integration test pins both the regex-rejected case (still 404) and this store-miss case. |
| AC-3706 | With `AUTONOMOUS_DEV_STATE_DIR` pointed at an **empty** state directory (no JSON files), the dashboard KPI strip renders `Active requests 0 across 0 repos`, `Awaiting approval 0`, `MTD $0.00`. With `AUTONOMOUS_DEV_STATE_DIR=server/fixtures/kit-parity`, the KPI strip exactly matches the kit screenshot (`Active 9 across 6 repos`, `Awaiting 3`, `MTD $153.60`, `Standards 7`). No reference to `acme`, `beta`, `REQ-000001..3`, `REQ-2041..2044` appears in any route handler's import; `git grep 'REQ-000001' server/routes/` returns nothing. |
| AC-3707 | With an empty `approvals-queue.json`, the Approvals surface renders the empty-state copy "No approvals waiting". The four `REQ-2041..2044` fixtures from `stubs/approvals.ts` do not appear in any code path reachable from a route handler. |
| AC-3708 | The Costs surface reviewer table lists agents that actually exist in `plugins/autonomous-dev/.claude/agents/` (verified by reading the directory at test time), not the kit's `qa-edge-case / ux-ui / accessibility / rule-set` example agents. With `AUTONOMOUS_DEV_STATE_DIR=server/fixtures/kit-parity`, the table renders the canonical fixture agents from `cost-ledger.json`. |
| AC-3709 | With the daemon stopped (no `daemon.pid` file), the Ops surface PID, uptime, and plugin version render as `—`, `daemon stopped`, and the real plugin version from `.claude-plugin/plugin.json`. No `pid 18472`, no `4d 12h`, no `autonomous-dev@2.4.0` — those strings do not appear in any route handler reachable from `routes/index.ts`. |
| AC-3710 | Rail-nav `Approvals`, `Requests`, `Agents` items render a count badge when count > 0, no badge when count = 0. The badge count comes from the same reader as the destination surface's primary KPI (verified by integration test: forcing a state-file count of N and asserting both badge and KPI render N). |
| AC-3711 | `getComputedStyle(document.documentElement).getPropertyValue('--brand')` returns a non-empty hex (`#c8631a` light / `#e89255` dark — already true today; this AC pins it as a regression check). The dashboard "+ New request" CTA's computed `background-color` equals the `--brand` value in both themes. `getComputedStyle` for any `--accent*` token returns `""` (no new tokens introduced).|
| AC-3712 | `plugins/autonomous-dev-portal/server/static/` is deleted. `git grep 'server/static'` returns no matches in `server/`, `docs/`, or `specs/`. `ls server/static` errors with `No such file or directory`. |
| AC-3713 | Implementation PR includes before/after screenshots for: Dashboard, Approvals, Requests, Costs, Ops, Settings (each tab), `/agents`, `/repos`, `/repo/<valid>/request/<valid>` (success path), `/repo/no-such-repo/request/REQ-999999` (404 surface). Screenshots taken with `AUTONOMOUS_DEV_STATE_DIR=server/fixtures/kit-parity` so they are reproducible and diffable. |
| AC-3714 | The `npm run kit-parity` (or equivalent bun script) starts the server with `AUTONOMOUS_DEV_STATE_DIR=server/fixtures/kit-parity` and prints the URL. No `PORTAL_DEMO_MODE` flag exists in the codebase (`git grep PORTAL_DEMO_MODE` returns nothing). The route handlers contain no `if (DEMO_MODE)` branches. |
| AC-3715 | Real-reader path p95 ≤ 50ms on a cold dashboard render with `AUTONOMOUS_DEV_STATE_DIR=server/fixtures/kit-parity`, measured by the new integration test (10 cold runs after `rm -rf .cache`, take the 95th percentile, assert ≤50ms). |

---

## 8. Implementation Order (sketch, full breakdown in PLAN-038)

Revised from v1.0. The data-wiring work is bigger than initially estimated because the composition readers are net-new and the Costs/Ops surfaces each integrate multiple state sources.

1. **Sweep & assets (low-risk, unblocks everything)** — copy brand SVGs into `static/brand/`, build a `favicon.svg` from `mark.svg`, add the `<link rel="icon">` to shell `<head>`, run the static-root sweep, delete `server/static/`. Verify with curl. (½ day)
2. **Route fixes** — add `/agents`, `/repos`, `/api/agents` route handlers (returning the new view types but initially backed by `Promise.resolve(emptyData)` to land the routes before the readers); fix `/repo/:repo/request/:id` 500→404; fix rail-nav `Agents` href; add `/favicon.svg` route. Integration tests for each, including the AC-3705 slug pair. (1 day)
3. **CTA `--brand` audit** — grep `static/*.css` for the primary-button rule, replace any hard-coded color or undefined-token reference with `var(--brand)`, verify on `/design-system`. Add the AC-3711 computed-style assertion. (½ day)
4. **Fixture state directory** — commit `server/fixtures/kit-parity/` with the five JSON files matching the kit screenshot. Pin in `state-paths.ts` via `kitParityFixtureRoot()`. Add the `kit-parity` npm/bun script. (1 day)
5. **State-paths additions** — `requestLedgerPath()`, `agentStatesPath()`, plus the `kitParityFixtureRoot()` from step 4. Tests pin the default paths. (½ day)
6. **Atomic readers (new)** — `request-ledger-reader`, `repo-aggregation-reader`, `agent-states-reader`. Unit tests against the fixture directory. (1 day)
7. **Composition readers (new)** — `wiring/dashboard-readers.ts`, `wiring/agents-readers.ts`, `wiring/repos-readers.ts`. Each composes the atomic readers from step 6 + the existing daemon/approvals readers into a view-input type. Unit tests assert empty-state honesty. (1 day)
8. **Surface wiring (one PR per surface)**:
   - Dashboard: route handler swap to `readDashboardData`. (½ day)
   - Approvals: route handler swap to `readApprovalsData`. (½ day)
   - Requests: route handler swap to `readRequestsData`. (½ day)
   - Costs: route handler swap + reviewer table sourced from real agent manifest scan + daily-spend chart binding. (**1.5 days** — multi-reader composition, chart data shape conversion)
   - Ops: route handler swap + daemon-log tail wiring + plugin-manifest scan + MCP probe binding. (**1.5 days** — multi-reader, log tail is a new reader)
   - Settings: route handler swap for repo allowlist and trust-level overrides. (½ day)
   Each PR ships before/after screenshots against the fixture directory.
9. **Nav badges** — extend the rail-nav template, populate badge counts from the composition readers. (½ day)
10. **Screenshot regression bundle** — bundle every before/after pair into the implementation PR. Add a CI job that diffs new screenshots against the committed baseline. (½ day)

Total estimated effort: **~9–11 engineering days** for one author. The biggest items are step 8's Costs and Ops surfaces (1.5 days each), step 6's atomic readers (1 day), and step 7's composition modules (1 day). v1.0 underestimated by treating the wiring as a simple import swap.

---

## 9. Out-of-scope follow-ups (deferred)

Tracked here so they don't get lost; not in TDD-037:

- Plugin contribution API so `autonomous-dev-homelab` can register a `Homelab` nav item + `/homelab` surface (handoff §"Plugin contribution API for Homelab").
- Cache-busting `?v=hash` on `<link rel="stylesheet">` hrefs (handoff Step 2, low priority — operator hard-refresh works).
- Mobile/responsive overhaul (PRD-018 NG-06).
- CI on `main` is partially red (`spec-reconciliation`, `typecheck`, `lint` were failing before this session — separate ticket).
- Host-plugin decision (`autonomous-dev-portal` vs core `autonomous-dev`).

---

## 10. Provenance

The findings in §3 come from a Chrome crawl on 2026-05-11 against `http://127.0.0.1:19280/` (dark theme, viewport 1470×747). Probes used:

- `document.documentElement.outerHTML` / `getComputedStyle` for tokens and DOM shape.
- `chrome.network` request log for asset 200/404 status.
- `curl http://127.0.0.1:19280/<route>` for status codes on routes the rail-nav doesn't expose.
- `diff -rq plugins/autonomous-dev-portal/server/static/ plugins/autonomous-dev-portal/static/` for the asset-duplication enumeration.
- `grep -rn` against `server/stubs/` to map every fixture string back to its source file.
- Cross-reference with the vendored design kit at `/tmp/portal-design-v2/autonomous-dev-design-system/project/` (same content as the design URL `https://api.anthropic.com/v1/design/h/xeQNMZjn2B6BAdYC61Q4og`, a 712 KB gzipped tarball).
- Handoff doc `plugins/autonomous-dev-portal/docs/triage/PORTAL-REDESIGN-HANDOFF.md` (closes its §"Static asset duplication" and §"Daemon data is real but zero" debug bullets).

Target kit screenshot: `/tmp/portal-design-v2/autonomous-dev-design-system/project/screenshots/dashboard.png`.

---

## 14. PRD Traceability Matrix

PRD-018 has 23 requirements (R-01 through R-23). TDD-037 is the **fourth** TDD under PRD-018 and closes the residual gap left by the first three. This matrix records, for every R-N, which TDD addresses it. R-N rows marked "TDD-037 §X" are work this TDD owns; rows marked "(upstream)" were closed by a prior TDD and are referenced here only to assert that TDD-037 does not regress them.

| PRD-018 Req | Summary                                                                 | Owning TDD            | TDD-037 obligation                                                |
|-------------|-------------------------------------------------------------------------|-----------------------|-------------------------------------------------------------------|
| R-01        | Vendor `colors_and_type.css` as `design-tokens.css`                     | TDD-034 (upstream)    | Do not alter; verify `--brand` resolves (AC-3711).                |
| R-02        | All non-token CSS references variables only                             | TDD-034 (upstream)    | §5.6 grep + fix any primary-button rule that hard-codes a color.   |
| R-03        | Light/dark theme toggle on `<html>`                                     | TDD-034 (upstream)    | Do not alter.                                                      |
| R-04        | Inter + JetBrains Mono fonts via `@import`                              | TDD-034 (upstream)    | Do not alter. (Verified live: fonts 200 in §3.)                   |
| R-05        | 220px left rail with brand, nav, ops bar                                | TDD-035 (upstream)    | Add nav-badge slots to the nav items (G-3712); rail structure unchanged. |
| R-06        | No top header; `<h1>` 28px + head-actions                               | TDD-035 (upstream)    | Do not alter.                                                      |
| R-07        | Content max-width 1280px                                                | TDD-035 (upstream)    | Do not alter.                                                      |
| R-08        | Primitives at `server/components/primitives.tsx` with pinned prop surface | TDD-035 (upstream)  | Do not alter; the new `/agents` and `/repos` surfaces consume existing primitives. |
| R-09        | Buttons follow kit: primary uses `--brand`                              | TDD-035 (upstream)    | **§5.6** — audit the consuming rule; G-3713/AC-3711 verify.       |
| R-10        | Dot + UPPERCASE badge for status; no emoji                              | TDD-035 (upstream)    | Do not alter. New surfaces (`/agents`, `/repos`) reuse `Dot` primitive. |
| R-11        | Phase chips UPPERCASE on `--phase-*` background                          | TDD-035 (upstream)    | Do not alter.                                                      |
| R-12        | Repo card 4px left bar in `--phase-<active>`                            | TDD-036 (upstream)    | Do not alter. The composition reader emits `activePhase` for each repo. |
| R-13        | KillSwitch primitive with `--err` palette                               | TDD-035 (upstream)    | Do not alter.                                                      |
| R-14        | Tables: hairlines only, no zebra, sticky headers                        | TDD-035 (upstream)    | New tables in `/agents`, `/repos`, and `repo-detail` reuse the existing `<table class="tbl">` skin. |
| R-15        | `.dot.live` indicator replaces spinners                                 | TDD-035 (upstream)    | Do not alter.                                                      |
| R-15a       | Hairline elevation, no glassmorphism, lint rejects `box-shadow:`        | TDD-034 (upstream)    | Do not alter.                                                      |
| R-16        | Dashboard matches `Dashboard.jsx`                                       | TDD-036 (visual) + **TDD-037 §5.1, §5.8** (data) | Visual already closed; this TDD wires the data so the kit-screenshot KPIs (`Active 9 across 6 repos`, `Awaiting 3`, `MTD $153.60`) come from `kit-parity` fixtures, not hardcoded stubs. AC-3706. |
| R-17        | Request Detail matches `RequestDetail.jsx`                              | TDD-036 (visual) + **TDD-037 §5.3** (500→404)   | Visual already closed; this TDD fixes the 500 on missing-id (AC-3705). |
| R-18        | Costs matches `Costs.jsx`                                               | TDD-036 (visual) + **TDD-037 §5.1, §8 step 8** (data) | Visual already closed; this TDD wires the reviewer table to real agents, the daily-spend chart to the cost ledger, and the phase-spend breakdown to the ledger. AC-3708. |
| R-19        | Ops matches `Ops.jsx`                                                   | TDD-036 (visual) + **TDD-037 §5.1, §8 step 8** (data) | Visual already closed; this TDD wires PID, uptime, MCP status, plugin versions, and log tail to real readers. AC-3709. |
| R-20        | Settings matches `Settings.jsx`                                         | TDD-036 (visual) + **TDD-037 §5.1** (data)      | Visual already closed; this TDD replaces the `/Users/op/repos/acme` fake allowlist with the real portal-settings allowlist. |
| R-21        | `/design-system` page                                                   | TDD-035 (upstream)    | Do not alter. Used as the §5.6 regression surface for the `--brand` audit. |
| R-22        | Voice/copy sweep (sentence case, no emoji, mono IDs, etc.)              | TDD-034 (upstream)    | Do not alter. New surfaces (`/agents`, `/repos`, 404 page for request detail) comply.|
| R-23        | Replace ad-hoc copy with kit strings                                    | TDD-034 (upstream)    | Empty-state copy on every surface uses kit strings: `No active requests`, `No approvals waiting`, `Daemon stopped`. |

**Net effect**: TDD-037 owns the **data** half of R-16 through R-20 (which TDD-036 closed at the **visual** level) plus R-09 cleanup (consumption side). Every other R-N is upstream and TDD-037 commits not to regress it. Two new surfaces (`/agents`, `/repos`) are net-new — they consume existing primitives (R-08) and reuse the table skin (R-14), so they do not extend the PRD surface area.

### TDD-037 work that is **not** in PRD-018

Three items in §2 Goals are operational hygiene, not PRD-018 requirements:

- **G-3701** (brand SVGs served / favicon) — implicit in PRD-018 G-03 ("brand wordmark") but never explicitly required as a served asset. TDD-037 chooses to include it because the 404s are visible in the network panel.
- **G-3714** (static-root sweep, delete `server/static/`) — operational cleanup deferred from PLAN-037; no PRD-018 requirement.
- **G-3716** (`kit-parity` fixture directory) — testing infrastructure; no PRD-018 requirement.

These are flagged here so reviewers can decide whether to keep them in TDD-037 or split into a separate operational-cleanup TDD. Recommendation: keep — they unblock the data work and prevent the duplication-drift bug from recurring.
