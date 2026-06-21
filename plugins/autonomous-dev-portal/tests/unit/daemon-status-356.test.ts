// #356 (FR-025-14/15, FR-404/935/938) — daemon-status surfaces uptime,
// iteration count, active request, and OpsHealth surfaces circuit-breaker +
// kill-switch state. The daemon now writes `start_time` to heartbeat.json.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readDaemonStatus } from "../../server/lib/daemon-status";
import { readOpsHealth } from "../../server/wiring/ops-readers";
import {
    buildDaemonStatusHandler,
    type DaemonStatusBody,
} from "../../server/routes/daemon-status";

const ORIGINAL = process.env["AUTONOMOUS_DEV_STATE_DIR"];
let dir: string;

function writeHeartbeat(fields: Record<string, unknown>): string {
    const p = join(dir, "heartbeat.json");
    writeFileSync(p, JSON.stringify(fields), "utf8");
    return p;
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daemon-356-"));
    process.env["AUTONOMOUS_DEV_STATE_DIR"] = dir;
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (ORIGINAL === undefined) delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
    else process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL;
});

describe("#356 readDaemonStatus uptime/iteration/active-request", () => {
    test("derives uptime_seconds from start_time and surfaces iteration + active request", async () => {
        const now = new Date();
        const start = new Date(now.getTime() - 3661 * 1000); // 1h 1m 1s ago
        writeHeartbeat({
            timestamp: now.toISOString(),
            pid: 4242,
            iteration_count: 17,
            active_request_id: "REQ-000042",
            start_time: start.toISOString(),
        });
        const s = await readDaemonStatus();
        expect(s.status).toBe("fresh");
        expect(s.iteration_count).toBe(17);
        expect(s.active_request_id).toBe("REQ-000042");
        expect(s.active_requests).toBe(1); // derived from the active id
        expect(s.uptime_seconds).not.toBeNull();
        expect(s.uptime_seconds!).toBeGreaterThanOrEqual(3600);
    });

    test("missing start_time → uptime null; idle (no active id) → active_requests 0", async () => {
        writeHeartbeat({
            timestamp: new Date().toISOString(),
            pid: 1,
            iteration_count: 0,
            active_request_id: null,
        });
        const s = await readDaemonStatus();
        expect(s.uptime_seconds).toBeNull();
        expect(s.active_request_id).toBeNull();
        expect(s.active_requests).toBe(0);
    });
});

describe("#356 readOpsHealth circuit-breaker + kill-switch", () => {
    test("populates circuitBreaker from crash-state.json (open when tripped)", async () => {
        writeFileSync(
            join(dir, "crash-state.json"),
            JSON.stringify({
                consecutive_crashes: 3,
                circuit_breaker_tripped: true,
                updated_at: "2026-06-21T00:00:00Z",
            }),
            "utf8",
        );
        const ops = await readOpsHealth();
        expect(ops.circuitBreaker).toBeDefined();
        expect(ops.circuitBreaker!.state).toBe("open");
        expect(ops.circuitBreaker!.failureCount).toBe(3);
        expect(ops.circuitBreaker!.changedAt).toBe("2026-06-21T00:00:00Z");
    });

    test("circuitBreaker undefined when crash-state absent (no fabrication)", async () => {
        const ops = await readOpsHealth();
        expect(ops.circuitBreaker).toBeUndefined();
    });
});

describe("#356 GET /api/daemon-status body has uptime/iteration/active-request", () => {
    test("handler surfaces the heartbeat-derived fields", async () => {
        const now = new Date();
        const hbPath = writeHeartbeat({
            timestamp: now.toISOString(),
            pid: 9,
            iteration_count: 5,
            active_request_id: "REQ-000007",
            start_time: new Date(now.getTime() - 120_000).toISOString(),
        });
        const handler = buildDaemonStatusHandler({
            heartbeatPath: hbPath,
            readMtdSpend: async () => 12.5,
            readApprovalsCount: async () => 0,
            readKillSwitchEngaged: async () => false,
        });
        // Minimal Hono-context shim: the handler only uses c.header + c.json.
        const c = {
            header: () => {},
            json: (b: unknown) =>
                new Response(JSON.stringify(b), {
                    headers: { "content-type": "application/json" },
                }),
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await handler(c as any);
        const body = (await res.json()) as DaemonStatusBody;
        expect(body.iterationCount).toBe(5);
        expect(body.activeRequestId).toBe("REQ-000007");
        expect(body.uptimeSeconds).not.toBeNull();
        expect(body.uptimeSeconds!).toBeGreaterThanOrEqual(120);
        expect(body.mtdSpend).toBe(12.5);
    });
});
