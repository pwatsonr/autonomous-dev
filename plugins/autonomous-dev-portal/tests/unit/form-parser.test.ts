// SPEC-015-2-02 — form parser unit tests.
//
// FormSource is satisfied by URLSearchParams; no FormData polyfill needed.

import { describe, expect, test } from "bun:test";

import {
    flattenKeys,
    parseFormDataToConfig,
} from "../../server/lib/form-parser";

function fd(pairs: Array<[string, string]>): URLSearchParams {
    const p = new URLSearchParams();
    for (const [k, v] of pairs) p.append(k, v);
    return p;
}

describe("parseFormDataToConfig", () => {
    test("dotted numeric key is coerced and nested", () => {
        const out = parseFormDataToConfig(fd([["costCaps.daily", "10"]]));
        expect(out).toEqual({ costCaps: { daily: 10 } });
    });

    test("array key collapses repeated values into an ordered array", () => {
        const out = parseFormDataToConfig(
            fd([
                ["allowlist[]", "/a"],
                ["allowlist[]", "/b"],
            ]),
        );
        expect(out).toEqual({ allowlist: ["/a", "/b"] });
    });

    test("unknown keys are silently dropped", () => {
        const out = parseFormDataToConfig(
            fd([
                ["evilKey", "x"],
                ["__proto__", "polluted"],
            ]),
        );
        expect("evilKey" in out).toBe(false);
        expect("__proto__" in out).toBe(false);
    });

    test("trustLevels.<repo> dynamic key is preserved", () => {
        const out = parseFormDataToConfig(
            fd([["trustLevels.repo-a", "trusted"]]),
        );
        expect(out).toEqual({ trustLevels: { "repo-a": "trusted" } });
    });

    test("empty numeric string becomes null (validator handles)", () => {
        const out = parseFormDataToConfig(fd([["costCaps.daily", ""]]));
        expect(out).toEqual({ costCaps: { daily: null } });
    });

    test("non-numeric value for numeric field becomes null", () => {
        const out = parseFormDataToConfig(fd([["costCaps.daily", "abc"]]));
        expect(out).toEqual({ costCaps: { daily: null } });
    });

    test("notification email is left as a string", () => {
        const out = parseFormDataToConfig(
            fd([["notifications.email.to", "op@example.com"]]),
        );
        expect(out).toEqual({
            notifications: { email: { to: "op@example.com" } },
        });
    });
});

describe("flattenKeys", () => {
    test("nested object produces dotted leaf paths", () => {
        expect(flattenKeys({ a: { b: 1, c: { d: 2 } } })).toEqual([
            "a.b",
            "a.c.d",
        ]);
    });
    test("arrays are leaves (parent path only)", () => {
        expect(flattenKeys({ a: [1, 2], b: { c: [3] } })).toEqual([
            "a",
            "b.c",
        ]);
    });
});
