// SPEC-036-1-02 §KpiStrip — Dashboard 4-tile header region.
//
// Layout-only presentational fragment. Rendered as the second region
// of the Dashboard (after the page head, before the repo card grid).
// Reusable on Costs (PLAN-036-2) and Ops (PLAN-036-3) but per
// PLAN-036-1 ships once, here. The fragment imports no primitives;
// cost-ring / score visualizations belong on the Costs/Ops surfaces.
//
// Rendered HTML (SPEC-036-1-02 AC #2):
//   <div id="kpi-strip" class="kpi-strip">
//     <div class="kpi">
//       <div class="kpi-label">{label}</div>
//       <div class="kpi-value">{value}</div>
//       <div class="kpi-sub">{sub}</div>   <!-- omitted when sub is undefined -->
//     </div>
//     ...
//   </div>

import type { FC } from "hono/jsx";

export interface KpiItem {
    label: string;
    value: string | number;
    sub?: string;
}

export interface KpiStripProps {
    items: KpiItem[];
    /** Defaults to `"kpi-strip"` so HTMX `dashboard:kpis` SSE OOB swap
     *  finds the fragment without the call site repeating the id. */
    id?: string;
}

export const KpiStrip: FC<KpiStripProps> = ({ items, id = "kpi-strip" }) => (
    <div id={id} class="kpi-strip">
        {items.map((it) => (
            <div class="kpi">
                <div class="kpi-label">{it.label}</div>
                <div class="kpi-value">{it.value}</div>
                {it.sub != null && <div class="kpi-sub">{it.sub}</div>}
            </div>
        ))}
    </div>
);
