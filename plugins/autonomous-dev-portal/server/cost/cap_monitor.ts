// SPEC-015-3-01 — CostCapMonitor: daily/monthly cap evaluation.
//
// Reads cap config via an injected getter (PLAN-015-2 owns settings).
// Returns null when a cap is unconfigured or non-positive — UI uses
// null to suppress the card entirely.

import type { CostAggregator } from "./aggregator";
import type {
    CapConfig,
    CapStatus,
    CostLedgerEntry,
} from "./types";

const WARN_PCT = 80;
const EXCEED_PCT = 100;

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

function severityFor(pct: number): CapStatus["severity"] {
    if (pct >= EXCEED_PCT) return "exceeded";
    if (pct >= WARN_PCT) return "warn";
    return "ok";
}

function daysInMonth(year: number, monthIdx: number): number {
    // monthIdx is 0-based. Day 0 of next month == last day of current.
    return new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
}

export class CostCapMonitor {
    constructor(
        // aggregator is reserved for future cross-method access
        // (e.g. aggregating without a passed-in entries slice).
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        private readonly aggregator: CostAggregator,
        private readonly getConfig: () => Promise<CapConfig>,
        private readonly clock: () => Date = () => new Date(),
    ) {}

    async dailyStatus(
        entries: ReadonlyArray<CostLedgerEntry>,
    ): Promise<CapStatus | null> {
        const cfg = await this.getConfig();
        const limit = cfg.daily_usd;
        if (limit === undefined || limit <= 0) return null;
        const today = this.clock().toISOString().slice(0, 10);
        let current = 0;
        for (const e of entries) {
            if (e.timestamp.slice(0, 10) === today) current += e.cost_usd;
        }
        const pct = round2((current / limit) * 100);
        return {
            scope: "daily",
            current_usd: round2(current),
            limit_usd: limit,
            pct_of_limit: pct,
            severity: severityFor(pct),
        };
    }

    async monthlyStatus(
        entries: ReadonlyArray<CostLedgerEntry>,
    ): Promise<CapStatus | null> {
        const cfg = await this.getConfig();
        const limit = cfg.monthly_usd;
        if (limit === undefined || limit <= 0) return null;
        const now = this.clock();
        const month = now.toISOString().slice(0, 7);
        let current = 0;
        for (const e of entries) {
            if (e.timestamp.slice(0, 7) === month) current += e.cost_usd;
        }
        const pct = round2((current / limit) * 100);
        const day = now.getUTCDate();
        const dim = daysInMonth(now.getUTCFullYear(), now.getUTCMonth());
        const projected =
            day > 0 ? round2(current * (dim / day)) : round2(current);
        return {
            scope: "monthly",
            current_usd: round2(current),
            limit_usd: limit,
            pct_of_limit: pct,
            severity: severityFor(pct),
            projected_total_usd: projected,
        };
    }
}
