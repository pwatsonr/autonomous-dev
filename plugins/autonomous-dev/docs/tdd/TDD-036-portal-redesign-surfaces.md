# TDD-036: Portal Redesign — Surface-by-Surface Adoption

| Field          | Value                                                                    |
|----------------|--------------------------------------------------------------------------|
| **Title**      | Portal Redesign — Surface-by-Surface Adoption                           |
| **TDD ID**     | TDD-036                                                                  |
| **Version**    | 1.0                                                                      |
| **Date**       | 2026-05-09                                                               |
| **Author**     | Patrick Watson                                                           |
| **Status**     | Draft                                                                    |
| **Parent PRD** | PRD-018 (Portal Visual Redesign — Design System Adoption)                |
| **Plugin**     | autonomous-dev-portal                                                    |
| **Depends on** | TDD-035 (shell + primitives) — surfaces consume primitives shipped there |

---

## 1. Summary

TDD-036 re-skins the five operator-facing portal surfaces (Dashboard, Request Detail, Costs, Ops, Settings) to match the design system UI kit supplied in `autonomous-dev-design-system/project/ui_kits/portal/`. Each surface is ported from its current minimal Hono JSX view (`templates/views/*.tsx`) to a pixel-faithful reproduction of the corresponding kit component (`Dashboard.jsx`, `RequestDetail.jsx`, `Costs.jsx`, `Ops.jsx`, `Settings.jsx`), consuming the primitive components (`Btn`, `Chip`, `Dot`, `Score`, `CostRing`, `Card`, `KillSwitch`) and layout shell that TDD-035 delivers.

This is a pure visual re-skin. No new data sources, no new SSE events, no new routes. The existing route handlers, stub data loaders, and integration pipelines remain unchanged. The work extends the existing `RenderProps` interfaces where the kit demands richer data shapes than the current stubs provide, but the server-side data plumbing already exists in the daemon state files — this TDD only concerns the template layer.

**Implementation sequencing.** This TDD can be authored and reviewed in parallel with TDD-035 (shell + primitives), but the implementation PR for TDD-036 must land after TDD-035's primitives are merged and available in `server/components/primitives.tsx`. The implementation branch should be based on the TDD-035 merge commit.

---

## 2. Goals & Non-Goals

### Goals

| ID     | Goal                                                                                                                                              |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| G-3601 | Re-skin the Dashboard view to match `Dashboard.jsx`: KPI strip, repo cards grid with 4px phase-colored left bar, active requests table, approval indicators. |
| G-3602 | Re-skin the Request Detail view to match `RequestDetail.jsx`: pipeline visualization, artifact pane, gate panel, reviewer chain, deploy pipeline.  |
| G-3603 | Re-skin the Costs view to match `Costs.jsx`: KPI strip, daily spend SVG chart, phase spend breakdown table, reviewer spend table, deploy backend spend table. |
| G-3604 | Re-skin the Ops view to match `Ops.jsx`: health KPI strip, plugin chain visualization, live log tail, deploy events, MCP server status, standards changes. |
| G-3605 | Re-skin the Settings view to match `Settings.jsx`: tabbed interface (General, Pipeline variants, Engineering standards, Deploy backends, Agent factory) with live form validation. |
| G-3606 | Produce before/after screenshot pairs for all 5 surfaces (M-04) that ship with the implementation PR.                                             |
| G-3607 | Handle empty-state gracefully for every surface — the kit assumes populated data; a fresh install has none.                                        |
| G-3608 | Maintain all existing HTMX behaviors (SSE streaming, form submission, CSRF protection) through the re-skin.                                       |

### Non-Goals

| ID      | Non-Goal                                                                                                            |
|---------|---------------------------------------------------------------------------------------------------------------------|
| NG-3601 | Primitive component implementation (`Btn`, `Chip`, `Dot`, `Score`, `CostRing`, `Card`, `KillSwitch`) — TDD-035.      |
| NG-3602 | Design token vendoring, theme switcher, CI lint for hex literals — TDD-034.                                          |
| NG-3603 | Layout shell (left rail, brand wordmark, global ops bar, nav) — TDD-035.                                             |
| NG-3604 | Voice/copy sweep of non-surface code paths — TDD-034.                                                                |
| NG-3605 | `/design-system` reference page — TDD-035.                                                                           |
| NG-3606 | New data plumbing. If the kit shows data the daemon does not expose today, the surface uses a placeholder empty state.|
| NG-3607 | Approvals surface (not in R-16..R-20 scope; the approval queue is embedded in the Dashboard per the kit).            |
| NG-3608 | Mobile/responsive overhaul — PRD-018 NG-06 stands. Desktop + laptop viewport only.                                   |

---

## 3. Tenets

| Tenet                                    | Implication                                                                                                                                   |
|------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------|
| Pixel fidelity to the kit                | The rendered HTML output must visually match the kit screenshots. Deviations from the kit are bugs unless documented here as intentional.      |
| SSR-only, no client framework            | All surfaces render via Hono JSX server-side. Interactive behaviors (tab switching, form validation, accordion) use vanilla JS modules.         |
| Consume primitives, don't re-invent      | Every `Btn`, `Chip`, `Dot`, `Score`, `CostRing`, `Card`, `KillSwitch` usage imports from `server/components/primitives.tsx` (TDD-035).        |
| Empty states are first-class             | Every data-dependent section must handle `length === 0` with a muted text fallback, never a broken layout.                                    |
| Preserve existing contracts              | Route signatures, HTMX attributes, SSE channels, CSRF flows remain unchanged. Only the template layer changes.                                |

---

## 4. Background — Current State of Each Surface

Each surface today renders a minimal, unstyled view via Hono JSX. The gap between current state and the kit target is substantial.

| Surface         | Route                         | Current template                    | Current state                                                                                             |
|-----------------|-------------------------------|-------------------------------------|-----------------------------------------------------------------------------------------------------------|
| Dashboard       | `GET /`                       | `views/dashboard.tsx`               | `<h1>Repositories</h1>` + a flat `repo-grid` of `RepoCard` fragments. No KPI strip, no active requests table, no approval indicators. |
| Request Detail  | `GET /repo/:repo/request/:id` | `views/request-detail.tsx`          | Phase timeline fragment + basic request metadata. No pipeline visualization, no gate panel, no reviewer chain. |
| Costs           | `GET /costs`                  | `views/costs.tsx`                   | `<h1>Cost</h1>` + a single `CostChart` SVG. No KPI strip, no phase breakdown, no reviewer spend, no deploy spend. |
| Ops             | `GET /ops`                    | `views/ops.tsx`                     | `<h1>Ops</h1>` + daemon status `<dl>` + component status `<ul>`. No KPI strip, no plugin chain, no live log, no deploy events. |
| Settings        | `GET /settings`               | `views/settings.tsx`                | Legacy read-only `<dl>` for auth/port/log-level plus full `SettingsEditor` form (cost caps, trust, allowlist, notifications). No tabbed interface, no variants/standards/backends/agents tabs. |

---

## 5. Architecture

### 5.1 File Layout

The re-skinned surfaces replace the existing view files in-place. No new routes are added. The existing fragment components (`fragments/*.tsx`) are either updated to consume primitives or replaced by new fragments that match the kit's component decomposition.

```
plugins/autonomous-dev-portal/server/
├── templates/
│   ├── views/
│   │   ├── dashboard.tsx          ← REWRITE: KPI strip, repo grid, active requests table
│   │   ├── request-detail.tsx     ← REWRITE: pipeline, gate panel, reviewer chain, deploy
│   │   ├── costs.tsx              ← REWRITE: KPI strip, chart, phase/reviewer/deploy tables
│   │   ├── ops.tsx                ← REWRITE: KPI strip, plugin chain, log, events, MCP
│   │   └── settings.tsx           ← REWRITE: tabbed interface with 5 tabs
│   ├── fragments/
│   │   ├── repo-card.tsx          ← UPDATE: 4px left bar, phase chip, variant chip, footer
│   │   ├── kpi-strip.tsx          ← NEW: reusable KPI card strip component
│   │   ├── pipeline-vis.tsx       ← NEW: horizontal phase pipeline with done/now/pending
│   │   ├── reviewer-chain.tsx     ← NEW: reviewer card grid with blocking indicators
│   │   ├── deploy-pipeline.tsx    ← NEW: deploy stage visualization
│   │   ├── gate-detail.tsx        ← NEW: gate block with approve/reject actions
│   │   ├── phase-spend-table.tsx  ← NEW: per-phase cost breakdown with bar cells
│   │   ├── live-log.tsx           ← NEW: log tail component with level coloring
│   │   ├── plugin-chain.tsx       ← NEW: horizontal plugin chain visualization
│   │   ├── settings-tabs.tsx      ← NEW: segmented control tabs for settings
│   │   ├── variant-grid.tsx       ← NEW: pipeline variant cards
│   │   ├── backend-grid.tsx       ← NEW: deploy backend cards
│   │   ├── agent-table.tsx        ← NEW: agent factory table with inspect modal
│   │   ├── standards-table.tsx    ← NEW: engineering standards table with edit modal
│   │   └── empty-state.tsx        ← NEW: reusable "No <noun>" muted text component
│   └── layout/
│       └── base.tsx               ← UNCHANGED (shell is TDD-035)
├── types/
│   └── render.ts                  ← EXTEND: add richer data shapes for kit surfaces
├── stubs/
│   ├── repos.ts                   ← EXTEND: add phase, trust, variant, backend fields
│   ├── requests.ts                ← EXTEND: add variant, stack, flags, gate fields
│   ├── costs.ts                   ← EXTEND: add phaseSpend, reviewerSpend, deploySpend
│   ├── ops.ts                     ← EXTEND: add MCP servers, plugin chain, standards
│   └── settings.ts                ← EXTEND: add variants, standards, backends, agents
├── static/
│   └── js/
│       ├── settings-tabs.js       ← NEW: vanilla JS tab switching for Settings
│       └── form-validation.js     ← NEW: vanilla JS live form validation
└── components/
    └── primitives.tsx             ← PROVIDED BY TDD-035 (consumed, not authored here)
```

### 5.2 Surface-by-Surface Component Mapping

#### Dashboard (`GET /`) — `Dashboard.jsx`

| Region               | Kit source             | Primitives consumed           | Data shape (`data.js`)                                       | SSE channel         |
|----------------------|------------------------|-------------------------------|--------------------------------------------------------------|---------------------|
| Page head            | `.page-head`           | `Btn`                         | —                                                             | —                   |
| KPI strip (4 cards)  | `.kpi-strip`           | —                             | `repos[].active`, `requests.filter(gate)`, `repos[].mtd`, `standards` | `dashboard:kpis`    |
| Repo card grid       | `.repo-grid > .repo-card` | `Chip` (phase, variant), `Card` (left bar) | `repos[]: {id, path, trust, phase, active, mtd, lastMin, attn, gates, variant, backend, stack}` | `dashboard:repos`   |
| Active requests table| `.tbl`                 | `Chip` (phase), `Score`       | `requests[]: {id, repo, title, phase, status, cost, turns, score, variant, gateType}` | `dashboard:requests`|

**Empty states:**
- 0 repos: "No repositories allowlisted" muted text, no grid.
- 0 requests: "No active requests" muted text, no table.
- 0 approval gates: KPI card shows `0` with sub-text "none pending".

#### Request Detail (`GET /repo/:repo/request/:id`) — `RequestDetail.jsx`

| Region               | Kit source             | Primitives consumed           | Data shape                                                    | SSE channel           |
|----------------------|------------------------|-------------------------------|---------------------------------------------------------------|----------------------|
| Back row + page head | `.page-head`, `.back-row` | `Btn` (Pause, Kill)        | `request.id`, `request.title`                                  | —                    |
| Request header       | `.rd-head`             | `Chip` (phase, variant, stack)| `{repo, phase, variant, stack, started, cost, turns, score}`   | `request:{id}:meta`  |
| Pipeline             | `.pipeline`            | —                             | `variant.phases[]`, current phase index                         | `request:{id}:phase` |
| Reviewer chain       | `.rev-chain`           | —                             | `variant.reviewers[phase]`, agent data, blocking findings       | —                    |
| Deploy pipeline      | `.deploy-pipe`         | —                             | `request.deployStage`, deploy stage list                        | `request:{id}:deploy`|
| Gate detail          | `.gate-block`          | `Btn` (Approve, Reject)       | `gateType`, `gateDetail`, `waitedMin`                           | —                    |
| Standards applied    | `.std-list`            | —                             | `standards.filter(applies)`                                     | —                    |
| Confirm modal        | `.modal`               | `Btn`                         | —                                                               | —                    |
| Phase artifact modal | `.modal.modal-wide`    | —                             | Phase-specific artifact content                                  | —                    |

**Empty states:**
- Request not found: 404 view (existing behavior, no change).
- No reviewer chain (non-review phase): section not rendered.
- No deploy pipeline (non-deploy phase): section not rendered.
- No gate (running status): gate section not rendered.
- No standards applied: section not rendered.

#### Costs (`GET /costs`) — `Costs.jsx`

| Region                 | Kit source            | Primitives consumed   | Data shape                                                      | SSE channel      |
|------------------------|-----------------------|-----------------------|-----------------------------------------------------------------|------------------|
| Page head              | `.page-head`          | `Btn`                 | —                                                                | —                |
| KPI strip (4 cards)    | `.kpi-strip`          | —                     | `totalMtd`, `reviewerTotal`, `deployTotal`, `avgPerRequest`      | `costs:kpis`     |
| Daily spend chart      | `.chart-card > svg`   | —                     | `dailyCost[]: {day, cost}` (30 points)                           | —                |
| Phase spend table      | `.tbl.tight`          | `Chip` (phase)        | `phaseSpend[]: {phase, cost, pct}`                               | —                |
| Reviewer spend table   | `.tbl.tight`          | `Chip` (role)         | `reviewerSpend[]: {name, role, runs, fpRate, cost}`              | —                |
| Deploy spend table     | `.tbl`                | `Chip` (backend, health) | `deploySpend[]: {env, backend, deploys, lastDeploy, health, cost}` | —            |

**Empty states:**
- 0 daily cost data: chart area shows "No cost data yet" muted text.
- 0 phase spend: table body shows single row "No phase data".
- 0 reviewer spend: table body shows single row "No reviewer data".

#### Ops (`GET /ops`) — `Ops.jsx`

| Region                  | Kit source             | Primitives consumed     | Data shape                                                    | SSE channel     |
|-------------------------|------------------------|-------------------------|---------------------------------------------------------------|-----------------|
| Page head               | `.page-head`           | `Btn` (Refresh, Killswitch) | —                                                         | —               |
| Health KPI strip        | `.kpi-strip`           | `Dot` (live)            | daemon status, MCP server count, plugin chain count, standards | `ops:health`    |
| Plugin chain            | `.plugin-chain`        | —                       | Chain of packages: core, reviewers, variants, deploy, org      | —               |
| Live log                | `.log`                 | —                       | Log entries with timestamp, level marker, message text         | `ops:log`       |
| Deploy events table     | `.tbl.tight`           | `Chip` (backend, status)| Recent deploy events with time, backend, env, status           | `ops:deploys`   |
| MCP servers table       | `.tbl.tight`           | `Chip` (status)         | MCP server name, status, latency                               | `ops:mcp`       |
| Standards changes       | `.event-list`          | —                       | Recent standards change events with time and description       | —               |

**Empty states:**
- Daemon not running: KPI shows "stopped" in `--err` color, log section shows "Daemon offline".
- 0 MCP servers: table shows "No MCP servers connected".
- 0 deploy events: "No deploy events in last 24h".
- 0 standards changes: "No recent standards changes".

#### Settings (`GET /settings`) — `Settings.jsx`

| Region                  | Kit source             | Primitives consumed     | Data shape                                                    | SSE channel |
|-------------------------|------------------------|-------------------------|---------------------------------------------------------------|-------------|
| Page head               | `.page-head`           | `Btn` (Discard, Save)   | —                                                              | —           |
| Tab bar                 | `.seg.seg-tabs`        | —                       | Tab IDs: general, variants, standards, backends, agents        | —           |
| General tab             | `.settings-grid`       | —                       | Trust level, daily cap, default variant, default backend        | —           |
| Variants tab            | `.variant-grid`        | `Btn`, `Chip` (ok)      | `variants[]: {id, label, desc, phases, reviewers}`             | —           |
| Standards tab           | `.tbl` + edit modal    | `Btn`, `Chip` (severity)| `standards[]: {id, severity, desc, applies, source, immutable, hits}` | —   |
| Backends tab            | `.backend-grid`        | `Btn`, `Chip` (kind)    | `backends[]: {id, name, kind, cost, caps, status}`             | —           |
| Agents tab              | `.tbl` + inspect modal | `Btn`, `Chip` (role, state) | `agents[]: {name, role, state, approval, precision, recall, version}` | — |

**Empty states:**
- 0 repos (General tab, trust level): "No repositories allowlisted".
- 0 variants: "No pipeline variants configured".
- 0 standards: "No engineering standards defined".
- 0 backends: "No deploy backends available".
- 0 agents: "No agents registered".

### 5.3 Data Shape Extensions

The current `RenderProps` types are minimal stubs. The kit expects richer data. This TDD extends the types to match the kit's `data.js` shapes. The extensions are backward-compatible — every new field is optional at the type level, and the stub loaders populate them with representative data.

```typescript
// --- render.ts extensions ---

export interface RepoSummary {
    repo: string;
    activeRequests: number;
    lastActivity: string;
    monthlyCostUsd: number;
    attentionCount: number;
    // NEW fields for kit
    trust?: string;           // "L0"|"L1"|"L2"|"L3"
    phase?: string;           // current highest-priority phase
    variant?: string;         // pipeline variant ID
    backend?: string;         // deploy backend ID
    stack?: string;           // tech stack identifier
    gateCount?: number;       // number of approval gates pending
}

export interface DashboardData {
    repos: RepoSummary[];
    // NEW
    requests?: DashboardRequest[];
    standards?: StandardRule[];
    variants?: PipelineVariant[];
}

export interface DashboardRequest {
    id: string;
    repo: string;
    title: string;
    phase: string;
    status: "running" | "gate";
    cost: number;
    turns: number;
    score: number;
    variant: string;
    gateType?: string;
    stack?: string;
}

export interface StandardRule {
    id: string;
    severity: "blocking" | "warn" | "advisory";
    desc: string;
    applies: string;
    source: string;
    immutable: boolean;
    hits: number;
}

export interface PipelineVariant {
    id: string;
    label: string;
    desc: string;
    phases: string[];
    reviewers?: Record<string, string[]>;
}

export interface PhaseSpend {
    phase: string;
    cost: number;
    pct: number;
}

export interface ReviewerSpend {
    name: string;
    role: "generic" | "specialist";
    cost: number;
    runs: number;
    fpRate?: number;
    avgScore?: number;
}

export interface DeploySpend {
    env: string;
    backend: string;
    deploys: number;
    cost: number;
    lastDeploy: string;
    health: "ok" | "degraded" | "err";
}

export interface CostSeries {
    points: CostPoint[];
    budgetUsd: number;
    // NEW
    phaseSpend?: PhaseSpend[];
    reviewerSpend?: ReviewerSpend[];
    deploySpend?: DeploySpend[];
    totalMtd?: number;
    requestCount?: number;
}

export interface OpsHealth {
    daemon: { status: string; pid: number | null };
    components: Record<string, string>;
    // NEW
    mcpServers?: { name: string; status: string; latency: string }[];
    pluginChain?: {
        category: string;
        packages: { name: string; highlight?: "core" | "org" }[];
    }[];
    recentLog?: { time: string; level: string; text: string }[];
    deployEvents?: {
        time: string;
        backend: string;
        env: string;
        status: string;
    }[];
    standardsChanges?: { time: string; text: string }[];
    standardsCount?: number;
    immutableCount?: number;
}

export interface AgentRecord {
    name: string;
    role: "author" | "reviewer" | "specialist";
    state: "active" | "shadow" | "frozen";
    approval: number;
    precision?: number;
    recall?: number;
    version: string;
}

export interface DeployBackend {
    id: string;
    name: string;
    kind: "bundled" | "plugin";
    cost: string;
    caps: string[];
    status: "available" | "not-installed";
}
```

---

## 6. Detailed Design per Surface

### 6.1 Dashboard

**Template structure** (simplified JSX):

```tsx
<>
  <div class="page-head">
    <h1>Dashboard</h1>
    <div class="head-actions">
      <Btn>Refresh</Btn>
      <Btn kind="primary">+ New request</Btn>
    </div>
  </div>

  <KpiStrip items={[
    { label: "Active requests", value: totalActive, sub: `across ${repos.length} repos` },
    { label: "Awaiting approval", value: totalGates, sub: gateBreakdownText },
    { label: "MTD spend", value: `$${totalMtd.toFixed(2)}`, sub: `cap $${cap}` },
    { label: "Standards rules", value: standardsCount, sub: `${blockingHits} blocking hits MTD` },
  ]} />

  <section class="sec">
    <div class="sec-head">
      <h2>Repos</h2>
      <a class="link" href="#">view all</a>
    </div>
    <div class="repo-grid">
      {repos.length > 0
        ? repos.map(r => <RepoCard {...r} />)
        : <EmptyState noun="repositories allowlisted" />}
    </div>
  </section>

  <section class="sec">
    <div class="sec-head">
      <h2>Active requests</h2>
      <a class="link" href="#">filter...</a>
    </div>
    {requests.length > 0
      ? <ActiveRequestsTable requests={requests} />
      : <EmptyState noun="active requests" />}
  </section>
</>
```

**Component inventory:**

| Component          | Source                    | Primitive used          | Conditional rendering                    |
|--------------------|--------------------------|-------------------------|------------------------------------------|
| `KpiStrip`         | `fragments/kpi-strip.tsx` | None                   | Always rendered; values may be 0          |
| `RepoCard`         | `fragments/repo-card.tsx` | `Chip`, `Card`         | Skipped when `repos.length === 0`         |
| `ActiveRequestsTable` | Inline in view         | `Chip`, `Score`        | Replaced with `EmptyState` when empty     |
| `EmptyState`       | `fragments/empty-state.tsx` | None                 | Rendered when data array is empty         |

**RepoCard layout regions:**

1. **Top row**: repo name (14px, bold) + trust level badge (`L0`-`L3`, mono, 11px, bordered).
2. **Path row**: `~/projects/repo-name` in mono, 11px, `--fg-3`.
3. **Meta row 1**: phase chip (uppercase, phase-colored) + variant chip (sentence case).
4. **Meta row 2**: backend chip (info tint) + stack chip (neutral).
5. **Footer** (below hairline): `N active` + `$X.XX MTD` + either `N need approval` (warn) or `last Nm ago` (muted mono).
6. **Left bar**: 4px solid `--phase-<active-phase>`. If `attn === true`, left bar is `--warn` and outer card gets `--warn-line` box-shadow.

### 6.2 Request Detail

**Template structure:**

The view is organized as a vertical stack of conditional sections. No tabs; sections render or hide based on request state.

| Section             | Condition to render                      | Layout                         |
|---------------------|------------------------------------------|--------------------------------|
| Back row + head     | Always                                   | Flex row, back link + request ID |
| Request header      | Always                                   | Title, meta chips, stat strip  |
| Pipeline            | Always                                   | Horizontal phase steps         |
| Reviewer chain      | `phase === 'review' \|\| phase === 'code'` | Grid of reviewer cards         |
| Deploy pipeline     | `phase === 'deploy'`                     | Horizontal deploy stage steps  |
| Gate detail         | `status === 'gate'`                      | Warning card with actions      |
| Standards applied   | `request.flags.hasStandards === true`    | Stacked rule rows              |
| Confirm modal       | Client-side triggered                    | Modal overlay (vanilla JS)     |
| Phase artifact modal| Client-side triggered                    | Wide modal overlay (vanilla JS)|

**Pipeline visualization:**

Each phase renders as a `pipe-step` button with three visual states:
- `done`: background `--bg-1`, dot filled `--ok`.
- `now`: background `--brand-tint`, dot filled `--brand` with glow ring, state text in `--brand`.
- `pending`: background `--bg-1`, dot bordered `--line-2`, hollow.

The pipeline is a horizontal flex container. Steps touch edge-to-edge with `border-right: 0` on all but the last. First step has left border-radius, last step has right border-radius.

**Gate detail card:**

When `status === 'gate'`, a warning-tinted card appears with:
- Section head: `Gate . <gate type label>` + waited time in mono.
- Card body: gate detail text + approve/reject buttons.
- Approve button: `Btn kind="primary" size="sm"`.
- Reject button: `Btn kind="danger" size="sm"`.
- Clicking either triggers a confirm modal (rendered server-side, toggled via vanilla JS).

### 6.3 Costs

**Template structure:**

```
page-head (h1 "Costs" + Export CSV, Set caps buttons)
KPI strip (MTD spend, Reviewers, Deploys, Avg/request)
Section: Daily spend chart (SVG, server-rendered)
Cost grid (2-col):
  Left: Phase spend table (with bar cells)
  Right: Reviewer spend table
Section: Deploy backend spend table
```

**SVG chart** (server-rendered, no JS charting library):

The daily spend chart is an inline `<svg>` rendered in Hono JSX. Per PRD-009 FR-928, charts are server-rendered SVG. The chart implementation:
- Viewbox: `0 0 760 200`.
- 5 horizontal grid lines at 0%, 25%, 50%, 75%, 100% of max cost.
- Area fill: linear gradient from `--brand` at 32% opacity to transparent.
- Line stroke: `--brand`, 2px width.
- X-axis labels: day numbers (optional, every 5th day).
- Y-axis labels: dollar amounts (optional, at grid line intersections).

**Phase spend table** with bar cells:

Each row contains: phase chip, a horizontal bar (width proportional to percentage), cost in mono, percentage in mono dimmed. The bar is a 6px-tall div with `--brand` fill inside a `--bg-3` track.

### 6.4 Ops

**Template structure:**

```
page-head (h1 "Operations" + Refresh, Killswitch buttons)
Health KPI strip (daemon status, MCP servers, plugin chain, standards)
Section: Plugin chain (horizontal visualization)
ops-grid (1.4fr 1fr):
  Left: Live log (dark terminal block)
  Right: Deploy events table
ops-grid (1fr 1fr):
  Left: MCP servers table
  Right: Recent standards changes (event list)
```

**Plugin chain visualization:**

A horizontal flex container with 5 columns (CORE, REVIEWERS, VARIANTS, DEPLOY, ORG) separated by arrow characters. Each column has a header in mono uppercase and a stack of package name pills. The core package uses `--brand-tint/line` highlighting; the org package uses `--info-tint/line`.

**Live log:**

The log tail renders in a dark container (`background: #14130f`) regardless of the current theme. Log entries are colored by level:
- `INFO`: `--info` (blue).
- `WARN`: `--warn` (amber).
- `ERR`: `--err` (red).
- Phase/deploy markers: `--brand` (amber), bold.
- Timestamps: `--fg-2` (muted).

The container has `max-height: 320px; overflow: auto` and scrolls to the bottom on SSE updates.

### 6.5 Settings

**Template structure:**

The Settings view is the most complex surface. It uses a **segmented tab control** (`.seg.seg-tabs`) to switch between five tabs. Tab switching is handled by vanilla JS (show/hide sections by `data-tab` attribute). No page navigation on tab switch — all tabs render server-side and are hidden/shown client-side.

```
page-head (h1 "Settings" + Discard, Save buttons)
Segmented tabs: General | Pipeline variants | Engineering standards | Deploy backends | Agent factory

Tab: General (2-col grid of setting cards)
  - Trust level (select: L0-L3)
  - Daily cost cap ($ prefix input)
  - Default pipeline variant (select)
  - Default deploy backend (select)

Tab: Pipeline variants (variant card grid)
  - Each card: name, default badge, description, phase pipeline, reviewer map, Edit/Set default buttons

Tab: Engineering standards (full-width table + edit modal)
  - Columns: ID, Severity, Description, Applies, Source, Hits, Edit
  - Edit modal: form with description, severity select, applies predicate input

Tab: Deploy backends (responsive card grid)
  - Each card: name, kind badge, cost, capability chips, Configure/Set default or Install plugin buttons

Tab: Agent factory (full-width table + inspect modal)
  - Columns: Name, Role, State, Approval, Precision, Recall, Version, Inspect
  - Inspect modal: stats grid, recent runs mini-table, Promote/Shadow/Freeze buttons
```

**Tab switching (vanilla JS):**

```javascript
// static/js/settings-tabs.js
document.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tabId = btn.dataset.tab;
        document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        document.querySelectorAll('[data-tab-panel]').forEach(p => {
            p.hidden = p.dataset.tabPanel !== tabId;
        });
    });
});
```

**Form validation (vanilla JS):**

The General tab has live validation on the cost cap input:
- Negative values: shows inline error text below input.
- Non-numeric input: shows inline error text.
- Exceeds monthly cap: shows inline warning.

Validation messages render as `<span class="field-error">` inserted/removed via vanilla JS. Server-side validation via the existing HTMX `hx-post` flow remains authoritative.

**Modals (vanilla JS):**

The Edit Standard and Inspect Agent modals are rendered server-side as hidden `<div class="modal-bg" hidden>` blocks. Vanilla JS toggles the `hidden` attribute. The modal backdrop click-to-dismiss behavior is wired with a single event listener.

### 6.6 Sequence: Dashboard Load (Happy Path)

```
Browser                    Portal Server                    Daemon State
  |                             |                               |
  |--- GET / ----------------->|                               |
  |                             |--- read state.json files --->|
  |                             |--- read cost-ledger.json --->|
  |                             |<-- repo summaries, costs ----|
  |                             |                               |
  |                             |   renderPage("dashboard", {
  |                             |     repos, requests, standards,
  |                             |     variants
  |                             |   })
  |                             |                               |
  |                             |   BaseLayout wraps DashboardView
  |                             |     KpiStrip(totals)
  |                             |     RepoCard[] (with Chip, Card)
  |                             |     ActiveRequestsTable (with Chip, Score)
  |                             |                               |
  |<-- 200 HTML ---------------|                               |
  |                             |                               |
  |--- SSE /events ----------->|                               |
  |                             |--- watch state files -------->|
  |                             |<-- file change event ---------|
  |                             |                               |
  |<-- SSE: dashboard:repos ---|                               |
  |   (HTMX hx-swap-oob        |                               |
  |    replaces repo-grid)      |                               |
```

---

## 7. Trade-offs

| #  | Decision                                | Option A                                      | Option B                                         | Chosen | Rationale                                                                                                                      |
|----|-----------------------------------------|-----------------------------------------------|--------------------------------------------------|--------|--------------------------------------------------------------------------------------------------------------------------------|
| 1  | Surface rollout strategy                | **Incremental with feature flag per surface** — each surface gets a `PORTAL_REDESIGN_<SURFACE>` env var; when off, the old view renders. | **Single PR cutover** — all 5 surfaces flip in one PR; prior views kept in git history for revert. | B      | Feature flags per surface add operational complexity (10 code paths to maintain). The old views are trivial stubs; reverting one commit undoes the entire redesign. The kit surfaces are visually independent so regressions in one don't cascade. Git history provides the safety net. |
| 2  | Responsive treatment                    | **Full responsive** — grid breakpoints at 768px and 1024px, 1-col layout on tablet. | **Desktop-only** — kit's 1280px max-width + 220px rail, no breakpoints below 1024px. | B      | PRD-018 NG-06 explicitly excludes mobile. The kit was designed at desktop width. Adding breakpoints doubles the CSS surface and the visual regression test matrix. Tablet reads acceptably with horizontal scroll on dense tables. |
| 3  | Which surface to implement first        | **Dashboard** — most operator visibility, highest confidence (KPI + cards are stateless). | **Settings** — most complex (5 tabs, forms, modals) — if it works, everything works. | A      | Dashboard validates the primitive integration (Chip, Score, Card) and the data shape extensions at low risk. Settings has the most client-side JS (tab switching, validation, modals) and should land last to benefit from lessons learned. |
| 4  | Settings tab switching                  | **Vanilla JS show/hide** — all tabs render server-side, JS toggles `hidden`. | **HTMX `hx-get`** — each tab is a separate server request, renders only the active tab. | A      | All 5 tabs are lightweight (no expensive queries). Rendering all server-side means instant tab switching with no network round-trip. HTMX tab loading would add 5 new route handlers and SSR overhead per tab. Vanilla JS is simpler and faster. |
| 5  | Modal implementation                    | **Server-rendered hidden modals** — HTML in the page, toggled by vanilla JS. | **HTMX-fetched modals** — modal content loaded on demand via `hx-get`. | A      | For the MVP, modal data is already in the page context (agent record, standard record). No benefit to lazy-loading. Server-rendered modals are simpler and work without JS (graceful degradation: modals simply render inline). HTMX modals can be a follow-up if data volumes grow. |

---

## 8. Test Plan

### 8.1 Visual Regression per Surface

Each of the 5 surfaces gets a Playwright snapshot test that:
1. Starts the portal server with stub data.
2. Navigates to the surface route.
3. Takes a full-page screenshot.
4. Compares against a baseline image with a pixel-diff threshold of 0.1%.

Test files:
```
plugins/autonomous-dev-portal/tests/visual/
├── dashboard.visual.test.ts
├── request-detail.visual.test.ts
├── costs.visual.test.ts
├── ops.visual.test.ts
└── settings.visual.test.ts
```

Each visual test runs in both light and dark themes (2 screenshots per surface = 10 baseline images).

### 8.2 Data Shape Compatibility Tests

Unit tests that verify the extended `RenderProps` types are backward-compatible:
- Existing stub loaders still compile and return valid data.
- New optional fields default to `undefined` without breaking view rendering.
- Views handle `undefined` optional fields by rendering empty states.

### 8.3 Component Integration Tests

For each surface, a Hono test-client integration test that:
1. Mounts the route handler with stub data.
2. Sends `GET` to the surface route.
3. Asserts the response contains expected CSS classes (`.kpi-strip`, `.repo-card`, `.pipeline`, etc.).
4. Asserts the response does NOT contain old CSS classes (`<dl>`, `.component.status-*`, etc.).

### 8.4 Empty State Tests

For each surface, a test variant that provides empty data arrays and verifies:
- No JavaScript errors in the rendered HTML.
- The `EmptyState` component text appears.
- No broken layout (grid/flex containers handle 0 children gracefully).

### 8.5 M-04 Screenshot Diff

The implementation PR includes:
- 5 "before" screenshots (captured from main branch before the PR).
- 5 "after" screenshots (captured from the PR branch with the redesign).
- Both light and dark theme variants.
- Screenshots stored in `docs/screenshots/redesign/` (gitignored in production, committed in the PR for reviewer reference).

### 8.6 Client-Side JS Tests

For the vanilla JS modules (`settings-tabs.js`, `form-validation.js`):
- Unit tests using jsdom or happy-dom that verify:
  - Tab switching toggles `hidden` attributes correctly.
  - Form validation shows/hides error messages for boundary inputs.
  - Modal open/close toggles `hidden` attribute.

---

## 9. Phased Rollout

The surfaces are implemented in a single PR but in a deliberate order within that PR's commit history. This ordering minimizes risk by starting with the simplest surfaces and building toward the most complex.

| Order | Surface         | Complexity | Rationale                                                                                                    |
|-------|-----------------|------------|--------------------------------------------------------------------------------------------------------------|
| 1     | Dashboard       | Low        | Validates primitive integration (Chip, Score, Card) and data shape extensions. Highest operator visibility.    |
| 2     | Costs           | Low-Medium | Pure read-only display. SVG chart is the only new rendering concern. No modals, no forms.                     |
| 3     | Ops             | Medium     | Introduces the plugin chain visualization and the dark-themed log tail. No forms.                             |
| 4     | Request Detail  | Medium-High| Conditional rendering (pipeline state, gate state, reviewer chain). Multiple modal types.                     |
| 5     | Settings        | High       | 5 tabs, 2 modal types, live form validation, vanilla JS for tabs + modals + validation. Most client-side JS.  |

**Commit sequence within the PR:**

1. `types(portal): extend RenderProps with kit data shapes` — type extensions, no template changes.
2. `stubs(portal): populate extended data shapes in stub loaders` — stub data, no template changes.
3. `feat(portal): add shared fragments (kpi-strip, empty-state, pipeline-vis, etc.)` — new fragment components.
4. `feat(portal): re-skin Dashboard view to match design kit` — dashboard view rewrite.
5. `feat(portal): re-skin Costs view to match design kit` — costs view rewrite.
6. `feat(portal): re-skin Ops view to match design kit` — ops view rewrite.
7. `feat(portal): re-skin Request Detail view to match design kit` — request detail view rewrite.
8. `feat(portal): re-skin Settings view to match design kit` — settings view rewrite + vanilla JS modules.
9. `test(portal): add visual regression and integration tests` — test suite.
10. `docs(portal): M-04 before/after screenshots` — screenshot pairs.

**Rollback strategy:**

If a surface causes issues post-merge, the view file can be reverted to the pre-redesign version independently. The route handler, data loader, and `RenderProps` extensions are backward-compatible — the old view simply ignores the new optional fields.

---

## 10. Open Issues

| ID     | Question                                                                                                                                          | Owner          | Status |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------|----------------|--------|
| OI-001 | The kit's `Standards.jsx` uses a lock emoji for immutable standards (`s.immutable ? ' 🔒' : ''`). PRD-018 R-10 forbids emoji. Replace with a `Dot` or text label `immutable`. | TDD-036 author | RESOLVED: use `<span class="chip muted sm">immutable</span>` text badge. |
| OI-002 | The Costs chart in the kit uses a linear gradient fill (`url(#costFill)`). Verify that Hono JSX supports inline `<defs>` and `<linearGradient>` in SVG. | Implementer    | OPEN   |
| OI-003 | The Settings General tab shows "Default pipeline variant" and "Default deploy backend" selects that populate from `data.variants` and `data.backends`. Today's `SettingsView` has no variant/backend data. Stub data must be extended. | Implementer    | OPEN (tracked in Section 5.3 type extensions) |
| OI-004 | The kit's `RequestDetail.jsx` uses `useState` for confirm modal state. The SSR port needs a vanilla JS equivalent. Confirm the confirm-modal pattern from TDD-035 primitives (if KillSwitch includes one) or implement a standalone `confirm-modal.js`. | Implementer    | OPEN   |
| OI-005 | The kit references `window.PortalData` — a single global data object. The SSR port passes data as props to each view component. Verify no kit component has an implicit dependency on sibling surface data not passed to its view. | Implementer    | RESOLVED: each surface receives only its own data slice via `RenderProps`. |

---

## 11. Risks

| ID   | Risk                                                                                          | Likelihood | Impact | Mitigation                                                                                                                                             |
|------|-----------------------------------------------------------------------------------------------|------------|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------|
| R-01 | **Empty-state handling.** The kit assumes populated data (`data.repos.length > 0`, `data.requests.length > 0`). A fresh install has no active requests, no repos, no cost history. Surfaces may show broken grids, NaN costs, or missing elements. | High | Medium | Every data-dependent section has an explicit `length === 0` branch with `EmptyState` component. Template tests include empty-data variants. |
| R-02 | **Primitive dependency.** TDD-036 surfaces cannot render without TDD-035 primitives (`Btn`, `Chip`, `Dot`, `Score`, `Card`). If TDD-035 ships late, TDD-036 is blocked. | Medium | High | Implementation branch is based on TDD-035 merge commit. TDD-036 can be authored and code-reviewed in parallel using mock primitive stubs. |
| R-03 | **SVG chart rendering in Hono JSX.** The costs chart requires inline SVG with `<defs>`, `<linearGradient>`, `<path>`, and computed attributes. Hono's JSX runtime may not support all SVG elements natively. | Low | Medium | Fallback: render the SVG as a raw HTML string via `dangerouslySetInnerHTML` wrapped in the sanitization pipeline. Validate in a spike before full implementation. |
| R-04 | **CSS specificity conflicts.** The kit's `app.css` uses flat class selectors (`.kpi-strip`, `.repo-card`). The existing portal CSS (`portal.css`) may have conflicting class names. | Medium | Low | Audit existing CSS for conflicts before implementation. The kit's class names are specific enough to be unlikely to collide. Any conflicts are resolved by adopting the kit's class name as authoritative. |
| R-05 | **Vanilla JS module loading.** Settings tabs, form validation, and modals require `<script type="module">` loading. The existing portal serves JS via static middleware. Verify the CSP allows `script-src 'self'` for module scripts. | Low | Low | Existing CSP (`FR-S32`) sets `script-src 'self'`; module scripts from `/static/js/` are same-origin. No CSP change needed. |
| R-06 | **Settings form regression.** The existing `SettingsEditor` (SPEC-015-2-02) has a working HTMX form submission flow with CSRF, field errors, and success messages. The tabbed redesign must preserve this flow for the General tab while adding non-form tabs. | Medium | High | The General tab embeds the existing `SettingsEditor` form within its tab panel. HTMX attributes, CSRF token, and field-error rendering are preserved as-is. New tabs (variants, standards, backends, agents) are read-only displays in v1. |

---

## 12. PRD Requirements Traceability Matrix

Every functional requirement from PRD-018 in this TDD's scope (R-16 through R-20, M-04) is mapped below.

| PRD-018 Req | Description                                                                                   | TDD-036 Section                          | Status    |
|-------------|-----------------------------------------------------------------------------------------------|------------------------------------------|-----------|
| R-16        | Dashboard matches `Dashboard.jsx` — KPI strip, repo cards grid, approval queue strip, standards drift. | Section 5.2 (Dashboard), Section 6.1      | Covered   |
| R-17        | Request Detail matches `RequestDetail.jsx` — artifact pane, timeline, gate panel, agent log, run history. | Section 5.2 (Request Detail), Section 6.2 | Covered   |
| R-18        | Costs matches `Costs.jsx` — cost ring, time series, per-phase breakdown table, projection.     | Section 5.2 (Costs), Section 6.3          | Covered   |
| R-19        | Ops matches `Ops.jsx` — daemon status, heartbeat history, circuit breaker, kill switch, recent log entries. | Section 5.2 (Ops), Section 6.4            | Covered   |
| R-20        | Settings matches `Settings.jsx` — trust levels, cost caps, allowlist, notifications, all with live form validation. | Section 5.2 (Settings), Section 6.5       | Covered   |
| M-04        | Before/after screenshot pairs for all surfaces ship with the implementation PR.                | Section 8.5, Section 9 (commit 10)        | Covered   |

---

## 13. Appendix: Kit Component to Primitive Mapping

This table maps every UI element in the kit's JSX files to the TDD-035 primitive it consumes. This ensures no primitive is used without being shipped by TDD-035.

| Kit element                          | Kit file          | TDD-035 Primitive   | Props used                                      |
|--------------------------------------|-------------------|---------------------|-------------------------------------------------|
| `<Btn>Refresh</Btn>`                | Dashboard.jsx:14  | `Btn`               | `kind="secondary"` (default)                     |
| `<Btn kind="primary">+ New request` | Dashboard.jsx:15  | `Btn`               | `kind="primary"`                                 |
| `<Chip kind="phase" value={...}>`   | Dashboard.jsx:58  | `Chip`              | `variant="phase"`, `tone=<phase>`                |
| `<Score n={r.score} />`             | Dashboard.jsx:99  | `Score`             | `value=<0..100>`                                 |
| `<Btn kind="danger">Kill</Btn>`     | RequestDetail.jsx:29 | `Btn`            | `kind="destructive"`                             |
| `<Btn size="sm">Cancel</Btn>`       | RequestDetail.jsx:182 | `Btn`           | `size="sm"`                                      |
| `<Chip kind="phase" value={...}>`   | Costs.jsx:60      | `Chip`              | `variant="phase"`, `tone=<phase>`                |
| `<Btn kind="danger">Killswitch`     | Ops.jsx:9         | `Btn`               | `kind="destructive"`                             |
| `<Btn kind="primary">Save</Btn>`    | Settings.jsx:19   | `Btn`               | `kind="primary"`                                 |
| `<Btn size="sm" kind="primary">`    | Settings.jsx:106  | `Btn`               | `size="sm"`, `kind="primary"`                    |

**Note:** The kit uses `kind="danger"` in some places; the TDD-035 primitive API uses `kind="destructive"`. The port normalizes to the primitive's API.
