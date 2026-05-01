// SPEC-015-1-04 — HeartbeatReader: read heartbeat.json + compute
// staleness.
//
// Pure reader. The pipeline (heartbeat-pipeline.ts in PLAN-015-2) is
// what maps state transitions to SSE broadcasts; this module only
// answers "what's the daemon's current state?".
//
// Defaults: 60s = up→down threshold ("stale"). The DOD also references
// 300s as "unreachable" but the spec body collapses that to a single
// `down` state — operations dashboards visualize the magnitude of
// `stale_seconds` rather than gating a separate state. We honor the
// spec body.

import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { AggregationCache } from "../cache/AggregationCache";
import { parseHeartbeat } from "./schemas/heartbeat";
import type { Heartbeat, Result } from "./types";

const HEARTBEAT_TTL_MS = 2_000;
const STATUS_TTL_MS = 2_000;
const DEFAULT_STALE_THRESHOLD_S = 60;

export type DaemonState = "up" | "down" | "unknown";

export interface DaemonStatus {
    state: DaemonState;
    last_heartbeat: Heartbeat | null;
    /** 0 when state === 'up'. */
    stale_seconds: number;
    threshold_seconds: number;
}

export interface HeartbeatReaderDeps {
    /** Repo root. The daemon writes <basePath>/.autonomous-dev/heartbeat.json. */
    basePath: string;
    cache: AggregationCache;
    /** Default 60. Operator-tunable for low-throughput dev environments. */
    staleThresholdSeconds?: number;
    logger?: { warn?: (msg: string, ...args: unknown[]) => void };
    /** Inject a clock for tests. Defaults to Date.now. */
    now?: () => number;
}

export class HeartbeatReader {
    private readonly deps: HeartbeatReaderDeps;
    private readonly threshold: number;
    private readonly now: () => number;

    constructor(deps: HeartbeatReaderDeps) {
        this.deps = deps;
        this.threshold = Math.max(
            1,
            Math.floor(deps.staleThresholdSeconds ?? DEFAULT_STALE_THRESHOLD_S),
        );
        this.now = deps.now ?? Date.now;
    }

    private heartbeatPath(): string {
        return join(this.deps.basePath, ".autonomous-dev", "heartbeat.json");
    }

    /**
     * Returns the parsed heartbeat or null if missing.
     * Malformed file → ok=false (caller decides whether to surface as
     * `unknown` or `down`). The pipeline normalizes to `unknown`.
     */
    async readHeartbeat(): Promise<Result<Heartbeat | null>> {
        const cacheKey = "heartbeat:raw";
        const cached = await this.deps.cache.get<Heartbeat | null>(cacheKey);
        if (cached !== null) return { ok: true, value: cached };

        const path = this.heartbeatPath();
        let raw: string;
        try {
            raw = await fs.readFile(path, "utf8");
        } catch (err) {
            const e = err as { code?: string };
            if (e.code === "ENOENT") {
                // Missing → null. Do NOT cache (avoid masking a write).
                return { ok: true, value: null };
            }
            return {
                ok: false,
                error: new Error(`failed to read ${path}: ${(err as Error).message}`),
            };
        }

        let parsedJson: unknown;
        try {
            parsedJson = JSON.parse(raw);
        } catch (err) {
            return {
                ok: false,
                error: new Error(
                    `malformed JSON in ${path}: ${(err as Error).message}`,
                ),
            };
        }

        const result = parseHeartbeat(parsedJson);
        if (!result.ok || !result.value) {
            return {
                ok: false,
                error: new Error(
                    `schema violation in ${path}: ${result.error ?? "unknown"}`,
                ),
            };
        }

        await this.deps.cache.set(cacheKey, result.value, HEARTBEAT_TTL_MS);
        return { ok: true, value: result.value };
    }

    /**
     * Resolves to a normalized DaemonStatus. Missing OR malformed file
     * collapses to `state: 'unknown'` so the UI banner has a stable
     * tri-state to render.
     */
    async getStatus(): Promise<Result<DaemonStatus>> {
        const cacheKey = "heartbeat:status";
        const cached = await this.deps.cache.get<DaemonStatus>(cacheKey);
        if (cached !== null) return { ok: true, value: cached };

        const hb = await this.readHeartbeat();

        let status: DaemonStatus;
        if (!hb.ok) {
            // Malformed → treat as unknown. Spec §getStatus.
            status = {
                state: "unknown",
                last_heartbeat: null,
                stale_seconds: 0,
                threshold_seconds: this.threshold,
            };
        } else if (hb.value === null) {
            status = {
                state: "unknown",
                last_heartbeat: null,
                stale_seconds: 0,
                threshold_seconds: this.threshold,
            };
        } else {
            const hbMs = Date.parse(hb.value.ts);
            const ageS = Math.max(0, Math.floor((this.now() - hbMs) / 1000));
            status = {
                state: ageS <= this.threshold ? "up" : "down",
                last_heartbeat: hb.value,
                stale_seconds: ageS <= this.threshold ? 0 : ageS,
                threshold_seconds: this.threshold,
            };
        }

        await this.deps.cache.set(cacheKey, status, STATUS_TTL_MS);
        return { ok: true, value: status };
    }
}
