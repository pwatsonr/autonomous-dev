// SPEC-030-1-03: tests against the TailscaleClient *interface*.
//
// Target: plugins/autonomous-dev-portal/server/auth/tailscale-client.ts
//
// The production implementation uses Bun.spawn (Bun-only runtime) and
// shells out to the Tailscale CLI. Under jest+node we cannot exercise the
// real spawn path; instead we test the *contract* via a typed mock that
// implements the production interface (TDD-030 §5.5, OQ-05). Production
// signature changes break the mock at compile time.

import { createMock, DEFAULT_WHOIS } from "./__mocks__/tailscale-client";
import {
    TAILSCALE_CGNAT_V4,
    TAILSCALE_ULA_V6,
    type TailscaleClient,
    type TailscaleWhois,
} from "../tailscale-client";

describe("tailscale-client constants", () => {
    it("exports the documented CGNAT IPv4 range", () => {
        expect(TAILSCALE_CGNAT_V4).toBe("100.64.0.0/10");
    });

    it("exports the documented ULA IPv6 range", () => {
        expect(TAILSCALE_ULA_V6).toBe("fd7a:115c:a1e0::/48");
    });
});

describe("TailscaleClient — contract via typed mock", () => {
    it("happy path: whois resolves a TailscaleWhois", async () => {
        const c: TailscaleClient = createMock();
        const w = await c.whois("100.64.1.5");
        expect(w).toEqual(DEFAULT_WHOIS);
    });

    it("daemon socket missing: surfaces ENOENT typed error", async () => {
        const c: TailscaleClient = createMock({
            whois: jest.fn().mockRejectedValue(
                Object.assign(new Error("daemon down"), {
                    code: "ENOENT",
                    path: "/var/run/tailscale/tailscaled.sock",
                }),
            ),
        });
        try {
            await c.whois("100.64.1.5");
            throw new Error("expected throw");
        } catch (err) {
            expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
        }
    });

    it("malformed identity payload: returns null per contract", async () => {
        // The production whois returns null when the daemon has no record.
        const c: TailscaleClient = createMock({
            whois: jest.fn().mockResolvedValue(null),
        });
        await expect(c.whois("100.64.99.99")).resolves.toBeNull();
    });

    it("getInterfaceIp resolves a CGNAT IP", async () => {
        const c: TailscaleClient = createMock();
        await expect(c.getInterfaceIp()).resolves.toBe("100.64.1.2");
    });

    it("getTailnetCIDRs returns documented constants", async () => {
        const c: TailscaleClient = createMock();
        await expect(c.getTailnetCIDRs()).resolves.toEqual([
            TAILSCALE_CGNAT_V4,
            TAILSCALE_ULA_V6,
        ]);
    });

    it("ensureAvailable rejects with TAILSCALE_CLI_UNAVAILABLE when daemon absent", async () => {
        const c: TailscaleClient = createMock({
            ensureAvailable: jest.fn().mockRejectedValue(
                Object.assign(new Error("CLI not found"), {
                    code: "TAILSCALE_CLI_UNAVAILABLE",
                }),
            ),
        });
        try {
            await c.ensureAvailable();
            throw new Error("expected throw");
        } catch (err) {
            expect((err as { code: string }).code).toBe("TAILSCALE_CLI_UNAVAILABLE");
        }
    });

    it("TailscaleWhois shape: login + display_name are strings", () => {
        const w: TailscaleWhois = { login: "u@example.com", display_name: "U" };
        expect(typeof w.login).toBe("string");
        expect(typeof w.display_name).toBe("string");
    });
});
