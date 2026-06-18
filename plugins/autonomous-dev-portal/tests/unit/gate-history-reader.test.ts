// #429 — gate-history-reader unit tests.
//
// Drives readGateHistory / computeGateHistoryStats against a temp
// gate-decisions dir seeded with all three on-disk schema variants, and
// verifies: pending decisions are excluded, decided ones are returned with
// a normalized outcome, the time-window filter drops stale decisions, and
// the stats summary is computed from real entries (never fabricated).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    computeGateHistoryStats,
    readGateHistory,
    readGateHistoryWithStats,
} from "../../server/wiring/gate-history-reader";

let dir: string;

function write(name: string, obj: unknown): void {
    writeFileSync(join(dir, name), JSON.stringify(obj), "utf-8");
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gate-hist-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-06-18T12:00:00Z");
const now = (): number => NOW;

describe("readGateHistory — schema variants", () => {
    test("parses daemon shape A (state field) approved/rejected", async () => {
        write("acme__REQ-1.json", {
            id: "REQ-1",
            repo: "acme",
            phase: "code_review",
            state: "approved",
            decided_at: "2026-06-17T10:00:00Z",
        });
        write("acme__REQ-2.json", {
            id: "REQ-2",
            repo: "acme",
            phase: "spec_review",
            state: "rejected",
            decided_at: "2026-06-17T11:00:00Z",
        });
        const out = await readGateHistory(7, { decisionsDir: dir, now });
        expect(out.length).toBe(2);
        const byId = Object.fromEntries(out.map((e) => [e.id, e]));
        expect(byId["REQ-1"]!.decision).toBe("approved");
        expect(byId["REQ-1"]!.phase).toBe("review"); // code_review → review
        expect(byId["REQ-2"]!.decision).toBe("rejected");
    });

    test("parses portal FileApprovalsStore shape B (decision/operator_id)", async () => {
        write("acme__REQ-3.json", {
            id: "REQ-3",
            repo: "acme",
            request_id: "REQ-3",
            decision: "approved",
            operator_id: "alice",
            decided_at: "2026-06-17T09:00:00Z",
            state: "approved",
        });
        const out = await readGateHistory(7, { decisionsDir: dir, now });
        expect(out.length).toBe(1);
        expect(out[0]!.decision).toBe("approved");
        expect(out[0]!.decidedBy).toBe("alice");
    });

    test("parses gate-store shape C (verb/actor/decidedAt)", async () => {
        write("acme__REQ-4.json", {
            id: "REQ-4",
            repo: "acme",
            verb: "reject",
            actor: "bob",
            decidedAt: "2026-06-17T08:00:00Z",
        });
        const out = await readGateHistory(7, { decisionsDir: dir, now });
        expect(out.length).toBe(1);
        expect(out[0]!.decision).toBe("rejected");
        expect(out[0]!.decidedBy).toBe("bob");
    });

    test("request-changes is normalized", async () => {
        write("acme__REQ-5.json", {
            id: "REQ-5",
            repo: "acme",
            state: "request-changes",
            decided_at: "2026-06-17T07:00:00Z",
        });
        const out = await readGateHistory(7, { decisionsDir: dir, now });
        expect(out[0]!.decision).toBe("request-changes");
    });
});

describe("readGateHistory — filtering", () => {
    test("pending decisions are excluded (not history)", async () => {
        write("acme__REQ-P.json", {
            id: "REQ-P",
            repo: "acme",
            phase: "code_review",
            state: "pending",
            gate_entered_at: "2026-06-18T11:00:00Z",
        });
        const out = await readGateHistory(7, { decisionsDir: dir, now });
        expect(out.length).toBe(0);
    });

    test("decisions older than the window are dropped", async () => {
        write("acme__OLD.json", {
            id: "OLD",
            repo: "acme",
            state: "approved",
            decided_at: "2026-05-01T00:00:00Z", // >7d before NOW
        });
        write("acme__NEW.json", {
            id: "NEW",
            repo: "acme",
            state: "approved",
            decided_at: "2026-06-17T00:00:00Z", // within 7d
        });
        const out = await readGateHistory(7, { decisionsDir: dir, now });
        expect(out.map((e) => e.id)).toEqual(["NEW"]);
    });

    test("decisions without a timestamp are kept (cannot prove out-of-window)", async () => {
        write("acme__NOTS.json", {
            id: "NOTS",
            repo: "acme",
            verb: "approve",
        });
        const out = await readGateHistory(7, { decisionsDir: dir, now });
        expect(out.map((e) => e.id)).toEqual(["NOTS"]);
    });

    test("results are sorted newest-first by decidedAt", async () => {
        write("acme__A.json", { id: "A", repo: "acme", state: "approved", decided_at: "2026-06-15T00:00:00Z" });
        write("acme__B.json", { id: "B", repo: "acme", state: "approved", decided_at: "2026-06-17T00:00:00Z" });
        write("acme__C.json", { id: "C", repo: "acme", state: "approved", decided_at: "2026-06-16T00:00:00Z" });
        const out = await readGateHistory(7, { decisionsDir: dir, now });
        expect(out.map((e) => e.id)).toEqual(["B", "C", "A"]);
    });
});

describe("readGateHistory — resilience", () => {
    test("missing dir → empty []", async () => {
        const out = await readGateHistory(7, {
            decisionsDir: join(dir, "does-not-exist"),
            now,
        });
        expect(out).toEqual([]);
    });

    test("corrupt JSON file is skipped, others continue", async () => {
        writeFileSync(join(dir, "acme__BAD.json"), "{not json", "utf-8");
        write("acme__OK.json", {
            id: "OK",
            repo: "acme",
            state: "approved",
            decided_at: "2026-06-17T00:00:00Z",
        });
        const out = await readGateHistory(7, { decisionsDir: dir, now });
        expect(out.map((e) => e.id)).toEqual(["OK"]);
    });

    test("file without id is skipped", async () => {
        write("acme__NOID.json", { repo: "acme", state: "approved" });
        const out = await readGateHistory(7, { decisionsDir: dir, now });
        expect(out.length).toBe(0);
    });
});

describe("computeGateHistoryStats", () => {
    test("counts + rates from real entries", async () => {
        write("r__1.json", { id: "1", repo: "r", state: "approved", decided_at: "2026-06-17T00:00:00Z" });
        write("r__2.json", { id: "2", repo: "r", state: "approved", decided_at: "2026-06-17T00:00:00Z" });
        write("r__3.json", { id: "3", repo: "r", state: "approved", decided_at: "2026-06-17T00:00:00Z" });
        write("r__4.json", { id: "4", repo: "r", state: "rejected", decided_at: "2026-06-17T00:00:00Z" });
        write("r__5.json", { id: "5", repo: "r", state: "request-changes", decided_at: "2026-06-17T00:00:00Z" });
        const { stats } = await readGateHistoryWithStats(7, { decisionsDir: dir, now });
        expect(stats.total).toBe(5);
        expect(stats.approved).toBe(3);
        expect(stats.rejected).toBe(1);
        expect(stats.requestChanges).toBe(1);
        expect(stats.approveRate).toBeCloseTo(0.6, 5);
        expect(stats.rejectRate).toBeCloseTo(0.2, 5);
    });

    test("empty entries → zeroed stats (no division by zero)", () => {
        const stats = computeGateHistoryStats([], 7);
        expect(stats.total).toBe(0);
        expect(stats.approveRate).toBe(0);
        expect(stats.rejectRate).toBe(0);
    });
});
