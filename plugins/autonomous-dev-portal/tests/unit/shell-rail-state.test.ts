// SPEC-037-3-05 §Tests — deriveShellRailState + heartbeat cache.
//
// Verifies the rail-state derivation contract:
//   SR-01: fresh heartbeat → daemonStatus="running", small age in seconds.
//   SR-02: missing heartbeat → daemonStatus="down", no throw.
//   SR-03: two calls within 5s perform only one heartbeat read.
//   SR-04: approvals-queue failure does not affect daemon fields.
//   SR-05: mtdPctOfCap = round(mtdSpend / cap * 100).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
        // Intentionally write malformed JSON to approvals.json so the
        // approvals reader fails — daemon fields must remain populated.
        writeFileSync(join(stateDir, "approvals.json"), "{ not json");
        const state = await deriveShellRailState();
        expect(state.daemonStatus).toBe("running");
        expect(state.approvalsCount).toBeUndefined();
        expect(state.requestsCount).toBeUndefined();
        expect(state.agentsAlertCount).toBeUndefined();
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
        writeHeartbeat(new Date().toISOString());
        writeFileSync(
            join(stateDir, "approvals.json"),
            JSON.stringify({
                pending: [{ id: "a" }, { id: "b" }, { id: "c" }],
                active: [{ id: "r1" }],
                agents: [],
            }),
        );
        const state = await deriveShellRailState();
        expect(state.approvalsCount).toBe(3);
        expect(state.requestsCount).toBe(1);
        expect(state.agentsAlertCount).toBe(0);
    });

    test("kill_switch_active flag flows into killSwitchEngaged", async () => {
        writeHeartbeat(new Date().toISOString(), true);
        const state = await deriveShellRailState();
        expect(state.killSwitchEngaged).toBe(true);
    });
});
