// SPEC-013-3-01 §Route Table — dashboard (`GET /`).
// SPEC-036-1-01 — Dashboard route computes server-side aggregates before
// render so the view stays purely presentational.
// FR-026-10..15 — Extended to populate v3 hero data (swimlanes, activity,
// cost bars, agent utilization, KPI sparklines).

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import {
    computeStandardsDrift,
    totalBlockingHits as sumBlockingHits,
} from "../lib/standards-drift";
import {
    readDashboardData,
    groupRequestsByPhase,
    read14DayCostBars,
    readMonthlyCapUsd,
} from "../wiring/dashboard-readers";
import { readMtdSpend } from "../wiring/daemon-readers";
import type {
    DashboardAggregatesProp,
    DashboardData,
    DashboardRequest,
} from "../types/render";
import type { DashboardV3Extra } from "../templates/views/dashboard";
import { nowDate } from "../lib/clock";

/**
 * Build the gate-type partition string ("{N} reviewer / {N} standards
 * / {N} cost") for the KPI strip's "Awaiting approval" sub-line.
 * Counts each known gate type; unknown / undefined types are
 * intentionally excluded so the partition reads cleanly.
 */
function buildGateBreakdownText(requests: DashboardRequest[]): string {
    const reviewer = requests.filter(
        (r) => r.gateType === "reviewer-chain",
    ).length;
    const standards = requests.filter(
        (r) => r.gateType === "standards-violation",
    ).length;
    const cost = requests.filter((r) => r.gateType === "cost-cap").length;
    return `${reviewer} reviewer / ${standards} standards / ${cost} cost`;
}

/**
 * SPEC-036-1-01 §Server-side aggregates. Pure: no I/O, no globals.
 * Exported so unit tests can pin every aggregate independently of
 * the route handler's HTTP plumbing.
 *
 * Note: totalMtd is now injected as a parameter since it comes from
 * the cost-ledger reader (authoritative source) rather than being
 * computed from per-repo costs.
 */
export function computeDashboardAggregates(
    data: DashboardData,
    totalMtd: number,
): DashboardAggregatesProp {
    const repos = data.repos ?? [];
    const requests = data.requests ?? [];
    const standards = data.standards ?? [];
    const totalActive = repos.reduce((s, r) => s + r.activeRequests, 0);
    const gates = requests.filter((r) => r.status === "gate");
    // Sort by waitedMin desc, slice top 3 (SPEC-036-1-04 AC #2).
    const topGates = [...gates]
        .sort((a, b) => (b.waitedMin ?? 0) - (a.waitedMin ?? 0))
        .slice(0, 3);
    return {
        totalActive,
        totalGates: gates.length,
        totalMtd,
        gateBreakdownText: buildGateBreakdownText(requests),
        totalBlockingHits: sumBlockingHits(standards),
        standardsCount: standards.length,
        topGates,
        standardsDrift: computeStandardsDrift(standards, repos),
    };
}

/**
 * FR-026-10..15 — Build v3 hero extra data.
 *
 * #389: every section is REAL data or an honest empty/zero — the seeded
 * demo builders and hardcoded KPI constants ($400 cap, 94.2 pass rate,
 * 82m oldest, inFlight 12, $186.40 MTD) misled operators and are gone.
 */
async function buildV3Extra(
    data: DashboardData,
    aggregates: DashboardAggregatesProp,
    totalMtd: number,
): Promise<DashboardV3Extra> {
    const requests = data.requests ?? [];

    // Swimlanes from the live ledger (empty lanes when idle).
    const swimlanes = groupRequestsByPhase(requests);

    // Activity feed / agent utilization: the daemon records neither yet —
    // honest empty states (no fabricated "Streaming" rows or fake agents).
    const activity: DashboardV3Extra["activity"] = [];
    const agents: DashboardV3Extra["agents"] = [];

    // 14-day cost bars from the real ledger.
    const costBars = await read14DayCostBars();

    // Sparklines: the only real time series available is the daily cost
    // ledger (burn rate). The other tiles have no history source — empty
    // arrays render no sparkline rather than a fabricated walk.
    const sparks = {
        inFlight: [] as number[],
        burnRate: costBars.map((d) => d.total),
        passRate: [] as number[],
        queue: [] as number[],
    };

    // KPI values — real numbers, honest zeros, no invented fallbacks.
    const inFlight = Math.max(
        aggregates.totalActive,
        swimlanes.reduce((s, g) => s + g.cards.length, 0),
    );
    const monthlyCap = await readMonthlyCapUsd();
    const now = nowDate();
    const hoursElapsedThisMonth = Math.max(
        1,
        (now.getTime() - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) / 3_600_000,
    );
    const gateRows = requests.filter((r) => r.status === "gate");
    const queueOldestMin = gateRows.reduce(
        (m, r) => Math.max(m, r.waitedMin ?? 0),
        0,
    );

    return {
        swimlanes,
        activity,
        costBars,
        agents,
        sparks,
        kpi: {
            inFlight,
            inFlightSub: buildInFlightBreakdown(swimlanes),
            burnRatePerHr: totalMtd > 0 ? totalMtd / hoursElapsedThisMonth : 0,
            burnRateMtd: totalMtd,
            burnRateCap: monthlyCap,
            passRatePct: null, // no gate-outcome history source exists yet
            passRatePending: aggregates.totalGates,
            queueCount: aggregates.totalGates,
            queueOldestMin,
        },
    };
}

/** Build the "p0:N · p1:N · p2:N · p3:N" breakdown string from swimlanes. */
function buildInFlightBreakdown(
    swimlanes: import("../wiring/dashboard-readers").PhaseGroup[],
): string {
    const counts = { p0: 0, p1: 0, p2: 0, p3: 0 };
    for (const g of swimlanes) {
        for (const c of g.cards) {
            counts[c.priority] = (counts[c.priority] ?? 0) + 1;
        }
    }
    return `p0:${counts.p0} · p1:${counts.p1} · p2:${counts.p2} · p3:${counts.p3}`;
}

/**
 * Synthetic zero-state aggregates used when readDashboardData() fails.
 * This gives the view enough structure to render the error banner without
 * crashing on missing fields.
 */
const EMPTY_DATA: Parameters<typeof computeDashboardAggregates>[0] = {
    repos: [],
    requests: [],
    standards: [],
};

export const dashboardHandler = async (c: Context): Promise<Response> => {
    // PLAN-038 TASK-012 — swapped from loadDashboardStub() to the real
    // composition reader. Empty state-dir → honest zero KPIs (per the
    // tenet "Honesty over fidelity").
    //
    // Error coverage: if either reader rejects we render the dashboard shell
    // with an inline error banner instead of letting Hono produce a bare 500
    // page (satisfies the loading/empty/error/success quartet).
    let data: Awaited<ReturnType<typeof readDashboardData>>;
    let totalMtd: number;
    let readerError: string | null = null;

    try {
        data = await readDashboardData();
    } catch (err) {
        readerError = err instanceof Error ? err.message : String(err);
        data = { ...EMPTY_DATA };
    }

    try {
        totalMtd = await readMtdSpend();
    } catch (err) {
        if (readerError === null) {
            readerError = err instanceof Error ? err.message : String(err);
        }
        totalMtd = 0;
    }

    const aggregates = computeDashboardAggregates(data, totalMtd);

    // FR-026-10..15 — Build v3 hero extra data and attach to aggregates prop.
    // We cast to a wider local type here to avoid editing the shared
    // types/render.ts registry (per hard rule in PRD-026).
    const v3Extra = await buildV3Extra(data, aggregates, totalMtd);
    const aggregatesWithV3 = {
        ...aggregates,
        v3: v3Extra,
        readerError,
    };

    return renderPage(c, "dashboard", { data, aggregates: aggregatesWithV3 });
};
