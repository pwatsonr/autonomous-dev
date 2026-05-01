// SPEC-014-2-05 §CSRF attack scenarios.
//
// Exercises the CSRFProtection class and OriginValidator against the
// documented attack vectors:
//   - missing token / mismatched session / replayed token / expired token
//   - cross-origin POST (Origin and Referer mismatch)
//   - timing-safe compare bounded variance
//
// We test the security primitives directly rather than mounting the full
// middleware so the test surface stays small and the contract is clear.

import { describe, expect, test } from "bun:test";

import {
    randomToken,
    timingSafeCompare,
} from "../../server/security/crypto-utils";
import {
    CSRFProtection,
    OriginValidator,
    type OriginValidatorConfig,
} from "../../server/security/csrf-protection";
import type { CSRFConfig } from "../../server/security/types";

const SECRET = "test-secret-".padEnd(64, "x");

function defaultConfig(overrides: Partial<CSRFConfig> = {}): CSRFConfig {
    return {
        tokenTTL: 60_000,
        cookieName: "__csrf_signature",
        headerName: "X-CSRF-Token",
        excludePaths: [],
        secretKey: SECRET,
        maxTokensInMemory: 10_000,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Group 1: token issue / validate happy path
// ---------------------------------------------------------------------------

describe("CSRFProtection — happy path", () => {
    test("generated token validates with the matching signature and session", async () => {
        const csrf = new CSRFProtection(defaultConfig());
        const sid = randomToken(16);
        const { token, signature } = await csrf.generateTokenForSession(sid);
        expect(await csrf.validateToken(token, signature, sid)).toBe(true);
    });

    test("two issues for the same session produce distinct tokens", async () => {
        const csrf = new CSRFProtection(defaultConfig());
        const sid = randomToken(16);
        const a = await csrf.generateTokenForSession(sid);
        const b = await csrf.generateTokenForSession(sid);
        expect(a.token).not.toBe(b.token);
        expect(a.signature).not.toBe(b.signature);
    });
});

// ---------------------------------------------------------------------------
// Group 2: forgery attempts
// ---------------------------------------------------------------------------

describe("CSRFProtection — forgery rejection", () => {
    test("unknown token never validates", async () => {
        const csrf = new CSRFProtection(defaultConfig());
        const sid = randomToken(16);
        const fakeToken = randomToken(32);
        const { signature } = await csrf.generateTokenForSession(sid);
        expect(await csrf.validateToken(fakeToken, signature, sid)).toBe(false);
    });

    test("token from session A used with session B fails", async () => {
        const csrf = new CSRFProtection(defaultConfig());
        const sidA = randomToken(16);
        const sidB = randomToken(16);
        const { token, signature } = await csrf.generateTokenForSession(sidA);
        expect(await csrf.validateToken(token, signature, sidB)).toBe(false);
    });

    test("malformed signature (random hex) fails", async () => {
        const csrf = new CSRFProtection(defaultConfig());
        const sid = randomToken(16);
        const { token } = await csrf.generateTokenForSession(sid);
        const fakeSig = "deadbeef".repeat(8);
        expect(await csrf.validateToken(token, fakeSig, sid)).toBe(false);
    });

    test("signature swapped between two issues fails", async () => {
        const csrf = new CSRFProtection(defaultConfig());
        const sid = randomToken(16);
        const a = await csrf.generateTokenForSession(sid);
        const b = await csrf.generateTokenForSession(sid);
        // a's token + b's signature should NOT pass
        expect(await csrf.validateToken(a.token, b.signature, sid)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Group 3: replay + invalidate
// ---------------------------------------------------------------------------

describe("CSRFProtection — replay defence", () => {
    test("invalidated token no longer validates", async () => {
        const csrf = new CSRFProtection(defaultConfig());
        const sid = randomToken(16);
        const { token, signature } = await csrf.generateTokenForSession(sid);
        expect(await csrf.validateToken(token, signature, sid)).toBe(true);
        csrf.invalidateToken(token);
        expect(await csrf.validateToken(token, signature, sid)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Group 4: TTL expiry
// ---------------------------------------------------------------------------

describe("CSRFProtection — TTL", () => {
    test("token expires after tokenTTL elapses", async () => {
        const csrf = new CSRFProtection(defaultConfig({ tokenTTL: 1 }));
        const sid = randomToken(16);
        const { token, signature } = await csrf.generateTokenForSession(sid);
        await new Promise((r) => setTimeout(r, 10));
        expect(await csrf.validateToken(token, signature, sid)).toBe(false);
    });

    test("cleanupExpiredTokens evicts stale entries", async () => {
        const csrf = new CSRFProtection(defaultConfig({ tokenTTL: 1 }));
        const sid = randomToken(16);
        await csrf.generateTokenForSession(sid);
        await csrf.generateTokenForSession(sid);
        await new Promise((r) => setTimeout(r, 10));
        csrf.cleanupExpiredTokens();
        const fresh = await csrf.generateTokenForSession(sid);
        expect(await csrf.validateToken(fresh.token, fresh.signature, sid)).toBe(
            true,
        );
    });
});

// ---------------------------------------------------------------------------
// Group 5: OriginValidator
// ---------------------------------------------------------------------------

function originConfig(
    overrides: Partial<OriginValidatorConfig> = {},
): OriginValidatorConfig {
    return {
        allowedOrigins: ["https://portal.example"],
        nodeEnv: "production",
        ...overrides,
    };
}

describe("OriginValidator — cross-origin rejection", () => {
    test("Origin from allowed list passes", () => {
        const v = new OriginValidator(originConfig());
        const result = v.validateRequest(
            "POST",
            "https://portal.example",
            undefined,
        );
        expect(result.valid).toBe(true);
    });

    test("Origin from foreign domain fails", () => {
        const v = new OriginValidator(originConfig());
        const result = v.validateRequest(
            "POST",
            "https://evil.example",
            undefined,
        );
        expect(result.valid).toBe(false);
        expect(result.reason).toBe("origin-not-allowed");
    });

    test("missing Origin AND Referer fails", () => {
        const v = new OriginValidator(originConfig());
        const result = v.validateRequest("POST", undefined, undefined);
        expect(result.valid).toBe(false);
        expect(result.reason).toBe("missing-origin-and-referer");
    });

    test("Referer from foreign domain fails (Origin absent)", () => {
        const v = new OriginValidator(originConfig());
        const result = v.validateRequest(
            "POST",
            undefined,
            "https://evil.example/csrf-attack.html",
        );
        expect(result.valid).toBe(false);
    });

    test("wildcard subdomain origin is rejected in production", () => {
        const v = new OriginValidator(
            originConfig({ allowedOrigins: ["*.portal.example"] }),
        );
        const result = v.validateRequest(
            "POST",
            "https://anything.portal.example",
            undefined,
        );
        expect(result.valid).toBe(false);
        expect(result.reason).toBe("wildcard-rejected-in-production");
    });

    test("safe method (GET) passes without origin headers", () => {
        const v = new OriginValidator(originConfig());
        const result = v.validateRequest("GET", undefined, undefined);
        expect(result.valid).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Group 6: timing-safe compare
// ---------------------------------------------------------------------------

describe("timingSafeCompare", () => {
    test("returns true for identical inputs", () => {
        const a = "0123456789abcdef".repeat(2);
        const b = "0123456789abcdef".repeat(2);
        expect(timingSafeCompare(a, b)).toBe(true);
    });

    test("returns false for different inputs of same length", () => {
        const a = "0123456789abcdef".repeat(2);
        const b = "0123456789abcdee".repeat(2);
        expect(timingSafeCompare(a, b)).toBe(false);
    });

    test("returns false for different-length inputs", () => {
        expect(timingSafeCompare("abc", "abcd")).toBe(false);
    });

    test("timing variance bounded across early vs late mismatch positions", () => {
        const a = "x".repeat(1024);
        const earlyMismatch = "y" + "x".repeat(1023);
        const lateMismatch = "x".repeat(1023) + "y";

        const measure = (other: string): number => {
            const start = performance.now();
            for (let i = 0; i < 1000; i++) timingSafeCompare(a, other);
            return performance.now() - start;
        };

        const early = measure(earlyMismatch);
        const late = measure(lateMismatch);
        const ratio =
            Math.max(early, late) / Math.max(Math.min(early, late), 0.001);
        // Generous bound — CI noise can push this past 2x easily; we
        // only need to catch the catastrophic-leak case.
        expect(ratio).toBeLessThan(10);
    });
});
