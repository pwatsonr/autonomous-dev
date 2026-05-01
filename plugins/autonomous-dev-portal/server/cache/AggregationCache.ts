// SPEC-015-1-03 — Generic in-memory cache with TTL, LRU, memory cap,
// and pattern invalidation.
//
// Used by all read-only accessors. Invalidation is the integration
// point with FileWatcher: state.json change → invalidate('state:<id>')
// + invalidatePattern(/^(all-states|state-counts):/).

import type { CacheEntry, CacheOptions, CacheStats, CacheLogger } from "./types";

const DEFAULTS = {
    defaultTTLMs: 5_000,
    maxEntries: 1_000,
    maxMemoryMB: 50,
} as const;

const NOOP_LOGGER: CacheLogger = {
    warn: () => undefined,
};

/** Rough per-entry overhead in bytes. */
const ENTRY_OVERHEAD = 200;

export class AggregationCache {
    private readonly entries = new Map<string, CacheEntry>();
    private readonly opts: Required<Omit<CacheOptions, "logger" | "now">> & {
        logger: CacheLogger;
        now: () => number;
    };
    private hitCount = 0;
    private missCount = 0;
    private evictions = { ttl: 0, size: 0, memory: 0, manual: 0 };
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;
    private shuttingDown = false;

    constructor(options: CacheOptions = {}) {
        this.opts = {
            defaultTTLMs: options.defaultTTLMs ?? DEFAULTS.defaultTTLMs,
            maxEntries: options.maxEntries ?? DEFAULTS.maxEntries,
            maxMemoryMB: options.maxMemoryMB ?? DEFAULTS.maxMemoryMB,
            logger: options.logger ?? NOOP_LOGGER,
            now: options.now ?? Date.now,
        };

        if (this.opts.defaultTTLMs > 0) {
            const interval = Math.max(500, Math.floor(this.opts.defaultTTLMs / 2));
            this.cleanupTimer = setInterval(() => this.sweepExpired(), interval);
        }
    }

    async get<T>(key: string): Promise<T | null> {
        if (this.shuttingDown) return null;
        const entry = this.entries.get(key);
        if (!entry) {
            this.missCount += 1;
            return null;
        }
        const now = this.opts.now();
        if (now - entry.timestamp > entry.ttl) {
            this.entries.delete(key);
            this.evictions.ttl += 1;
            this.missCount += 1;
            return null;
        }
        entry.lastAccess = now;
        this.hitCount += 1;
        return entry.value as T;
    }

    async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
        if (this.shuttingDown) return;
        const now = this.opts.now();
        const entry: CacheEntry<T> = {
            value,
            timestamp: now,
            ttl: ttlMs ?? this.opts.defaultTTLMs,
            lastAccess: now,
            sizeBytes: estimateSize(key, value),
        };
        this.entries.set(key, entry as CacheEntry);

        if (this.entries.size > this.opts.maxEntries) {
            this.evictLRU(this.entries.size - this.opts.maxEntries);
        }
        if (this.estimateMemoryMB() > this.opts.maxMemoryMB) {
            this.evictByMemory();
        }
    }

    invalidate(key: string): boolean {
        const removed = this.entries.delete(key);
        if (removed) this.evictions.manual += 1;
        return removed;
    }

    invalidatePattern(pattern: RegExp): number {
        let count = 0;
        for (const key of Array.from(this.entries.keys())) {
            if (pattern.test(key)) {
                this.entries.delete(key);
                count += 1;
            }
        }
        if (count > 0) this.evictions.manual += count;
        return count;
    }

    getStats(): CacheStats {
        const total = this.hitCount + this.missCount;
        return {
            size: this.entries.size,
            hitCount: this.hitCount,
            missCount: this.missCount,
            hitRatio: total === 0 ? 0 : this.hitCount / total,
            approxMemoryMB: this.estimateMemoryMB(),
            evictions: { ...this.evictions },
        };
    }

    clear(): void {
        this.entries.clear();
        this.hitCount = 0;
        this.missCount = 0;
        this.evictions = { ttl: 0, size: 0, memory: 0, manual: 0 };
    }

    /** Stop background sweep and refuse further writes. */
    shutdown(): void {
        if (this.shuttingDown) return;
        this.shuttingDown = true;
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        this.entries.clear();
    }

    // -- internals --

    private sweepExpired(): void {
        const now = this.opts.now();
        for (const [key, entry] of this.entries) {
            if (now - entry.timestamp > entry.ttl) {
                this.entries.delete(key);
                this.evictions.ttl += 1;
            }
        }
    }

    private evictLRU(count: number): void {
        // Sort entries by lastAccess ascending and drop the oldest `count`.
        const sorted = Array.from(this.entries.entries()).sort(
            (a, b) => a[1].lastAccess - b[1].lastAccess,
        );
        for (let i = 0; i < count && i < sorted.length; i += 1) {
            const entry = sorted[i];
            if (!entry) continue;
            this.entries.delete(entry[0]);
            this.evictions.size += 1;
        }
    }

    private evictByMemory(): void {
        const dropCount = Math.max(1, Math.ceil(this.entries.size * 0.2));
        const sorted = Array.from(this.entries.entries()).sort(
            (a, b) => a[1].lastAccess - b[1].lastAccess,
        );
        for (let i = 0; i < dropCount && i < sorted.length; i += 1) {
            const entry = sorted[i];
            if (!entry) continue;
            this.entries.delete(entry[0]);
            this.evictions.memory += 1;
        }
    }

    private estimateMemoryMB(): number {
        let total = 0;
        for (const [key, entry] of this.entries) {
            total += key.length * 2 + entry.sizeBytes + ENTRY_OVERHEAD;
        }
        return total / (1024 * 1024);
    }
}

function estimateSize(key: string, value: unknown): number {
    try {
        return JSON.stringify(value).length * 2;
    } catch {
        // Circular references etc. — fall back to a coarse estimate so
        // the cache does not crash on un-serializable inputs.
        void key;
        return 1024;
    }
}
