// SPEC-015-1-05 — AggregationCache: TTL eviction, LRU eviction,
// pattern invalidation, memory cap.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { AggregationCache } from "../../server/cache/AggregationCache";

let cache: AggregationCache | null = null;

beforeEach(() => {
    cache = null;
});

afterEach(() => {
    if (cache) {
        cache.shutdown();
        cache = null;
    }
});

describe("AggregationCache", () => {
    test("set then get returns the value within TTL", async () => {
        cache = new AggregationCache({ defaultTTLMs: 1000 });
        await cache.set("k", { v: 42 });
        const v = await cache.get<{ v: number }>("k");
        expect(v?.v).toBe(42);
    });

    test("get after TTL expiry returns null and counts a miss", async () => {
        let nowMs = 1_000_000;
        cache = new AggregationCache({ defaultTTLMs: 50, now: () => nowMs });
        await cache.set("k", "stale");
        nowMs += 100; // past TTL
        const v = await cache.get<string>("k");
        expect(v).toBeNull();
        const stats = cache.getStats();
        expect(stats.missCount).toBe(1);
    });

    test("invalidate removes a single entry", async () => {
        cache = new AggregationCache({ defaultTTLMs: 1000 });
        await cache.set("k", 1);
        const removed = cache.invalidate("k");
        expect(removed).toBe(true);
        expect(await cache.get("k")).toBeNull();
    });

    test("invalidatePattern removes ALL keys matching the regex", async () => {
        cache = new AggregationCache({ defaultTTLMs: 1000 });
        await cache.set("state:REQ-000001", 1);
        await cache.set("state:REQ-000002", 2);
        await cache.set("cost:summary", 3);
        const count = cache.invalidatePattern(/^state:/);
        expect(count).toBe(2);
        expect(await cache.get<number>("cost:summary")).toBe(3);
    });

    test("LRU eviction: oldest by lastAccess is dropped when capacity exceeded", async () => {
        let nowMs = 1_000;
        cache = new AggregationCache({
            defaultTTLMs: 60_000,
            maxEntries: 3,
            now: () => nowMs,
        });
        await cache.set("a", 1);
        nowMs += 1;
        await cache.set("b", 2);
        nowMs += 1;
        await cache.set("c", 3);
        nowMs += 1;
        // Touch 'a' so 'b' becomes the LRU candidate.
        await cache.get("a");
        nowMs += 1;
        await cache.set("d", 4);
        // 'b' should have been evicted.
        expect(await cache.get<number>("b")).toBeNull();
        expect(await cache.get<number>("a")).toBe(1);
        expect(await cache.get<number>("c")).toBe(3);
        expect(await cache.get<number>("d")).toBe(4);
    });

    test("memory cap eviction drops ~20% of entries on overflow", async () => {
        cache = new AggregationCache({
            defaultTTLMs: 60_000,
            maxEntries: 1000,
            // Tiny memory cap; large stringified payloads force eviction.
            maxMemoryMB: 0.01,
        });
        const big = "x".repeat(2000);
        for (let i = 0; i < 50; i += 1) {
            await cache.set(`k${String(i)}`, big);
        }
        const stats = cache.getStats();
        expect(stats.evictions.memory).toBeGreaterThan(0);
    });

    test("hitRatio is hits / (hits + misses)", async () => {
        cache = new AggregationCache({ defaultTTLMs: 1000 });
        await cache.set("k", 1);
        await cache.get("k"); // hit
        await cache.get("k"); // hit
        await cache.get("missing"); // miss
        const stats = cache.getStats();
        expect(stats.hitCount).toBe(2);
        expect(stats.missCount).toBe(1);
        expect(stats.hitRatio).toBeCloseTo(2 / 3, 5);
    });

    test("clear empties the cache and resets counters", async () => {
        cache = new AggregationCache({ defaultTTLMs: 1000 });
        await cache.set("k", 1);
        await cache.get("k");
        cache.clear();
        expect(cache.getStats().size).toBe(0);
        expect(cache.getStats().hitCount).toBe(0);
    });

    test("shutdown blocks further sets", async () => {
        cache = new AggregationCache({ defaultTTLMs: 1000 });
        cache.shutdown();
        await cache.set("k", 1);
        expect(await cache.get("k")).toBeNull();
        cache = null;
    });

    test("per-entry TTL override beats default TTL", async () => {
        let nowMs = 0;
        cache = new AggregationCache({ defaultTTLMs: 60_000, now: () => nowMs });
        await cache.set("k", 1, 50);
        nowMs += 75;
        expect(await cache.get("k")).toBeNull();
    });
});
