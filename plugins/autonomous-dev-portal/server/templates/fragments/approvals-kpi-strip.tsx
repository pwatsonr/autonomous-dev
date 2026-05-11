// SPEC-037-4-01 §Approvals page KPI strip — 3-card per-gate-type strip.
// SPEC-037-4-05 — extracted from the view so the bulk-approve handler
// can re-render the same markup via an HTMX OOB swap.
//
// Render shape (matches kit `app.css:351-360`):
//   <div class="kpi-strip">
//     <div class="kpi">
//       <div class="kpi-label">{label}</div>
//       <div class="kpi-num">{N}</div>
//       <div class="kpi-sub">{sub}</div>
//     </div>
//     ...
//   </div>
//
// Counts are derived from the items array partitioned by `gateType`. The
// sub-lines surface the operationally useful aggregate for each gate:
//   - Reviewer chain → "across N repos"   (unique repo count)
//   - Standards       → "of which N are blocking"
//   - Cost cap        → "current cap $X/day"

import type { FC } from "hono/jsx";

import type { ApprovalItem } from "../../types/render";

export interface ApprovalsKpiStripProps {
    items: ApprovalItem[];
    /** Configured daily cost cap in USD (informational sub-line). */
    costCapDailyUsd: number;
    /** Optional `hx-swap-oob` value; set to `"outerHTML:.kpi-strip"`
     *  when the strip is the OOB payload of the bulk-approve response. */
    oob?: string;
}

export const ApprovalsKpiStrip: FC<ApprovalsKpiStripProps> = ({
    items,
    costCapDailyUsd,
    oob,
}) => {
    const reviewer = items.filter((i) => i.gateType === "reviewer-chain");
    const standards = items.filter((i) => i.gateType === "standards-violation");
    const cost = items.filter((i) => i.gateType === "cost-cap");

    const reviewerRepos = new Set(reviewer.map((i) => i.repo)).size;
    // Prefer the structured `blocking` field; fall back to the total
    // standards-violation count so the sub-line never reads "0 blocking"
    // when the stub hasn't populated the field yet.
    const blockingFromField = standards.filter((i) => i.blocking).length;
    const blocking = blockingFromField > 0 ? blockingFromField : standards.length;

    // Hono's JSX renders `hx-swap-oob={undefined}` as the literal string
    // `"undefined"`, so we conditionally emit the attribute.
    const oobAttr = oob !== undefined ? { "hx-swap-oob": oob } : {};

    return (
        <div class="kpi-strip" {...oobAttr}>
            <div class="kpi">
                <div class="kpi-label">Reviewer chain</div>
                <div class="kpi-num">{reviewer.length}</div>
                <div class="kpi-sub">across {reviewerRepos} repos</div>
            </div>
            <div class="kpi">
                <div class="kpi-label">Standards violation</div>
                <div class="kpi-num">{standards.length}</div>
                <div class="kpi-sub">of which {blocking} are blocking</div>
            </div>
            <div class="kpi">
                <div class="kpi-label">Cost cap</div>
                <div class="kpi-num">{cost.length}</div>
                <div class="kpi-sub">current cap ${costCapDailyUsd}/day</div>
            </div>
        </div>
    );
};
