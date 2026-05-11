// SPEC-013-3-01 §Route Table — dashboard (`GET /`).
// SPEC-036-1-01 — Dashboard route now computes server-side aggregates
// (`totalActive`, `totalGates`, `totalMtd`, `gateBreakdownText`,
// `totalBlockingHits`, `standardsDrift`, `topGates`) before render so
// the view stays purely presentational and SSE OOB fragments are
// self-consistent (no client-side recomputation).
//
// Loads the stubbed dashboard data and delegates rendering to
// renderPage. MUST NOT inspect HX-Request directly — that is
// renderPage's job.

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import {
    computeStandardsDrift,
    totalBlockingHits as sumBlockingHits,
} from "../lib/standards-drift";
import { readDashboardData } from "../wiring/dashboard-readers";
import type {
    DashboardAggregatesProp,
    DashboardData,
    DashboardRequest,
} from "../types/render";

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
 */
export function computeDashboardAggregates(
    data: DashboardData,
): DashboardAggregatesProp {
    const repos = data.repos ?? [];
    const requests = data.requests ?? [];
    const standards = data.standards ?? [];
    const totalActive = repos.reduce((s, r) => s + r.activeRequests, 0);
    const totalMtd = repos.reduce((s, r) => s + r.monthlyCostUsd, 0);
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

export const dashboardHandler = async (c: Context): Promise<Response> => {
    // PLAN-038 TASK-012 — swapped from loadDashboardStub() to the real
    // composition reader. Empty state-dir → honest zero KPIs (per the
    // tenet "Honesty over fidelity").
    const data = await readDashboardData();
    const aggregates = computeDashboardAggregates(data);
    return renderPage(c, "dashboard", { data, aggregates });
};
