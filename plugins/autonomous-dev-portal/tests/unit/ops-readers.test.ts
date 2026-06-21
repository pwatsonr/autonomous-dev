// PLAN-038 TASK-017 — Ops composition reader tests.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

    test("#562: production intelligence is undefined when no observe cycle has run", async () => {
        const ops = await readOpsHealth();
        expect(ops.productionIntelligence).toBeUndefined();
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

describe("readOpsHealth — production intelligence (#562 / FR-938)", () => {
    let dir: string;
    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "ops-prod-intel-"));
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = dir;
    });
    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
        if (ORIGINAL_STATE_DIR === undefined) {
            delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
        } else {
            process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
        }
    });

    function writeSummary(obj: unknown): void {
        writeFileSync(
            join(dir, "production-intelligence.json"),
            JSON.stringify(obj),
            "utf-8",
        );
    }

    test("maps a completed observe cycle into productionIntelligence", async () => {
        writeSummary({
            last_run_id: "RUN-20260621-040000",
            last_run_at: "2026-06-21T04:00:00Z",
            services_scanned: 3,
            observations_generated: 12,
            observations_filtered: 4,
            triage_processed: 7,
            error_count: 1,
            updated_at: "2026-06-21T04:00:05Z",
        });
        const ops = await readOpsHealth();
        expect(ops.productionIntelligence).toEqual({
            lastRunId: "RUN-20260621-040000",
            lastRunAt: "2026-06-21T04:00:00Z",
            servicesScanned: 3,
            observationsGenerated: 12,
            observationsFiltered: 4,
            triageProcessed: 7,
            errorCount: 1,
        });
    });

    test("missing numeric fields default to 0 (no NaN leakage)", async () => {
        writeSummary({ last_run_id: "RUN-20260621-050000" });
        const ops = await readOpsHealth();
        expect(ops.productionIntelligence).toEqual({
            lastRunId: "RUN-20260621-050000",
            lastRunAt: null,
            servicesScanned: 0,
            observationsGenerated: 0,
            observationsFiltered: 0,
            triageProcessed: 0,
            errorCount: 0,
        });
    });

    test("a summary without last_run_id is treated as absent (honesty)", async () => {
        writeSummary({ observations_generated: 99 });
        const ops = await readOpsHealth();
        expect(ops.productionIntelligence).toBeUndefined();
    });

    test("malformed JSON yields undefined, not a throw", async () => {
        writeFileSync(
            join(dir, "production-intelligence.json"),
            "{ not json",
            "utf-8",
        );
        const ops = await readOpsHealth();
        expect(ops.productionIntelligence).toBeUndefined();
    });
});
