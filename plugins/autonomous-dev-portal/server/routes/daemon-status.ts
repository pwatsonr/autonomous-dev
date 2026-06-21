// SPEC-037-2-02 — GET /api/daemon-status
//
// Read-only endpoint for the rail-ops status pill. Reads four sources in
// parallel via Promise.allSettled so a partial failure (cost-ledger throws,
// kill-switch state file missing) still returns a usable payload with
// defaults + a structured WARN log.
//
// Latency budget: p99 < 50ms (FR-8). The handler does pure FS reads with no
// sequential awaits; the four reads run concurrently and the slowest sets
// the response time.
//
// Caching: Cache-Control: no-store so the 5s rail-ops poll never serves a
// stale value from an intermediary (FR-7).

import type { Context } from "hono";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ActionLogger } from "./_action-deps";
import { noopActionLogger } from "./_action-deps";

const RUNNING_MS = 60_000;
const STALE_MS = 300_000;

/** Sentinel returned in `heartbeatAgeMs` when the heartbeat file is absent. */
export const HEARTBEAT_MISSING_AGE_MS = -1;

export type DaemonRunState = "running" | "stale" | "down";

export interface DaemonStatusBody {
    status: DaemonRunState;
    heartbeatAgeMs: number;
    mtdSpend: number;
    approvalsCount: number;
    killSwitchEngaged: boolean;
    /** Seconds since the daemon started, from heartbeat `start_time` (#356 / FR-404). */
    uptimeSeconds: number | null;
    /** Supervisor-loop iteration count from the heartbeat (#356). */
    iterationCount: number | null;
    /** Request the daemon is currently processing, or null when idle (#356). */
    activeRequestId: string | null;
}

/** The heartbeat fields #356 surfaces (defensively parsed). */
interface HeartbeatExtras {
    uptimeSeconds: number | null;
    iterationCount: number | null;
    activeRequestId: string | null;
}

function parseHeartbeatExtras(raw: string, now: number): HeartbeatExtras {
    const empty: HeartbeatExtras = {
        uptimeSeconds: null,
        iterationCount: null,
        activeRequestId: null,
    };
    let obj: Record<string, unknown>;
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
        obj = parsed as Record<string, unknown>;
    } catch {
        return empty;
    }
    let uptimeSeconds: number | null = null;
    const start = obj["start_time"];
    if (typeof start === "string" && start.length > 0) {
        const startMs = Date.parse(start);
        if (!Number.isNaN(startMs) && now >= startMs) {
            uptimeSeconds = Math.floor((now - startMs) / 1000);
        }
    }
    const iter = obj["iteration_count"];
    const iterationCount =
        typeof iter === "number" && Number.isInteger(iter) && iter >= 0 ? iter : null;
    const reqId = obj["active_request_id"];
    const activeRequestId = typeof reqId === "string" && reqId.length > 0 ? reqId : null;
    return { uptimeSeconds, iterationCount, activeRequestId };
}

export interface DaemonStatusDeps {
    /**
     * Override the heartbeat file path. Defaults to
     * `~/.autonomous-dev/heartbeat.json` (honors `AUTONOMOUS_DEV_STATE_DIR`).
     */
    heartbeatPath?: string;
    /** Read month-to-date spend in USD. Throw or reject to fall back to 0. */
    readMtdSpend: () => Promise<number>;
    /** Pending approval count. Throw/reject to fall back to 0. */
    readApprovalsCount: () => Promise<number>;
    /** Kill-switch state. Throw/reject to fall back to false. */
    readKillSwitchEngaged: () => Promise<boolean>;
    logger?: ActionLogger;
}

function resolveDefaultHeartbeatPath(): string {
    const override = process.env["AUTONOMOUS_DEV_STATE_DIR"];
    if (override !== undefined && override.length > 0) {
        return join(override, "heartbeat.json");
    }
    return join(homedir(), ".autonomous-dev", "heartbeat.json");
}

function classify(ageMs: number): DaemonRunState {
    if (ageMs < 0 || ageMs > STALE_MS) return "down";
    if (ageMs > RUNNING_MS) return "stale";
    return "running";
}

/**
 * Build the daemon-status handler. Production wiring lives in `server.ts`;
 * tests inject mocks for each reader to exercise the partial-failure paths.
 */
export function buildDaemonStatusHandler(
    deps: DaemonStatusDeps,
): (c: Context) => Promise<Response> {
    const heartbeatPath = deps.heartbeatPath ?? resolveDefaultHeartbeatPath();
    const log = deps.logger ?? noopActionLogger();

    return async (c: Context): Promise<Response> => {
        c.header("Cache-Control", "no-store");

        const [hbR, hbBodyR, spendR, apprR, ksR] = await Promise.allSettled([
            fs.stat(heartbeatPath),
            fs.readFile(heartbeatPath, "utf8"),
            deps.readMtdSpend(),
            deps.readApprovalsCount(),
            deps.readKillSwitchEngaged(),
        ]);

        const now = Date.now();
        const heartbeatAgeMs =
            hbR.status === "fulfilled"
                ? Math.max(0, now - hbR.value.mtimeMs)
                : HEARTBEAT_MISSING_AGE_MS;
        const status = classify(heartbeatAgeMs);

        // #356: parse the heartbeat body for uptime/iteration/active-request.
        const extras: HeartbeatExtras =
            hbBodyR.status === "fulfilled"
                ? parseHeartbeatExtras(hbBodyR.value, now)
                : { uptimeSeconds: null, iterationCount: null, activeRequestId: null };

        if (spendR.status !== "fulfilled") {
            log.warn("daemon_status_cost_unavailable", {
                error: rejectionMessage(spendR.reason),
            });
        }
        if (apprR.status !== "fulfilled") {
            log.warn("daemon_status_approvals_unavailable", {
                error: rejectionMessage(apprR.reason),
            });
        }
        if (ksR.status !== "fulfilled") {
            log.warn("daemon_status_ks_unavailable", {
                error: rejectionMessage(ksR.reason),
            });
        }

        const body: DaemonStatusBody = {
            status,
            heartbeatAgeMs,
            mtdSpend: spendR.status === "fulfilled" ? spendR.value : 0,
            approvalsCount: apprR.status === "fulfilled" ? apprR.value : 0,
            killSwitchEngaged:
                ksR.status === "fulfilled" ? ksR.value : false,
            uptimeSeconds: extras.uptimeSeconds,
            iterationCount: extras.iterationCount,
            activeRequestId: extras.activeRequestId,
        };
        return c.json(body);
    };
}

function rejectionMessage(reason: unknown): string {
    if (reason instanceof Error) return reason.message;
    return typeof reason === "string" ? reason : "unknown-error";
}
