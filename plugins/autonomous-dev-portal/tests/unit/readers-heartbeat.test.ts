// SPEC-015-1-05 — HeartbeatReader: fresh / stale / unreachable
// thresholds, missing-file unknown semantics.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AggregationCache } from "../../server/cache/AggregationCache";
import { HeartbeatReader } from "../../server/readers/HeartbeatReader";
import type { Heartbeat } from "../../server/readers/types";

interface Ctx {
    dir: string;
    cache: AggregationCache | null;
}

const ctx: Ctx = { dir: "", cache: null };

function setupRepo(): { dir: string; hbPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "hb-reader-"));
    mkdirSync(join(dir, ".autonomous-dev"), { recursive: true });
    return { dir, hbPath: join(dir, ".autonomous-dev", "heartbeat.json") };
}

function writeHb(path: string, hb: Heartbeat): void {
    writeFileSync(path, JSON.stringify(hb));
}

beforeEach(() => {
    ctx.dir = "";
    ctx.cache = null;
});

afterEach(() => {
    if (ctx.cache) {
        ctx.cache.shutdown();
        ctx.cache = null;
    }
    if (ctx.dir) rmSync(ctx.dir, { recursive: true, force: true });
});

describe("HeartbeatReader", () => {
    test("missing heartbeat file → state='unknown'", async () => {
        const { dir } = setupRepo();
        ctx.dir = dir;
        ctx.cache = new AggregationCache({ defaultTTLMs: 5000 });
        const reader = new HeartbeatReader({
            basePath: dir,
            cache: ctx.cache,
            now: () => Date.parse("2026-05-01T00:00:00Z"),
        });
        const r = await reader.getStatus();
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.state).toBe("unknown");
            expect(r.value.last_heartbeat).toBeNull();
            expect(r.value.stale_seconds).toBe(0);
        }
    });

    test("malformed file → state='unknown'", async () => {
        const { dir, hbPath } = setupRepo();
        ctx.dir = dir;
        ctx.cache = new AggregationCache({ defaultTTLMs: 5000 });
        writeFileSync(hbPath, "{not json");
        const reader = new HeartbeatReader({
            basePath: dir,
            cache: ctx.cache,
            now: () => Date.parse("2026-05-01T00:00:00Z"),
        });
        const r = await reader.getStatus();
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.state).toBe("unknown");
        }
    });

    test("fresh heartbeat (age < threshold) → state='up'", async () => {
        const { dir, hbPath } = setupRepo();
        ctx.dir = dir;
        ctx.cache = new AggregationCache({ defaultTTLMs: 5000 });
        const now = Date.parse("2026-05-01T00:00:00Z");
        writeHb(hbPath, {
            version: 1,
            ts: new Date(now - 10_000).toISOString(), // 10s old
            pid: 4242,
            uptime_s: 60,
            daemon_version: "0.1.0",
            active_requests: 1,
        });
        const reader = new HeartbeatReader({
            basePath: dir,
            cache: ctx.cache,
            staleThresholdSeconds: 60,
            now: () => now,
        });
        const r = await reader.getStatus();
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.state).toBe("up");
            expect(r.value.stale_seconds).toBe(0);
            expect(r.value.last_heartbeat?.pid).toBe(4242);
        }
    });

    test("stale heartbeat (age > threshold) → state='down'", async () => {
        const { dir, hbPath } = setupRepo();
        ctx.dir = dir;
        ctx.cache = new AggregationCache({ defaultTTLMs: 5000 });
        const now = Date.parse("2026-05-01T00:00:00Z");
        writeHb(hbPath, {
            version: 1,
            ts: new Date(now - 120_000).toISOString(), // 120s old
            pid: 4242,
            uptime_s: 60,
            daemon_version: "0.1.0",
            active_requests: 0,
        });
        const reader = new HeartbeatReader({
            basePath: dir,
            cache: ctx.cache,
            staleThresholdSeconds: 60,
            now: () => now,
        });
        const r = await reader.getStatus();
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.state).toBe("down");
            expect(r.value.stale_seconds).toBeGreaterThan(60);
        }
    });

    test("very stale heartbeat ('unreachable' magnitude) still reports 'down' with large stale_seconds", async () => {
        const { dir, hbPath } = setupRepo();
        ctx.dir = dir;
        ctx.cache = new AggregationCache({ defaultTTLMs: 5000 });
        const now = Date.parse("2026-05-01T00:00:00Z");
        writeHb(hbPath, {
            version: 1,
            ts: new Date(now - 600_000).toISOString(), // 10 minutes old
            pid: 4242,
            uptime_s: 1,
            daemon_version: "0.1.0",
            active_requests: 0,
        });
        const reader = new HeartbeatReader({
            basePath: dir,
            cache: ctx.cache,
            staleThresholdSeconds: 60,
            now: () => now,
        });
        const r = await reader.getStatus();
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.state).toBe("down");
            // 10 minutes = 600s; way past the 300s "unreachable" magnitude.
            expect(r.value.stale_seconds).toBeGreaterThanOrEqual(300);
        }
    });

    test("readHeartbeat returns the parsed Heartbeat directly", async () => {
        const { dir, hbPath } = setupRepo();
        ctx.dir = dir;
        ctx.cache = new AggregationCache({ defaultTTLMs: 5000 });
        const ts = "2026-05-01T00:00:00Z";
        writeHb(hbPath, {
            version: 1,
            ts,
            pid: 99,
            uptime_s: 5,
            daemon_version: "1.0.0",
            active_requests: 3,
        });
        const reader = new HeartbeatReader({
            basePath: dir,
            cache: ctx.cache,
        });
        const r = await reader.readHeartbeat();
        expect(r.ok).toBe(true);
        if (r.ok && r.value) {
            expect(r.value.pid).toBe(99);
            expect(r.value.daemon_version).toBe("1.0.0");
            expect(r.value.active_requests).toBe(3);
        }
    });
});
