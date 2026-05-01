// SPEC-015-1-03 — Cache types.

export interface CacheLogger {
    debug?: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
}

export interface CacheOptions {
    /** Per-entry TTL when set() omits an explicit value. Default: 5_000 ms. */
    defaultTTLMs?: number;
    /** Hard ceiling on entry count; LRU evicts the oldest when exceeded. */
    maxEntries?: number;
    /** Soft ceiling on heap usage in MB; on overflow, drop oldest 20%. */
    maxMemoryMB?: number;
    logger?: CacheLogger;
    /** Inject a clock for tests. Defaults to Date.now. */
    now?: () => number;
}

export interface CacheEntry<T = unknown> {
    value: T;
    /** ms since epoch when set() was called. */
    timestamp: number;
    /** Per-entry TTL in ms. */
    ttl: number;
    /** ms since epoch when the value was last read or written. */
    lastAccess: number;
    /** Cached `JSON.stringify(value).length`. Used by the memory estimator. */
    sizeBytes: number;
}

export interface CacheStats {
    size: number;
    hitCount: number;
    missCount: number;
    hitRatio: number;
    approxMemoryMB: number;
    evictions: {
        ttl: number;
        size: number;
        memory: number;
        manual: number;
    };
}
