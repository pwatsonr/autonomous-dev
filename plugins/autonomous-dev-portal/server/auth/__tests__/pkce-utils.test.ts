// SPEC-030-1-02: pure-function tests for ../oauth/pkce-utils.ts.
// Target module: plugins/autonomous-dev-portal/server/auth/oauth/pkce-utils.ts
// See TDD-030 §5.2 (pkce-utils block) and RFC 7636 appendix B.

import {
    base64UrlEncode,
    deriveCodeChallenge,
    generateCodeVerifier,
    PKCE_VERIFIER_MAX_LEN,
    PKCE_VERIFIER_MIN_LEN,
} from "../oauth/pkce-utils";
import { SecurityError } from "../types";

describe("pkce-utils — code_verifier", () => {
    it("generates a verifier whose length is within RFC-7636 bounds (43..128)", () => {
        const v = generateCodeVerifier();
        expect(v.length).toBeGreaterThanOrEqual(PKCE_VERIFIER_MIN_LEN);
        expect(v.length).toBeLessThanOrEqual(PKCE_VERIFIER_MAX_LEN);
    });

    it("generates verifiers that match the RFC 7636 §4.1 unreserved alphabet", () => {
        const v = generateCodeVerifier();
        expect(v).toMatch(/^[A-Za-z0-9._~-]+$/);
    });

    it("produces unique verifiers across 100 generations", () => {
        const set = new Set<string>();
        for (let i = 0; i < 100; i++) {
            set.add(generateCodeVerifier());
        }
        expect(set.size).toBe(100);
    });
});

describe("pkce-utils — code_challenge (S256)", () => {
    it("matches the RFC-7636 appendix-B example vector", () => {
        // Verifier: dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
        // Expected: E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
        const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        const challenge = deriveCodeChallenge(verifier);
        expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    });

    it("produces a base64url challenge with no padding character (=)", () => {
        const verifier = generateCodeVerifier();
        const challenge = deriveCodeChallenge(verifier);
        expect(challenge.includes("=")).toBe(false);
    });
});

describe("pkce-utils — verifier validation", () => {
    it("rejects a verifier shorter than 43 chars with a typed error", () => {
        try {
            deriveCodeChallenge("abc");
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(SecurityError);
            expect((err as SecurityError).code).toBe("PKCE_INVALID_VERIFIER");
        }
    });

    it("rejects a verifier longer than 128 chars with a typed error", () => {
        const tooLong = "a".repeat(129);
        try {
            deriveCodeChallenge(tooLong);
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(SecurityError);
            expect((err as SecurityError).code).toBe("PKCE_INVALID_VERIFIER");
        }
    });

    it("rejects a verifier containing characters outside the §4.1 alphabet", () => {
        const bad = "x".repeat(43) + "!";
        try {
            deriveCodeChallenge(bad.slice(0, 44));
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(SecurityError);
            expect((err as SecurityError).code).toBe("PKCE_INVALID_VERIFIER");
        }
    });

    it("rejects a non-string verifier with a typed error", () => {
        try {
            // Intentional misuse — production code defends against it.
            (deriveCodeChallenge as unknown as (v: unknown) => string)(123);
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(SecurityError);
            expect((err as SecurityError).code).toBe("PKCE_INVALID_VERIFIER");
        }
    });
});

describe("pkce-utils — base64UrlEncode helper", () => {
    it("strips padding characters from output", () => {
        const out = base64UrlEncode(Buffer.from([0x01, 0x02]));
        expect(out.includes("=")).toBe(false);
    });

    it("uses url-safe alphabet (- and _ instead of + and /)", () => {
        // 0xfb 0xff 0xff yields '+///' in standard base64; url-safe should swap.
        const out = base64UrlEncode(Buffer.from([0xfb, 0xff, 0xff, 0xff]));
        expect(out.includes("+")).toBe(false);
        expect(out.includes("/")).toBe(false);
    });
});
