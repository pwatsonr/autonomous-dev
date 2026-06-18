// SPEC-013-3-01 §Route Table — approvals (`GET /approvals`).
// SPEC-037-4-04 — propagates `costCapDailyUsd` to the view so the KPI
// strip's "Cost cap" sub-line has a real value out of the box.
// PLAN-038 TASK-013 — swapped to real approvals reader. Empty queue
// renders the honest empty-state "No approvals waiting".
//
// Finding-1 fix (punch-list): reads the `selected` query param and
// threads it into the view so row selection survives HTMX swaps.
//
// #429 — reads the `tab` query param (pending/approved/rejected) and the
// REAL gate-decision history (wiring/gate-history-reader.ts) so the
// Approved/Rejected tabs and the 7-day gate-stats card render live data.

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { readApprovalsQueue } from "../wiring/approvals-reader";
import {
    computeGateHistoryStats,
    readGateHistory,
} from "../wiring/gate-history-reader";
import type {
    ApprovalsTab,
    GateHistoryItem,
    GateStats7d,
} from "../types/render";

const GATE_STATS_WINDOW_DAYS = 7;

/** Validate the `tab` query param; default to "pending". */
function parseTab(raw: string | undefined): ApprovalsTab {
    if (raw === "approved" || raw === "rejected" || raw === "pending") {
        return raw;
    }
    return "pending";
}

export const approvalsHandler = async (c: Context): Promise<Response> => {
    const { items, costCapDailyUsd } = await readApprovalsQueue();
    // `selected` is set by the row hx-get; keep the requested row highlighted
    // across the polling swap instead of always defaulting to rows[0].
    const selectedId = c.req.query("selected") ?? undefined;
    // #391: thread the issued CSRF token so the action buttons can submit it.
    const csrfToken = (c.get("csrfToken") as string | undefined) ?? "";

    // #429: real gate-decision history powers the Approved/Rejected tabs
    // and the 7-day stats card. The reader is resilient (missing dir / bad
    // JSON → []); on any unexpected failure we degrade to an honest empty
    // history rather than 500-ing the whole page.
    const tab = parseTab(c.req.query("tab"));
    let history: GateHistoryItem[] = [];
    let gateStats: GateStats7d | null = null;
    try {
        const entries = await readGateHistory(GATE_STATS_WINDOW_DAYS);
        history = entries.map((e) => ({
            id: e.id,
            repo: e.repo,
            phase: e.phase,
            decision: e.decision,
            decidedAt: e.decidedAt,
            decidedBy: e.decidedBy,
        }));
        gateStats = computeGateHistoryStats(entries, GATE_STATS_WINDOW_DAYS);
    } catch {
        history = [];
        gateStats = null;
    }

    return renderPage(c, "approvals", {
        items,
        costCapDailyUsd,
        selectedId,
        csrfToken,
        tab,
        history,
        gateStats,
    });
};
