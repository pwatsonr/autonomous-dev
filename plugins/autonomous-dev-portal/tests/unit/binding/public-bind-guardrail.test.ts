// PLAN-041 §Follow-ups F-041-05 — Tests for the refuse-to-start guardrail
// that blocks non-loopback binds without an explicit acknowledgement.
//
// Covers:
//   - loopback hostname (127.0.0.1) → ok
//   - non-loopback hostname + no ack → throws PortalError
//   - non-loopback hostname + PORTAL_PUBLIC_BIND=1 env → ok
//   - non-loopback hostname + public_bind_acknowledged: true → ok

import { describe, expect, test } from "bun:test";

import { enforcePublicBindAcknowledgement } from "../../../server/lib/binding";
import type { PortalConfig } from "../../../server/lib/config";
import { PortalError } from "../../../server/middleware/error-handler";

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

describe("enforcePublicBindAcknowledgement (F-041-05)", () => {
    test("loopback hostname 127.0.0.1 passes without ack", () => {
        const cfg = baseConfig();
        // Should not throw.
        enforcePublicBindAcknowledgement("127.0.0.1", cfg, {});
    });

    test("loopback hostname ::1 passes without ack", () => {
        const cfg = baseConfig();
        enforcePublicBindAcknowledgement("::1", cfg, {});
    });

    test("loopback hostname 'localhost' passes without ack", () => {
        const cfg = baseConfig();
        enforcePublicBindAcknowledgement("localhost", cfg, {});
    });

    test("non-loopback hostname (0.0.0.0) without ack throws PortalError", () => {
        const cfg = baseConfig();
        let caught: unknown = null;
        try {
            enforcePublicBindAcknowledgement("0.0.0.0", cfg, {});
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(PortalError);
        expect((caught as PortalError).code).toBe(
            "PUBLIC_BIND_NOT_ACKNOWLEDGED",
        );
        // The error message MUST mention the override mechanism so
        // operators know how to authorize the bind.
        expect((caught as PortalError).message).toContain("PORTAL_PUBLIC_BIND=1");
        expect((caught as PortalError).message).toContain(
            "public_bind_acknowledged",
        );
        // And it MUST quote the offending hostname.
        expect((caught as PortalError).message).toContain('"0.0.0.0"');
    });

    test("non-loopback specific public IP without ack also throws (same as 0.0.0.0)", () => {
        const cfg = baseConfig();
        let caught: unknown = null;
        try {
            enforcePublicBindAcknowledgement("192.168.1.50", cfg, {});
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(PortalError);
        expect((caught as PortalError).code).toBe(
            "PUBLIC_BIND_NOT_ACKNOWLEDGED",
        );
    });

    test("non-loopback hostname with PORTAL_PUBLIC_BIND=1 env ack passes", () => {
        const cfg = baseConfig();
        // Should not throw.
        enforcePublicBindAcknowledgement("0.0.0.0", cfg, {
            PORTAL_PUBLIC_BIND: "1",
        });
    });

    test("PORTAL_PUBLIC_BIND set to any value other than '1' does NOT count as ack", () => {
        const cfg = baseConfig();
        let caught: unknown = null;
        try {
            enforcePublicBindAcknowledgement("0.0.0.0", cfg, {
                PORTAL_PUBLIC_BIND: "true",
            });
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(PortalError);
        expect((caught as PortalError).code).toBe(
            "PUBLIC_BIND_NOT_ACKNOWLEDGED",
        );
    });

    test("non-loopback hostname with public_bind_acknowledged=true config ack passes", () => {
        const cfg = baseConfig({ public_bind_acknowledged: true });
        // Should not throw.
        enforcePublicBindAcknowledgement("0.0.0.0", cfg, {});
    });

    test("public_bind_acknowledged=false is treated as no ack", () => {
        const cfg = baseConfig({ public_bind_acknowledged: false });
        let caught: unknown = null;
        try {
            enforcePublicBindAcknowledgement("0.0.0.0", cfg, {});
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(PortalError);
        expect((caught as PortalError).code).toBe(
            "PUBLIC_BIND_NOT_ACKNOWLEDGED",
        );
    });
});
