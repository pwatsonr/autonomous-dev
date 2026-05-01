// SPEC-015-4-04 — StaleDataHandler unit tests.
//
// Truth table coverage (4 statuses × 3 outputs):
//   healthy → severity:none, ariaRole:status, mutations allowed
//   stale   → severity:warning, ariaRole:status, mutations allowed
//   dead    → severity:error, ariaRole:alert, mutations blocked, retry
//   unknown → severity:error, ariaRole:alert, mutations blocked, retry
//
// The handler's only collaborator is DaemonHealthMonitor#getDaemonStatus —
// we stub the monitor with a tiny shim rather than building a real one,
// so the truth table tests stay independent of the I/O path.

import { describe, expect, test } from "bun:test";

import type { DaemonHealthMonitor } from "../../server/health/daemon-health-monitor";
import {
    StaleDataHandler,
    formatAge,
} from "../../server/health/stale-data-handler";
import type { DaemonHealth, DaemonStatus } from "../../server/health/health-types";

function stubMonitor(snapshot: Partial<DaemonHealth> & { status: DaemonStatus }) {
    const full: DaemonHealth = {
        status: snapshot.status,
        heartbeatTimestamp: snapshot.heartbeatTimestamp ?? null,
        heartbeatAgeMs: snapshot.heartbeatAgeMs ?? null,
        pid: snapshot.pid ?? null,
        iteration: snapshot.iteration ?? null,
        observedAt: snapshot.observedAt ?? Date.now(),
    };
    return {
        getDaemonStatus: () => full,
    } as unknown as DaemonHealthMonitor;
}

describe("StaleDataHandler — banner severity truth table", () => {
    test("healthy: severity 'none', no message, no retry", () => {
        const h = new StaleDataHandler(stubMonitor({ status: "healthy" }));
        const banner = h.getBannerStatus();
        expect(banner.severity).toBe("none");
        expect(banner.ariaRole).toBe("status");
        expect(banner.message).toBe("");
        expect(banner.details).toBe("");
        expect(banner.showRetry).toBe(false);
    });

    test("stale: severity 'warning', status role, no retry", () => {
        const h = new StaleDataHandler(
            stubMonitor({ status: "stale", heartbeatAgeMs: 60_000 }),
        );
        const banner = h.getBannerStatus();
        expect(banner.severity).toBe("warning");
        expect(banner.ariaRole).toBe("status");
        expect(banner.message).toMatch(/stale/i);
        expect(banner.details).toContain("60s");
        expect(banner.showRetry).toBe(false);
    });

    test("dead: severity 'error', alert role, retry enabled", () => {
        const h = new StaleDataHandler(
            stubMonitor({ status: "dead", heartbeatAgeMs: 300_000 }),
        );
        const banner = h.getBannerStatus();
        expect(banner.severity).toBe("error");
        expect(banner.ariaRole).toBe("alert");
        expect(banner.message).toMatch(/unreachable/i);
        expect(banner.details).toContain("5m");
        expect(banner.showRetry).toBe(true);
    });

    test("dead with missing heartbeat (null age): details says 'missing'", () => {
        const h = new StaleDataHandler(
            stubMonitor({ status: "dead", heartbeatAgeMs: null }),
        );
        const banner = h.getBannerStatus();
        expect(banner.severity).toBe("error");
        expect(banner.details).toMatch(/missing/i);
        expect(banner.showRetry).toBe(true);
    });

    test("unknown: severity 'error', alert role, retry enabled", () => {
        const h = new StaleDataHandler(stubMonitor({ status: "unknown" }));
        const banner = h.getBannerStatus();
        expect(banner.severity).toBe("error");
        expect(banner.ariaRole).toBe("alert");
        expect(banner.message).toMatch(/cannot be determined/i);
        expect(banner.showRetry).toBe(true);
    });
});

describe("StaleDataHandler — mutation gating", () => {
    test("healthy: mutations allowed", () => {
        const h = new StaleDataHandler(stubMonitor({ status: "healthy" }));
        const v = h.validateMutationAllowed();
        expect(v.allowed).toBe(true);
        expect(v.reason).toBeUndefined();
    });

    test("stale: mutations allowed (daemon may be slow but is alive)", () => {
        const h = new StaleDataHandler(
            stubMonitor({ status: "stale", heartbeatAgeMs: 60_000 }),
        );
        expect(h.validateMutationAllowed().allowed).toBe(true);
    });

    test("dead: mutations blocked with reason", () => {
        const h = new StaleDataHandler(stubMonitor({ status: "dead" }));
        const v = h.validateMutationAllowed();
        expect(v.allowed).toBe(false);
        expect(v.reason).toMatch(/unavailable/i);
    });

    test("unknown: mutations blocked with reason", () => {
        const h = new StaleDataHandler(stubMonitor({ status: "unknown" }));
        const v = h.validateMutationAllowed();
        expect(v.allowed).toBe(false);
        expect(v.reason).toMatch(/unavailable/i);
    });
});

describe("formatAge", () => {
    test("null → 'unknown'", () => {
        expect(formatAge(null)).toBe("unknown");
    });

    test("seconds bucket (<60s)", () => {
        expect(formatAge(0)).toBe("0s");
        expect(formatAge(45_000)).toBe("45s");
        expect(formatAge(59_999)).toBe("60s"); // rounds up
    });

    test("minutes bucket (<1h)", () => {
        expect(formatAge(60_000)).toBe("1m");
        expect(formatAge(120_000)).toBe("2m");
        expect(formatAge(3_599_999)).toBe("60m"); // rounds up
    });

    test("hours bucket (>=1h)", () => {
        expect(formatAge(3_600_000)).toBe("1h");
        expect(formatAge(7_200_000)).toBe("2h");
    });
});
