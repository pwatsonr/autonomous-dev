// SPEC-015-4-04 — AuditLogReader unit tests.
//
// Covers:
//   - Pagination: page boundaries, custom page size, clamping, empty file.
//   - Filter combinators: operatorId exact, action substring (case-insens),
//     date range, combinations.
//   - HMAC chain integrity: clean chain → 'verified', tampered entry →
//     'error', missing key → 'unknown', malformed lines skipped.
//
// Test data is generated inline using the same hmac-chain primitives the
// production logger uses, so chain construction stays in lockstep with
// the verifier.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    AuditLogReader,
    StaticAuditChainVerifier,
} from "../../server/services/audit-log-reader";
import { computeEntryHmac } from "../../server/security/hmac-chain";

interface Ctx {
    dir: string;
    auditPath: string;
}
const ctx: Ctx = { dir: "", auditPath: "" };

const TEST_KEY = Buffer.alloc(32, 0xab);
const KEY_ID = "audit-test-key";

interface SeedEntryInput {
    sequence: number;
    timestamp: string;
    action: string;
    user: string;
    resource?: string;
    details?: Record<string, unknown>;
}

interface SeedOptions {
    /** When set, replace the entry_hmac at this 1-based sequence with garbage. */
    tamperedAtSequence?: number;
    /** When set, omit the HMAC chain key from the verifier (returns 'unknown'). */
    omitKey?: boolean;
    /** Append a malformed line at the bottom. */
    appendMalformed?: boolean;
}

function buildEntries(count: number): SeedEntryInput[] {
    const startTs = Date.parse("2026-05-01T00:00:00Z");
    const out: SeedEntryInput[] = [];
    const operators = ["alice", "bob", "carol"];
    const actions = [
        "kill-switch.engage",
        "kill-switch.reset",
        "circuit-breaker.reset",
        "config.update",
    ];
    for (let i = 1; i <= count; i += 1) {
        out.push({
            sequence: i,
            // 1s apart so date-range filters have something to bite on.
            timestamp: new Date(startTs + i * 1000).toISOString(),
            action: actions[i % actions.length] ?? "noop",
            user: operators[i % operators.length] ?? "unknown",
            resource: "daemon",
            details: { iteration: i, outcome: "success" },
        });
    }
    return out;
}

function writeAuditLog(entries: SeedEntryInput[], opts: SeedOptions = {}): void {
    let prevHmac = "";
    const lines: string[] = [];
    for (const e of entries) {
        const noHmac = {
            timestamp: e.timestamp,
            sequence: e.sequence,
            action: e.action,
            user: e.user,
            resource: e.resource ?? "daemon",
            details: e.details ?? {},
            previous_hmac: prevHmac,
            key_id: KEY_ID,
        };
        let entry_hmac = computeEntryHmac(TEST_KEY, prevHmac, noHmac);
        if (opts.tamperedAtSequence === e.sequence) {
            // Flip a hex char so the chain check fails at this sequence.
            const head = entry_hmac.slice(0, -1);
            const lastChar = entry_hmac[entry_hmac.length - 1] ?? "0";
            const flipped = lastChar === "0" ? "1" : "0";
            entry_hmac = `${head}${flipped}`;
        }
        lines.push(JSON.stringify({ ...noHmac, entry_hmac }));
        prevHmac = entry_hmac;
    }
    if (opts.appendMalformed === true) {
        lines.push("{not valid json");
        lines.push(""); // blank line should also be tolerated
    }
    writeFileSync(ctx.auditPath, lines.join("\n") + "\n");
}

function makeReader(opts: { omitKey?: boolean } = {}): AuditLogReader {
    const verifier = new StaticAuditChainVerifier(
        opts.omitKey === true ? null : TEST_KEY,
    );
    return new AuditLogReader(ctx.auditPath, verifier);
}

beforeEach(() => {
    ctx.dir = mkdtempSync(join(tmpdir(), "audit-reader-"));
    ctx.auditPath = join(ctx.dir, "audit.log");
});

afterEach(() => {
    if (ctx.dir) rmSync(ctx.dir, { recursive: true, force: true });
});

describe("AuditLogReader — pagination", () => {
    test("missing log file: integrity 'error', empty page", async () => {
        // Don't write the file at all.
        const reader = makeReader();
        const r = await reader.getPage(1, 50);
        expect(r.entries).toHaveLength(0);
        expect(r.totalCount).toBe(0);
        expect(r.hasNext).toBe(false);
        expect(r.hasPrevious).toBe(false);
        expect(r.integrityStatus).toBe("error");
    });

    test("empty file: 0 entries, integrity 'verified'", async () => {
        writeFileSync(ctx.auditPath, "");
        const reader = makeReader();
        const r = await reader.getPage(1, 50);
        expect(r.entries).toHaveLength(0);
        expect(r.totalCount).toBe(0);
        expect(r.integrityStatus).toBe("verified");
    });

    test("first page of three (150 entries, default size 50)", async () => {
        writeAuditLog(buildEntries(150));
        const reader = makeReader();
        const r = await reader.getPage(1, 50);
        expect(r.entries).toHaveLength(50);
        expect(r.totalCount).toBe(150);
        expect(r.hasNext).toBe(true);
        expect(r.hasPrevious).toBe(false);
        expect(r.currentPage).toBe(1);
        expect(r.pageSize).toBe(50);
        // Newest-first order: first entry on page 1 is sequence 150.
        expect(r.entries[0]?.sequence).toBe(150);
        expect(r.entries[49]?.sequence).toBe(101);
    });

    test("middle page (page 2 of 3)", async () => {
        writeAuditLog(buildEntries(150));
        const reader = makeReader();
        const r = await reader.getPage(2, 50);
        expect(r.entries).toHaveLength(50);
        expect(r.hasNext).toBe(true);
        expect(r.hasPrevious).toBe(true);
        expect(r.entries[0]?.sequence).toBe(100);
        expect(r.entries[49]?.sequence).toBe(51);
    });

    test("last page (page 3 of 3)", async () => {
        writeAuditLog(buildEntries(150));
        const reader = makeReader();
        const r = await reader.getPage(3, 50);
        expect(r.entries).toHaveLength(50);
        expect(r.hasNext).toBe(false);
        expect(r.hasPrevious).toBe(true);
        expect(r.entries[0]?.sequence).toBe(50);
        expect(r.entries[49]?.sequence).toBe(1);
    });

    test("page beyond total returns empty slice", async () => {
        writeAuditLog(buildEntries(10));
        const reader = makeReader();
        const r = await reader.getPage(5, 50);
        expect(r.entries).toHaveLength(0);
        expect(r.totalCount).toBe(10);
        expect(r.hasNext).toBe(false);
        expect(r.hasPrevious).toBe(true);
    });

    test("custom page size honoured", async () => {
        writeAuditLog(buildEntries(25));
        const reader = makeReader();
        const r = await reader.getPage(2, 10);
        expect(r.entries).toHaveLength(10);
        expect(r.pageSize).toBe(10);
    });

    test("clamps page size to MIN/MAX", async () => {
        writeAuditLog(buildEntries(5));
        const reader = makeReader();
        const tooSmall = await reader.getPage(1, 0);
        expect(tooSmall.pageSize).toBe(1);
        const tooBig = await reader.getPage(1, 99_999);
        expect(tooBig.pageSize).toBe(200);
    });

    test("invalid page values default to page 1", async () => {
        writeAuditLog(buildEntries(5));
        const reader = makeReader();
        const r = await reader.getPage(NaN, 50);
        expect(r.currentPage).toBe(1);
    });

    test("malformed lines are skipped silently", async () => {
        writeAuditLog(buildEntries(5), { appendMalformed: true });
        const reader = makeReader();
        const r = await reader.getPage(1, 50);
        expect(r.entries).toHaveLength(5);
        expect(r.totalCount).toBe(5);
    });
});

describe("AuditLogReader — filter combinators", () => {
    test("filter by operatorId (exact match)", async () => {
        writeAuditLog(buildEntries(30));
        const reader = makeReader();
        const r = await reader.getPage(1, 50, { operatorId: "alice" });
        expect(r.entries.length).toBeGreaterThan(0);
        for (const e of r.entries) {
            expect(e.operatorId).toBe("alice");
        }
    });

    test("filter by action substring (case-insensitive)", async () => {
        writeAuditLog(buildEntries(30));
        const reader = makeReader();
        const r = await reader.getPage(1, 50, { action: "KILL-SWITCH" });
        expect(r.entries.length).toBeGreaterThan(0);
        for (const e of r.entries) {
            expect(e.action.toLowerCase()).toContain("kill-switch");
        }
    });

    test("filter by date range", async () => {
        writeAuditLog(buildEntries(60));
        const reader = makeReader();
        const startDate = new Date(Date.parse("2026-05-01T00:00:10Z"));
        const endDate = new Date(Date.parse("2026-05-01T00:00:20Z"));
        const r = await reader.getPage(1, 50, { startDate, endDate });
        expect(r.entries.length).toBeGreaterThan(0);
        for (const e of r.entries) {
            const ts = Date.parse(e.timestamp);
            expect(ts).toBeGreaterThanOrEqual(startDate.getTime());
            expect(ts).toBeLessThanOrEqual(endDate.getTime());
        }
    });

    test("combined filters: operator + action", async () => {
        writeAuditLog(buildEntries(60));
        const reader = makeReader();
        const r = await reader.getPage(1, 50, {
            operatorId: "alice",
            action: "circuit-breaker",
        });
        for (const e of r.entries) {
            expect(e.operatorId).toBe("alice");
            expect(e.action).toContain("circuit-breaker");
        }
    });

    test("filter with no matches returns 0 entries", async () => {
        writeAuditLog(buildEntries(10));
        const reader = makeReader();
        const r = await reader.getPage(1, 50, { operatorId: "nobody" });
        expect(r.entries).toHaveLength(0);
        expect(r.totalCount).toBe(0);
    });
});

describe("AuditLogReader — HMAC chain integrity", () => {
    test("clean chain: integrity 'verified'", async () => {
        writeAuditLog(buildEntries(30));
        const reader = makeReader();
        const r = await reader.getPage(1, 50);
        expect(r.integrityStatus).toBe("verified");
        expect(r.integrityDetail).toBeUndefined();
    });

    test("tampered entry: integrity 'error' with detail", async () => {
        // 30 entries → page 1 (size 50) holds them all → tampered entry
        // (sequence 15) is on the page.
        writeAuditLog(buildEntries(30), { tamperedAtSequence: 15 });
        const reader = makeReader();
        const r = await reader.getPage(1, 50);
        expect(r.integrityStatus).toBe("error");
        expect(r.integrityDetail?.hmacFailures).toBeGreaterThan(0);
        expect(r.integrityDetail?.firstFailingSequence).toBe(15);
    });

    test("missing verifier key: integrity 'unknown'", async () => {
        writeAuditLog(buildEntries(10));
        const reader = makeReader({ omitKey: true });
        const r = await reader.getPage(1, 50);
        expect(r.integrityStatus).toBe("unknown");
    });

    test("filtered slice (non-contiguous sequence range): integrity 'unknown'", async () => {
        // Filtering by operator punches holes in the sequence range, so the
        // verifier cannot prove the chain link between non-adjacent entries.
        writeAuditLog(buildEntries(30));
        const reader = makeReader();
        const r = await reader.getPage(1, 50, { operatorId: "alice" });
        expect(r.entries.length).toBeGreaterThan(1);
        expect(r.integrityStatus).toBe("unknown");
    });

    test("clean chain on a contiguous sub-page (page 3 of 3)", async () => {
        writeAuditLog(buildEntries(150));
        const reader = makeReader();
        const r = await reader.getPage(3, 50);
        expect(r.integrityStatus).toBe("verified");
    });

    test("tampered entry off-page: page integrity unaffected", async () => {
        // Tamper at sequence 5 (oldest), but request page 1 (newest 50).
        writeAuditLog(buildEntries(150), { tamperedAtSequence: 5 });
        const reader = makeReader();
        const r = await reader.getPage(1, 50);
        // Newest-first: page 1 contains sequences 101-150; sequence 5 is on page 3.
        expect(r.integrityStatus).toBe("verified");
        // But the page where it lives (3) MUST report the tamper.
        const r3 = await reader.getPage(3, 50);
        expect(r3.integrityStatus).toBe("error");
    });

    test("on-disk previous_hmac maps to null on first entry only", async () => {
        writeAuditLog(buildEntries(3));
        const reader = makeReader();
        const r = await reader.getPage(1, 50);
        const oldest = r.entries.find((e) => e.sequence === 1);
        expect(oldest?.previous_hmac).toBeNull();
        const second = r.entries.find((e) => e.sequence === 2);
        expect(typeof second?.previous_hmac).toBe("string");
        expect(second?.previous_hmac?.length).toBeGreaterThan(0);
    });

    test("on-disk 'user' field maps to operatorId", async () => {
        writeAuditLog(buildEntries(2));
        const reader = makeReader();
        const r = await reader.getPage(1, 50);
        for (const e of r.entries) {
            expect(typeof e.operatorId).toBe("string");
            expect(e.operatorId.length).toBeGreaterThan(0);
        }
    });
});
