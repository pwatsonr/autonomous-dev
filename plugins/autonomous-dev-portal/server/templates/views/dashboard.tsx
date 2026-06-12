// FR-026-10..15 — Dashboard v3 hero view.
//
// This replaces the v1.1 Dashboard with the full v3 layout:
//   1. Topbar (sticky frosted header)
//   2. KPI strip with sparklines (4 tiles)
//   3. Pipeline swimlanes (8 columns, grouped by phase)
//   4. Activity feed + 14-day stacked cost bars (2-col grid)
//   5. Agents mini-grid (top 9 by utilization)
//
// All aggregates are computed server-side in the route handler and passed
// in as plain props. The view is purely presentational — no client-side
// recomputation.
//
// Presentational note: when live readers yield no active requests the
// swimlanes fall back to deterministic seeded demo data (see
// groupRequestsByPhase in dashboard-readers.ts).

import type { FC } from "hono/jsx";

import { Topbar } from "../../components/topbar";
import type { RenderProps } from "../../types/render";
import { DashboardKpiStrip } from "../fragments/dashboard-kpi";
import type { DashboardKpiTile } from "../fragments/dashboard-kpi";
import { DashboardSwimlanes } from "../fragments/dashboard-swimlanes";
import { DashboardActivityFeed } from "../fragments/dashboard-activity";
import { DashboardCostBars } from "../fragments/dashboard-cost-bars";
import { DashboardAgentsMini } from "../fragments/dashboard-agents";
import type {
    PhaseGroup,
    ActivityRow,
    DayCostBar,
    AgentUtilRow,
} from "../../wiring/dashboard-readers";

// ─────────────────────────────────────────────────────────────────────────────
// Local prop interface for the v3 hero. Extends the v1.1 aggregates with
// the additional v3 hero data. Declared locally (per hard rule: do not edit
// shared types/render.ts). The route handler constructs DashboardV3Props and
// casts via the existing `aggregates` field's union.
// ─────────────────────────────────────────────────────────────────────────────

/** V3-specific extra data threaded alongside the v1.1 aggregates. */
export interface DashboardV3Extra {
    /** Swimlane groups (8 phase columns). */
    swimlanes: PhaseGroup[];
    /** Activity feed rows (up to 10). */
    activity: ActivityRow[];
    /** 14-day phase-split cost bars. */
    costBars: DayCostBar[];
    /** Top-9 agent utilization rows. */
    agents: AgentUtilRow[];
    /** Sparkline point arrays for the 4 KPI tiles. */
    sparks: {
        inFlight: number[];
        burnRate: number[];
        passRate: number[];
        queue: number[];
    };
    /** KPI computed values for the 4 tiles. */
    kpi: {
        inFlight: number;
        inFlightSub: string;
        burnRatePerHr: number;
        burnRateMtd: number;
        /** Configured monthly cap; null = no cap configured (#389: never invent one). */
        burnRateCap: number | null;
        /** Gate pass rate; null = no outcome-history source exists yet (#389). */
        passRatePct: number | null;
        passRatePending: number;
        queueCount: number;
        queueOldestMin: number;
    };
}

export interface DashboardViewProps {
    data: RenderProps["dashboard"]["data"];
    aggregates: RenderProps["dashboard"]["aggregates"] & {
        v3?: DashboardV3Extra;
        /** Non-null when readDashboardData() or readMtdSpend() rejected. */
        readerError?: string | null;
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// KPI tile builder — converts v3 KPI data into DashboardKpiTile[]
// ─────────────────────────────────────────────────────────────────────────────

export function buildV3KpiTiles(extra: DashboardV3Extra): DashboardKpiTile[] {
    const { kpi, sparks } = extra;

    // Honesty over fidelity: never show fabricated deltas/comparisons.
    // Deltas require a prior-period snapshot; when that data isn't available
    // (which is the current case — no historical aggregation store), we omit
    // the delta entirely rather than display a hardcoded constant.
    return [
        {
            label: "In flight",
            value: String(kpi.inFlight),
            unit: "reqs",
            sub: kpi.inFlightSub,
            sparkPoints: sparks.inFlight,
            sparkTone: "info",
        },
        {
            label: "Burn rate",
            value: `$${kpi.burnRatePerHr.toFixed(2)}`,
            unit: "/hr",
            valueTone: kpi.burnRatePerHr < 5 ? "kpi-ok" : kpi.burnRatePerHr < 10 ? undefined : "kpi-warn",
            // #389: only claim a cap when one is actually configured.
            sub: kpi.burnRateCap !== null
                ? `MTD $${kpi.burnRateMtd.toFixed(2)} / $${kpi.burnRateCap.toFixed(2)}`
                : `MTD $${kpi.burnRateMtd.toFixed(2)} — no cap configured`,
            sparkPoints: sparks.burnRate,
            sparkTone: "ok",
        },
        {
            label: "Gate pass rate",
            // #389: no outcome-history source exists — show "—", never 94.2.
            value: kpi.passRatePct !== null ? `${kpi.passRatePct.toFixed(1)}` : "—",
            unit: kpi.passRatePct !== null ? "%" : undefined,
            sub: kpi.passRatePct !== null
                ? `${kpi.passRatePending} pending review`
                : "no data source yet",
            sparkPoints: sparks.passRate,
            sparkTone: "ok",
        },
        {
            label: "Approvals queue",
            value: String(kpi.queueCount),
            valueTone: kpi.queueCount > 0 ? "kpi-warn" : undefined,
            // #389: no SLA is configured anywhere — don't invent one.
            sub: kpi.queueOldestMin > 0
                ? `oldest ${Math.floor(kpi.queueOldestMin / 60)}h ${kpi.queueOldestMin % 60}m`
                : "clear",
            sparkPoints: sparks.queue,
            sparkTone: "warn",
        },
    ];
}

/** Fallback KPI tiles when v3 extra is absent (graceful degradation). */
function buildFallbackKpiTiles(
    totalActive: number,
    totalGates: number,
    totalMtd: number,
): DashboardKpiTile[] {
    const fallbackPoints = Array.from({ length: 24 }, (_, i) => 50 + (i % 5) * 5);
    return [
        {
            label: "In flight",
            value: String(totalActive),
            unit: "reqs",
            sub: "active pipeline",
            sparkPoints: fallbackPoints,
            sparkTone: "info",
        },
        {
            label: "MTD spend",
            value: `$${totalMtd.toFixed(2)}`,
            sub: "cap $400.00",
            sparkPoints: fallbackPoints,
            sparkTone: "ok",
        },
        {
            label: "Gate pass rate",
            value: "—",
            sub: "no data",
            sparkPoints: fallbackPoints,
            sparkTone: "ok",
        },
        {
            label: "Approvals queue",
            value: String(totalGates),
            valueTone: totalGates > 0 ? "kpi-warn" : undefined,
            sub: totalGates > 0 ? "awaiting approval" : "clear",
            sparkPoints: fallbackPoints,
            sparkTone: "warn",
        },
    ];
}

// Pre-computed HTMX polling trigger (no inline JS).
// Pinned at 5s by the auto-refresh polling contract test.
//
// Focus-safety: suppress the poll when the keyboard focus is inside
// #dashboard-body so replacing the subtree doesn't steal focus (WCAG 2.4.3).
// The [data-paused] check lets operators freeze the feed via the Pause button.
const DASHBOARD_POLLING_TRIGGER =
    'every 5s [document.visibilityState === "visible" && !document.activeElement.closest("#dashboard-body") && !document.querySelector("#dashboard-body[data-paused]")]';

/**
 * FR-026-10..15 — Dashboard v3 hero view.
 *
 * Composes: Topbar → KPI strip → swimlanes → activity+cost grid → agents.
 * All data is server-derived; the view is purely presentational.
 */
export const DashboardView: FC<DashboardViewProps> = ({
    data,
    aggregates,
}) => {
    const v3 = (aggregates as DashboardViewProps["aggregates"]).v3;
    const readerError = (aggregates as DashboardViewProps["aggregates"]).readerError ?? null;
    const kpiTiles = v3 != null
        ? buildV3KpiTiles(v3)
        : buildFallbackKpiTiles(
              aggregates.totalActive,
              aggregates.totalGates,
              aggregates.totalMtd,
          );

    return (
        <div
            id="dashboard-body"
            hx-get="/"
            hx-trigger={DASHBOARD_POLLING_TRIGGER}
            hx-target="this"
            hx-swap="outerHTML"
            hx-select="#dashboard-body"
        >
            {/*
              * Error banner: rendered when readDashboardData() or readMtdSpend()
              * rejected. Follows the loading/empty/error/success quartet. Shows
              * the last-cached snapshot (which is the zero-state aggregates when
              * no prior data exists) and offers a Retry link.
              */}
            {readerError != null && (
                <div class="dashboard-error-banner" role="alert" aria-live="assertive">
                    <span class="dashboard-error-banner__icon" aria-hidden="true">⚠</span>
                    <span class="dashboard-error-banner__message">
                        {/* #396: there is no cache — zeros render where data
                            is unavailable. Don't claim a snapshot exists. */}
                        Failed to load dashboard data — values below may be
                        incomplete (zeros where data is unavailable).
                    </span>
                    <a href="/" class="btn ghost sm" aria-label="Retry loading dashboard data">
                        Retry
                    </a>
                </div>
            )}
            <Topbar
                title="Dashboard"
                subTitle="autonomous-dev · control plane"
                liveIndicator
                rightSlot={
                    <>
                        {/* Honest freshness label — no fabricated "updated X ago" */}
                        <span class="topbar-refresh-label">
                            auto-refreshing every 5s
                        </span>
                        {/*
                          * Pause feed toggle — sets data-paused on #dashboard-body.
                          * The HTMX poll predicate checks for data-paused so pressing
                          * this button freezes the surface (WCAG 2.2 AA, operator UX).
                          * Click is handled by static/js/dashboard-feed-pause.js
                          * (CSP disallows inline onclick attributes).
                          */}
                        <button
                            class="btn ghost sm"
                            aria-label="Pause live feed"
                            aria-pressed="false"
                            data-pause-feed
                        >
                            Pause feed
                        </button>
                        <a href="/" class="btn sm" aria-label="Refresh dashboard">
                            Refresh
                        </a>
                    </>
                }
            />

            <div class="main-inner">
                {/* Region 1: KPI strip with sparklines */}
                <div class="sec">
                    <DashboardKpiStrip tiles={kpiTiles} />
                </div>

                {/* Region 2: Pipeline swimlanes */}
                <div class="sec">
                    <div class="sec-head">
                        <h2>Pipeline · all in-flight</h2>
                        <div class="head-actions">
                            {/*
                              * Swimlanes / List / Timeline view modes are not yet
                              * implemented. A single-option segmented control reads
                              * as a stray button (operator-reported), so until the
                              * other modes ship this is a plain meta label — no
                              * button costume, no false affordance.
                              */}
                            <span class="meta-mono dim">
                                grouped by phase · swimlanes
                            </span>
                        </div>
                    </div>
                    {v3 != null ? (
                        <DashboardSwimlanes groups={v3.swimlanes} />
                    ) : (
                        <div class="pipeline-shell">
                            <div class="pipeline-empty">
                                No pipeline data available
                            </div>
                        </div>
                    )}
                </div>

                {/* Region 3: Activity feed + 14-day cost bars (2-col) */}
                <div class="dashboard-grid-activity">
                    <div class="sec dashboard-sec-no-mb">
                        <div class="sec-head">
                            <h2>Activity</h2>
                            {/*
                              * Activity filter (All/Agents/Gates/Cost) is not yet
                              * implemented server-side. A lone "All" chip conveyed
                              * nothing and read as a stray button (operator-
                              * reported) — omit the control entirely until the
                              * filter endpoint ships.
                              */}
                        </div>
                        {v3 != null ? (
                            <DashboardActivityFeed rows={v3.activity} />
                        ) : (
                            <div class="card">
                                <div class="card-b">
                                    <span class="dim">No activity data</span>
                                </div>
                            </div>
                        )}
                    </div>
                    <div class="sec dashboard-sec-no-mb">
                        <div class="sec-head">
                            <h2>Cost · 14d</h2>
                            <div class="head-actions">
                                {/* #389: bars are single-tone daily totals — the
                                    ledger records no per-phase attribution. */}
                                <span class="meta-mono dim">daily totals</span>
                            </div>
                        </div>
                        {v3 != null ? (
                            <DashboardCostBars days={v3.costBars} />
                        ) : (
                            <div class="card">
                                <div class="card-b">
                                    <span class="dim">No cost data</span>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Region 4: Agents mini-grid */}
                <div class="sec dashboard-sec-agents">
                    <div class="sec-head">
                        <h2>Agents</h2>
                        <div class="head-actions">
                            <a href="/agents" class="btn ghost sm">
                                Open agents view →
                            </a>
                        </div>
                    </div>
                    {v3 != null ? (
                        <DashboardAgentsMini
                            agents={v3.agents}
                            totalAgents={v3.agents.length}
                        />
                    ) : (
                        <div class="card">
                            <div class="card-b">
                                <span class="dim">No agent data</span>
                            </div>
                        </div>
                    )}
                </div>
            </div>
            {/* External JS for the Pause feed toggle. CSP disallows inline
                onclick attributes; the handler lives in static/js/. */}
            <script src="/static/js/dashboard-feed-pause.js" defer></script>
        </div>
    );
};
