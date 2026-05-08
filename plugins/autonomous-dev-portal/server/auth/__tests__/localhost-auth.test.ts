// SPEC-030-1-03: tests for ../localhost-auth.ts.
// Target module: plugins/autonomous-dev-portal/server/auth/localhost-auth.ts
// See TDD-030 §5.2 (localhost-auth block).
//
// LocalhostAuthProvider exposes a pure `evaluate(request, peerIp)` whose
// decision is driven by peerIp (extractPeerIp, owned by the middleware
// layer, is the authoritative source). Unit tests therefore exercise the
// provider directly rather than spinning up an HTTP server — TDD-030 §5.2's
// "spoofed XFF from non-loopback" assertion translates to: evaluate() with
// a non-loopback peerIp must deny, regardless of any X-Forwarded-For
// header on the Request.

import { LocalhostAuthProvider } from "../localhost-auth";
import { SecurityError } from "../types";

type AuthLogger = {
    info: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
};

function makeLogger(): AuthLogger {
    return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeConfig(overrides: Record<string, unknown> = {}): any {
    return {
        auth_mode: "localhost",
        bind_host: "127.0.0.1",
        trusted_reverse_proxy: false,
        ...overrides,
    };
}

describe("localhost-auth — evaluate() peer admission", () => {
    it("allows IPv4 loopback peer (127.0.0.1)", async () => {
        const p = new LocalhostAuthProvider(makeConfig(), makeLogger());
        const decision = await p.evaluate(new Request("http://127.0.0.1/"), "127.0.0.1");
        expect(decision.kind).toBe("allow");
    });

    it("allows IPv6 loopback peer (::1)", async () => {
        const p = new LocalhostAuthProvider(makeConfig(), makeLogger());
        const decision = await p.evaluate(new Request("http://[::1]/"), "::1");
        expect(decision.kind).toBe("allow");
    });

    it("allows IPv4-mapped IPv6 loopback peer (::ffff:127.0.0.1)", async () => {
        const p = new LocalhostAuthProvider(makeConfig(), makeLogger());
        const decision = await p.evaluate(
            new Request("http://127.0.0.1/"),
            "::ffff:127.0.0.1",
        );
        expect(decision.kind).toBe("allow");
    });

    it("denies a non-loopback peer (10.0.0.5)", async () => {
        const p = new LocalhostAuthProvider(makeConfig(), makeLogger());
        const decision = await p.evaluate(new Request("http://example/"), "10.0.0.5");
        expect(decision.kind).toBe("deny");
        if (decision.kind === "deny") {
            expect(decision.status).toBe(403);
            expect(decision.error_code).toBe("NON_LOOPBACK");
        }
    });

    it("denies a non-loopback peer that spoofs X-Forwarded-For: 127.0.0.1", async () => {
        // Security assertion (TDD-030 §5.2): peer-address check, NOT the
        // header, drives the decision. If this test ever flips to "allow",
        // it indicates a real vulnerability — escalate per TDD-030 §8.1.
        const p = new LocalhostAuthProvider(makeConfig(), makeLogger());
        const req = new Request("http://example/", {
            headers: { "X-Forwarded-For": "127.0.0.1" },
        });
        const decision = await p.evaluate(req, "10.0.0.5");
        expect(decision.kind).toBe("deny");
    });

    it("denies the broader 127.0.0.0/8 range (only exact loopback ips allowed)", async () => {
        // network-binding.ts intentionally restricts loopback to literal
        // 127.0.0.1, ::1, ::ffff:127.0.0.1.
        const p = new LocalhostAuthProvider(makeConfig(), makeLogger());
        const decision = await p.evaluate(new Request("http://x/"), "127.0.0.2");
        expect(decision.kind).toBe("deny");
    });

    it("emits a warn log line on rejection", async () => {
        const logger = makeLogger();
        const p = new LocalhostAuthProvider(makeConfig(), logger);
        await p.evaluate(new Request("http://x/"), "10.0.0.5");
        expect(logger.warn).toHaveBeenCalledWith(
            "localhost.auth.rejected_non_loopback",
            expect.objectContaining({ peer_ip: "10.0.0.5" }),
        );
    });
});

describe("localhost-auth — init() bind validation", () => {
    it("accepts bind_host=null (resolveBindHostname substitutes 127.0.0.1)", async () => {
        const p = new LocalhostAuthProvider(makeConfig({ bind_host: null }), makeLogger());
        await expect(p.init()).resolves.toBeUndefined();
    });

    it("accepts bind_host='127.0.0.1' explicitly", async () => {
        const p = new LocalhostAuthProvider(
            makeConfig({ bind_host: "127.0.0.1" }),
            makeLogger(),
        );
        await expect(p.init()).resolves.toBeUndefined();
    });

    it("refuses bind_host='0.0.0.0' with a typed SecurityError", async () => {
        const p = new LocalhostAuthProvider(
            makeConfig({ bind_host: "0.0.0.0" }),
            makeLogger(),
        );
        try {
            await p.init();
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(SecurityError);
            expect((err as SecurityError).code).toBe("LOCALHOST_REQUIRES_LOOPBACK");
        }
    });
});
