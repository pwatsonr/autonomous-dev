// SPEC-015-4-03 §StaleDataHandler — banner config + mutation gating
// derived from the latest DaemonHealthMonitor snapshot.
//
// Truth table:
//   healthy → severity:none, mutations allowed
//   stale   → severity:warning, mutations allowed (daemon may be slow)
//   dead    → severity:error, mutations blocked
//   unknown → severity:error, mutations blocked
//
// `showRetry` is true only for dead/unknown; the retry button kicks
// the monitor's poll loop via /health (the route triggers a fresh read).

import type { DaemonHealthMonitor } from "./daemon-health-monitor";
import type { BannerConfig, MutationValidation } from "./health-types";

/** Format an age (ms) as a short human string ("45s", "2m", "1h"). */
export function formatAge(ms: number | null): string {
    if (ms === null) return "unknown";
    if (ms < 60_000) return `${String(Math.round(ms / 1000))}s`;
    if (ms < 3_600_000) return `${String(Math.round(ms / 60_000))}m`;
    return `${String(Math.round(ms / 3_600_000))}h`;
}

export class StaleDataHandler {
    constructor(private readonly monitor: DaemonHealthMonitor) {}

    getBannerStatus(): BannerConfig {
        const h = this.monitor.getDaemonStatus();
        switch (h.status) {
            case "healthy":
                return {
                    severity: "none",
                    ariaRole: "status",
                    message: "",
                    details: "",
                    showRetry: false,
                };
            case "stale":
                return {
                    severity: "warning",
                    ariaRole: "status",
                    message:
                        "Daemon heartbeat is stale. Data may be out of date.",
                    details: `Heartbeat age ${formatAge(h.heartbeatAgeMs)}`,
                    showRetry: false,
                };
            case "dead":
                return {
                    severity: "error",
                    ariaRole: "alert",
                    message: "Daemon is unreachable. Read-only mode.",
                    details:
                        h.heartbeatAgeMs !== null
                            ? `Last heartbeat ${formatAge(h.heartbeatAgeMs)} ago`
                            : "Heartbeat file missing",
                    showRetry: true,
                };
            case "unknown":
                return {
                    severity: "error",
                    ariaRole: "alert",
                    message: "Daemon status cannot be determined.",
                    details: "Heartbeat file is malformed or unreadable",
                    showRetry: true,
                };
        }
    }

    validateMutationAllowed(): MutationValidation {
        const status = this.monitor.getDaemonStatus().status;
        if (status === "dead" || status === "unknown") {
            return {
                allowed: false,
                reason: "Daemon is unavailable. Mutations are disabled.",
            };
        }
        return { allowed: true };
    }
}
