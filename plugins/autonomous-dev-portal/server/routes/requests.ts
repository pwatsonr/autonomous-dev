// PLAN-Requests-Surface §`GET /requests` — list-all-requests surface.
//
// RailNav has linked to `/requests` since SPEC-037-3-01 but the route
// was never implemented (404). This handler aggregates every request
// across the allowlisted repos (via the dashboard stub) and renders the
// kit-shape table view at `templates/views/requests.tsx`.
//
// All four KPIs (active / in-gate / completed-today / MTD cost) are
// computed server-side here so the view stays purely presentational and
// the route handler remains the single contract surface for tests.

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { readRequestLedger } from "../wiring/request-ledger-reader";
import { readMtdSpend } from "../wiring/daemon-readers";
import type {
    DashboardRequest,
    RequestsAggregatesProp,
} from "../types/render";
import { nowMs } from "../lib/clock";

/**
 * Twenty-four hours in milliseconds; used by the "Completed today" KPI
 * to bound the lookback window from the supplied `now`.
 */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Returns `true` when `iso` is a parseable ISO-8601 timestamp within the
 * trailing 24 hours of `now`. Defensive: any unparseable or future-dated
 * value returns `false` so a single malformed stub row cannot inflate
 * the KPI.
 */
function isWithin24h(iso: string | undefined, now: number): boolean {
    if (!iso) return false;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return false;
    const delta = now - t;
    return delta >= 0 && delta <= ONE_DAY_MS;
}

/**
 * PLAN-Requests-Surface §Server-side aggregates. Pure — no I/O, no
 * globals beyond the injected `now`. Exported so unit tests can pin
 * each KPI independently of the route handler's HTTP plumbing.
 *
 * Note: totalCostMtdUsd is now injected as a parameter since it comes from
 * the cost-ledger reader (authoritative source) rather than being computed
 * from per-request costs.
 */
export function computeRequestsAggregates(
    requests: DashboardRequest[],
    totalCostMtdUsd: number,
    now: number = nowMs(),
): RequestsAggregatesProp {
    let activeCount = 0;
    let inGateCount = 0;
    let completedTodayCount = 0;
    for (const r of requests) {
        if (r.status === "gate") {
            inGateCount++;
        } else if (r.status === "done") {
            if (isWithin24h(r.completedAt, now)) completedTodayCount++;
        } else if (r.status === "failed" || r.status === "cancelled") {
            // Terminal non-success states are NOT active. The old `else`
            // counted them, so a board of corpses showed "Active 7" while
            // the daemon was idle (visual crawl, page 2).
        } else {
            // queued | running
            activeCount++;
        }
    }
    return {
        activeCount,
        inGateCount,
        completedTodayCount,
        totalCostMtdUsd,
    };
}

export const requestsHandler = async (c: Context): Promise<Response> => {
    // PLAN-038 TASK-014 — swapped from loadDashboardStub() to the real
    // request-ledger reader. Empty state-dir → honest empty table.
    const items: DashboardRequest[] = await readRequestLedger();
    const totalCostMtdUsd = await readMtdSpend();
    const aggregates = computeRequestsAggregates(items, totalCostMtdUsd);
    return renderPage(c, "requests", { items, aggregates });
};
