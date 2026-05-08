// SPEC-030-1-03: tests for ../tailscale-auth.ts.
//
// TailscaleAuthProvider's evaluate() is exercised against a typed mock
// TailscaleClient. The mock's interface is the production interface
// (TDD-030 §5.5, §8.4 mock-drift mitigation).

import { TailscaleAuthProvider } from "../tailscale-auth";
import { createMock, DEFAULT_WHOIS } from "./__mocks__/tailscale-client";

function makeConfig(overrides: Record<string, unknown> = {}): any {
    return {
        auth_mode: "tailscale",
        bind_host: "auto",
        trusted_reverse_proxy: false,
        tailscale: { require_whois_for_writes: true },
        ...overrides,
    };
}

function makeLogger() {
    return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe("TailscaleAuthProvider — init()", () => {
    it("loads CIDRs from the client and ensures availability", async () => {
        const client = createMock();
        const p = new TailscaleAuthProvider({
            config: makeConfig(),
            client,
            logger: makeLogger(),
        });
        await p.init();
        expect(client.ensureAvailable).toHaveBeenCalled();
        expect(client.getInterfaceIp).toHaveBeenCalled();
        expect(client.getTailnetCIDRs).toHaveBeenCalled();
        expect(p.getInterfaceIp()).toBe("100.64.1.2");
    });

    it("re-throws if the client rejects ensureAvailable", async () => {
        const client = createMock({
            ensureAvailable: jest
                .fn()
                .mockRejectedValue(new Error("daemon missing")),
        });
        const p = new TailscaleAuthProvider({
            config: makeConfig(),
            client,
            logger: makeLogger(),
        });
        await expect(p.init()).rejects.toThrow("daemon missing");
    });
});

describe("TailscaleAuthProvider — evaluate()", () => {
    async function freshProvider(extraConfig: Record<string, unknown> = {}, mockOverrides = {}) {
        const client = createMock(mockOverrides);
        const p = new TailscaleAuthProvider({
            config: makeConfig(extraConfig),
            client,
            logger: makeLogger(),
        });
        await p.init();
        return { p, client };
    }

    it("denies a peer outside the tailnet CIDRs", async () => {
        const { p } = await freshProvider();
        const decision = await p.evaluate(new Request("http://x/"), "10.0.0.5");
        expect(decision.kind).toBe("deny");
        if (decision.kind === "deny") {
            expect(decision.error_code).toBe("NOT_IN_TAILNET");
        }
    });

    it("allows a tailnet peer for a read-only GET (whois not required)", async () => {
        const { p } = await freshProvider();
        const decision = await p.evaluate(
            new Request("http://x/", { method: "GET" }),
            "100.64.1.5",
        );
        expect(decision.kind).toBe("allow");
    });

    it("requires whois on mutating methods and uses its identity", async () => {
        const { p, client } = await freshProvider();
        const decision = await p.evaluate(
            new Request("http://x/", { method: "POST" }),
            "100.64.1.5",
        );
        expect(client.whois).toHaveBeenCalledWith("100.64.1.5");
        expect(decision.kind).toBe("allow");
        if (decision.kind === "allow") {
            expect(decision.context.source_user_id).toBe(DEFAULT_WHOIS.login);
            expect(decision.context.details.whois_verified).toBe(true);
        }
    });

    it("denies mutating method when whois returns null", async () => {
        const { p } = await freshProvider({}, {
            whois: jest.fn().mockResolvedValue(null),
        });
        const decision = await p.evaluate(
            new Request("http://x/", { method: "POST" }),
            "100.64.1.5",
        );
        expect(decision.kind).toBe("deny");
        if (decision.kind === "deny") {
            expect(decision.error_code).toBe("WHOIS_FAILED");
        }
    });

    it("does not consult X-Forwarded-For (peerIp drives decision)", async () => {
        const { p } = await freshProvider();
        const req = new Request("http://x/", {
            method: "GET",
            headers: { "X-Forwarded-For": "100.64.1.5" },
        });
        const decision = await p.evaluate(req, "10.0.0.5");
        // Header-spoofed XFF must not bypass the CIDR check.
        expect(decision.kind).toBe("deny");
    });

    it("falls back to tailnet-peer when no header identity is present (read-only)", async () => {
        const { p } = await freshProvider({
            tailscale: { require_whois_for_writes: false },
        });
        const decision = await p.evaluate(
            new Request("http://x/", { method: "GET" }),
            "100.64.1.5",
        );
        expect(decision.kind).toBe("allow");
        if (decision.kind === "allow") {
            expect(decision.context.source_user_id).toBe("tailnet-peer:100.64.1.5");
        }
    });

    it("re-throws underlying client rejection during whois", async () => {
        const { p } = await freshProvider({}, {
            whois: jest.fn().mockRejectedValue(
                Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
            ),
        });
        try {
            await p.evaluate(new Request("http://x/", { method: "POST" }), "100.64.1.5");
            throw new Error("expected throw");
        } catch (err) {
            expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
        }
    });
});
