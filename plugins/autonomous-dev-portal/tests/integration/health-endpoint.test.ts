// BUG-2 regression test: /health must read canonical "timestamp" field from heartbeat.json
//
// SPEC-013-3-01 — /health endpoint returns 200 OK with daemon status when
// heartbeat.json contains fresh timestamp. Before this fix, daemon-status.ts
// read "last_seen" (nonexistent), always returned "dead" status → 503.

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { readDaemonStatus } from "../../server/lib/daemon-status";

describe("Health endpoint regression test for BUG-2", () => {
    let testStateDir: string | undefined;

    beforeEach(async () => {
        // Create a temporary state directory
        testStateDir = join(tmpdir(), `portal-health-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
        await mkdir(testStateDir, { recursive: true });

        // Set env var so our test state directory is used
        process.env.AUTONOMOUS_DEV_STATE_DIR = testStateDir;
    });

    afterEach(() => {
        // Clean up env var
        delete process.env.AUTONOMOUS_DEV_STATE_DIR;
        testStateDir = undefined;
    });

    it("readDaemonStatus returns 'fresh' status when heartbeat.json contains fresh timestamp", async () => {
        if (!testStateDir) throw new Error("Test setup failed");

        // Write a synthetic heartbeat.json with canonical field name and fresh timestamp
        const now = new Date().toISOString();
        const heartbeatContent = JSON.stringify({
            timestamp: now,
            pid: 12345,
            iteration_count: 42,
            active_request_id: null,
        });

        await writeFile(join(testStateDir, "heartbeat.json"), heartbeatContent);

        // Read daemon status directly
        const daemonStatus = await readDaemonStatus();

        // Daemon should be reported as fresh (alive)
        expect(daemonStatus.status).toBe("fresh");
        expect(daemonStatus.last_seen).toBe(now); // Should return the canonical timestamp
        expect(daemonStatus.pid).toBe(12345);
    });

    it("readDaemonStatus returns 'dead' status when heartbeat.json is missing", async () => {
        // Don't write heartbeat.json file (it should be missing)

        // Read daemon status directly
        const daemonStatus = await readDaemonStatus();

        // Daemon should be reported as dead
        expect(daemonStatus.status).toBe("dead");
        expect(daemonStatus.last_seen).toBeNull();
        expect(daemonStatus.pid).toBeNull();
    });

    it("readDaemonStatus returns 'dead' status when heartbeat.json has stale timestamp", async () => {
        if (!testStateDir) throw new Error("Test setup failed");

        // Write a heartbeat.json with a timestamp older than 5 minutes (300,000ms)
        const staleTime = new Date(Date.now() - 400_000).toISOString(); // 400 seconds ago
        const heartbeatContent = JSON.stringify({
            timestamp: staleTime,
            pid: 12345,
            iteration_count: 42,
            active_request_id: null,
        });

        await writeFile(join(testStateDir, "heartbeat.json"), heartbeatContent);

        // Read daemon status directly
        const daemonStatus = await readDaemonStatus();

        // Daemon should be reported as dead due to stale timestamp
        expect(daemonStatus.status).toBe("dead");
        expect(daemonStatus.last_seen).toBe(staleTime);
        expect(daemonStatus.pid).toBe(12345);
    });
});