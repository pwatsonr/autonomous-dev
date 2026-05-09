# PLAN-036-2: Costs + Ops Surface Re-skin

## Metadata
- **Parent TDD**: TDD-036-portal-redesign-surfaces (v1.1)
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Estimated effort**: 4 days (both surfaces)
- **Dependencies**: ["PLAN-035-2", "PLAN-035-3"]
- **Blocked by**: PLAN-035-2 (primitives), PLAN-035-3 (KillSwitch primitive used by Ops)
- **Priority**: P1
- **Stage**: Surface rollout order #2 (Costs) and #3 (Ops) per TDD-036 §9

## Objective

Re-skin the Costs (`GET /costs`) and Ops (`GET /ops`) surfaces in a single
plan, because both are read-mostly views with simple SSE update channels
and share infrastructure (`KpiStrip`, table-with-chip patterns, the Costs
SVG chart adjacent to Ops's plugin-chain visualization). Pairing them lets
one engineer carry the kit-fidelity context across both, and the visual
regression baseline images can be captured in a single Playwright run.

This plan covers PRD-018 R-18 (Costs: ring, time series, per-phase
breakdown, projection) and R-19 (Ops: daemon status, heartbeat history,
circuit breaker, kill switch, recent log entries) per TDD-036 §6.3 and §6.4.

Costs ships before Ops in the commit sequence (TDD-036 §9 order #2 and #3)
because Costs has no client-side JS (pure server-rendered SVG) and is the
lowest-risk surface to ship after Dashboard validates the primitive
integration pattern. Ops introduces the dark-themed log tail (theme-defying
container per TDD-036 §6.4) and the `KillSwitch` primitive in the page-head
actions, which are the Ops-specific risks.

## Scope

### In Scope

**Costs surface** (`templates/views/costs.tsx`):
- Page head with `Btn` (Export CSV, Set caps).
- KPI strip (4 cards): MTD spend, Reviewers spend, Deploys spend, Avg/request — sourced from `costs.totalMtd`, `costs.reviewerSpend.total`, `costs.deploySpend.total`, `costs.totalMtd / costs.requestCount`.
- Daily spend SVG chart (server-rendered inline SVG per PRD-009 FR-928 and TDD-036 §6.3): viewbox `0 0 760 200`, 5 horizontal grid lines, `--brand` line + area gradient, optional X/Y labels. New `fragments/cost-chart.tsx`.
- Phase spend table with bar cells: phase chip + 6px-tall `--brand` bar in `--bg-3` track + cost mono + percentage mono dim. New `fragments/phase-spend-table.tsx`.
- Reviewer spend table: name + role chip + runs + fpRate + cost.
- Deploy backend spend table: env + backend chip + deploys + lastDeploy + health chip + cost.
- Empty states per TDD-036 §6.3 ("No cost data yet", "No phase data", "No reviewer data").

**Ops surface** (`templates/views/ops.tsx`):
- Page head with `Btn` (Refresh) + `KillSwitch` primitive (engaged-aware).
- Health KPI strip with `Dot({ live: true })` indicator on daemon status (R-15 / R-15 live-dot replaces spinners).
- Plugin chain visualization (5 columns: CORE, REVIEWERS, VARIANTS, DEPLOY, ORG with arrow separators). New `fragments/plugin-chain.tsx`.
- Live log tail in dark container (`background: #14130f` regardless of theme per TDD-036 §6.4): per-line level coloring (INFO/WARN/ERR/marker/timestamp), `max-height: 320px; overflow: auto`, scrolls to bottom on SSE updates. Includes agent dispatch entries (per TDD-036 §6.4: "agent prd-author@1.0.0 dispatched"). New `fragments/live-log.tsx`.
- Deploy events table: time + backend chip + env + status chip.
- MCP servers table: name + status chip + latency.
- Recent standards changes event list.
- Empty states per TDD-036 §6.4 (daemon-not-running shows "stopped" in `--err`, "Daemon offline" in log).

**Shared work across both**:
- Reuse `fragments/kpi-strip.tsx` from PLAN-036-1 (no new copy).
- Reuse `fragments/empty-state.tsx` from PLAN-036-1.
- Extend `types/render.ts` with the Costs/Ops shapes from TDD-036 §5.3: `PhaseSpend`, `ReviewerSpend`, `DeploySpend`, `CostSeries` extensions, `OpsHealth` extensions (`mcpServers`, `pluginChain`, `recentLog`, `deployEvents`, `standardsChanges`, `standardsCount`, `immutableCount`).
- Extend `stubs/costs.ts` and `stubs/ops.ts` to populate the new fields with kit-faithful representative data.
- Wire SSE channels: `costs:kpis`, `ops:health`, `ops:log`, `ops:deploys`, `ops:mcp` per TDD-036 §5.2 mapping tables.
- Visual regression tests for both surfaces (light + dark): `tests/visual/{costs,ops}.visual.test.ts`.
- Integration tests for both: `tests/integration/{costs,ops}.test.ts`.
- M-04 before/after screenshot pairs for both surfaces.

### Out of Scope
- `KillSwitch` primitive implementation — TDD-035 / PLAN-035-3.
- KPI-strip and empty-state fragments — landed in PLAN-036-1.
- Dashboard, Request Detail, Settings — sister plans.
- Charting library / clientside JS chart — not used; SVG is server-rendered.
- New cost/ops data plumbing — daemon already exposes the underlying state files; new optional fields are populated by stub loaders pending real wiring.

## Tasks

1. **Extend `types/render.ts`** with Costs/Ops shapes from TDD-036 §5.3. Add `PhaseSpend`, `ReviewerSpend`, `DeploySpend`, extend `CostSeries` with `phaseSpend?`, `reviewerSpend?`, `deploySpend?`, `totalMtd?`, `requestCount?`. Extend `OpsHealth` with the 6 new optional fields.
   - Files: `plugins/autonomous-dev-portal/server/types/render.ts`.
   - Acceptance: `bun tsc --noEmit` passes; existing surfaces still compile.
   - Effort: 0.25 day.

2. **Populate `stubs/costs.ts`** with `phaseSpend` (8 phases), `reviewerSpend` (mix of generic/specialist roles, 5-8 entries), `deploySpend` (3 envs across 2 backends), `totalMtd`, `requestCount`. Numbers should be operator-realistic.
   - Files: `plugins/autonomous-dev-portal/server/stubs/costs.ts`.
   - Acceptance: Stub renders the kit's full visual; tables have ≥3 rows each so empty-cell logic is exercised.
   - Effort: 0.25 day.

3. **Populate `stubs/ops.ts`** with `mcpServers` (3 entries), `pluginChain` (5 categories with 2-4 packages each, including `core` and `org` highlights), `recentLog` (10-15 mixed-level entries including agent-dispatch lines), `deployEvents` (5 entries), `standardsChanges` (3 entries).
   - Files: `plugins/autonomous-dev-portal/server/stubs/ops.ts`.
   - Acceptance: Live log shows mixed INFO/WARN/ERR/marker lines and at least 2 agent-dispatch entries to validate marker styling.
   - Effort: 0.25 day.

4. **Implement `fragments/cost-chart.tsx`.** Server-rendered inline SVG. Pure function: takes `points: CostPoint[]` and `budgetUsd`, returns SVG element. 5 horizontal grid lines, area gradient `url(#cost-grad)`, line stroke `--brand`. Empty case: `<text>No cost data yet</text>` centered.
   - Files: `plugins/autonomous-dev-portal/server/templates/fragments/cost-chart.tsx`.
   - Acceptance: Snapshot test for 30-point series, 1-point series, 0-point empty case. SVG is well-formed and viewBox is `0 0 760 200`.
   - Effort: 0.5 day.

5. **Implement `fragments/phase-spend-table.tsx`.** Renders `<table class="tbl tight">` with 4 cols (phase chip, bar cell, cost, pct). Bar is `<div class="bar"><div class="bar-fill" style="width:{pct}%"></div></div>` consuming `--brand`/`--bg-3`. Empty case: single row "No phase data".
   - Files: `plugins/autonomous-dev-portal/server/templates/fragments/phase-spend-table.tsx`.
   - Acceptance: Renders 8 phases when populated; bar widths sum to 100% when `pct` field accurate.
   - Effort: 0.25 day.

6. **Rewrite `templates/views/costs.tsx`** to compose the 6 regions per TDD-036 §6.3 template structure (page head, KPI strip, chart, 2-col cost grid with phase + reviewer tables, deploy backend table). Wire `costs:kpis` SSE channel `id` attributes for OOB swaps.
   - Files: `plugins/autonomous-dev-portal/server/templates/views/costs.tsx`, `server/routes/costs.ts`.
   - Acceptance: Visual snapshot light/dark passes; integration test asserts new CSS classes present.
   - Effort: 0.5 day.

7. **Implement `fragments/plugin-chain.tsx`.** 5 columns (CORE, REVIEWERS, VARIANTS, DEPLOY, ORG) with arrow separator `›` between, header in mono uppercase, package pills below. Highlight `core` packages with `--brand-tint/line`, `org` with `--info-tint/line`.
   - Files: `plugins/autonomous-dev-portal/server/templates/fragments/plugin-chain.tsx`.
   - Acceptance: Renders 5 columns + 4 arrow separators; missing category renders empty stack (no broken layout).
   - Effort: 0.25 day.

8. **Implement `fragments/live-log.tsx`.** Dark container regardless of theme (`background: #14130f` literal — exception to no-hex rule, documented inline as theme-defying log-block per kit). Per-line level coloring via `<span>` wrappers. SSE OOB swap appends to `<div id="log-tail">` and CSS scrolls to bottom via `scroll-behavior: smooth`.
   - Files: `plugins/autonomous-dev-portal/server/templates/fragments/live-log.tsx`.
   - Acceptance: Renders 10+ lines without overflow misbehavior; INFO/WARN/ERR each get correct color tokens; agent-dispatch lines bold + `--brand`. Document the `#14130f` exception in fragment header comment for the no-hex CI lint to whitelist.
   - Effort: 0.5 day.

9. **Rewrite `templates/views/ops.tsx`** to compose the 7 regions per TDD-036 §6.4 (page head with `KillSwitch`, health KPI strip with `Dot live`, plugin chain, ops-grid with live log + deploy events, ops-grid with MCP table + standards changes). Wire `ops:health`, `ops:log`, `ops:deploys`, `ops:mcp` SSE channel `id` attributes.
   - Files: `plugins/autonomous-dev-portal/server/templates/views/ops.tsx`, `server/routes/ops.ts`.
   - Acceptance: Visual snapshot light/dark passes; KillSwitch renders in correct armed/engaged state per stub.
   - Effort: 0.5 day.

10. **Daemon-down handling on Ops.** When `health.daemon.status !== 'running'`, KPI shows "stopped" in `--err`; live log shows "Daemon offline" muted. Per TDD-036 §6.4 empty-state list.
    - Files: `plugins/autonomous-dev-portal/server/templates/views/ops.tsx`.
    - Acceptance: Empty-state test variant feeds `daemon: { status: 'stopped' }`, asserts both behaviors render.
    - Effort: 0.25 day.

11. **Capture M-04 before/after screenshots** for both surfaces (light + dark, 8 PNGs total).
    - Files: `plugins/autonomous-dev-portal/docs/screenshots/redesign/{costs,ops}-{before,after}-{light,dark}.png`.
    - Acceptance: PR includes all 8 PNGs; reviewer can eyeball-compare.
    - Effort: 0.25 day.

## Verification

- `bun test plugins/autonomous-dev-portal/tests/integration/costs.test.ts` — asserts `.kpi-strip`, `.chart-card`, phase/reviewer/deploy `.tbl` classes; old `<h1>Cost</h1> + single chart` markup absent.
- `bun test plugins/autonomous-dev-portal/tests/integration/ops.test.ts` — asserts `.plugin-chain`, `.log`, `.kill-switch`, deploy/mcp `.tbl` classes; old `<dl>` markup absent.
- `bun playwright test plugins/autonomous-dev-portal/tests/visual/{costs,ops}.visual.test.ts` — light + dark, 0.1% pixel-diff threshold.
- Empty-state variants pass for both surfaces.
- SSE smoke tests fire one event per channel and confirm correct fragment swap.
- M-04 deliverable: 8 screenshots committed to `docs/screenshots/redesign/`.
- Manual sanity: `bun run dev`, visit `/costs` and `/ops`, eye-compare against `autonomous-dev-design-system/project/screenshots/Costs*.png` and `Ops*.png`.
- Daemon-down on Ops: `/ops` with stopped daemon stub renders without JS errors and shows error/muted text.

## Test Plan

- **Visual regression** per TDD-036 §8.1 — both surfaces, both themes.
- **Component integration** per TDD-036 §8.3.
- **Empty state** per TDD-036 §8.4 — zero cost/ops data feeds.
- **Data shape compatibility** per TDD-036 §8.2.
- **SVG chart unit tests**: 30-point, 1-point, 0-point edge cases.
- **Live-log SSE append**: simulated `ops:log` event appends a line and scrolls to bottom.

## Rollback

Per TDD-036 §9, revert the 2 view files (`costs.tsx`, `ops.tsx`) plus the new fragments (`cost-chart.tsx`, `phase-spend-table.tsx`, `plugin-chain.tsx`, `live-log.tsx`) in a single commit. `RenderProps` extensions are backward-compatible. Costs and Ops can be reverted independently of each other if only one surface regresses.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Inline SVG chart hard to maintain (5 grid lines + gradient + path); designers evolve the chart in the kit | Medium | Low — pinned to kit v1 | Keep `cost-chart.tsx` self-contained; document the viewBox + token mapping in fragment header. Fall-back: extract chart to a lightweight server-side helper if it grows beyond ~150 lines. |
| Live-log dark container `#14130f` literal trips no-hex CI lint | High (lint will catch) | Low | Add explicit lint-whitelist comment in `live-log.tsx` referencing this plan + TDD-036 §6.4 rationale. Alternative: introduce `--log-bg` token in `colors_and_type.css` (cheaper if TDD-034 hasn't shipped lints yet). |
| `KillSwitch` armed/engaged state mismatch between Ops view and TDD-035 primitive contract | Medium | Medium | Pin to PLAN-035-3 merge commit; require KillSwitch primitive PR landed before this PR opens. R-08 / R-13 prop surface is binding. |
| Plugin-chain visualization breaks when a category is empty (e.g., no `org` packages) | Low | Low | `plugin-chain.tsx` renders the column header even when `packages: []`; integration test feeds empty `org`. |
| SSE OOB swap to `#log-tail` causes accumulated DOM growth (log lines never trimmed) | Medium | Low — long-running portal sessions slow down | Trim `<div id="log-tail">` to last 200 entries server-side before each SSE emit; document in route handler. |
| Costs phase-spend bar percentages don't sum to 100 due to rounding | Low | Low | Cast `pct` to fixed 1-decimal in the stub computation; note the 0.1% rounding tolerance in the integration test. |
| Empty Ops surface (zero MCP, zero deploys, zero standards changes) reads as "everything broken" not "everything quiet" | Low | Low — UX papercut | Each empty-state text is calm-toned ("No deploy events in last 24h", "No MCP servers connected"). Daemon status is the only error-tinted KPI. |
