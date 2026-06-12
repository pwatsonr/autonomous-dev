// PLAN-038 TASK-016 — Costs composition reader tests.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetDaemonReaderCacheForTests } from "../../server/wiring/daemon-readers";
import { readCostsData } from "../../server/wiring/costs-readers";
import { kitParityFixtureRoot } from "../../server/wiring/state-paths";

const ORIGINAL_STATE_DIR = process.env["AUTONOMOUS_DEV_STATE_DIR"];

describe("readCostsData — kit-parity fixture", () => {
    beforeAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = kitParityFixtureRoot();
    });
    beforeEach(() => {
        __resetDaemonReaderCacheForTests();
    });
    afterAll(() => {
        if (ORIGINAL_STATE_DIR === undefined) {
            delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
        } else {
            process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
        }
    });

    test("emits a daily chart series from cost-ledger.json", async () => {
        const series = await readCostsData();
        // #396: the series is the last 30 CALENDAR days, zero-filled.
        // The kit-parity fixture's static dates fall outside the live
        // window, so values are zero — but the shape contract holds.
        expect(series.points.length).toBe(30);
        for (const p of series.points) {
            expect(p.value).toBeGreaterThanOrEqual(0);
        }
    });

    test("reviewer / phase / deploy tables empty on real install (O.Q. #6)", async () => {
        const series = await readCostsData();
        expect(series.reviewerSpend).toEqual([]);
        expect(series.phaseSpend).toEqual([]);
        expect(series.deploySpend).toEqual([]);
    });

    test("requestCount is month-scoped from ledger sessions (#396)", async () => {
        const series = await readCostsData();
        // #396: the avg/request denominator counts DISTINCT request ids
        // with sessions in the CURRENT month (the old all-time request
        // count deflated the average). The kit-parity fixture's sessions
        // carry static dates outside the current month → 0.
        expect(series.requestCount).toBe(0);
    });
});

describe("readCostsData — empty state-dir (honesty contract)", () => {
    let emptyDir: string;
    beforeAll(() => {
        emptyDir = mkdtempSync(join(tmpdir(), "PLAN-038-costs-empty-"));
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = emptyDir;
    });
    beforeEach(() => {
        __resetDaemonReaderCacheForTests();
    });
    afterAll(() => {
        rmSync(emptyDir, { recursive: true, force: true });
        if (ORIGINAL_STATE_DIR === undefined) {
            delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
        } else {
            process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
        }
    });

    test("empty state-dir yields zero KPIs across the board", async () => {
        const series = await readCostsData();
        // #396: 30 zero-filled calendar days (honest empty), not [].
        expect(series.points.length).toBe(30);
        expect(series.points.every((p) => p.value === 0)).toBe(true);
        expect(series.totalMtd).toBe(0);
        expect(series.requestCount).toBe(0);
        expect(series.costCap).toBeNull();
        expect(series.reviewerSpend).toEqual([]);
        expect(series.phaseSpend).toEqual([]);
        expect(series.deploySpend).toEqual([]);
    });
});
