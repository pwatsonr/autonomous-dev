// SPEC-036-1-02 §KpiStrip — Dashboard 4-tile header region.
//
// Layout-only presentational fragment. Rendered as the second region
// of the Dashboard (after the page head, before the repo card grid).
// Reusable on Costs (PLAN-036-2) and Ops (PLAN-036-3) but per
// PLAN-036-1 ships once, here. The fragment imports no primitives;
// cost-ring / score visualizations belong on the Costs/Ops surfaces.
//
// Rendered HTML (SPEC-036-1-02 AC #2, updated by SPEC-037-6-01):
//   <div id="kpi-strip" class="kpi-strip">
//     <div class="kpi">
//       <div class="kpi-label">{label}</div>
//       <div class="kpi-num">{value}</div>
//       <div class="kpi-sub">{sub}</div>   <!-- omitted when sub is undefined -->
//     </div>
//     ...
//   </div>
//
// SPEC-037-6-01: class `.kpi-value` was renamed to `.kpi-num` to match the
// kit's canonical name (`app.css:354`). No layout change; the rename makes
// the existing kit rule (mono, 26px) actually hit.

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
                <div class="kpi-num">{it.value}</div>
                {it.sub != null && <div class="kpi-sub">{it.sub}</div>}
            </div>
        ))}
    </div>
);
