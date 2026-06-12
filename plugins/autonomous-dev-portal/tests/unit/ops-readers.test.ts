// PLAN-038 TASK-017 — Ops composition reader tests.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readOpsHealth } from "../../server/wiring/ops-readers";

const ORIGINAL_STATE_DIR = process.env["AUTONOMOUS_DEV_STATE_DIR"];

describe("readOpsHealth — empty state-dir (honesty contract)", () => {
    let emptyDir: string;
    beforeAll(() => {
        emptyDir = mkdtempSync(join(tmpdir(), "PLAN-038-ops-empty-"));
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = emptyDir;
    });
    afterAll(() => {
        rmSync(emptyDir, { recursive: true, force: true });
        if (ORIGINAL_STATE_DIR === undefined) {
            delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
        } else {
            process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
        }
    });

    test("with no heartbeat, daemon renders dead + last-heartbeat dash", async () => {
        const ops = await readOpsHealth();
        // Daemon goes to "dead" when heartbeat is missing.
        expect(ops.daemon.status).toBe("dead");
        expect(ops.daemon.pid).toBeNull();
        // Crawl p6: the old `uptime` field put the string "alive" in a
        // duration row — replaced by the honest relative timestamp.
        expect(ops.lastHeartbeat).toBe("—");
    });

    test("untracked subsystems are empty (not fake fixtures)", async () => {
        const ops = await readOpsHealth();
        expect(ops.mcpServers).toEqual([]);
        expect(ops.deployEvents).toEqual([]);
        expect(ops.standardsChanges).toEqual([]);
        expect(ops.standardsCount).toBe(0);
        expect(ops.heartbeat).toEqual([]);
    });

    test("plugin chain reads real plugin manifests (≥1 entry from this workspace)", async () => {
        const ops = await readOpsHealth();
        // The workspace has plugins/autonomous-dev*, so at least one
        // CORE category should populate from the manifest scan.
        expect((ops.pluginChain ?? []).length).toBeGreaterThanOrEqual(1);
        const core = ops.pluginChain?.[0];
        expect(core?.name).toBe("CORE");
        // No fake versions; manifest scan returns real packages.
        for (const pkg of core?.packages ?? []) {
            expect(pkg).toMatch(/@/); // name@version format
            // No fictional "autonomous-dev@2.4.0" — version comes from
            // the manifest, which is currently 0.x.
            expect(pkg).not.toBe("autonomous-dev@2.4.0");
        }
    });
});
