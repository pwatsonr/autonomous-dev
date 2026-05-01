// SPEC-015-3-04 — CostCapMonitor unit suite.
//
// All four severity outcomes (ok/warn/exceeded/null) are exercised, plus
// month-end projection arithmetic on day 1 and day 10.

import { describe, expect, test } from "bun:test";

import { CostAggregator } from "../../server/cost/aggregator";
import { CostCapMonitor } from "../../server/cost/cap_monitor";
import type { CapConfig, CostLedgerEntry } from "../../server/cost/types";

function entry(over: Partial<CostLedgerEntry> = {}): CostLedgerEntry {
    return {
        timestamp: "2026-04-15T12:00:00Z",
        request_id: "REQ-000001",
        repository: "/repo/a",
        phase: "Code",
        cost_tokens: 1000,
        cost_usd: 0.5,
        model: "claude-opus-4",
        operation: "session.spawn",
        ...over,
    };
}

function makeMonitor(
    cfg: CapConfig,
    clockIso: string,
): CostCapMonitor {
    const clock = (): Date => new Date(clockIso);
    const agg = new CostAggregator("/nonexistent", clock);
    return new CostCapMonitor(agg, async () => cfg, clock);
}

describe("CostCapMonitor.dailyStatus", () => {
    test("returns null when daily_usd unset", async () => {
        const m = makeMonitor({}, "2026-04-15T12:00:00Z");
        const r = await m.dailyStatus([]);
        expect(r).toBeNull();
    });

    test("returns null when daily_usd <= 0 (treated as unset)", async () => {
        const m = makeMonitor({ daily_usd: -1 }, "2026-04-15T12:00:00Z");
        expect(await m.dailyStatus([])).toBeNull();
        const m0 = makeMonitor({ daily_usd: 0 }, "2026-04-15T12:00:00Z");
        expect(await m0.dailyStatus([])).toBeNull();
    });

    test("50% spend → severity=ok", async () => {
        const m = makeMonitor({ daily_usd: 100 }, "2026-04-15T12:00:00Z");
        const entries: CostLedgerEntry[] = [
            entry({ timestamp: "2026-04-15T01:00:00Z", cost_usd: 50 }),
        ];
        const r = await m.dailyStatus(entries);
        expect(r?.severity).toBe("ok");
        expect(r?.pct_of_limit).toBe(50);
    });

    test("80% spend → severity=warn", async () => {
        const m = makeMonitor({ daily_usd: 100 }, "2026-04-15T12:00:00Z");
        const entries: CostLedgerEntry[] = [
            entry({ timestamp: "2026-04-15T01:00:00Z", cost_usd: 80 }),
        ];
        const r = await m.dailyStatus(entries);
        expect(r?.severity).toBe("warn");
    });

    test("100% spend → severity=exceeded", async () => {
        const m = makeMonitor({ daily_usd: 100 }, "2026-04-15T12:00:00Z");
        const entries: CostLedgerEntry[] = [
            entry({ timestamp: "2026-04-15T01:00:00Z", cost_usd: 100 }),
        ];
        const r = await m.dailyStatus(entries);
        expect(r?.severity).toBe("exceeded");
    });

    test("150% spend → severity=exceeded with pct=150", async () => {
        const m = makeMonitor({ daily_usd: 100 }, "2026-04-15T12:00:00Z");
        const entries: CostLedgerEntry[] = [
            entry({ timestamp: "2026-04-15T01:00:00Z", cost_usd: 150 }),
        ];
        const r = await m.dailyStatus(entries);
        expect(r?.severity).toBe("exceeded");
        expect(r?.pct_of_limit).toBe(150);
    });
});

describe("CostCapMonitor.monthlyStatus", () => {
    test("day 10 of 30-day month, $100 spent → projected=$300", async () => {
        // April 2026 has 30 days. Day-of-month 10.
        const m = makeMonitor({ monthly_usd: 1000 }, "2026-04-10T12:00:00Z");
        const entries: CostLedgerEntry[] = [
            entry({ timestamp: "2026-04-10T01:00:00Z", cost_usd: 100 }),
        ];
        const r = await m.monthlyStatus(entries);
        expect(r?.projected_total_usd).toBe(300);
    });

    test("day 1 → projection = current * days_in_month", async () => {
        // March 2026 has 31 days.
        const m = makeMonitor({ monthly_usd: 1000 }, "2026-03-01T12:00:00Z");
        const entries: CostLedgerEntry[] = [
            entry({ timestamp: "2026-03-01T01:00:00Z", cost_usd: 5 }),
        ];
        const r = await m.monthlyStatus(entries);
        expect(r?.projected_total_usd).toBe(5 * 31);
    });

    test("returns null when monthly_usd unset", async () => {
        const m = makeMonitor({}, "2026-04-15T00:00:00Z");
        expect(await m.monthlyStatus([])).toBeNull();
    });
});
