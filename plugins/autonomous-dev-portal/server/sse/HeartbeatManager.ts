// SPEC-015-1-02 — Heartbeat broadcaster + staleness sweeper.
//
// Two intervals:
//   - heartbeatIntervalMs (default 30s): broadcast a `heartbeat` event
//   - heartbeatIntervalMs / 2 (default 15s): sweep stale connections

import type { Connection } from "./Connection";
import type { SSELogger } from "./types";

export interface HeartbeatManagerDeps {
    heartbeatIntervalMs: number;
    /** Closure that returns currently-open connections at sweep time. */
    getConnections: () => Connection[];
    /** Called once per heartbeat interval to broadcast a heartbeat event. */
    onHeartbeat: () => Promise<void> | void;
    /** Called for each stale connection. */
    onStale: (conn: Connection) => Promise<void> | void;
    logger: SSELogger;
    now?: () => number;
}

export class HeartbeatManager {
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private sweepTimer: ReturnType<typeof setInterval> | null = null;
    private started = false;
    private stopped = false;
    private readonly deps: HeartbeatManagerDeps;
    private readonly now: () => number;

    constructor(deps: HeartbeatManagerDeps) {
        this.deps = deps;
        this.now = deps.now ?? Date.now;
    }

    start(): void {
        if (this.started || this.stopped) return;
        this.started = true;

        const interval = this.deps.heartbeatIntervalMs;
        const sweepInterval = Math.max(1000, Math.floor(interval / 2));

        this.heartbeatTimer = setInterval(() => {
            void Promise.resolve(this.deps.onHeartbeat()).catch((err: unknown) => {
                this.deps.logger.error(
                    `HeartbeatManager: heartbeat broadcast failed (${(err as Error).message})`,
                );
            });
        }, interval);

        this.sweepTimer = setInterval(() => {
            const now = new Date(this.now());
            for (const conn of this.deps.getConnections()) {
                if (conn.isStale(now)) {
                    void Promise.resolve(this.deps.onStale(conn)).catch(
                        (err: unknown) => {
                            this.deps.logger.error(
                                `HeartbeatManager: stale-close failed (${(err as Error).message})`,
                            );
                        },
                    );
                }
            }
        }, sweepInterval);
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
    }
}
