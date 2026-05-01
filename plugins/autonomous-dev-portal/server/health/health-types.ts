// SPEC-015-4-03 §Types — daemon health + banner + mutation gating.

export type DaemonStatus = "healthy" | "stale" | "dead" | "unknown";

export interface DaemonHealth {
    status: DaemonStatus;
    /** Epoch ms; null when the heartbeat file is missing or unreadable. */
    heartbeatTimestamp: number | null;
    /** ms since the heartbeat; null when timestamp is null. */
    heartbeatAgeMs: number | null;
    pid: number | null;
    iteration: number | null;
    /** When this snapshot was captured (epoch ms). */
    observedAt: number;
}

export type BannerSeverity = "none" | "warning" | "error";

export interface BannerConfig {
    severity: BannerSeverity;
    /** "status" for warning, "alert" for error; consumed by the banner. */
    ariaRole: "status" | "alert";
    message: string;
    details: string;
    showRetry: boolean;
}

export interface MutationValidation {
    allowed: boolean;
    reason?: string;
}

/** Threshold constants — exported for tests. */
export const HEALTHY_THRESHOLD_MS = 30_000;
export const STALE_THRESHOLD_MS = 120_000;
export const POLL_INTERVAL_MS = 15_000;
