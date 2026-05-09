# PLAN-036-1: Dashboard Surface Re-skin

## Metadata
- **Parent TDD**: TDD-036-portal-redesign-surfaces (v1.1)
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Estimated effort**: 4 days
- **Dependencies**: ["PLAN-035-1", "PLAN-035-2"]
- **Blocked by**: PLAN-035-1 (shell), PLAN-035-2 (primitives)
- **Priority**: P0 (highest visibility surface; first surface to flip per TDD-036 §9; validates primitive integration pattern for the rest of the rollout)
- **Stage**: Surface rollout order #1 per TDD-036 §9

## Objective

Re-skin the Dashboard surface (`GET /`) to match `Dashboard.jsx` from
`autonomous-dev-design-system/project/ui_kits/portal/`, consuming the
primitives (`Chip`, `Card`, `Score`, `Btn`) and shell (left rail, page head)
delivered by TDD-035. This plan covers PRD-018 R-16 in full, including the
v1.1 additions (approval queue strip and standards drift summary) and the
existing four regions from v1.0 (page head, KPI strip, repo card grid with
4px phase-colored left bars, active requests table).

The Dashboard ships first because it is the operator's primary at-a-glance
view, exercises every primitive (`Chip` for phase/variant/gate-type,
`Card` for repo cards with left bars, `Score` for the active requests
table), and validates the data-shape extensions (`DashboardData`,
`DashboardRequest`, `StandardsDriftEntry`) that the remaining surfaces
will inherit. If the primitive integration is wrong, the Dashboard will
catch it before Costs/Ops/Request-Detail/Settings inherit the bug.

## Scope

### In Scope
- Rewrite `plugins/autonomous-dev-portal/server/templates/views/dashboard.tsx` to render the six v1.1 regions per TDD-036 §6.1:
  1. **Page head** — `<h1>Dashboard</h1>` + `head-actions` group with Refresh and `+ New request` (`Btn`).
  2. **KPI strip** — 4 cards (Active requests / Awaiting approval / MTD spend / Standards rules) via the new `fragments/kpi-strip.tsx` (R-16 region 2).
  3. **Repo card grid** — `repos.map(r => <RepoCard {...r} />)` with the 4px phase-colored left bar via the existing `fragments/repo-card.tsx` (updated to consume `Card` primitive with `leftBar` prop).
  4. **Approval queue strip** (v1.1) — new `fragments/approval-queue.tsx`, top 3 gates by `waitedMin` desc, with phase chip + repo + ID + gate-type chip (warn/err/info tone) + age + Review `Btn`.
  5. **Standards drift summary** (v1.1) — new `fragments/standards-drift.tsx`, portfolio-wide table of repos with hits + max severity chip; falls back to `EmptyState` when `drift.length === 0`.
  6. **Active requests table** — inline table with phase `Chip`, `Score`, repo + title + cost + turns; falls back to `EmptyState` when empty.
- Add `fragments/kpi-strip.tsx` (reusable across Dashboard/Costs/Ops).
- Add `fragments/approval-queue.tsx` per TDD-036 §6.1 (full kit-faithful HTML).
- Add `fragments/standards-drift.tsx` per TDD-036 §6.1.
- Add `fragments/empty-state.tsx` (reusable across all surfaces).
- Update `fragments/repo-card.tsx` to consume `Card` + `Chip` primitives, render 6 layout regions per TDD-036 §6.1 RepoCard description (top row, path row, meta rows 1-2, footer, 4px left bar in `--phase-<active>` or `--warn` when `attn === true`).
- Extend `types/render.ts` with the Dashboard-relevant shapes from TDD-036 §5.3: `RepoSummary` (add `trust`, `phase`, `variant`, `backend`, `stack`, `gateCount`), `DashboardData`, `DashboardRequest`, `StandardsHit`, `StandardsDriftEntry`, `StandardRule`, `PipelineVariant`.
- Extend `stubs/repos.ts` and `stubs/requests.ts` to populate the new fields with representative data.
- Server-side compute `standardsDrift` in the Dashboard route handler from `data.standards` and `data.requests` per TDD-036 §6.1 ("Server-side population: route handler iterates over `standards` and for each rule with `hits > 0`, groups by repo using the `applies` predicate. Result is sorted by `hitCount` descending").
- Wire HTMX SSE channels: `dashboard:kpis`, `dashboard:repos`, `dashboard:gates`, `dashboard:standards`, `dashboard:requests` (route handler emits, fragments expose `id` attributes for `hx-swap-oob`).
- Empty states for all 5 regions per TDD-036 §6.1 ("Empty states" subsection).
- Visual regression test: `tests/visual/dashboard.visual.test.ts` (Playwright snapshot, light + dark themes, threshold 0.1%).
- Integration test: `tests/integration/dashboard.test.ts` (Hono test-client; assert `.kpi-strip`, `.repo-card`, `.approval-queue`, `.standards-drift`, `.tbl` classes present; assert old `<dl>` markup absent).
- Empty-state test variant feeding `repos: []`, `requests: []`, `standards: []` and asserting `EmptyState` text appears for each region.
- M-04 before/after screenshot pair for the Dashboard (light + dark) into `docs/screenshots/redesign/dashboard-{before,after}-{light,dark}.png`.

### Out of Scope
- Primitives implementation — TDD-035 / PLAN-035-2.
- Layout shell, brand wordmark, left rail nav — TDD-035 / PLAN-035-1.
- Design tokens / theme switcher — TDD-034.
- Other surfaces (Costs, Ops, Request Detail, Settings) — sister plans PLAN-036-2/3/4.
- New data plumbing — Dashboard reads existing daemon state files; new optional fields are populated by stub loaders (NG-3606).
- Voice/copy sweep beyond the Dashboard view's strings (TDD-034 / NG-3604).

## Tasks

1. **Extend `types/render.ts` with Dashboard data shapes.** Add the seven types listed in scope from TDD-036 §5.3. Mark every new field optional for backward compat. Verify existing stub loaders still typecheck.
   - Files: `plugins/autonomous-dev-portal/server/types/render.ts`.
   - Acceptance: `bun tsc --noEmit` passes; existing surfaces compile unchanged.
   - Effort: 0.5 day.

2. **Populate stub loaders.** Extend `stubs/repos.ts` to include `trust`, `phase`, `variant`, `backend`, `stack`, `gateCount`. Extend `stubs/requests.ts` to include `variant`, `gateType`, `stack`, `variantLabel`, `waitedMin`. Add `stubs/standards.ts` if absent.
   - Files: `plugins/autonomous-dev-portal/server/stubs/{repos,requests,standards}.ts`.
   - Acceptance: Stub data renders the kit's full visual without TypeScript errors. Existing tests using these stubs still pass.
   - Effort: 0.5 day.

3. **Implement `fragments/kpi-strip.tsx`, `fragments/empty-state.tsx`.** Pure presentational components. `KpiStrip` accepts `items: { label, value, sub }[]` and renders the kit's `.kpi-strip` markup. `EmptyState` accepts `noun: string` and renders `<p class="muted">No {noun}</p>`.
   - Files: `plugins/autonomous-dev-portal/server/templates/fragments/{kpi-strip,empty-state}.tsx`.
   - Acceptance: Snapshot tests cover happy + zero-value cases. No primitive imports needed (they are layout-only).
   - Effort: 0.5 day.

4. **Update `fragments/repo-card.tsx` to kit-faithful 6-region layout.** Consume `Card({ leftBar })` and `Chip({ variant: 'phase' | 'status' })` from `server/components/primitives.tsx`. Implement attn-warn case (left bar `--warn`, outer `--warn-line` shadow).
   - Files: `plugins/autonomous-dev-portal/server/templates/fragments/repo-card.tsx`.
   - Acceptance: Renders all 6 regions per TDD-036 §6.1; integration test asserts left-bar color matches `--phase-<phase>` for active phase and `--warn` for `attn === true`.
   - Effort: 0.5 day.

5. **Implement `fragments/approval-queue.tsx`.** Per TDD-036 §6.1 markup verbatim. Sort by `waitedMin` desc, slice 3. Gate type tone mapping: `reviewer-chain` → warn, `standards-violation` → err, `cost-cap` → info. Renders nothing when `gates.length === 0`.
   - Files: `plugins/autonomous-dev-portal/server/templates/fragments/approval-queue.tsx`.
   - Acceptance: Integration test feeds 5 gates, asserts only 3 rendered (longest-wait first); feeds 0 gates, asserts entire `.approval-queue` section is absent.
   - Effort: 0.5 day.

6. **Implement `fragments/standards-drift.tsx`.** Per TDD-036 §6.1 markup verbatim. Render table when `drift.length > 0`, else `EmptyState noun="blocking hits"`. Severity tone mapping: `blocking` → err, `warn` → warn, `advisory` → info.
   - Files: `plugins/autonomous-dev-portal/server/templates/fragments/standards-drift.tsx`.
   - Acceptance: Integration test asserts table rows match drift array; empty case shows `EmptyState`.
   - Effort: 0.25 day.

7. **Rewrite `templates/views/dashboard.tsx` to compose the 6 regions.** Use the simplified JSX template from TDD-036 §6.1 as the canonical structure. Compute totals server-side (`totalActive`, `totalGates`, `totalMtd`, `gateBreakdownText`, `blockingHits`, `totalBlockingHits`).
   - Files: `plugins/autonomous-dev-portal/server/templates/views/dashboard.tsx`.
   - Acceptance: Page-head, KPI strip, repo grid, approval queue, standards drift, active requests table all render in correct order. Light/dark visual snapshots pass.
   - Effort: 0.75 day.

8. **Wire HTMX SSE OOB swap channels.** Add `id` attributes to the 5 swappable regions (`kpi-strip`, `repo-grid`, `approval-queue`, `standards-drift`, `requests-tbl`). Update the route handler in `server/routes/dashboard.ts` to emit named SSE events.
   - Files: `plugins/autonomous-dev-portal/server/routes/dashboard.ts`, `templates/views/dashboard.tsx`.
   - Acceptance: SSE smoke test fires a `dashboard:repos` event and asserts the `repo-grid` HTML is replaced; existing SSE behaviors regress-tested.
   - Effort: 0.25 day.

9. **Server-side compute `standardsDrift` in dashboard route.** Iterate `standards`, group by repo via `applies` predicate, sort `hitCount` desc. Pass into render props.
   - Files: `plugins/autonomous-dev-portal/server/routes/dashboard.ts`.
   - Acceptance: Unit test for the aggregation function with three input cases (empty, single-repo, multi-repo with mixed severity).
   - Effort: 0.25 day.

## Verification

- `bun test plugins/autonomous-dev-portal/tests/integration/dashboard.test.ts` passes; asserts `.kpi-strip`, `.repo-card`, `.approval-queue`, `.standards-drift`, `.tbl` classes present and old `<dl>` absent.
- `bun playwright test plugins/autonomous-dev-portal/tests/visual/dashboard.visual.test.ts` passes for light + dark theme snapshots (10 baseline images for Dashboard alone if we count states, but minimum 2: light populated + dark populated).
- Empty-state test variant passes (zero data → `EmptyState` text appears for each of the 5 region types).
- Existing Dashboard route smoke tests still pass (no SSE regressions).
- M-04 deliverable: 4 screenshots committed to `docs/screenshots/redesign/dashboard-*` (before-light, before-dark, after-light, after-dark).
- Manual sanity check: `bun run dev` from `plugins/autonomous-dev-portal/`, visit `http://localhost:8788/`, confirm visual match against `autonomous-dev-design-system/project/screenshots/Dashboard*.png`.

## Test Plan

- **Visual regression**: Playwright snapshot per TDD-036 §8.1 (light + dark), 0.1% pixel-diff threshold.
- **Component integration**: Hono test-client per TDD-036 §8.3 — assert presence of new CSS classes, absence of old.
- **Empty state**: Per TDD-036 §8.4 — feed empty arrays, assert `EmptyState` rendered, no JS errors, no broken layout.
- **Data shape compatibility**: Per TDD-036 §8.2 — existing stubs compile, new optional fields default `undefined` without breaking views.
- **Standards-drift aggregation unit test**: covers empty, single-repo, multi-repo cases.
- **SSE OOB swap smoke**: simulate one event per channel, confirm correct fragment swaps.

## Rollback

Revert the dashboard view + new fragments in a single commit (per TDD-036 §9 "Rollback strategy"). The `RenderProps` extensions are backward-compatible; reverting the view file alone restores the prior unstyled Dashboard. Stubs and types can stay extended without impact (other surfaces will use them). No data migration is needed.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Primitive API drift between TDD-035 and TDD-036 (Chip/Card prop names change late) | Medium | Medium — Dashboard re-skin breaks until aligned | Pin to PLAN-035-2 merge commit; require primitives PR landed before this PR opens. R-08 prop surface is binding from PRD-018. |
| Standards-drift aggregation diverges from the kit's visual expectation (the kit has hand-coded data; we compute server-side) | Medium | Low — fixable in fragment | Eyeball-compare against `Dashboard.jsx` lines 95-130 during implementation; visual regression catches drift. |
| `attn`-state warn shadow conflicts with hairline-elevation rule (R-15a forbids untokened box-shadow) | Low | Low | Use `--warn-line` token (already in `colors_and_type.css`). CI lint enforces. |
| SSE OOB swap loses scroll position on table refresh | Medium | Low — UX papercut | Only swap `<tbody>` not full `<table>`; preserve `<thead>` and outer `<table>` element. |
| Empty repo array yields a 100%-empty Dashboard (every region empty) — operator confusion | Low | Low | Each `EmptyState` has clear noun-text; KPI strip still renders with `0` values; page never blank. |
| Stub data drift between this plan and PLAN-036-2/3/4 — sister surfaces expect different fields | Medium | Medium | Stubs land in this plan once; sisters consume unchanged. PLAN-036-2/3/4 may extend (additive only). |
