// SPEC-015-1-02 — SSE event bus.
//
// Owns the connection registry, sequence counter, heartbeat manager,
// and the broadcast fan-out. Delivery to slow clients is non-blocking
// (drop-on-overflow); a single slow client never delays delivery to
// fast clients.

import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { SSEStreamingApi } from "hono/streaming";

import {
    type BroadcastInput,
    EVENT_PROTOCOL_VERSION,
    type PortalEvent,
} from "../events/types";
import { safeParseEvent } from "../events/schemas";
import { Connection } from "./Connection";
import {
    generateConnectionId,
    generateEventId,
    SequenceCounter,
} from "./EventProtocol";
import { HeartbeatManager } from "./HeartbeatManager";
import type { ConnectionStats, SSELogger, SSEServerOptions, SSEStreamLike } from "./types";

const DEFAULTS = {
    maxConnections: 10,
    heartbeatIntervalMs: 30_000,
    connectionTimeoutMs: 300_000,
    writeQueueLimit: 50,
} as const;

const NOOP_LOGGER: SSELogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

export class SSEEventBus {
    private readonly opts: Required<Omit<SSEServerOptions, "logger" | "now">> & {
        logger: SSELogger;
        now: () => number;
    };
    private readonly connections = new Map<string, Connection>();
    private readonly sequence = new SequenceCounter();
    private readonly heartbeatManager: HeartbeatManager;
    private shuttingDown = false;

    constructor(options: SSEServerOptions = {}) {
        this.opts = {
            maxConnections: options.maxConnections ?? DEFAULTS.maxConnections,
            heartbeatIntervalMs:
                options.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs,
            connectionTimeoutMs:
                options.connectionTimeoutMs ?? DEFAULTS.connectionTimeoutMs,
            writeQueueLimit: options.writeQueueLimit ?? DEFAULTS.writeQueueLimit,
            logger: options.logger ?? NOOP_LOGGER,
            now: options.now ?? Date.now,
        };
        this.heartbeatManager = new HeartbeatManager({
            heartbeatIntervalMs: this.opts.heartbeatIntervalMs,
            getConnections: () =>
                Array.from(this.connections.values()).filter(
                    (c) => c.state === "open",
                ),
            onHeartbeat: () => this.broadcastHeartbeat(),
            onStale: (conn) => this.removeConnection(conn.id, "stale"),
            logger: this.opts.logger,
            now: this.opts.now,
        });
        this.heartbeatManager.start();
    }

    /** Hono route handler. Returns 429 when the cap is reached. */
    handleConnection(c: Context): Response {
        if (this.shuttingDown) {
            return c.text("Server shutting down", 503);
        }
        if (this.connections.size >= this.opts.maxConnections) {
            return c.text(
                `Too many SSE connections (max ${String(this.opts.maxConnections)}). Retry later.`,
                429,
                { "Retry-After": "30" },
            );
        }

        return streamSSE(c, async (stream: SSEStreamingApi) => {
            await this.acceptStream(this.adaptHonoStream(stream));
        });
    }

    /**
     * Test/embedded entry point: register a Connection wrapping any
     * SSEStreamLike. Returns the Connection so callers can close or
     * inspect it. Returns null when the cap is hit.
     */
    async registerStream(stream: SSEStreamLike): Promise<Connection | null> {
        if (this.shuttingDown) return null;
        if (this.connections.size >= this.opts.maxConnections) return null;
        return await this.acceptStream(stream);
    }

    private async acceptStream(stream: SSEStreamLike): Promise<Connection> {
        const id = generateConnectionId(this.opts.now);
        const conn = new Connection({
            id,
            stream,
            createdAt: new Date(this.opts.now()),
            writeQueueLimit: this.opts.writeQueueLimit,
            heartbeatTimeoutMs: this.opts.connectionTimeoutMs,
            logger: this.opts.logger,
            now: this.opts.now,
        });
        this.connections.set(id, conn);

        stream.onAbort(() => {
            void this.removeConnection(id, "client");
        });

        // Send initial `: connected` SSE comment to flush proxy buffers,
        // followed by an immediate heartbeat so clients see liveness on
        // connect.
        await conn.writeComment("connected");
        const hb = this.makeHeartbeatEvent(conn);
        await conn.write(hb);

        return conn;
    }

    /** Build a Hono SSEStreamingApi adapter that satisfies SSEStreamLike. */
    private adaptHonoStream(stream: SSEStreamingApi): SSEStreamLike {
        return {
            writeSSE: async (msg) => {
                await stream.writeSSE(msg);
            },
            write: async (chunk) => {
                await stream.write(chunk);
            },
            onAbort: (cb) => {
                stream.onAbort(cb);
            },
            close: async () => {
                await stream.close();
            },
        };
    }

    /**
     * Public broadcast — caller supplies type+payload only. Envelope
     * fields are filled in atomically; validation runs before any wire
     * write so malformed events never leak to clients.
     */
    async broadcast(input: BroadcastInput): Promise<void> {
        if (this.shuttingDown) return;
        const event = this.envelope(input);
        const parsed = safeParseEvent(event);
        if (!parsed.success) {
            this.opts.logger.error(
                `SSEEventBus: refusing to broadcast invalid event (${parsed.error?.message ?? "unknown"})`,
            );
            return;
        }

        const conns = Array.from(this.connections.values()).filter(
            (c) => c.state === "open",
        );
        const results = await Promise.allSettled(
            conns.map((c) => c.write(parsed.data!)),
        );
        // Reap connections that closed during the write.
        for (let i = 0; i < conns.length; i += 1) {
            const conn = conns[i];
            if (!conn) continue;
            const r = results[i];
            const closed =
                conn.state === "closed" ||
                (r?.status === "fulfilled" && r.value === "closed");
            if (closed) {
                void this.removeConnection(conn.id, "server");
            }
        }
    }

    private envelope(input: BroadcastInput): PortalEvent {
        const base = {
            v: EVENT_PROTOCOL_VERSION,
            id: generateEventId(this.opts.now),
            seq: this.sequence.next(),
            ts: new Date(this.opts.now()).toISOString(),
        };
        return { ...base, ...input } as PortalEvent;
    }

    private async broadcastHeartbeat(): Promise<void> {
        // Heartbeat connection_age_s is per-connection. We broadcast a
        // single envelope but write per connection, computing age inline
        // so the payload reflects each client.
        const conns = Array.from(this.connections.values()).filter(
            (c) => c.state === "open",
        );
        const tasks = conns.map(async (conn) => {
            const event = this.makeHeartbeatEvent(conn);
            return await conn.write(event);
        });
        await Promise.allSettled(tasks);
    }

    private makeHeartbeatEvent(conn: Connection): PortalEvent {
        const nowMs = this.opts.now();
        const ageS = Math.max(
            0,
            Math.floor((nowMs - conn.createdAt.getTime()) / 1000),
        );
        return {
            v: EVENT_PROTOCOL_VERSION,
            id: generateEventId(this.opts.now),
            seq: this.sequence.next(),
            ts: new Date(nowMs).toISOString(),
            type: "heartbeat",
            payload: {
                server_ts: new Date(nowMs).toISOString(),
                connection_age_s: ageS,
            },
        };
    }

    getConnectionCount(): number {
        return this.connections.size;
    }

    getConnectionStats(): ConnectionStats[] {
        const now = this.opts.now();
        return Array.from(this.connections.values()).map((c) => ({
            id: c.id,
            ageMs: now - c.createdAt.getTime(),
            writeQueueDepth: c.writeQueueDepth,
            droppedEventCount: c.droppedEventCount,
            lastHeartbeatMs: now - c.lastHeartbeat.getTime(),
        }));
    }

    /** Sequence counter snapshot for tests. */
    getCurrentSeq(): number {
        return this.sequence.current();
    }

    private async removeConnection(
        id: string,
        reason: "client" | "server" | "stale" | "overcap",
    ): Promise<void> {
        const conn = this.connections.get(id);
        if (!conn) return;
        this.connections.delete(id);
        await conn.close(reason);
    }

    /**
     * Final shutdown: send `: shutdown` comment, close every
     * connection, stop heartbeat timers. Subsequent `broadcast` calls
     * are no-ops.
     */
    async shutdown(): Promise<void> {
        if (this.shuttingDown) return;
        this.shuttingDown = true;
        this.heartbeatManager.stop();

        const conns = Array.from(this.connections.values());
        await Promise.allSettled(
            conns.map(async (c) => {
                try {
                    await c.writeComment("shutdown");
                } finally {
                    await this.removeConnection(c.id, "server");
                }
            }),
        );
    }
}
