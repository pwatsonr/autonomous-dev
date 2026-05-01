// SPEC-015-1-05 — CostReader: aggregation correctness, malformed
// tolerance, missing-file ok semantics.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AggregationCache } from "../../server/cache/AggregationCache";
import { CostReader } from "../../server/readers/CostReader";
import type { CostLedger } from "../../server/readers/types";

interface Ctx {
    dir: string;
    cache: AggregationCache | null;
}

const ctx: Ctx = { dir: "", cache: null };

function setupRepo(): { dir: string; ledgerPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "cost-reader-"));
    mkdirSync(join(dir, ".autonomous-dev"), { recursive: true });
    return { dir, ledgerPath: join(dir, ".autonomous-dev", "cost-ledger.json") };
}

function writeLedger(path: string, ledger: CostLedger): void {
    writeFileSync(path, JSON.stringify(ledger));
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

describe("CostReader", () => {
    test("missing ledger file returns ok=true with empty ledger", async () => {
        const { dir } = setupRepo();
        ctx.dir = dir;
        ctx.cache = new AggregationCache({ defaultTTLMs: 5000 });
        const reader = new CostReader({ basePath: dir, cache: ctx.cache });
        const r = await reader.readLedger();
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.total_usd).toBe(0);
            expect(r.value.entries).toEqual([]);
            expect(r.value.daily_usd).toEqual({});
        }
    });

    test("malformed JSON returns ok=false and does not cache", async () => {
        const { dir, ledgerPath } = setupRepo();
        ctx.dir = dir;
        ctx.cache = new AggregationCache({ defaultTTLMs: 5000 });
        writeFileSync(ledgerPath, "{not json");
        const reader = new CostReader({ basePath: dir, cache: ctx.cache });
        const r = await reader.readLedger();
        expect(r.ok).toBe(false);
        // Cache must remain empty for the ledger key.
        expect(await ctx.cache.get("cost:ledger")).toBeNull();
    });

    test("schema violation returns ok=false (e.g. negative total_usd)", async () => {
        const { dir, ledgerPath } = setupRepo();
        ctx.dir = dir;
        ctx.cache = new AggregationCache({ defaultTTLMs: 5000 });
        writeFileSync(
            ledgerPath,
            JSON.stringify({
                version: 1,
                total_usd: -5,
                daily_usd: {},
                per_request: {},
                entries: [],
                last_updated: "2026-05-01T00:00:00Z",
            }),
        );
        const reader = new CostReader({ basePath: dir, cache: ctx.cache });
        const r = await reader.readLedger();
        expect(r.ok).toBe(false);
    });

    test("getSummary sorts recent_entries by ts desc, length ≤ 50", async () => {
        const { dir, ledgerPath } = setupRepo();
        ctx.dir = dir;
        ctx.cache = new AggregationCache({ defaultTTLMs: 5000 });
        const entries: import("../../server/readers/types").CostEntry[] = [];
        for (let i = 0; i < 80; i += 1) {
            const day = String(i % 28 + 1).padStart(2, "0");
            entries.push({
                ts: `2026-04-${day}T00:00:00Z`,
                request_id: `REQ-${String(100000 + i).padStart(6, "0")}`,
                phase: null,
                delta_usd: 0.01 * (i + 1),
                reason: "session_completion",
            });
        }
        writeLedger(ledgerPath, {
            version: 1,
            total_usd: 100,
            daily_usd: { "2026-04-01": 50, "2026-04-02": 50 },
            per_request: {
                "REQ-100000": 5,
                "REQ-100001": 25,
                "REQ-100002": 70,
            },
            entries,
            last_updated: "2026-05-01T00:00:00Z",
        });
        const reader = new CostReader({ basePath: dir, cache: ctx.cache });
        const r = await reader.getSummary();
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.recent_entries.length).toBeLessThanOrEqual(50);
            // Sorted by ts desc.
            for (let i = 1; i < r.value.recent_entries.length; i += 1) {
                const prev = r.value.recent_entries[i - 1]!.ts;
                const curr = r.value.recent_entries[i]!.ts;
                expect(prev >= curr).toBe(true);
            }
            expect(r.value.per_request_top.length).toBeLessThanOrEqual(10);
            // Sorted by cost desc.
            for (let i = 1; i < r.value.per_request_top.length; i += 1) {
                expect(
                    r.value.per_request_top[i - 1]!.cost_usd >=
                        r.value.per_request_top[i]!.cost_usd,
                ).toBe(true);
            }
        }
    });

    test("getRecentEntries respects the limit parameter", async () => {
        const { dir, ledgerPath } = setupRepo();
        ctx.dir = dir;
        ctx.cache = new AggregationCache({ defaultTTLMs: 5000 });
        writeLedger(ledgerPath, {
            version: 1,
            total_usd: 0.6,
            daily_usd: {},
            per_request: {},
            entries: [
                {
                    ts: "2026-04-01T00:00:00Z",
                    request_id: null,
                    phase: null,
                    delta_usd: 0.1,
                    reason: "session_completion",
                },
                {
                    ts: "2026-04-02T00:00:00Z",
                    request_id: null,
                    phase: null,
                    delta_usd: 0.2,
                    reason: "session_completion",
                },
                {
                    ts: "2026-04-03T00:00:00Z",
                    request_id: null,
                    phase: null,
                    delta_usd: 0.3,
                    reason: "session_completion",
                },
            ],
            last_updated: "2026-05-01T00:00:00Z",
        });
        const reader = new CostReader({ basePath: dir, cache: ctx.cache });
        const r = await reader.getRecentEntries(2);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.length).toBe(2);
            // Newest first.
            expect(r.value[0]!.ts).toBe("2026-04-03T00:00:00Z");
        }
    });
});
