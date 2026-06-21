// PLAN-038 TASK-016 — Costs composition reader tests.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetDaemonReaderCacheForTests } from "../../server/wiring/daemon-readers";
import { readCostsData } from "../../server/wiring/costs-readers";
import { kitParityFixtureRoot } from "../../server/wiring/state-paths";

const ORIGINAL_STATE_DIR = process.env["AUTONOMOUS_DEV_STATE_DIR"];
const ORIGINAL_NOW = process.env["AUTONOMOUS_DEV_NOW"];

// #361: the kit-parity fixture is now dated relative to a frozen reference
// clock so the windowed readers (30-day chart, MTD, month request count) are
// deterministic. The ledger has late-May (9 days @ $8) + June 1–21 (21 days
// @ $10) entries; under T the 30-day window is 2026-05-23..06-21 (all filled).
const T = "2026-06-21T12:00:00Z";

describe("readCostsData — kit-parity fixture", () => {
    beforeAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = kitParityFixtureRoot();
        process.env["AUTONOMOUS_DEV_NOW"] = T;
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
        if (ORIGINAL_NOW === undefined) {
            delete process.env["AUTONOMOUS_DEV_NOW"];
        } else {
            process.env["AUTONOMOUS_DEV_NOW"] = ORIGINAL_NOW;
        }
    });

    test("emits a daily chart series from cost-ledger.json", async () => {
        const series = await readCostsData();
        // #396/#361: the series is the last 30 CALENDAR days, zero-filled.
        // Under the frozen clock the window captures the whole fixture:
        // points[0] = 2026-05-23 ($8), points[29] = today 2026-06-21 ($10).
        expect(series.points.length).toBe(30);
        expect(series.points[0]?.value).toBe(8);
        expect(series.points[29]?.value).toBe(10);
    });

    test("reviewer / phase / deploy tables empty on real install (O.Q. #6)", async () => {
        const series = await readCostsData();
        expect(series.reviewerSpend).toEqual([]);
        expect(series.phaseSpend).toEqual([]);
        expect(series.deploySpend).toEqual([]);
    });

    test("MTD + requestCount are month-scoped from ledger sessions (#396)", async () => {
        const series = await readCostsData();
        // #396: the avg/request denominator counts DISTINCT request ids with
        // sessions in the CURRENT month. Under T (June) the fixture has 21
        // June days, each with one distinct request id, summing to $210 MTD.
        expect(series.totalMtd).toBe(210);
        expect(series.requestCount).toBe(21);
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
