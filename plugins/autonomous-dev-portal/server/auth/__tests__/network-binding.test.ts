// SPEC-030-1-03: tests for ../network-binding.ts + ../security/binding-enforcer.ts.
// See TDD-030 §5.2 (network-binding block).
//
// The functions under test are pure (no I/O): enforceBinding() throws on
// misconfiguration, isLoopbackIp() is a strict predicate, and
// enforceTailscaleBinding() resolves an interface IP via the injected
// client. We do not spin up a real http server here — the spec's "no
// listener on 0.0.0.0" assertion is satisfied by enforceBinding throwing
// before the bootstrap can call .listen().

import { enforceBindingWithLogging } from "../security/binding-enforcer";
import {
    enforceBinding,
    enforceTailscaleBinding,
    isLoopbackIp,
} from "../network-binding";
import { SecurityError } from "../types";

function makeConfig(overrides: Record<string, unknown> = {}): any {
    return {
        auth_mode: "localhost",
        bind_host: "127.0.0.1",
        trusted_reverse_proxy: false,
        ...overrides,
    };
}

describe("network-binding — isLoopbackIp", () => {
    it.each([["127.0.0.1"], ["::1"], ["::ffff:127.0.0.1"]])(
        "returns true for %p",
        (ip) => {
            expect(isLoopbackIp(ip)).toBe(true);
        },
    );

    it.each([
        ["127.0.0.2"], // strictly the literal, not the /8
        ["10.0.0.5"],
        ["192.168.1.1"],
        ["::"],
        [""],
    ])("returns false for %p", (ip) => {
        expect(isLoopbackIp(ip)).toBe(false);
    });
});

describe("network-binding — enforceBinding (localhost mode)", () => {
    it("accepts bind_host='127.0.0.1'", () => {
        expect(() => enforceBinding(makeConfig({ bind_host: "127.0.0.1" }))).not.toThrow();
    });

    it("accepts bind_host=null", () => {
        expect(() => enforceBinding(makeConfig({ bind_host: null }))).not.toThrow();
    });

    it("refuses bind_host='0.0.0.0' with LOCALHOST_FORBIDDEN_BIND", () => {
        try {
            enforceBinding(makeConfig({ bind_host: "0.0.0.0" }));
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(SecurityError);
            expect((err as SecurityError).code).toBe("LOCALHOST_FORBIDDEN_BIND");
        }
    });

    it("refuses non-loopback IPs with LOCALHOST_REQUIRES_LOOPBACK", () => {
        try {
            enforceBinding(makeConfig({ bind_host: "10.0.0.5" }));
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(SecurityError);
            expect((err as SecurityError).code).toBe("LOCALHOST_REQUIRES_LOOPBACK");
        }
    });

    it("refuses trusted_reverse_proxy=true with LOCALHOST_REJECTS_PROXY", () => {
        try {
            enforceBinding(makeConfig({ trusted_reverse_proxy: true }));
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(SecurityError);
            expect((err as SecurityError).code).toBe("LOCALHOST_REJECTS_PROXY");
        }
    });
});

describe("network-binding — enforceBinding (tailscale mode)", () => {
    it("rejects bind_host='0.0.0.0' with TAILSCALE_FORBIDDEN_BIND", () => {
        try {
            enforceBinding(
                makeConfig({ auth_mode: "tailscale", bind_host: "0.0.0.0" }),
            );
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(SecurityError);
            expect((err as SecurityError).code).toBe("TAILSCALE_FORBIDDEN_BIND");
        }
    });

    it("accepts bind_host='auto'", () => {
        expect(() =>
            enforceBinding(
                makeConfig({ auth_mode: "tailscale", bind_host: "auto" }),
            ),
        ).not.toThrow();
    });
});

describe("network-binding — enforceTailscaleBinding", () => {
    const fakeClient = {
        getInterfaceIp: jest.fn().mockResolvedValue("100.64.1.2"),
    };

    beforeEach(() => fakeClient.getInterfaceIp.mockClear());

    it("returns the client's interface IP for bind_host='auto'", async () => {
        const out = await enforceTailscaleBinding(
            makeConfig({ auth_mode: "tailscale", bind_host: "auto" }),
            fakeClient,
        );
        expect(out).toBe("100.64.1.2");
    });

    it("returns the interface IP for bind_host=null", async () => {
        const out = await enforceTailscaleBinding(
            makeConfig({ auth_mode: "tailscale", bind_host: null }),
            fakeClient,
        );
        expect(out).toBe("100.64.1.2");
    });

    it("accepts an explicit bind_host that matches the interface IP", async () => {
        const out = await enforceTailscaleBinding(
            makeConfig({ auth_mode: "tailscale", bind_host: "100.64.1.2" }),
            fakeClient,
        );
        expect(out).toBe("100.64.1.2");
    });

    it("throws TAILSCALE_BIND_MISMATCH when explicit bind doesn't match", async () => {
        try {
            await enforceTailscaleBinding(
                makeConfig({ auth_mode: "tailscale", bind_host: "10.0.0.1" }),
                fakeClient,
            );
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(SecurityError);
            expect((err as SecurityError).code).toBe("TAILSCALE_BIND_MISMATCH");
        }
    });

    it("throws TAILSCALE_BINDING_NO_CLIENT when client is null", async () => {
        try {
            await enforceTailscaleBinding(
                makeConfig({ auth_mode: "tailscale", bind_host: "auto" }),
                null,
            );
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(SecurityError);
            expect((err as SecurityError).code).toBe("TAILSCALE_BINDING_NO_CLIENT");
        }
    });
});

describe("security/binding-enforcer — logging wrapper", () => {
    it("logs binding_enforced on success", () => {
        const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        enforceBindingWithLogging(makeConfig(), logger);
        expect(logger.info).toHaveBeenCalledWith(
            "binding_enforced",
            expect.objectContaining({ auth_mode: "localhost" }),
        );
    });

    it("logs binding_refused and rethrows on misconfig", () => {
        const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        try {
            enforceBindingWithLogging(makeConfig({ bind_host: "0.0.0.0" }), logger);
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(SecurityError);
            expect(logger.error).toHaveBeenCalledWith(
                "binding_refused",
                expect.objectContaining({ code: "LOCALHOST_FORBIDDEN_BIND" }),
            );
        }
    });
});
