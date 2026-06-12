// SPEC-036-2-01..03 — Costs surface (PLAN-036-2 first surface).
//
// Composes the v1.1 cost surface in fixed order:
//   1. Page head      (rendered inline)
//   2. KPI strip      (KpiStrip — 4 cards, SSE OOB targets via data-sse)
//   3. Daily-spend chart (CostChart — 30-day SVG line chart)
//   4. Projection     (CostProjection — CostRing + detail block)
//   5. 2-col grid     (PhaseSpendTable + reviewer-spend table)
//   6. Deploy backend table
//
// All aggregates (MTD, avg/request, projection) are computed server-side
// in the route handler so the view stays purely presentational.

import type { FC } from "hono/jsx";
import { Topbar } from "../../components/topbar";

import { Chip } from "../../components/primitives";
import type { ProjectionResult } from "../../lib/costs-projection";
import type { CostSeries, RenderProps } from "../../types/render";

// Pre-computed hx-trigger value - using double quotes inside bracket expression
const COSTS_POLLING_TRIGGER = 'every 10s [document.visibilityState === "visible"]';
import { CostChart } from "../fragments/cost-chart";
import { CostProjection } from "../fragments/cost-projection";
import { EmptyState } from "../fragments/empty-state";
import { KpiStrip } from "../fragments/kpi-strip";
import type { KpiItem } from "../fragments/kpi-strip";
import { PhaseSpendTable } from "../fragments/phase-spend-table";

export interface CostsViewProps {
    series: CostSeries;
    projection: ProjectionResult;
}

/** Build the 4 KPI tiles. SPEC-036-2-01 §FR-3 + FR-7. */
export function buildCostsKpis(s: CostSeries): KpiItem[] {
    const totalMtd = s.totalMtd ?? 0;
    const reviewerSpend = s.reviewerSpend ?? [];
    const deploySpend = s.deploySpend ?? [];
    const reviewersTotal = reviewerSpend.reduce((a, r) => a + r.cost, 0);
    const deploysTotal = deploySpend.reduce((a, d) => a + d.cost, 0);
    const totalDeploys = deploySpend.reduce((a, d) => a + d.deploys, 0);
    const specialists = reviewerSpend.filter(
        (r) => r.role === "specialist",
    ).length;
    const reqCount = s.requestCount ?? 0;
    const avgPerReq = reqCount > 0 ? totalMtd / reqCount : 0;
    // #396: cap is null when none is configured — say so, never invent $400.
    const cap = s.costCap ?? null;

    return [
        {
            id: "kpi-mtd",
            sseChannel: "costs:kpis",
            label: "MTD spend",
            value: `$${totalMtd.toFixed(2)}`,
            sub: cap !== null ? `cap $${cap.toFixed(2)}` : "no cap configured",
        },
        {
            id: "kpi-reviewers",
            sseChannel: "costs:kpis",
            label: "Reviewers",
            value: `$${reviewersTotal.toFixed(2)}`,
            sub: `${String(specialists)} specialists`,
        },
        {
            id: "kpi-deploys",
            sseChannel: "costs:kpis",
            label: "Deploys",
            value: `$${deploysTotal.toFixed(2)}`,
            sub: `${String(totalDeploys)} runs`,
        },
        {
            id: "kpi-avg",
            sseChannel: "costs:kpis",
            label: "Avg / request",
            value: `$${avgPerReq.toFixed(2)}`,
            sub: `${String(reqCount)} requests MTD`,
        },
    ];
}

const CostsHeadActions: FC = () => (
    // PLAN-038 polish — "Export CSV" was a dead button (no handler, no
    // requirement). Dropped. "Set caps" now deeplinks to the cost-caps
    // section on the Settings General tab.
    <>
        <a class="btn" href="/settings#cost-caps">
            Set caps
        </a>
    </>
);

export const CostsView: FC<RenderProps["costs"] & { projection?: ProjectionResult }> = ({
    series,
    projection,
}) => {
    const kpis = buildCostsKpis(series);
    const reviewerSpend = series.reviewerSpend ?? [];
    const deploySpend = series.deploySpend ?? [];
    const phaseSpend = series.phaseSpend ?? [];
    const cap = series.costCap ?? null; // #396: null = no cap configured
    const mtd = series.totalMtd ?? 0;
    const proj: ProjectionResult = projection ?? {
        projected: 0,
        runRateDaily: 0,
        daysRemaining: 0,
        overage: 0,
    };

    return (
        <div
            id="costs-body"
            hx-get="/costs"
            hx-trigger={COSTS_POLLING_TRIGGER}
            hx-target="this"
            hx-swap="outerHTML"
            hx-select="#costs-body"
        >
            {/* PORTAL-AUDIT-2026-05-16: 10s polling. The MTD-spend tile
                and daily/projection chart tick up as the daemon writes
                to ~/.autonomous-dev/cost-ledger.json. */}
            {/* Region 1: v3 Topbar (sticky frosted) */}
            <Topbar title="Costs" subTitle="spend & projections" rightSlot={<CostsHeadActions />} />
            <div class="main-inner">

            {/* Region 2: KPI strip with SSE targets */}
            <KpiStrip items={kpis} />

            {/* Region 3: daily-spend chart */}
            <section class="sec">
                <div class="sec-head">
                    <h2>Daily spend · last 30 days</h2>
                </div>
                <div class="chart-card">
                    <CostChart
                        points={series.points}
                        budgetUsd={series.budgetUsd}
                    />
                </div>
            </section>

            {/* Region 4: month-end projection */}
            <section class="sec">
                <div class="sec-head">
                    <h2>Month-end projection</h2>
                </div>
                <CostProjection projection={proj} cap={cap} mtd={mtd} />
            </section>

            {/* Region 5: 2-col grid — phase spend + reviewer spend */}
            <div class="cost-grid">
                <section class="sec">
                    <div class="sec-head">
                        <h2>Spend by phase</h2>
                    </div>
                    <PhaseSpendTable rows={phaseSpend} />
                </section>

                <section class="sec">
                    <div class="sec-head">
                        <h2>Spend by reviewer</h2>
                        <span class="meta-mono dim">PRD-012</span>
                    </div>
                    {reviewerSpend.length > 0 ? (
                        <table class="tbl tight reviewer-spend">
                            <thead>
                                <tr>
                                    <th>Reviewer</th>
                                    <th>Role</th>
                                    <th>Runs</th>
                                    <th>FP rate</th>
                                    <th class="num-r">Cost</th>
                                </tr>
                            </thead>
                            <tbody>
                                {reviewerSpend.map((r) => (
                                    <tr>
                                        <td>{r.name}</td>
                                        <td>
                                            {/* SPEC-037-6-03: reviewer-role chips use the kit's purpose-built
                                             *  role-* palette instead of the generic info / muted tones. */}
                                            <Chip
                                                variant="status"
                                                tone={
                                                    r.role === "specialist"
                                                        ? "role-specialist"
                                                        : "role-generic"
                                                }
                                            >
                                                {r.role}
                                            </Chip>
                                        </td>
                                        <td class="meta-mono">
                                            {String(r.runs)}
                                        </td>
                                        <td class="meta-mono">
                                            {r.fpRate !== null
                                                ? `${(r.fpRate * 100).toFixed(0)}%`
                                                : "—"}
                                        </td>
                                        <td class="meta-mono num-r">
                                            ${r.cost.toFixed(2)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : (
                        <EmptyState noun="reviewer spend" />
                    )}
                </section>
            </div>

            {/* Region 6: deploy-backend spend table */}
            <section class="sec">
                <div class="sec-head">
                    <h2>Spend by deploy backend</h2>
                    <span class="meta-mono dim">PRD-014</span>
                </div>
                {deploySpend.length > 0 ? (
                    <table class="tbl deploy-spend">
                        <thead>
                            <tr>
                                <th>Env</th>
                                <th>Backend</th>
                                <th>Deploys</th>
                                <th>Last</th>
                                <th>Health</th>
                                <th class="num-r">Cost</th>
                            </tr>
                        </thead>
                        <tbody>
                            {deploySpend.map((d) => (
                                <tr>
                                    <td>
                                        <strong>{d.env}</strong>
                                    </td>
                                    <td>
                                        {/* SPEC-037-6-03: deploy-backend column uses the kit's
                                         *  `.chip.backend.sm` marker (compact). */}
                                        <Chip variant="backend" size="sm">
                                            {d.backend}
                                        </Chip>
                                    </td>
                                    <td class="meta-mono">
                                        {String(d.deploys)}
                                    </td>
                                    <td class="meta-mono">
                                        {d.lastDeploy}
                                    </td>
                                    <td>
                                        <Chip
                                            variant="status"
                                            tone={d.health}
                                        >
                                            {d.health === "ok"
                                                ? "ok"
                                                : d.health === "warn"
                                                  ? "degraded"
                                                  : "rolled back"}
                                        </Chip>
                                    </td>
                                    <td class="meta-mono num-r">
                                        ${d.cost.toFixed(2)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : (
                    <EmptyState noun="deploy spend" />
                )}
            </section>
            </div>
        </div>
    );
};
