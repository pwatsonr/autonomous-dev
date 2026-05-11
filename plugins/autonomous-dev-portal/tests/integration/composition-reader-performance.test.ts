// PLAN-038 TASK-021 / TDD-037 AC-3715 — composition reader performance.
//
// Pins: cold dashboard render against the kit-parity fixture state-dir
// must complete in ≤50ms p95 over 10 runs. The cache is cleared before
// each run so we measure true cold-cache I/O.
//
// If 50ms turns out to be too aggressive on CI (file I/O variance), the
// threshold can be relaxed to ≤100ms with a one-line change here and a
// note in the PR description — see PLAN-038 O.Q. #1.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { __resetDaemonReaderCacheForTests } from "../../server/wiring/daemon-readers";
import { readDashboardData } from "../../server/wiring/dashboard-readers";
import { kitParityFixtureRoot } from "../../server/wiring/state-paths";

const ORIGINAL_STATE_DIR = process.env["AUTONOMOUS_DEV_STATE_DIR"];
const P95_THRESHOLD_MS = 50;
const RUN_COUNT = 10;

describe("composition reader performance (AC-3715)", () => {
    beforeAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = kitParityFixtureRoot();
    });
    afterAll(() => {
        if (ORIGINAL_STATE_DIR === undefined) {
            delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
        } else {
            process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
        }
    });

    test(`p95 of cold readDashboardData() ≤ ${P95_THRESHOLD_MS}ms over ${RUN_COUNT} runs`, async () => {
        const durationsMs: number[] = [];
        for (let i = 0; i < RUN_COUNT; i++) {
            __resetDaemonReaderCacheForTests();
            const start = performance.now();
            await readDashboardData();
            durationsMs.push(performance.now() - start);
        }
        durationsMs.sort((a, b) => a - b);
        // p95 of a 10-run sample is the 9th element (0-indexed: 8).
        const p95 = durationsMs[Math.floor(RUN_COUNT * 0.95) - 1] ?? 0;
        // Provide a useful diagnostic when the assertion fails.
        if (p95 > P95_THRESHOLD_MS) {
            console.error(
                `p95=${p95.toFixed(2)}ms; durations=${durationsMs
                    .map((d) => d.toFixed(2))
                    .join(", ")}`,
            );
        }
        expect(p95).toBeLessThanOrEqual(P95_THRESHOLD_MS);
    });
});
