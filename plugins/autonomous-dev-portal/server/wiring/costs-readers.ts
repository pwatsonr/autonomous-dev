// PLAN-038 TASK-016 — costs composition reader.
//
// Reads the real cost-ledger.json and produces a CostSeries the Costs
// view consumes. Per PLAN-038 O.Q. #6: the cost-ledger only tracks daily
// totals (`{daily: {date: {total_usd}}}`). It does NOT track per-phase,
// per-reviewer, or per-(env,backend) breakdowns. Those tables are
// therefore EMPTY on a normal install — the view renders an honest
// "Reviewer-level cost tracking not enabled" disclosure. With the
// `kit-parity` fixture state-dir, the daily-spend chart populates
// from the fixture's 10 daily entries summing to ~$153.60.

import { readFile } from "node:fs/promises";

import type { CostPoint, CostSeries } from "../types/render";

import { costLedgerPath, readMtdSpend } from "./daemon-readers";
import { readMonthlyCapUsd } from "./dashboard-readers";
import { type RequestLedgerReaderOptions } from "./request-ledger-reader";

interface CostLedgerFile {
    daily?: Record<
        string,
        | {
              total_usd?: number;
              sessions?: Array<{ request_id?: string } | undefined>;
          }
        | undefined
    >;
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
    try {
        const raw = await readFile(path, "utf-8");
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

/**
 * Convert cost-ledger.daily into the last-30-CALENDAR-day series,
 * zero-filled (#396). The old version emitted only days present in the
 * ledger, so "last 30 days" could span months of sparse entries — which
 * also poisoned the projection's trailing-7 run rate (last 7 *entries*,
 * not last 7 days: $7.54/day rendered vs a real ~$3.00/day).
 */
function dailyToPoints(daily: CostLedgerFile["daily"]): CostPoint[] {
    const out: CostPoint[] = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
        const d = new Date(Date.UTC(
            now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i,
        ));
        const key = d.toISOString().slice(0, 10);
        const v = daily?.[key];
        out.push({
            label: key.slice(-2),
            value: typeof v?.total_usd === "number" ? v.total_usd : 0,
        });
    }
    return out;
}

/**
 * Distinct request ids with ledger sessions in the CURRENT month (#396).
 * The avg/request KPI divides MTD spend by this; the old denominator was
 * the all-time request count, deflating the average (e.g. $2.10 vs $10.53).
 */
function countMonthRequests(daily: CostLedgerFile["daily"]): number {
    const monthPrefix = new Date().toISOString().slice(0, 7);
    const ids = new Set<string>();
    for (const [date, day] of Object.entries(daily ?? {})) {
        if (!date.startsWith(monthPrefix)) continue;
        for (const s of day?.sessions ?? []) {
            if (typeof s?.request_id === "string") ids.add(s.request_id);
        }
    }
    return ids.size;
}

export interface CostsReaderOptions extends RequestLedgerReaderOptions {
    /** Override the cost-ledger.json path. */
    ledgerPath?: string;
    /** Monthly cap override; default = cost-cap.json or null (#396). */
    monthlyCap?: number;
}

export async function readCostsData(
    opts: CostsReaderOptions = {},
): Promise<CostSeries> {
    const ledgerFile = await readJsonOrNull<CostLedgerFile>(
        opts.ledgerPath ?? costLedgerPath(),
    );
    const points = dailyToPoints(ledgerFile?.daily);
    const totalMtd = await readMtdSpend();
    // #396: never invent a cap — read the configured one or carry null.
    const monthlyCap = opts.monthlyCap ?? (await readMonthlyCapUsd());

    // Per O.Q. #6: per-reviewer / per-phase / per-deploy breakdowns are
    // not tracked by the daemon. The view's render-time code already
    // tolerates undefined for these fields; we explicitly emit empty
    // arrays so the table renders headers + the honest "not tracked"
    // disclosure (rendered by the view layer when the array is empty).
    const phaseSpend: NonNullable<CostSeries["phaseSpend"]> = [];
    const reviewerSpend: NonNullable<CostSeries["reviewerSpend"]> = [];
    const deploySpend: NonNullable<CostSeries["deploySpend"]> = [];

    // Request count for the "avg / request" KPI — month-scoped (#396).
    const requestCount = countMonthRequests(ledgerFile?.daily);

    return {
        points,
        budgetUsd: monthlyCap,
        phaseSpend,
        reviewerSpend,
        deploySpend,
        totalMtd,
        requestCount,
        costCap: monthlyCap,
    };
}
