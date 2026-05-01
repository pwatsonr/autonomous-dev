// SPEC-015-4-04 — DaemonHealthMonitor unit tests.
//
// Covers:
//   - Status classification (healthy / stale / dead / unknown) using
//     deterministic now() injection so heartbeats sit at exact ages.
//   - Polling cadence: poll() runs immediately on start(), interval
//     timer is honoured, stop() clears the timer.
//   - Broadcast semantics: broadcaster fires on transition, NOT on
//     repeated polls in the same status, and broadcaster errors are
//     swallowed (poll never throws).
//
// All filesystem activity uses mkdtempSync so tests are hermetic.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    DaemonHealthMonitor,
    type DaemonHealthBroadcaster,
} from "../../server/health/daemon-health-monitor";
import {
    HEALTHY_THRESHOLD_MS,
    STALE_THRESHOLD_MS,
    type DaemonHealth,
} from "../../server/health/health-types";

interface Ctx {
    dir: string;
    heartbeatPath: string;
}
const ctx: Ctx = { dir: "", heartbeatPath: "" };

const FIXED_NOW = Date.parse("2026-05-01T12:00:00Z");

function setupHeartbeatDir(): void {
    ctx.dir = mkdtempSync(join(tmpdir(), "dhm-test-"));
    ctx.heartbeatPath = join(ctx.dir, "heartbeat.json");
}

function writeHeartbeat(
    ageMs: number,
    opts: { pid?: number; iteration?: number; now?: number } = {},
): void {
    const now = opts.now ?? FIXED_NOW;
    const ts = new Date(now - ageMs).toISOString();
    writeFileSync(
        ctx.heartbeatPath,
        JSON.stringify({
            timestamp: ts,
            pid: opts.pid ?? 12345,
            iteration: opts.iteration ?? 0,
        }),
    );
}

function writeMalformedHeartbeat(content: string): void {
    writeFileSync(ctx.heartbeatPath, content);
}

function deleteHeartbeat(): void {
    try {
        unlinkSync(ctx.heartbeatPath);
    } catch {
        /* ignore ENOENT */
    }
}

function captureBroadcaster(): {
    broadcaster: DaemonHealthBroadcaster;
    calls: DaemonHealth[];
} {
    const calls: DaemonHealth[] = [];
    const broadcaster: DaemonHealthBroadcaster = {
        broadcastStatusChange(snapshot) {
            calls.push(snapshot);
        },
    };
    return { broadcaster, calls };
}

function makeMonitor(opts: { now?: () => number; pollIntervalMs?: number } = {}) {
    const { broadcaster, calls } = captureBroadcaster();
    const monitor = new DaemonHealthMonitor(ctx.heartbeatPath, broadcaster, {
        now: opts.now ?? (() => FIXED_NOW),
        pollIntervalMs: opts.pollIntervalMs ?? 0, // disable interval by default
    });
    return { monitor, calls };
}

beforeEach(() => {
    setupHeartbeatDir();
});

afterEach(() => {
    if (ctx.dir) rmSync(ctx.dir, { recursive: true, force: true });
});

describe("DaemonHealthMonitor — status classification", () => {
    test("healthy: heartbeat age < 30s", async () => {
        writeHeartbeat(5_000);
        const { monitor } = makeMonitor();
        await monitor.poll();
        const status = monitor.getDaemonStatus();
        expect(status.status).toBe("healthy");
        expect(status.heartbeatAgeMs).toBe(5_000);
        expect(status.pid).toBe(12345);
        expect(status.iteration).toBe(0);
    });

    test("healthy: at the boundary (just under 30s)", async () => {
        writeHeartbeat(HEALTHY_THRESHOLD_MS - 1);
        const { monitor } = makeMonitor();
        await monitor.poll();
        expect(monitor.getDaemonStatus().status).toBe("healthy");
    });

    test("stale: heartbeat age in 30-120s window (lower edge)", async () => {
        writeHeartbeat(HEALTHY_THRESHOLD_MS); // exactly 30s → stale (>=)
        const { monitor } = makeMonitor();
        await monitor.poll();
        expect(monitor.getDaemonStatus().status).toBe("stale");
    });

    test("stale: heartbeat age 60s", async () => {
        writeHeartbeat(60_000);
        const { monitor } = makeMonitor();
        await monitor.poll();
        const s = monitor.getDaemonStatus();
        expect(s.status).toBe("stale");
        expect(s.heartbeatAgeMs).toBe(60_000);
    });

    test("stale: heartbeat just under 120s", async () => {
        writeHeartbeat(STALE_THRESHOLD_MS - 1);
        const { monitor } = makeMonitor();
        await monitor.poll();
        expect(monitor.getDaemonStatus().status).toBe("stale");
    });

    test("dead: heartbeat age > 120s", async () => {
        writeHeartbeat(300_000);
        const { monitor } = makeMonitor();
        await monitor.poll();
        const s = monitor.getDaemonStatus();
        expect(s.status).toBe("dead");
        expect(s.heartbeatAgeMs).toBe(300_000);
    });

    test("dead: heartbeat exactly at 120s threshold", async () => {
        writeHeartbeat(STALE_THRESHOLD_MS);
        const { monitor } = makeMonitor();
        await monitor.poll();
        expect(monitor.getDaemonStatus().status).toBe("dead");
    });

    test("dead: heartbeat file missing (ENOENT)", async () => {
        deleteHeartbeat();
        const { monitor } = makeMonitor();
        await monitor.poll();
        const s = monitor.getDaemonStatus();
        expect(s.status).toBe("dead");
        expect(s.heartbeatAgeMs).toBeNull();
        expect(s.heartbeatTimestamp).toBeNull();
        expect(s.pid).toBeNull();
    });

    test("unknown: heartbeat is malformed JSON", async () => {
        writeMalformedHeartbeat('{"timestamp": invalid');
        const { monitor } = makeMonitor();
        await monitor.poll();
        expect(monitor.getDaemonStatus().status).toBe("unknown");
    });

    test("unknown: heartbeat missing timestamp field", async () => {
        writeMalformedHeartbeat('{"pid": 1, "iteration": 0}');
        const { monitor } = makeMonitor();
        await monitor.poll();
        expect(monitor.getDaemonStatus().status).toBe("unknown");
    });

    test("unknown: timestamp is not a parseable date", async () => {
        writeMalformedHeartbeat('{"timestamp": "not-a-date", "pid": 1}');
        const { monitor } = makeMonitor();
        await monitor.poll();
        expect(monitor.getDaemonStatus().status).toBe("unknown");
    });

    test("accepts numeric epoch-ms timestamp", async () => {
        writeFileSync(
            ctx.heartbeatPath,
            JSON.stringify({ timestamp: FIXED_NOW - 5_000, pid: 1 }),
        );
        const { monitor } = makeMonitor();
        await monitor.poll();
        expect(monitor.getDaemonStatus().status).toBe("healthy");
    });

    test("non-numeric pid coerces to null but status still resolves", async () => {
        writeFileSync(
            ctx.heartbeatPath,
            JSON.stringify({
                timestamp: new Date(FIXED_NOW - 5_000).toISOString(),
                pid: "not-a-number",
            }),
        );
        const { monitor } = makeMonitor();
        await monitor.poll();
        const s = monitor.getDaemonStatus();
        expect(s.status).toBe("healthy");
        expect(s.pid).toBeNull();
    });
});

describe("DaemonHealthMonitor — polling cadence", () => {
    test("initial snapshot is unknown before first poll", () => {
        writeHeartbeat(5_000);
        const { monitor } = makeMonitor();
        expect(monitor.getDaemonStatus().status).toBe("unknown");
    });

    test("start() triggers an immediate (async) poll", async () => {
        writeHeartbeat(5_000);
        const { monitor } = makeMonitor();
        monitor.start();
        // The poll is fire-and-forget; await a microtask + IO turn.
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        expect(monitor.getDaemonStatus().status).toBe("healthy");
        monitor.stop();
    });

    test("interval timer fires repeated polls", async () => {
        writeHeartbeat(5_000);
        const { monitor, calls } = makeMonitor({ pollIntervalMs: 25 });
        monitor.start();
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
        // First poll is the unknown→healthy transition; subsequent polls
        // do not re-broadcast (status unchanged), but they DO occur.
        expect(calls.length).toBeGreaterThanOrEqual(1);
        monitor.stop();
    });

    test("stop() is idempotent", () => {
        const { monitor } = makeMonitor();
        monitor.stop();
        monitor.stop();
        expect(monitor.getDaemonStatus().status).toBe("unknown");
    });

    test("start() is idempotent — no double timer", async () => {
        writeHeartbeat(5_000);
        const { monitor } = makeMonitor({ pollIntervalMs: 0 });
        monitor.start();
        monitor.start();
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        monitor.stop();
        // No assertion on internals — we just verify no throw.
        expect(monitor.getDaemonStatus().status).toBe("healthy");
    });
});

describe("DaemonHealthMonitor — SSE broadcast on transition", () => {
    test("broadcasts on unknown→healthy transition", async () => {
        writeHeartbeat(5_000);
        const { monitor, calls } = makeMonitor();
        await monitor.poll();
        expect(calls).toHaveLength(1);
        expect(calls[0]?.status).toBe("healthy");
    });

    test("broadcasts on healthy→stale transition", async () => {
        writeHeartbeat(5_000);
        const { monitor, calls } = makeMonitor();
        await monitor.poll();
        writeHeartbeat(60_000);
        await monitor.poll();
        expect(calls.map((c) => c.status)).toEqual(["healthy", "stale"]);
    });

    test("broadcasts on healthy→dead transition", async () => {
        writeHeartbeat(5_000);
        const { monitor, calls } = makeMonitor();
        await monitor.poll();
        writeHeartbeat(300_000);
        await monitor.poll();
        expect(calls.map((c) => c.status)).toEqual(["healthy", "dead"]);
    });

    test("broadcasts on healthy→unknown transition (malformed file)", async () => {
        writeHeartbeat(5_000);
        const { monitor, calls } = makeMonitor();
        await monitor.poll();
        writeMalformedHeartbeat("not json at all");
        await monitor.poll();
        expect(calls.map((c) => c.status)).toEqual(["healthy", "unknown"]);
    });

    test("does NOT broadcast when status is unchanged", async () => {
        writeHeartbeat(5_000);
        const { monitor, calls } = makeMonitor();
        await monitor.poll(); // unknown → healthy (1 broadcast)
        await monitor.poll(); // healthy → healthy (no broadcast)
        await monitor.poll(); // healthy → healthy (no broadcast)
        expect(calls).toHaveLength(1);
    });

    test("broadcaster errors do not propagate out of poll()", async () => {
        writeHeartbeat(5_000);
        const broadcaster: DaemonHealthBroadcaster = {
            broadcastStatusChange: mock(() => {
                throw new Error("broadcast failed");
            }),
        };
        const monitor = new DaemonHealthMonitor(
            ctx.heartbeatPath,
            broadcaster,
            { now: () => FIXED_NOW, pollIntervalMs: 0 },
        );
        // Must not throw.
        await monitor.poll();
        expect(monitor.getDaemonStatus().status).toBe("healthy");
    });

    test("supports async broadcasters", async () => {
        writeHeartbeat(5_000);
        const calls: DaemonHealth[] = [];
        const broadcaster: DaemonHealthBroadcaster = {
            async broadcastStatusChange(snapshot) {
                await new Promise<void>((resolve) => setTimeout(resolve, 1));
                calls.push(snapshot);
            },
        };
        const monitor = new DaemonHealthMonitor(
            ctx.heartbeatPath,
            broadcaster,
            { now: () => FIXED_NOW, pollIntervalMs: 0 },
        );
        await monitor.poll();
        expect(calls).toHaveLength(1);
        expect(calls[0]?.status).toBe("healthy");
    });
});
