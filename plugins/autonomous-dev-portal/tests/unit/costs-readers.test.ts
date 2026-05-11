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
        // kit-parity has 10 daily entries.
        expect(series.points.length).toBe(10);
        // All points have a non-negative value.
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

    test("requestCount reflects the request ledger", async () => {
        const series = await readCostsData();
        // kit-parity has 9 request-actions/*.json files.
        expect(series.requestCount).toBe(9);
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
        expect(series.points.length).toBe(0);
        expect(series.totalMtd).toBe(0);
        expect(series.requestCount).toBe(0);
        expect(series.reviewerSpend).toEqual([]);
        expect(series.phaseSpend).toEqual([]);
        expect(series.deploySpend).toEqual([]);
    });
});
