// SPEC-036-1-01..06 — Dashboard view (PLAN-036-1, first surface flip).
//
// Renders the six v1.1 regions of the Dashboard in fixed order
// (TDD-036 §6.1):
//   1. Page head           (rendered by ShellLayout via pageTitle/headActions)
//   2. KPI strip           (KpiStrip)
//   3. Repo card grid      (RepoCardGrid + section chrome)
//   4. Approval queue strip (ApprovalQueueStrip — v1.1, omitted when 0 gates)
//   5. Standards drift     (StandardsDriftSummary — v1.1, header always shown)
//   6. Active requests tbl (.tbl class)
//
// All aggregates are computed server-side in the route handler
// (`computeDashboardAggregates`) and passed in as plain props so the
// view stays purely presentational. The view never reaches into
// `data.variants` to look up labels — `variantLabel` arrives
// pre-resolved per SPEC-036-1-06 AC #8.
//
// Page head is delivered through ShellLayout (pageTitle="Dashboard"
// and a `headActions` slot) per SPEC-035-1-01. The route handler is
// responsible for passing those through to renderFullPage's caller.

import type { FC } from "hono/jsx";

import { Btn, Chip } from "../../components/primitives";
import type { PhaseName } from "../../components/primitives";
import type {
    DashboardRequest,
    RenderProps,
    StandardsDriftEntry,
} from "../../types/render";
import { ApprovalQueueStrip } from "../fragments/approval-queue";
import { EmptyState } from "../fragments/empty-state";
import { KpiStrip } from "../fragments/kpi-strip";
import type { KpiItem } from "../fragments/kpi-strip";
import { RepoCardGrid } from "../fragments/repo-card";
import { StandardsDriftSummary } from "../fragments/standards-drift";

export interface DashboardAggregates {
    /** Sum of `activeRequests` across all repos. */
    totalActive: number;
    /** Number of requests with `status === "gate"`. */
    totalGates: number;
    /** Sum of `monthlyCostUsd` across all repos. */
    totalMtd: number;
    /** "{N} reviewer / {N} standards / {N} cost" partition. */
    gateBreakdownText: string;
    /** Sum of `hits` for rules with severity === "blocking". */
    totalBlockingHits: number;
    /** Number of standards rules in the catalog. */
    standardsCount: number;
    /** Pre-sorted (waitedMin desc), max-3-sliced gate-blocked requests. */
    topGates: DashboardRequest[];
    /** Pre-sorted (hitCount desc) per-repo drift entries. */
    standardsDrift: StandardsDriftEntry[];
}

/**
 * The page-head action slot. Exposed as a stand-alone export so
 * route handlers (and tests) can mount it on `ShellLayout.headActions`
 * without re-importing the `Btn` primitive at the call site.
 */
export const DashboardHeadActions: FC = () => (
    <>
        <Btn>Refresh</Btn>
        <Btn kind="primary">+ New request</Btn>
    </>
);

/**
 * Build the four KPI items for the strip. Pure helper kept next to
 * the view so the contract stays in one place; SPEC-036-1-02 AC #3
 * pins the labels and order verbatim.
 */
export function buildKpiItems(
    repoCount: number,
    a: DashboardAggregates,
    /** Optional MTD cap for the third tile's sub-line. Uses $400.00
     *  to mirror the kit (Dashboard.jsx line 33) when omitted. */
    mtdCapUsd: number = 400,
): KpiItem[] {
    return [
        {
            label: "Active requests",
            value: a.totalActive,
            sub: `across ${repoCount} repos`,
        },
        {
            label: "Awaiting approval",
            value: a.totalGates,
            sub: a.gateBreakdownText,
        },
        {
            label: "MTD spend",
            value: `$${a.totalMtd.toFixed(2)}`,
            sub: `cap $${mtdCapUsd.toFixed(2)}`,
        },
        {
            label: "Standards rules",
            value: a.standardsCount,
            sub: `${a.totalBlockingHits} blocking hits MTD`,
        },
    ];
}

export interface DashboardViewProps {
    data: RenderProps["dashboard"]["data"];
    /** Pre-computed aggregates from the route handler. The view never
     *  recomputes them so SSE OOB fragments stay self-consistent. */
    aggregates: DashboardAggregates;
}

/**
 * Status-cell renderer for the active requests table. Routes a
 * gate-status request through the warn-toned chip with the gate type
 * appended; running requests get an ok-toned chip.
 */
const StatusCell: FC<{ r: DashboardRequest }> = ({ r }) => {
    if (r.status === "gate") {
        return (
            <Chip variant="status" tone="warn">
                gate · {r.gateType ?? "pending"}
            </Chip>
        );
    }
    return (
        <Chip variant="status" tone="ok">
            running
        </Chip>
    );
};

/**
 * SPEC-036-1-01..06 — Dashboard view. Composes the six v1.1 regions.
 *
 * The page-head (region 1) is intentionally delivered by ShellLayout
 * through `pageTitle` / `headActions` so the title + actions sit in
 * the consistent global slot. The view body therefore starts at the
 * KPI strip (region 2).
 *
 * Empty-state contracts (SPEC-036-1-06):
 *   - 0 repos    -> EmptyState noun="repositories allowlisted" (substitutes for grid)
 *   - 0 requests -> EmptyState noun="active requests" (within table section)
 *   - 0 gates    -> ApprovalQueueStrip returns null (entire section absent)
 *   - 0 hits     -> StandardsDriftSummary keeps header, body delegates to EmptyState
 */
export const DashboardView: FC<DashboardViewProps> = ({
    data,
    aggregates,
}) => {
    const repos = data.repos ?? [];
    const requests = data.requests ?? [];
    const kpiItems = buildKpiItems(repos.length, aggregates);

    return (
        <>
            {/* Region 1: Page head — rendered inline (rather than via
                ShellLayout's pageTitle/headActions slots) so the
                Dashboard surface owns the action set and HTMX can
                target the head as a fragment if needed in future. */}
            <div class="page-head">
                <h1>Dashboard</h1>
                <div class="head-actions">
                    <DashboardHeadActions />
                </div>
            </div>

            {/* Region 2: KPI strip */}
            <KpiStrip items={kpiItems} />

            {/* Region 3: Repos */}
            <section class="sec repos">
                <div class="sec-head">
                    <h2>Repos</h2>
                </div>
                {repos.length > 0 ? (
                    <RepoCardGrid repos={repos} />
                ) : (
                    <EmptyState noun="repositories allowlisted" />
                )}
            </section>

            {/* Region 4: Approval queue strip (v1.1) — null when empty */}
            <ApprovalQueueStrip
                gates={aggregates.topGates}
                totalCount={aggregates.totalGates}
            />

            {/* Region 5: Standards drift summary (v1.1) */}
            <StandardsDriftSummary
                drift={aggregates.standardsDrift}
                totalBlockingHits={aggregates.totalBlockingHits}
            />

            {/* Region 6: Active requests table */}
            <section id="requests-tbl" class="sec requests">
                <div class="sec-head">
                    <h2>Active requests</h2>
                </div>
                {requests.length > 0 ? (
                    <table class="tbl">
                        <thead>
                            <tr>
                                <th>Request</th>
                                <th>Repo</th>
                                <th>Variant</th>
                                <th>Phase</th>
                                <th>Status</th>
                                <th>Cost</th>
                            </tr>
                        </thead>
                        <tbody>
                            {requests.map((r) => (
                                <tr>
                                    <td>
                                        <div class="r-title">{r.title}</div>
                                        <div class="r-id meta-mono">
                                            {r.id}
                                        </div>
                                    </td>
                                    <td>{r.repo}</td>
                                    <td>
                                        <Chip variant="status" tone="muted">
                                            {r.variantLabel ?? r.variant}
                                        </Chip>
                                    </td>
                                    <td>
                                        <Chip
                                            variant="phase"
                                            tone={r.phase as PhaseName}
                                        />
                                    </td>
                                    <td>
                                        <StatusCell r={r} />
                                    </td>
                                    <td class="meta-mono">
                                        ${r.cost.toFixed(2)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : (
                    <EmptyState noun="active requests" />
                )}
            </section>
        </>
    );
};
