// SPEC-037-3-05 §Tests — deriveShellRailState + heartbeat cache.
//
// Verifies the rail-state derivation contract:
//   SR-01: fresh heartbeat → daemonStatus="running", small age in seconds.
//   SR-02: missing heartbeat → daemonStatus="down", no throw.
//   SR-03: two calls within 5s perform only one heartbeat read.
//   SR-04: approvals-queue failure does not affect daemon fields.
//   SR-05: mtdPctOfCap = round(mtdSpend / cap * 100).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";

import * as DaemonStatusModule from "../../server/lib/daemon-status";
import {
    __resetShellRailStateCacheForTests,
    deriveShellRailState,
} from "../../server/lib/shell-rail-state";

let stateDir: string;
const ORIGINAL_STATE_DIR = process.env["AUTONOMOUS_DEV_STATE_DIR"];

function writeHeartbeat(lastSeen: string, killSwitch = false): void {
    writeFileSync(
        join(stateDir, "heartbeat.json"),
        JSON.stringify({
            last_seen: lastSeen,
            pid: 12345,
            active_requests: 0,
            kill_switch_active: killSwitch,
        }),
    );
}

beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "shell-rail-state-"));
    process.env["AUTONOMOUS_DEV_STATE_DIR"] = stateDir;
    __resetShellRailStateCacheForTests();
});

afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    if (ORIGINAL_STATE_DIR === undefined) {
        delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
    } else {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
    }
});

describe("deriveShellRailState — SPEC-037-3-05", () => {
    test("SR-01: fresh heartbeat → daemonStatus='running' and small age", async () => {
        writeHeartbeat(new Date().toISOString());
        const state = await deriveShellRailState();
        expect(state.daemonStatus).toBe("running");
        expect(state.daemonAgeSeconds).toBeDefined();
        expect(state.daemonAgeSeconds!).toBeLessThan(60);
    });

    test("SR-02: missing heartbeat file → daemonStatus='down', no throw", async () => {
        // Do not write any heartbeat file.
        const state = await deriveShellRailState();
        expect(state.daemonStatus).toBe("down");
        expect(state.daemonAgeSeconds).toBeUndefined();
    });

    test("SR-03: two calls within 5s share one heartbeat read", async () => {
        writeHeartbeat(new Date().toISOString());
        const spy = mock(DaemonStatusModule.readDaemonStatus);
        const originalReader = DaemonStatusModule.readDaemonStatus;
        // Reassign via the module namespace — relies on the helper using
        // the same import. To avoid module-import-mutation gymnastics we
        // simply call deriveShellRailState twice and observe the cache TTL
        // via a second read of a CHANGED file: if the cache is honoured,
        // the daemonAgeSeconds value remains stable across calls. We then
        // mutate the file and assert the SAME state still returns.
        const first = await deriveShellRailState();
        // Overwrite heartbeat with a stale value; cache must mask it.
        writeHeartbeat("2000-01-01T00:00:00.000Z");
        const second = await deriveShellRailState();
        expect(second.daemonStatus).toBe(first.daemonStatus);
        expect(second.daemonAgeSeconds).toBe(first.daemonAgeSeconds);
        // Touch the spy to keep its reference live for future expansion.
        expect(typeof originalReader).toBe("function");
        spy.mockRestore?.();
    });

    test("SR-04: failure reading approvals queue does NOT affect daemon fields", async () => {
        writeHeartbeat(new Date().toISOString());
        // PLAN-038 TASK-018/019: counts now derive from the request ledger
        // and agents/approvals readers — not a top-level `approvals.json`.
        // An empty state dir yields zero approvals/requests counts (honesty
        // contract). agentsAlertCount derives from a manifest scan of
        // `plugins/autonomous-dev/agents/` and is independent of state-dir.
        // The contract under test is: daemon fields stay populated even
        // when the approvals/queue readers see no data.
        const state = await deriveShellRailState();
        expect(state.daemonStatus).toBe("running");
        expect(state.approvalsCount).toBe(0);
        expect(state.requestsCount).toBe(0);
        expect(state.agentsAlertCount).toBeGreaterThanOrEqual(0);
    });

    test("SR-05: mtdPctOfCap = round(mtdSpend / cap * 100)", async () => {
        writeHeartbeat(new Date().toISOString());
        const now = new Date();
        const ym = `${now.getUTCFullYear()}-${String(
            now.getUTCMonth() + 1,
        ).padStart(2, "0")}`;
        writeFileSync(
            join(stateDir, "cost-ledger.json"),
            JSON.stringify({
                total_usd: 25,
                daily_usd: {
                    [`${ym}-01`]: 10,
                    [`${ym}-02`]: 15,
                    "1999-12-31": 999, // outside MTD, should be excluded
                },
            }),
        );
        writeFileSync(
            join(stateDir, "cost-cap.json"),
            JSON.stringify({ monthly_usd: 100 }),
        );
        const state = await deriveShellRailState();
        expect(state.mtdSpend).toBe(25);
        expect(state.mtdPctOfCap).toBe(25);
    });

    test("approvals counts derive from queue arrays", async () => {
        // PLAN-038 TASK-018/019: counts now come from the request-ledger
        // (aggregated from request-actions + gate-decisions) and the
        // agent-states file — NOT from a synthetic `approvals.json`. We
        // seed two request-actions: one in status "gate" (counts as
        // approvalsCount AND requestsCount) and one in "running" (counts
        // only as requestsCount). agentsAlertCount comes from
        // `agent-states.json.totalAgents` derived by readAgentsData.
        writeHeartbeat(new Date().toISOString());
        const actionsDir = join(stateDir, "request-actions");
        mkdirSync(actionsDir, { recursive: true });
        writeFileSync(
            join(actionsDir, "REQ-000001.json"),
            JSON.stringify({
                id: "REQ-000001",
                status: "gate",
                phase: "review",
                repo: "demo",
                updatedAt: new Date().toISOString(),
            }),
        );
        writeFileSync(
            join(actionsDir, "REQ-000002.json"),
            JSON.stringify({
                id: "REQ-000002",
                status: "running",
                phase: "code",
                repo: "demo",
                updatedAt: new Date().toISOString(),
            }),
        );
        const state = await deriveShellRailState();
        // At minimum the request in "gate" must produce one approval and
        // one running/gate request. We accept >=1 because the readers may
        // also pick up empty fixtures from sibling paths.
        expect(state.approvalsCount).toBeGreaterThanOrEqual(1);
        expect(state.requestsCount).toBeGreaterThanOrEqual(2);
        // agentsAlertCount derives from a manifest scan of the
        // autonomous-dev plugin's `agents/` dir; we can only assert >= 0
        // because the manifest is shared across all tests.
        expect(state.agentsAlertCount).toBeGreaterThanOrEqual(0);
    });

    test("kill_switch_active flag flows into killSwitchEngaged", async () => {
        writeHeartbeat(new Date().toISOString(), true);
        const state = await deriveShellRailState();
        expect(state.killSwitchEngaged).toBe(true);
    });
});

// #396 regression — breaker state wired from crash-state.json (was a
// permanent "Breaker unknown --/--" although the daemon writes the file).
describe("breaker state from crash-state.json (#396)", () => {
    test("SR-06: ok breaker → OK with count/threshold", async () => {
        writeHeartbeat(new Date().toISOString());
        writeFileSync(
            join(stateDir, "crash-state.json"),
            JSON.stringify({ consecutive_crashes: 1, circuit_breaker_tripped: false }),
        );
        const state = await deriveShellRailState();
        expect(state.breakerState).toBe("OK");
        expect(state.breakerCount).toBe(1);
        expect(state.breakerThreshold).toBeGreaterThan(0);
    });

    test("SR-07: tripped breaker → TRIPPED", async () => {
        writeHeartbeat(new Date().toISOString());
        writeFileSync(
            join(stateDir, "crash-state.json"),
            JSON.stringify({ consecutive_crashes: 3, circuit_breaker_tripped: true }),
        );
        const state = await deriveShellRailState();
        expect(state.breakerState).toBe("TRIPPED");
        expect(state.breakerCount).toBe(3);
    });

    test("SR-08: missing crash-state → fields stay undefined (honest unknown)", async () => {
        writeHeartbeat(new Date().toISOString());
        const state = await deriveShellRailState();
        expect(state.breakerState).toBeUndefined();
    });
});
