// SPEC-015-1-02 — SSE bus internal types.

export interface SSELogger {
    debug?: (msg: string, ...args: unknown[]) => void;
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
}

export interface SSEServerOptions {
    /** Hard cap on concurrent SSE connections. Default: 10. */
    maxConnections?: number;
    /** Heartbeat broadcast cadence in ms. Default: 30_000. */
    heartbeatIntervalMs?: number;
    /** Idle deadline before sweeper closes a stale connection. Default: 300_000. */
    connectionTimeoutMs?: number;
    /** Per-connection write queue ceiling. Default: 50. */
    writeQueueLimit?: number;
    logger?: SSELogger;
    /**
     * Inject an alternate clock for fake-timer tests. Returns ms since
     * epoch. Defaults to `Date.now`.
     */
    now?: () => number;
}

export type ConnectionState = "open" | "closing" | "closed";

/**
 * Minimal contract that the SSE Connection wrapper expects from a
 * "stream". The Hono `SSEStreamingApi` satisfies this naturally; tests
 * pass an in-memory implementation.
 */
export interface SSEStreamLike {
    /** Write a pre-formatted SSE frame to the wire. */
    writeSSE(frame: { id?: string; event?: string; data: string }): Promise<void>;
    /** Write a raw chunk (used for SSE comments like `: connected`). */
    write?: (chunk: string) => Promise<void>;
    /** Subscribe to an abort signal from the client (e.g. tab closed). */
    onAbort: (cb: () => void) => void;
    /** Close the stream (no-op when already closed). */
    close: () => Promise<void> | void;
}

export interface ConnectionStats {
    id: string;
    ageMs: number;
    writeQueueDepth: number;
    droppedEventCount: number;
    lastHeartbeatMs: number;
}
