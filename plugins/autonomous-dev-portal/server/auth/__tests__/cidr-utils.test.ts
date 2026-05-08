// SPEC-030-1-02: pure-function tests for ../cidr-utils.ts.
// Target module: plugins/autonomous-dev-portal/server/auth/cidr-utils.ts
// See TDD-030 §5.2 (cidr-utils block) for the test plan.

import { ipInAnyCIDR, ipInCIDR, parseCIDR } from "../cidr-utils";
import { SecurityError } from "../types";

describe("cidr-utils — IPv4 membership", () => {
    it("matches an address inside a /8 block", () => {
        const r = parseCIDR("10.0.0.0/8");
        expect(ipInCIDR("10.1.2.3", r)).toBe(true);
    });

    it("rejects an address outside a /8 block", () => {
        const r = parseCIDR("10.0.0.0/8");
        expect(ipInCIDR("192.168.1.1", r)).toBe(false);
    });

    it("handles /32 exact match", () => {
        const r = parseCIDR("1.2.3.4/32");
        expect(ipInCIDR("1.2.3.4", r)).toBe(true);
        expect(ipInCIDR("1.2.3.5", r)).toBe(false);
    });
});

describe("cidr-utils — IPv6 membership", () => {
    it("matches an address inside a /32 block", () => {
        const r = parseCIDR("2001:db8::/32");
        expect(ipInCIDR("2001:db8:1::1", r)).toBe(true);
    });

    it("rejects an address outside a /32 block", () => {
        const r = parseCIDR("2001:db8::/32");
        expect(ipInCIDR("2001:db9::1", r)).toBe(false);
    });

    it("handles /128 exact match", () => {
        const r = parseCIDR("::1/128");
        expect(ipInCIDR("::1", r)).toBe(true);
        expect(ipInCIDR("::2", r)).toBe(false);
    });
});

describe("cidr-utils — IPv4-mapped IPv6 normalization", () => {
    it("treats ::ffff:127.0.0.1 as 127.0.0.1 against an IPv4 CIDR", () => {
        const r = parseCIDR("127.0.0.0/8");
        expect(ipInCIDR("::ffff:127.0.0.1", r)).toBe(true);
    });

    it("returns false when ip family does not match cidr family", () => {
        const v4 = parseCIDR("10.0.0.0/8");
        expect(ipInCIDR("2001:db8::1", v4)).toBe(false);
    });
});

describe("cidr-utils — malformed input", () => {
    it.each([[""], ["not-a-cidr"], ["10.0.0.0/33"], ["::1/129"], ["10.0.0.0/-1"]])(
        "throws a typed SecurityError for %p",
        (input) => {
            try {
                parseCIDR(input);
                throw new Error("expected parseCIDR to throw");
            } catch (err) {
                // AC-4: assert on a typed property, not a message substring.
                expect(err).toBeInstanceOf(SecurityError);
                expect((err as SecurityError).code).toBe("INVALID_CIDR");
            }
        },
    );
});

describe("cidr-utils — deny-by-default invariant", () => {
    // Security-critical assertion per TDD-030 §5.2: an empty allowlist must
    // never permit any address. ipInAnyCIDR over [] is the parser's "no
    // ranges configured" state and must return false (deny by default).
    it("returns false for any address against an empty allowlist", () => {
        expect(ipInAnyCIDR("10.0.0.5", [])).toBe(false);
        expect(ipInAnyCIDR("::1", [])).toBe(false);
    });

    it("ipInCIDR returns false for empty/invalid ip strings", () => {
        const r = parseCIDR("10.0.0.0/8");
        expect(ipInCIDR("", r)).toBe(false);
        expect(ipInCIDR("garbage", r)).toBe(false);
    });
});

describe("cidr-utils — ipInAnyCIDR over multiple ranges", () => {
    it("returns true if any range matches", () => {
        const ranges = [parseCIDR("10.0.0.0/8"), parseCIDR("192.168.0.0/16")];
        expect(ipInAnyCIDR("192.168.5.5", ranges)).toBe(true);
        expect(ipInAnyCIDR("172.16.0.1", ranges)).toBe(false);
    });
});
