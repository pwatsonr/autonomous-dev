// SPEC-015-1-02 — Per-client SSE wrapper.
//
// Each Connection owns a queue depth counter, drops events past the
// queue ceiling (without throwing), and observes its own lastHeartbeat.
// Errors from the underlying stream transition the connection to
// 'closed' so the bus can drop it from the registry.

import type { PortalEvent } from "../events/types";
import { formatSSE } from "./EventProtocol";
import type { ConnectionState, SSEStreamLike, SSELogger } from "./types";

export type WriteResult = "sent" | "dropped" | "closed";

export interface ConnectionDeps {
    id: string;
    stream: SSEStreamLike;
    createdAt: Date;
    writeQueueLimit: number;
    heartbeatTimeoutMs: number;
    logger: SSELogger;
    now?: () => number;
}

const DROP_LOG_RATE_LIMIT_MS = 10_000;

export class Connection {
    readonly id: string;
    readonly createdAt: Date;
    state: ConnectionState = "open";
    lastHeartbeat: Date;
    writeQueueDepth = 0;
    droppedEventCount = 0;

    private readonly stream: SSEStreamLike;
    private readonly writeQueueLimit: number;
    private readonly heartbeatTimeoutMs: number;
    private readonly logger: SSELogger;
    private readonly now: () => number;
    private lastDropLogMs = 0;

    constructor(deps: ConnectionDeps) {
        this.id = deps.id;
        this.stream = deps.stream;
        this.createdAt = deps.createdAt;
        this.lastHeartbeat = deps.createdAt;
        this.writeQueueLimit = deps.writeQueueLimit;
        this.heartbeatTimeoutMs = deps.heartbeatTimeoutMs;
        this.logger = deps.logger;
        this.now = deps.now ?? Date.now;
    }

    async write(event: PortalEvent): Promise<WriteResult> {
        if (this.state !== "open") return "closed";
        if (this.writeQueueDepth >= this.writeQueueLimit) {
            this.droppedEventCount += 1;
            const now = this.now();
            if (now - this.lastDropLogMs >= DROP_LOG_RATE_LIMIT_MS) {
                this.lastDropLogMs = now;
                this.logger.warn(
                    `SSE conn ${this.id}: backpressure drop; queue depth=${String(this.writeQueueDepth)} limit=${String(this.writeQueueLimit)}`,
                );
            }
            return "dropped";
        }

        // Format on the bus thread; only awaited write goes async.
        const frame = formatSSE(event);
        this.writeQueueDepth += 1;
        try {
            await this.stream.writeSSE({
                id: event.id,
                event: event.type,
                data: JSON.stringify(event),
            });
            // Record liveness on every successful write — any delivered
            // frame proves the socket is alive.
            this.lastHeartbeat = new Date(this.now());
            return "sent";
        } catch (err) {
            this.logger.warn(
                `SSE conn ${this.id}: write failed (${(err as Error).message}); marking closed`,
            );
            this.state = "closed";
            return "closed";
        } finally {
            this.writeQueueDepth -= 1;
            // `frame` is computed but writeSSE may use the structured
            // form. Keep the variable to allow stream impls that prefer
            // raw chunks via stream.write.
            void frame;
        }
    }

    /** Send a raw SSE comment (e.g. `: connected\n\n`). Best-effort. */
    async writeComment(comment: string): Promise<void> {
        if (this.state !== "open") return;
        try {
            if (this.stream.write) {
                await this.stream.write(`: ${comment}\n\n`);
            } else {
                // Fall back to writeSSE with empty event — most clients
                // treat unknown event types as no-ops.
                await this.stream.writeSSE({ event: "comment", data: comment });
            }
        } catch (err) {
            this.logger.warn(
                `SSE conn ${this.id}: comment write failed (${(err as Error).message})`,
            );
            this.state = "closed";
        }
    }

    isStale(now: Date): boolean {
        return now.getTime() - this.lastHeartbeat.getTime() > this.heartbeatTimeoutMs;
    }

    async close(reason: "client" | "server" | "stale" | "overcap"): Promise<void> {
        if (this.state === "closed") return;
        this.state = "closing";
        try {
            await this.stream.close();
        } catch {
            // ignore close errors; reason is best-effort
        }
        this.state = "closed";
        this.logger.info(`SSE conn ${this.id}: closed (${reason})`);
    }
}
