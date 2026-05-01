// SPEC-014-1-02 §Task 2.5 — Smoke tests for LocalhostAuthProvider and the
// network-binding enforcer. Full test matrix lives in PLAN-014-2's
// SPEC-014-2-05 / PLAN-014-3 SPEC-014-3-04; these cases exercise the
// happy path + the headline rejection paths for each acceptance criterion.

import { beforeEach, describe, expect, test } from "bun:test";

import { LocalhostAuthProvider } from "../../server/auth/localhost-auth";
import {
    enforceBinding,
    isLoopbackIp,
} from "../../server/auth/network-binding";
import { SecurityError } from "../../server/auth/types";
import type { PortalConfig } from "../../server/lib/config";
import type { AuthLogger } from "../../server/auth/base-auth";

function baseConfig(overrides: Partial<PortalConfig> = {}): PortalConfig {
    return {
        port: 30100,
        auth_mode: "localhost",
        bind_host: null,
        allowed_origins: [],
        logging: { level: "info" },
        paths: {
            state_dir: "~/.autonomous-dev",
            logs_dir: "~/.autonomous-dev/logs",
            user_config: "~/.autonomous-dev/config.json",
        },
        shutdown: { grace_period_ms: 1000, force_timeout_ms: 2000 },
        ...overrides,
    };
}

function recordingLogger(): AuthLogger & {
    events: Array<{ level: string; event: string; fields: unknown }>;
} {
    const events: Array<{ level: string; event: string; fields: unknown }> = [];
    return {
        events,
        info: (event, fields) => events.push({ level: "info", event, fields }),
        warn: (event, fields) => events.push({ level: "warn", event, fields }),
        error: (event, fields) => events.push({ level: "error", event, fields }),
    };
}

describe("isLoopbackIp", () => {
    test("recognises only the documented loopback constants", () => {
        expect(isLoopbackIp("127.0.0.1")).toBe(true);
        expect(isLoopbackIp("::1")).toBe(true);
        expect(isLoopbackIp("::ffff:127.0.0.1")).toBe(true);
    });

    test("rejects other 127.0.0.0/8 addresses, LAN, external, and falsy values", () => {
        expect(isLoopbackIp("127.0.0.2")).toBe(false);
        expect(isLoopbackIp("127.10.0.5")).toBe(false);
        expect(isLoopbackIp("192.168.1.50")).toBe(false);
        expect(isLoopbackIp("203.0.113.5")).toBe(false);
        expect(isLoopbackIp("")).toBe(false);
        expect(isLoopbackIp("unknown")).toBe(false);
        expect(isLoopbackIp(" 127.0.0.1 ")).toBe(false);
    });
});

describe("LocalhostAuthProvider.evaluate", () => {
    test("allows loopback peer and stamps the documented AuthContext", async () => {
        const provider = new LocalhostAuthProvider(baseConfig());
        const decision = await provider.evaluate(
            new Request("http://127.0.0.1/ignored"),
            "127.0.0.1",
        );
        expect(decision.kind).toBe("allow");
        if (decision.kind !== "allow") return;
        expect(decision.context.mode).toBe("localhost");
        expect(decision.context.source_user_id).toBe("localhost");
        expect(decision.context.display_name).toBe("Local Operator");
        expect(decision.context.details).toEqual({ peer_ip: "127.0.0.1" });
    });

    test("denies a LAN peer with 403 NON_LOOPBACK and emits a warn log", async () => {
        const logger = recordingLogger();
        const provider = new LocalhostAuthProvider(baseConfig(), logger);
        const decision = await provider.evaluate(
            new Request("http://127.0.0.1/ignored"),
            "192.168.1.50",
        );
        expect(decision).toEqual({
            kind: "deny",
            status: 403,
            error_code: "NON_LOOPBACK",
            message: "Localhost mode requires loopback origin",
        });
        const warned = logger.events.find(
            (e) => e.event === "localhost.auth.rejected_non_loopback",
        );
        expect(warned).toBeDefined();
    });

    test("init throws LOCALHOST_REQUIRES_LOOPBACK for non-loopback bind_host", async () => {
        const provider = new LocalhostAuthProvider(
            baseConfig({ bind_host: "192.168.1.50" }),
        );
        let caught: unknown = null;
        try {
            await provider.init();
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(SecurityError);
        expect((caught as SecurityError).code).toBe(
            "LOCALHOST_REQUIRES_LOOPBACK",
        );
    });
});

describe("enforceBinding", () => {
    beforeEach(() => {
        // No-op; placeholder for parity with other binding tests.
    });

    test("passes silently for the recommended localhost defaults", () => {
        // bind_host=null is the recommended default; should not throw.
        enforceBinding(baseConfig());
        enforceBinding(baseConfig({ bind_host: "127.0.0.1" }));
    });

    test("rejects 0.0.0.0 with LOCALHOST_FORBIDDEN_BIND", () => {
        let caught: unknown = null;
        try {
            enforceBinding(baseConfig({ bind_host: "0.0.0.0" }));
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(SecurityError);
        expect((caught as SecurityError).code).toBe("LOCALHOST_FORBIDDEN_BIND");
    });

    test("rejects a LAN bind with LOCALHOST_REQUIRES_LOOPBACK", () => {
        let caught: unknown = null;
        try {
            enforceBinding(baseConfig({ bind_host: "192.168.1.50" }));
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(SecurityError);
        expect((caught as SecurityError).code).toBe(
            "LOCALHOST_REQUIRES_LOOPBACK",
        );
    });

    test("rejects trusted_reverse_proxy=true in localhost mode", () => {
        let caught: unknown = null;
        try {
            enforceBinding(baseConfig({ trusted_reverse_proxy: true }));
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(SecurityError);
        expect((caught as SecurityError).code).toBe("LOCALHOST_REJECTS_PROXY");
    });

    test("is a no-op for tailscale and oauth-pkce modes", () => {
        // Other modes carry their own enforcers; this gate must not fire.
        enforceBinding(
            baseConfig({ auth_mode: "tailscale", bind_host: "0.0.0.0" }),
        );
        enforceBinding(
            baseConfig({ auth_mode: "oauth-pkce", bind_host: "0.0.0.0" }),
        );
    });
});
