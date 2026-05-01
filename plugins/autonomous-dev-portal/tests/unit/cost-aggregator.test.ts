// SPEC-015-3-04 — CostAggregator unit suite.
//
// Covers loadLedger malformed-line tolerance, daily/monthly zero-fill,
// per-repo + per-phase rollups, top-N tie-break, and 7-day projection
// edge cases (no data / partial week / full week).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CostAggregator } from "../../server/cost/aggregator";
import type { CostLedgerEntry } from "../../server/cost/types";

interface Ctx {
    dir: string;
}

const ctx: Ctx = { dir: "" };

function setupRepo(): { dir: string; ledgerPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "cost-agg-"));
    return { dir, ledgerPath: join(dir, "cost-ledger.jsonl") };
}

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

function writeJsonl(path: string, entries: CostLedgerEntry[]): void {
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n"));
}

beforeEach(() => {
    ctx.dir = "";
});

afterEach(() => {
    if (ctx.dir) rmSync(ctx.dir, { recursive: true, force: true });
});

describe("CostAggregator.loadLedger", () => {
    test("missing ledger file returns []", async () => {
        const { dir, ledgerPath } = setupRepo();
        ctx.dir = dir;
        const agg = new CostAggregator(ledgerPath);
        const out = await agg.loadLedger();
        expect(out).toEqual([]);
    });

    test("parses 1000 valid lines without skips", async () => {
        const { dir, ledgerPath } = setupRepo();
        ctx.dir = dir;
        const entries: CostLedgerEntry[] = [];
        for (let i = 0; i < 1000; i += 1) {
            entries.push(
                entry({
                    request_id: `REQ-${String(100000 + i).padStart(6, "0")}`,
                }),
            );
        }
        writeJsonl(ledgerPath, entries);
        const agg = new CostAggregator(ledgerPath);
        const out = await agg.loadLedger();
        expect(out.length).toBe(1000);
    });

    test("skips malformed JSON lines and continues", async () => {
        const { dir, ledgerPath } = setupRepo();
        ctx.dir = dir;
        const valid = entry();
        writeFileSync(
            ledgerPath,
            [JSON.stringify(valid), "{not json", JSON.stringify(valid)].join("\n"),
        );
        const warns: string[] = [];
        const agg = new CostAggregator(ledgerPath, () => new Date(), {
            warn: (m) => warns.push(m),
        });
        const out = await agg.loadLedger();
        expect(out.length).toBe(2);
        expect(warns.some((w) => w.includes("malformed"))).toBe(true);
    });

    test("drops negative cost_usd entries", async () => {
        const { dir, ledgerPath } = setupRepo();
        ctx.dir = dir;
        writeJsonl(ledgerPath, [entry({ cost_usd: -1 }), entry({ cost_usd: 1 })]);
        const agg = new CostAggregator(ledgerPath);
        const out = await agg.loadLedger();
        expect(out.length).toBe(1);
        expect(out[0]!.cost_usd).toBe(1);
    });
});

describe("CostAggregator rollups", () => {
    test("empty entries → all rollups return zero/empty", () => {
        const agg = new CostAggregator("/nonexistent");
        expect(agg.daily([], "2026-04-01", "2026-04-07")).toHaveLength(7);
        expect(agg.byRepository([])).toEqual([]);
        expect(agg.byPhase([])).toHaveLength(7);
        expect(agg.topExpensive([], 10)).toEqual([]);
    });

    test("daily produces 7 entries with zero-fill", () => {
        const agg = new CostAggregator("/x");
        const entries: CostLedgerEntry[] = [
            entry({ timestamp: "2026-04-01T00:00:00Z", cost_usd: 1 }),
            entry({ timestamp: "2026-04-03T00:00:00Z", cost_usd: 2 }),
        ];
        const out = agg.daily(entries, "2026-04-01", "2026-04-07");
        expect(out.length).toBe(7);
        expect(out[0]!.date).toBe("2026-04-01");
        expect(out[6]!.date).toBe("2026-04-07");
        expect(out[1]!.total_cost_usd).toBe(0); // zero-fill day 02
    });

    test("monthly aggregates across year boundary", () => {
        const agg = new CostAggregator("/x");
        const entries: CostLedgerEntry[] = [
            entry({ timestamp: "2025-12-15T00:00:00Z", cost_usd: 5 }),
            entry({ timestamp: "2026-01-15T00:00:00Z", cost_usd: 7 }),
        ];
        const out = agg.monthly(entries, "2025-12", "2026-01");
        expect(out.length).toBe(2);
        expect(out[0]!.month).toBe("2025-12");
        expect(out[0]!.total_cost_usd).toBe(5);
        expect(out[1]!.month).toBe("2026-01");
        expect(out[1]!.total_cost_usd).toBe(7);
    });

    test("byRepository percentages sum to 100", () => {
        const agg = new CostAggregator("/x");
        const entries: CostLedgerEntry[] = [
            entry({ repository: "/r/a", cost_usd: 30, request_id: "REQ-000001" }),
            entry({ repository: "/r/b", cost_usd: 70, request_id: "REQ-000002" }),
        ];
        const out = agg.byRepository(entries);
        expect(out.length).toBe(2);
        const total = out.reduce((a, r) => a + r.pct_of_total, 0);
        expect(Math.abs(total - 100)).toBeLessThan(0.01);
        expect(out[0]!.repository).toBe("/r/b"); // sorted desc
    });

    test("byPhase always returns 7 entries in canonical order", () => {
        const agg = new CostAggregator("/x");
        const out = agg.byPhase([entry({ phase: "Code", cost_usd: 1 })]);
        expect(out.length).toBe(7);
        expect(out.map((p) => p.phase)).toEqual([
            "PRD",
            "TDD",
            "Plan",
            "Spec",
            "Code",
            "Review",
            "Deploy",
        ]);
    });

    test("topExpensive sorts desc with request_id tie-break", () => {
        const agg = new CostAggregator("/x");
        const entries: CostLedgerEntry[] = [
            entry({ request_id: "REQ-000005", cost_usd: 10 }),
            entry({ request_id: "REQ-000002", cost_usd: 10 }),
            entry({ request_id: "REQ-000003", cost_usd: 20 }),
        ];
        const out = agg.topExpensive(entries, 10);
        expect(out[0]!.request_id).toBe("REQ-000003");
        expect(out[1]!.request_id).toBe("REQ-000002"); // tie → ascending id
        expect(out[2]!.request_id).toBe("REQ-000005");
        expect(out[0]!.drill_down_url).toBe("/requests/REQ-000003");
    });

    test("topExpensive(_, 0) returns []", () => {
        const agg = new CostAggregator("/x");
        expect(agg.topExpensive([entry()], 0)).toEqual([]);
    });

    test("projectSevenDay no data → all zeros", () => {
        const agg = new CostAggregator("/x", () => new Date("2026-04-15T12:00:00Z"));
        const out = agg.projectSevenDay([]);
        expect(out).toEqual({
            trailing_avg_usd_per_day: 0,
            projected_seven_day_usd: 0,
            basis_days: 0,
        });
    });

    test("projectSevenDay 3 days → basis_days=3, projection=avg*7", () => {
        const agg = new CostAggregator(
            "/x",
            () => new Date("2026-04-15T12:00:00Z"),
        );
        const entries: CostLedgerEntry[] = [
            entry({ timestamp: "2026-04-13T00:00:00Z", cost_usd: 3 }),
            entry({ timestamp: "2026-04-14T00:00:00Z", cost_usd: 6 }),
            entry({ timestamp: "2026-04-15T00:00:00Z", cost_usd: 9 }),
        ];
        const out = agg.projectSevenDay(entries);
        expect(out.basis_days).toBe(3);
        expect(out.trailing_avg_usd_per_day).toBe(6);
        expect(out.projected_seven_day_usd).toBe(42);
    });
});
