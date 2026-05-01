// SPEC-015-1-05 — SSEEventBus: connection cap, backpressure (slow
// client), heartbeat broadcast cadence, sequence tracking.
//
// Uses a stub SSEStreamLike (no real HTTP) so each test stays under
// a few hundred ms. Backpressure is induced by holding writeSSE
// pending via a never-resolving Promise.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { SSEEventBus } from "../../server/sse/SSEEventBus";
import type { SSEStreamLike } from "../../server/sse/types";

interface StubStream extends SSEStreamLike {
    frames: Array<{ id?: string; event?: string; data: string }>;
    comments: string[];
    closed: boolean;
    onAbortCb: (() => void) | null;
    /** When true, every writeSSE returns a promise that never resolves. */
    block: boolean;
    /** When true, every writeSSE rejects. */
    failNext: boolean;
}

function makeStubStream(): StubStream {
    const stub: StubStream = {
        frames: [],
        comments: [],
        closed: false,
        onAbortCb: null,
        block: false,
        failNext: false,
        writeSSE(frame) {
            if (stub.failNext) {
                stub.failNext = false;
                return Promise.reject(new Error("stub: tcp reset"));
            }
            if (stub.block) return new Promise<void>(() => {});
            stub.frames.push(frame);
            return Promise.resolve();
        },
        write(chunk: string) {
            stub.comments.push(chunk);
            return Promise.resolve();
        },
        onAbort(cb: () => void) {
            stub.onAbortCb = cb;
        },
        close() {
            stub.closed = true;
            return Promise.resolve();
        },
    };
    return stub;
}

let bus: SSEEventBus | null = null;

beforeEach(() => {
    bus = null;
});

afterEach(async () => {
    if (bus) {
        await bus.shutdown();
        bus = null;
    }
});

describe("SSEEventBus", () => {
    test("registerStream returns null when at the connection cap", async () => {
        bus = new SSEEventBus({ maxConnections: 2, heartbeatIntervalMs: 60_000 });
        const a = await bus.registerStream(makeStubStream());
        const b = await bus.registerStream(makeStubStream());
        const c = await bus.registerStream(makeStubStream());
        expect(a).not.toBeNull();
        expect(b).not.toBeNull();
        expect(c).toBeNull();
        expect(bus.getConnectionCount()).toBe(2);
    });

    test("new connection receives `: connected` comment then a heartbeat frame", async () => {
        bus = new SSEEventBus({ heartbeatIntervalMs: 60_000 });
        const stub = makeStubStream();
        await bus.registerStream(stub);
        // The first comment is "connected" and the first frame is a heartbeat.
        expect(stub.comments.length).toBeGreaterThanOrEqual(1);
        expect(stub.comments[0]).toContain("connected");
        expect(stub.frames.length).toBeGreaterThanOrEqual(1);
        expect(stub.frames[0]!.event).toBe("heartbeat");
    });

    test("broadcast fans out to every open connection", async () => {
        bus = new SSEEventBus({ heartbeatIntervalMs: 60_000 });
        const a = makeStubStream();
        const b = makeStubStream();
        await bus.registerStream(a);
        await bus.registerStream(b);
        const beforeA = a.frames.length;
        const beforeB = b.frames.length;
        await bus.broadcast({
            type: "state-change",
            payload: {
                request_id: "REQ-000001",
                old_phase: "pending",
                new_phase: "executing",
                repository: "/tmp/repo",
            },
        });
        expect(a.frames.length).toBe(beforeA + 1);
        expect(b.frames.length).toBe(beforeB + 1);
        expect(a.frames[a.frames.length - 1]!.event).toBe("state-change");
    });

    test("backpressure: blocked writer drops further events without throwing", async () => {
        bus = new SSEEventBus({
            heartbeatIntervalMs: 60_000,
            writeQueueLimit: 3,
        });
        const slow = makeStubStream();
        const conn = await bus.registerStream(slow);
        expect(conn).not.toBeNull();
        slow.block = true; // freeze the writer
        // Fire enough writes that the queue saturates.
        for (let i = 0; i < 20; i += 1) {
            await bus.broadcast({
                type: "cost-update",
                payload: { delta_usd: 0, total_usd: 0 },
            });
        }
        // Stats must show drops; bus must NOT have thrown.
        const stats = bus.getConnectionStats();
        expect(stats.length).toBe(1);
        expect(stats[0]!.droppedEventCount).toBeGreaterThan(0);
    });

    test("write failure transitions connection to closed and reaps it", async () => {
        bus = new SSEEventBus({ heartbeatIntervalMs: 60_000 });
        const stub = makeStubStream();
        await bus.registerStream(stub);
        stub.failNext = true;
        await bus.broadcast({
            type: "cost-update",
            payload: { delta_usd: 0.1, total_usd: 1.5 },
        });
        // Reap is async via removeConnection; allow a tick.
        await new Promise((r) => setTimeout(r, 10));
        expect(bus.getConnectionCount()).toBe(0);
    });

    test("sequence counter is monotonic across broadcasts", async () => {
        bus = new SSEEventBus({ heartbeatIntervalMs: 60_000 });
        const stub = makeStubStream();
        await bus.registerStream(stub);
        const seqsBefore = stub.frames.map((f) => JSON.parse(f.data).seq as number);
        for (let i = 0; i < 5; i += 1) {
            await bus.broadcast({
                type: "cost-update",
                payload: { delta_usd: 0, total_usd: 0 },
            });
        }
        const seqs = stub.frames.map((f) => JSON.parse(f.data).seq as number);
        for (let i = 1; i < seqs.length; i += 1) {
            expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
        }
        expect(seqs.length).toBeGreaterThan(seqsBefore.length);
    });

    test("shutdown sends a `: shutdown` comment and refuses subsequent broadcasts", async () => {
        bus = new SSEEventBus({ heartbeatIntervalMs: 60_000 });
        const stub = makeStubStream();
        await bus.registerStream(stub);
        await bus.shutdown();
        expect(stub.comments.some((c) => c.includes("shutdown"))).toBe(true);
        const beforeFrames = stub.frames.length;
        await bus.broadcast({
            type: "cost-update",
            payload: { delta_usd: 0, total_usd: 0 },
        });
        expect(stub.frames.length).toBe(beforeFrames);
        bus = null; // afterEach already ran shutdown
    });

    test("getConnectionStats reports per-connection metadata", async () => {
        bus = new SSEEventBus({ heartbeatIntervalMs: 60_000 });
        await bus.registerStream(makeStubStream());
        await bus.registerStream(makeStubStream());
        const stats = bus.getConnectionStats();
        expect(stats.length).toBe(2);
        for (const s of stats) {
            expect(typeof s.id).toBe("string");
            expect(s.ageMs).toBeGreaterThanOrEqual(0);
            expect(s.writeQueueDepth).toBeGreaterThanOrEqual(0);
            expect(s.droppedEventCount).toBeGreaterThanOrEqual(0);
        }
    });
});
