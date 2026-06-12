// #396 — costs surface honesty: zero-filled 30-day series (sane run
// rate), month-scoped avg/request denominator, no invented $500/$400 cap.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCostsData } from "../../server/wiring/costs-readers";
import { projectMonthEnd } from "../../server/lib/costs-projection";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "costs396-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function isoDaysAgo(n: number): string {
    const now = new Date();
    return new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - n,
    )).toISOString().slice(0, 10);
}

describe("costs series honesty (#396)", () => {
    test("points are the last 30 CALENDAR days, zero-filled", async () => {
        const ledger = join(dir, "ledger.json");
        writeFileSync(ledger, JSON.stringify({
            daily: {
                [isoDaysAgo(1)]: { total_usd: 6.1, sessions: [] },
                // a month-old sparse entry must not crowd the window
                "2026-01-01": { total_usd: 99, sessions: [] },
            },
        }));
        const s = await readCostsData({ ledgerPath: ledger });
        expect(s.points).toHaveLength(30);
        expect(s.points[28]!.value).toBeCloseTo(6.1);
        expect(s.points.filter((p) => p.value > 0)).toHaveLength(1);
    });

    test("trailing-7 run rate uses calendar days (sparse history can't inflate it)", async () => {
        const ledger = join(dir, "ledger.json");
        writeFileSync(ledger, JSON.stringify({
            daily: {
                [isoDaysAgo(2)]: { total_usd: 14.0, sessions: [] },
                [isoDaysAgo(1)]: { total_usd: 7.0, sessions: [] },
                "2026-01-05": { total_usd: 500, sessions: [] }, // ancient spike
            },
        }));
        const s = await readCostsData({ ledgerPath: ledger });
        const proj = projectMonthEnd({
            series: s.points,
            mtd: 21,
            cap: 100,
            today: new Date(),
        });
        expect(proj.runRateDaily).toBeCloseTo(21 / 7, 1); // 3.0, not 75+
    });

    test("avg/request denominator is month-scoped distinct requests", async () => {
        const monthDay = new Date().toISOString().slice(0, 10);
        const ledger = join(dir, "ledger.json");
        writeFileSync(ledger, JSON.stringify({
            daily: {
                [monthDay]: { total_usd: 20, sessions: [
                    { request_id: "REQ-000016" },
                    { request_id: "REQ-000016" },
                    { request_id: "REQ-000017" },
                ] },
                "2026-01-01": { total_usd: 50, sessions: [
                    { request_id: "REQ-000001" }, { request_id: "REQ-000002" },
                ] },
            },
        }));
        const s = await readCostsData({ ledgerPath: ledger });
        expect(s.requestCount).toBe(2); // not 4 (all-time)
    });

    test("no cap configured → costCap null (never invented)", async () => {
        const ledger = join(dir, "ledger.json");
        writeFileSync(ledger, JSON.stringify({ daily: {} }));
        const s = await readCostsData({ ledgerPath: ledger });
        expect(s.costCap).toBeNull();
        expect(s.budgetUsd).toBeNull();
    });
});
