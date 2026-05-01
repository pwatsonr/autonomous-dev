// SPEC-014-1-03 §Task 3.6 — Smoke tests for TailscaleAuthProvider and the
// CIDR helpers. Full subprocess-fixture suite belongs to PLAN-014-3
// SPEC-014-3-04; these cases anchor the headline allow/deny paths and the
// forged-header defence so we have a regression guard inline.

import { describe, expect, test } from "bun:test";

import {
    ipInAnyCIDR,
    ipInCIDR,
    parseCIDR,
} from "../../server/auth/cidr-utils";
import {
    enforceBinding,
    enforceTailscaleBinding,
} from "../../server/auth/network-binding";
import { TailscaleAuthProvider } from "../../server/auth/tailscale-auth";
import type {
    TailscaleClient,
    TailscaleWhois,
} from "../../server/auth/tailscale-client";
import { SecurityError } from "../../server/auth/types";
import type { PortalConfig } from "../../server/lib/config";

function baseConfig(overrides: Partial<PortalConfig> = {}): PortalConfig {
    return {
        port: 30100,
        auth_mode: "tailscale",
        bind_host: "auto",
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

interface StubClientOptions {
    interfaceIp?: string;
    whois?: TailscaleWhois | null;
    whoisCalls?: string[];
}

function stubClient(opts: StubClientOptions = {}): TailscaleClient {
    return {
        ensureAvailable: async () => undefined,
        getInterfaceIp: async () => opts.interfaceIp ?? "100.64.10.5",
        getTailnetCIDRs: async () => [
            "100.64.0.0/10",
            "fd7a:115c:a1e0::/48",
        ],
        whois: async (peerIp) => {
            opts.whoisCalls?.push(peerIp);
            return opts.whois ?? null;
        },
    };
}

describe("ipInCIDR boundary cases", () => {
    test("CGNAT range membership and edges", () => {
        const cgnat = parseCIDR("100.64.0.0/10");
        expect(ipInCIDR("100.64.0.0", cgnat)).toBe(true);
        expect(ipInCIDR("100.127.255.255", cgnat)).toBe(true);
        expect(ipInCIDR("100.128.0.0", cgnat)).toBe(false);
        expect(ipInCIDR("100.63.255.255", cgnat)).toBe(false);
        expect(ipInCIDR("192.168.1.1", cgnat)).toBe(false);
        expect(ipInCIDR("127.0.0.1", cgnat)).toBe(false);
    });

    test("IPv6 ULA membership and cross-family", () => {
        const ula = parseCIDR("fd7a:115c:a1e0::/48");
        expect(ipInCIDR("fd7a:115c:a1e0::1", ula)).toBe(true);
        expect(ipInCIDR("fd7a:115c:a1e1::1", ula)).toBe(false);
        expect(ipInCIDR("100.64.0.1", ula)).toBe(false);
    });

    test("ipInAnyCIDR matches when any range matches", () => {
        const ranges = [
            parseCIDR("100.64.0.0/10"),
            parseCIDR("fd7a:115c:a1e0::/48"),
        ];
        expect(ipInAnyCIDR("100.65.0.1", ranges)).toBe(true);
        expect(ipInAnyCIDR("fd7a:115c:a1e0::abcd", ranges)).toBe(true);
        expect(ipInAnyCIDR("10.0.0.1", ranges)).toBe(false);
    });

    test("parseCIDR rejects malformed input with INVALID_CIDR", () => {
        for (const bad of ["100.64.0.0", "100.64.0.0/40", "10.x.0.0/8", ""]) {
            let caught: unknown = null;
            try {
                parseCIDR(bad);
            } catch (e) {
                caught = e;
            }
            expect(caught).toBeInstanceOf(SecurityError);
            expect((caught as SecurityError).code).toBe("INVALID_CIDR");
        }
    });
});

describe("TailscaleAuthProvider.evaluate", () => {
    test("GET inside the tailnet without identity becomes a tailnet-peer:<ip>", async () => {
        const provider = new TailscaleAuthProvider({
            config: baseConfig(),
            client: stubClient(),
        });
        await provider.init();
        const decision = await provider.evaluate(
            new Request("http://100.64.10.5/"),
            "100.64.10.5",
        );
        expect(decision.kind).toBe("allow");
        if (decision.kind !== "allow") return;
        expect(decision.context.source_user_id).toBe("tailnet-peer:100.64.10.5");
        expect(decision.context.details).toEqual({
            peer_ip: "100.64.10.5",
            whois_verified: false,
        });
    });

    test("POST overrides forged header with whois result (defence-in-depth)", async () => {
        const calls: string[] = [];
        const provider = new TailscaleAuthProvider({
            config: baseConfig(),
            client: stubClient({
                whois: { login: "alice@example.com", display_name: "Alice" },
                whoisCalls: calls,
            }),
        });
        await provider.init();
        const req = new Request("http://100.64.10.5/api", {
            method: "POST",
            headers: { "Tailscale-User-Login": "admin@evil" },
        });
        const decision = await provider.evaluate(req, "100.64.10.5");
        expect(calls).toEqual(["100.64.10.5"]);
        expect(decision.kind).toBe("allow");
        if (decision.kind !== "allow") return;
        // Header was IGNORED; whois identity wins.
        expect(decision.context.source_user_id).toBe("alice@example.com");
        expect(decision.context.display_name).toBe("Alice");
        expect(decision.context.details).toEqual({
            peer_ip: "100.64.10.5",
            whois_verified: true,
        });
    });

    test("POST denies WHOIS_FAILED when whois returns null", async () => {
        const provider = new TailscaleAuthProvider({
            config: baseConfig(),
            client: stubClient({ whois: null }),
        });
        await provider.init();
        const decision = await provider.evaluate(
            new Request("http://100.64.10.5/api", { method: "POST" }),
            "100.64.10.5",
        );
        expect(decision).toEqual({
            kind: "deny",
            status: 403,
            error_code: "WHOIS_FAILED",
            message: "Tailscale whois did not return an identity for this peer",
        });
    });

    test("non-tailnet peer denies NOT_IN_TAILNET", async () => {
        const provider = new TailscaleAuthProvider({
            config: baseConfig(),
            client: stubClient(),
        });
        await provider.init();
        const decision = await provider.evaluate(
            new Request("http://100.64.10.5/"),
            "192.168.1.5",
        );
        expect(decision.kind).toBe("deny");
        if (decision.kind !== "deny") return;
        expect(decision.error_code).toBe("NOT_IN_TAILNET");
    });
});

describe("enforceBinding (tailscale)", () => {
    test("rejects 0.0.0.0 with TAILSCALE_FORBIDDEN_BIND", () => {
        let caught: unknown = null;
        try {
            enforceBinding(
                baseConfig({ auth_mode: "tailscale", bind_host: "0.0.0.0" }),
            );
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(SecurityError);
        expect((caught as SecurityError).code).toBe("TAILSCALE_FORBIDDEN_BIND");
    });

    test("auto bind resolves to the interface IP", async () => {
        const ip = await enforceTailscaleBinding(
            baseConfig({ auth_mode: "tailscale", bind_host: "auto" }),
            stubClient({ interfaceIp: "100.64.10.5" }),
        );
        expect(ip).toBe("100.64.10.5");
    });

    test("explicit bind mismatch throws TAILSCALE_BIND_MISMATCH", async () => {
        let caught: unknown = null;
        try {
            await enforceTailscaleBinding(
                baseConfig({ bind_host: "100.64.99.99" }),
                stubClient({ interfaceIp: "100.64.10.5" }),
            );
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(SecurityError);
        expect((caught as SecurityError).code).toBe("TAILSCALE_BIND_MISMATCH");
    });

    test("missing client throws TAILSCALE_BINDING_NO_CLIENT", async () => {
        let caught: unknown = null;
        try {
            await enforceTailscaleBinding(baseConfig(), null);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(SecurityError);
        expect((caught as SecurityError).code).toBe("TAILSCALE_BINDING_NO_CLIENT");
    });
});
