# SPEC-036-1-02: Dashboard KPI Strip — 4-tile Header Region

## Metadata
- **Parent Plan**: PLAN-036-1 (Dashboard Surface Re-skin)
- **Parent TDD**: TDD-036, §6.1 (Dashboard, KPI strip)
- **Parent PRD**: PRD-018, R-16
- **Tasks Covered**: PLAN-036-1 Task 3 (`fragments/kpi-strip.tsx`)
- **Estimated effort**: 0.5 day
- **Dependencies**: PLAN-035-1 (layout shell, hairline elevation tokens), PLAN-035-2 — `Score` and `CostRing` primitives are referenced for the MTD-spend tile decoration but the tile itself is layout-only and does not import them in v1.
- **Priority**: P0 (highest-traffic region; first thing the operator sees).
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Implement `fragments/kpi-strip.tsx` — a reusable presentational fragment that renders the Dashboard's 4-tile KPI strip per TDD-036 §6.1: Active requests, Awaiting approval, MTD spend, Standards rules. The fragment is also reusable on Costs (PLAN-036-2) and Ops (PLAN-036-3); per PLAN-036-1 it ships once, here.

## Acceptance Criteria

1. **Prop signature**:
   ```ts
   export interface KpiItem {
       label: string;
       value: string | number;
       sub?: string;
   }
   export interface KpiStripProps {
       items: KpiItem[];
       id?: string; // defaults to "kpi-strip" for SSE OOB swap
   }
   export const KpiStrip: FC<KpiStripProps>;
   ```
2. **Rendered HTML**: `<div id="kpi-strip" class="kpi-strip">` containing one `<div class="kpi">` per item, with `<div class="kpi-label">{label}</div>`, `<div class="kpi-value">{value}</div>`, and `<div class="kpi-sub">{sub}</div>` (sub omitted when undefined).
3. **Dashboard call site** (per TDD-036 §6.1) passes exactly four items in this order:
   - `Active requests` / `totalActive` / `across {repos.length} repos`
   - `Awaiting approval` / `totalGates` / `gateBreakdownText`
   - `MTD spend` / `$X.XX` (always 2 decimals per PRD-018 R-22) / `cap $Y.YY`
   - `Standards rules` / `standardsCount` / `{blockingHits} blocking hits MTD`
4. **Zero values render** without crashing or visual collapse: `value: 0` renders as `0` (mono); `value: "$0.00"` keeps two decimals.
5. **HTMX SSE OOB**: the strip's outer `<div>` accepts `hx-swap-oob="true"` from the route handler when emitted on the `dashboard:kpis` channel; default `id="kpi-strip"`.
6. **No primitive imports**: layout-only. Cost-ring / score visualizations sit inside the broader Costs/Ops surfaces (PLAN-036-2/3), not in this fragment.

## Implementation

**File**: `plugins/autonomous-dev-portal/server/templates/fragments/kpi-strip.tsx`

```tsx
import type { FC } from "hono/jsx";

export interface KpiItem {
    label: string;
    value: string | number;
    sub?: string;
}

export interface KpiStripProps {
    items: KpiItem[];
    id?: string;
}

export const KpiStrip: FC<KpiStripProps> = ({ items, id = "kpi-strip" }) => (
    <div id={id} class="kpi-strip">
        {items.map((it) => (
            <div class="kpi" key={it.label}>
                <div class="kpi-label">{it.label}</div>
                <div class="kpi-value">{it.value}</div>
                {it.sub != null && <div class="kpi-sub">{it.sub}</div>}
            </div>
        ))}
    </div>
);
```

CSS (`.kpi-strip`, `.kpi`, `.kpi-label`, `.kpi-value`, `.kpi-sub`) lives in `server/static/dashboard.css` and references only `--bg-1`, `--line-1`, `--fg-0`, `--fg-3`, type tokens — no hex literals (PRD-018 R-02, M-01).

## Tests

| Test | Assertion |
|------|-----------|
| 4-tile happy path | renders 4 `.kpi` children in input order |
| Zero values | `value: 0` and `value: "$0.00"` render without exception |
| Sub omitted | `sub: undefined` → no `.kpi-sub` element in that tile |
| Custom id | `id="dashboard-kpis-x"` overrides default |
| Dashboard call site | integration test asserts the four expected labels appear in order |
| MTD format | the MTD tile value matches `/^\$\d+\.\d{2}$/` |

## Verification

- `bun test plugins/autonomous-dev-portal/tests/unit/kpi-strip.test.tsx` passes.
- `bun test plugins/autonomous-dev-portal/tests/integration/dashboard.test.ts` finds `.kpi-strip` and the four expected labels in DOM order.
- `grep -E "#[0-9a-f]{3,6}" server/templates/fragments/kpi-strip.tsx` returns zero matches (PRD-018 M-01).
- Visual regression snapshot of the Dashboard at light + dark covers the strip implicitly.
