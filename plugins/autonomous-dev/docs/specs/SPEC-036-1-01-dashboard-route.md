# SPEC-036-1-01: Dashboard Route Handler — `GET /` SSR + SSE Composition

## Metadata
- **Parent Plan**: PLAN-036-1 (Dashboard Surface Re-skin)
- **Parent TDD**: TDD-036, §6.1 (Dashboard) and §6.6 (Sequence: Dashboard Load)
- **Parent PRD**: PRD-018, R-16
- **Tasks Covered**: PLAN-036-1 Tasks 7, 8, 9 (rewrite view, wire SSE OOB channels, server-side `standardsDrift` aggregation)
- **Estimated effort**: 1.0 day
- **Dependencies**: PLAN-035-1 (shell, layout primitives), PLAN-035-2 (`Btn`, `Chip`, `Card`, `Score` primitives — esp. SPEC-035-2-05 `Card`), SPEC-036-1-02..06 (the fragments this route composes), SPEC-036-1-06 (`DashboardData` type extensions and `variantLabel` server-resolved field).
- **Priority**: P0 (first surface to flip per TDD-036 §9; gates the rest of the rollout).
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Rewrite the Dashboard route handler at `plugins/autonomous-dev-portal/server/routes/dashboard.ts` and the view at `plugins/autonomous-dev-portal/server/templates/views/dashboard.tsx` to render the six v1.1 regions per TDD-036 §6.1 in fixed order (page head → KPI strip → repo card grid → approval queue strip → standards drift → active requests table). The route is SSE-driven: it computes server-side aggregates (`totalActive`, `totalGates`, `totalMtd`, `gateBreakdownText`, `blockingHits`, `totalBlockingHits`, `standardsDrift`) and exposes named SSE channels (`dashboard:kpis`, `dashboard:repos`, `dashboard:gates`, `dashboard:standards`, `dashboard:requests`) for HTMX `hx-swap-oob` updates.

## Acceptance Criteria

1. **Region order is fixed** per TDD-036 §6.1: page head, `KpiStrip`, repos `<section>`, `ApprovalQueueStrip`, `StandardsDriftSummary`, active requests `<section>`. Integration test asserts DOM order via class selectors.
2. **Page head** renders `<h1>Dashboard</h1>` and a `head-actions` group with two `Btn`s: `Refresh` (default kind) and `+ New request` (`kind="primary"`). Per PRD-018 R-06.
3. **Server-side aggregates** computed in the route handler before render:
   - `totalActive = repos.reduce((s, r) => s + r.activeRequests, 0)`
   - `totalGates = requests.filter(r => r.status === 'gate').length`
   - `totalMtd = repos.reduce((s, r) => s + r.monthlyCostUsd, 0)`
   - `gateBreakdownText = "{N} reviewer / {N} standards / {N} cost"` from `gateType` partition
   - `blockingHits = standards.filter(s => s.severity === 'blocking').reduce((s, r) => s + r.hits, 0)`
   - `standardsDrift` per Acceptance #4
4. **`standardsDrift` aggregation** per TDD-036 §6.1 ("Server-side population"): iterate `standards` rules where `hits > 0`, group by repo using the rule's `applies` predicate against each repo, output `StandardsDriftEntry[]` sorted by `hitCount` descending. Empty input → empty array (never `undefined`). Unit test covers empty / single-repo / multi-repo with mixed severity.
5. **HTMX SSE OOB swap**: each of the five swappable regions carries an `id` attribute (`kpi-strip`, `repo-grid`, `approval-queue`, `standards-drift`, `requests-tbl`). The route emits named SSE events with the same fragment HTML; `hx-swap-oob="true"` on the fragment root performs surgical replacement.
6. **Empty-data path**: when `repos`, `requests`, `standards` are all empty, the page still renders without JS errors; KPI strip shows zeros; each region delegates to its own empty state per SPEC-036-1-06.
7. **Old markup absent**: integration test asserts no `<dl>` element appears anywhere in the rendered HTML (was the v1.0 Dashboard's primary container).

## Implementation

**File**: `plugins/autonomous-dev-portal/server/routes/dashboard.ts`

```ts
export const dashboardRoute = (app: Hono) => {
    app.get("/", async (c) => {
        const data = await loadDashboardData(); // existing stub loader; SPEC-036-1-06 extends shape
        const aggregates = computeAggregates(data);
        const standardsDrift = computeStandardsDrift(data.standards ?? [], data.repos);
        return c.html(renderDashboard({ ...data, ...aggregates, standardsDrift }));
    });

    app.get("/sse/dashboard", (c) => streamSSE(c, async (stream) => {
        // emit named events: dashboard:kpis, dashboard:repos, dashboard:gates,
        // dashboard:standards, dashboard:requests — each carries the fragment HTML
        // with hx-swap-oob="true" on the fragment root.
    }));
};
```

**File**: `plugins/autonomous-dev-portal/server/templates/views/dashboard.tsx`

Use the simplified JSX template from TDD-036 §6.1 verbatim as the canonical structure. Compose `<KpiStrip>`, `<RepoCard>`, `<ApprovalQueueStrip>`, `<StandardsDriftSummary>`, `<ActiveRequestsTable>` from the sibling specs. No inline computation in the view — all aggregates are passed as props.

**`computeStandardsDrift(standards, repos)`** lives in `server/lib/standards-drift.ts` (new file) so the route stays thin and the aggregator is independently unit-tested.

## Tests

| Test | Assertion |
|------|-----------|
| Region order | `.page-head` precedes `.kpi-strip` precedes `.repo-grid` precedes `.approval-queue` precedes `.standards-drift` precedes `.tbl` (active requests) |
| Old markup absent | rendered HTML contains no `<dl>` |
| KPI strip values | `totalActive`, `totalGates`, `totalMtd`, `standardsCount` match input |
| `standardsDrift` empty | `standards: []` → `standardsDrift = []` |
| `standardsDrift` single-repo | one rule, `applies` matches repo A → one entry, repo A, hitCount = rule.hits |
| `standardsDrift` multi-repo sort | three repos with hits {2, 7, 4} → output order [7, 4, 2] |
| SSE channel `dashboard:repos` | event payload contains `<div id="repo-grid"` and `hx-swap-oob="true"` |
| Empty-data render | repos / requests / standards all `[]` → no JS errors, page renders |

## Verification

- `bun test plugins/autonomous-dev-portal/tests/integration/dashboard.test.ts` passes (region order + old-markup-absent assertions).
- `bun test plugins/autonomous-dev-portal/tests/unit/standards-drift.test.ts` passes (three aggregation cases).
- SSE OOB swap smoke test fires one event per channel and asserts the corresponding fragment ID swaps.
- Existing dashboard route smoke tests still pass (no SSE regressions).
- `bun playwright test tests/visual/dashboard.visual.test.ts` snapshots match for light + dark themes (0.1% threshold).
