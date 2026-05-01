// SPEC-015-4-03 §DaemonHealthMonitor — polls heartbeat.json every 15s,
// classifies status (healthy < 30s, stale 30-120s, dead >120s OR file
// missing, unknown on parse error), and broadcasts status changes via
// the supplied broadcaster.
//
// Design decisions:
//   - The monitor is decoupled from the SSEEventBus's strongly-typed
//     event vocabulary. Callers wire whatever broadcaster they need
//     (the live SSEEventBus emits `daemon-down` events; tests use a
//     simple capture mock). This keeps the monitor portable across
//     event-bus revisions.
//   - File reads use node:fs/promises, not Bun.file — the rest of the
//     portal already uses fs/promises and we want a single I/O path.
//   - Polling cadence is fixed at 15s; the constant is exported so
//     tests can call `poll()` directly without waiting on the timer.

import { promises as fs } from "node:fs";

import {
    HEALTHY_THRESHOLD_MS,
    POLL_INTERVAL_MS,
    STALE_THRESHOLD_MS,
    type DaemonHealth,
    type DaemonStatus,
} from "./health-types";

/** Loose broadcaster interface — caller chooses how to ship events. */
export interface DaemonHealthBroadcaster {
    broadcastStatusChange(snapshot: DaemonHealth): void | Promise<void>;
}

export interface DaemonHealthMonitorOptions {
    /** Override the wall clock for tests. */
    now?: () => number;
    /** Override the poll interval (ms) — tests set 0 to disable. */
    pollIntervalMs?: number;
}

/** Initial snapshot — status `unknown`, no heartbeat data. */
function makeUnknown(now: number): DaemonHealth {
    return {
        status: "unknown",
        heartbeatTimestamp: null,
        heartbeatAgeMs: null,
        pid: null,
        iteration: null,
        observedAt: now,
    };
}

interface HeartbeatFile {
    timestamp: unknown;
    pid?: unknown;
    iteration?: unknown;
}

export class DaemonHealthMonitor {
    private current: DaemonHealth;
    private timer: ReturnType<typeof setInterval> | null = null;
    private readonly now: () => number;
    private readonly pollIntervalMs: number;

    constructor(
        private readonly heartbeatPath: string,
        private readonly broadcaster: DaemonHealthBroadcaster,
        options: DaemonHealthMonitorOptions = {},
    ) {
        this.now = options.now ?? Date.now;
        this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
        this.current = makeUnknown(this.now());
    }

    /** Start polling. Idempotent. */
    start(): void {
        if (this.timer !== null) return;
        // Immediate poll so the first status is fresh; do not await
        // (the start() caller should not block on disk).
        void this.poll();
        if (this.pollIntervalMs > 0) {
            this.timer = setInterval(() => {
                void this.poll();
            }, this.pollIntervalMs);
            const t = this.timer as { unref?: () => void };
            if (typeof t.unref === "function") t.unref();
        }
    }

    /** Stop the poll loop. Safe to call repeatedly. */
    stop(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** Latest snapshot. Cheap synchronous read. */
    getDaemonStatus(): DaemonHealth {
        return this.current;
    }

    /**
     * Read the heartbeat, classify, and broadcast on transition. Public
     * so tests can step the loop deterministically.
     */
    async poll(): Promise<void> {
        const previous = this.current;
        this.current = await this.readHeartbeat();
        if (previous.status !== this.current.status) {
            try {
                await this.broadcaster.broadcastStatusChange(this.current);
            } catch {
                // Broadcaster failures are intentionally swallowed:
                // health polling must never throw.
            }
        }
    }

    private async readHeartbeat(): Promise<DaemonHealth> {
        const observedAt = this.now();
        let raw: string;
        try {
            raw = await fs.readFile(this.heartbeatPath, "utf8");
        } catch (err) {
            const code =
                typeof err === "object" && err !== null && "code" in err
                    ? String((err as { code: unknown }).code)
                    : "UNKNOWN";
            // Missing file → dead. Anything else (perm denied, etc.) → unknown.
            const status: DaemonStatus = code === "ENOENT" ? "dead" : "unknown";
            return {
                status,
                heartbeatTimestamp: null,
                heartbeatAgeMs: null,
                pid: null,
                iteration: null,
                observedAt,
            };
        }

        let parsed: HeartbeatFile;
        try {
            parsed = JSON.parse(raw) as HeartbeatFile;
        } catch {
            return {
                status: "unknown",
                heartbeatTimestamp: null,
                heartbeatAgeMs: null,
                pid: null,
                iteration: null,
                observedAt,
            };
        }

        const ts =
            typeof parsed.timestamp === "string"
                ? Date.parse(parsed.timestamp)
                : typeof parsed.timestamp === "number"
                  ? parsed.timestamp
                  : NaN;
        if (!Number.isFinite(ts)) {
            return {
                status: "unknown",
                heartbeatTimestamp: null,
                heartbeatAgeMs: null,
                pid: null,
                iteration: null,
                observedAt,
            };
        }
        const age = observedAt - ts;
        const status: DaemonStatus =
            age < HEALTHY_THRESHOLD_MS
                ? "healthy"
                : age < STALE_THRESHOLD_MS
                  ? "stale"
                  : "dead";
        return {
            status,
            heartbeatTimestamp: ts,
            heartbeatAgeMs: age,
            pid:
                typeof parsed.pid === "number" && Number.isFinite(parsed.pid)
                    ? parsed.pid
                    : null,
            iteration:
                typeof parsed.iteration === "number" &&
                Number.isFinite(parsed.iteration)
                    ? parsed.iteration
                    : null,
            observedAt,
        };
    }
}
