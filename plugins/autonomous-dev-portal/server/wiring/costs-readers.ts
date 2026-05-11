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
import { readRequestLedger, type RequestLedgerReaderOptions } from "./request-ledger-reader";

interface CostLedgerFile {
    daily?: Record<string, { total_usd?: number } | undefined>;
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
    try {
        const raw = await readFile(path, "utf-8");
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

/** Convert cost-ledger.daily into a stable-ordered CostPoint[]. */
function dailyToPoints(
    daily: Record<string, { total_usd?: number } | undefined> | undefined,
): CostPoint[] {
    if (daily === undefined) return [];
    const entries = Object.entries(daily)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)); // chronological
    return entries.map(([date, v]) => ({
        label: date.slice(-2), // "d10" → "10"; chart x-axis is compact
        value: typeof v?.total_usd === "number" ? v.total_usd : 0,
    }));
}

export interface CostsReaderOptions extends RequestLedgerReaderOptions {
    /** Override the cost-ledger.json path. */
    ledgerPath?: string;
    /** Monthly cap for the cost ring + projection. Default $500. */
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
    const monthlyCap = opts.monthlyCap ?? 500;

    // Per O.Q. #6: per-reviewer / per-phase / per-deploy breakdowns are
    // not tracked by the daemon. The view's render-time code already
    // tolerates undefined for these fields; we explicitly emit empty
    // arrays so the table renders headers + the honest "not tracked"
    // disclosure (rendered by the view layer when the array is empty).
    const phaseSpend: NonNullable<CostSeries["phaseSpend"]> = [];
    const reviewerSpend: NonNullable<CostSeries["reviewerSpend"]> = [];
    const deploySpend: NonNullable<CostSeries["deploySpend"]> = [];

    // Request count for the "avg / request" KPI.
    const requests = await readRequestLedger(opts);

    return {
        points,
        budgetUsd: monthlyCap,
        phaseSpend,
        reviewerSpend,
        deploySpend,
        totalMtd,
        requestCount: requests.length,
        costCap: monthlyCap,
    };
}
