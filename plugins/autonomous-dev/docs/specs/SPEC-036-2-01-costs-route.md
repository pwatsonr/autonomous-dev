# SPEC-036-2-01: Costs Route — `GET /costs`

## Metadata
- **Parent Plan**: PLAN-036-2-costs-and-ops
- **Parent TDD**: TDD-036-portal-redesign-surfaces (§6.3)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-18)
- **Tasks Covered**: PLAN-036-2 Tasks 1, 2, 6
- **Dependencies**: PLAN-035-2 (primitives — `Btn`, `Chip`, `CostRing`, `Card`), PLAN-036-1 (`fragments/kpi-strip.tsx`, `fragments/empty-state.tsx`), SPEC-036-2-02 (cost time-series SVG), SPEC-036-2-03 (projection)
- **Estimated effort**: 0.75 day
- **Status**: Draft
- **Date**: 2026-05-09

## 1. Summary

Implement the Costs surface route handler and view template at
`server/routes/costs.tsx` and `server/templates/views/costs.tsx`. The
route renders the page-head, KPI strip, daily-spend SVG chart, two-column
phase-spend + reviewer-spend grid, and the deploy-backend table. Costs
ships before Ops in the rollout sequence (TDD-036 §9 order #2) because
it has no client-side JS — pure server-rendered SVG plus SSE OOB swaps.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                           | Task |
|-------|---------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | Route `GET /costs` MUST be registered in the portal router and respond with `200 text/html` for an authenticated operator.            | T6   |
| FR-2  | The view MUST render a `page-head` with `<h1>Costs</h1>` and two `Btn` actions: `Export CSV`, `Set caps`.                              | T6   |
| FR-3  | Below the page-head the view MUST render a 4-card KPI strip via `fragments/kpi-strip.tsx`: MTD spend, Reviewers spend, Deploys spend, Avg/request. | T6   |
| FR-4  | The view MUST render the SVG line chart via `fragments/cost-chart.tsx` (SPEC-036-2-02) for `costs.series` (30 daily points).          | T6   |
| FR-5  | A 2-col grid below the chart MUST render the phase-spend table (left, via `fragments/phase-spend-table.tsx`) and reviewer-spend table (right). | T6   |
| FR-6  | A full-width deploy-backend spend table MUST render below the 2-col grid: env + backend chip + deploys + lastDeploy + health chip + cost columns. | T6   |
| FR-7  | The view MUST emit SSE OOB target `id` attributes for the `costs:kpis` channel on each KPI card; SSE updates replace card values without full page reload. | T6   |
| FR-8  | When `costs.series` is empty, the chart fragment MUST render the empty state ("No cost data yet"); when `phaseSpend`, `reviewerSpend`, or `deploySpend` are empty, each table MUST render its empty-state row from `fragments/empty-state.tsx`. | T6   |
| FR-9  | `types/render.ts` MUST be extended with `PhaseSpend`, `ReviewerSpend`, `DeploySpend`, and `CostSeries` extensions (`phaseSpend?`, `reviewerSpend?`, `deploySpend?`, `totalMtd?`, `requestCount?`) per TDD-036 §5.3.                                  | T1   |
| FR-10 | `stubs/costs.ts` MUST be populated with operator-realistic data: 8 phases, 5–8 reviewers (mix of generic + specialist), 3 envs across 2 backends, 30 daily points. | T2   |

## 3. Acceptance Criteria

```
Given an authenticated operator
When GET /costs is requested
Then the response status is 200
And the body contains <h1>Costs</h1>
And contains class names .kpi-strip, .chart-card, .tbl
And contains data-sse="costs:kpis" attributes on the KPI strip
And the legacy <h1>Cost</h1>+<dl> markup is absent
```

```
Given a costs feed with series=[], phaseSpend=[], reviewerSpend=[], deploySpend=[]
When GET /costs is requested
Then the chart renders <text>No cost data yet</text>
And each table renders its empty-state row exactly once
And the page returns 200 (no JS errors in HAR)
```

## 4. Implementation Notes

- New file: `server/routes/costs.tsx`. Use Hono's `app.get('/costs', handler)`.
- Rewrite `server/templates/views/costs.tsx` to compose: page-head → KPI strip → chart → 2-col grid → deploy table.
- Compute `costs.totalMtd / costs.requestCount` in the route handler when `Avg/request` KPI is computed, guarding against zero denominators.
- The route reads from `stubs/costs.ts` until real plumbing lands (out of scope per PLAN-036-2 §Out of Scope).
- Per PRD-018 R-22, all numerics in tables render via `mono` class; costs render to 2 decimals always.

## 5. Tests

- **Integration**: `tests/integration/costs.test.ts` — assert `.kpi-strip`, `.chart-card`, `.tbl` classes present; legacy `<h1>Cost</h1>` markup absent; SSE id attributes present.
- **Empty-state**: feed empty arrays for each region; assert empty-state rows rendered.
- **Visual regression**: `tests/visual/costs.visual.test.ts` light + dark, 0.1% pixel-diff.

## 6. Verification

- `bun test plugins/autonomous-dev-portal/tests/integration/costs.test.ts` passes.
- `bun playwright test plugins/autonomous-dev-portal/tests/visual/costs.visual.test.ts` passes light + dark.
- Manual: `bun run dev`, visit `/costs`, eye-compare against `autonomous-dev-design-system/project/screenshots/Costs*.png`.
- M-04 deliverable: 2 screenshots committed (`costs-after-{light,dark}.png`).
