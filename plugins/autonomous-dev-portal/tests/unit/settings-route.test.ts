// SPEC-036-4-01 — `resolveActiveTab` unit tests.
//
// Pure-function tests for the tab-id resolver. No Hono context, no DOM.

import { describe, expect, test } from "bun:test";

import { resolveActiveTab } from "../../server/routes/settings";
import { TAB_IDS } from "../../server/types/render";

describe("resolveActiveTab", () => {
    test("returns the value when it is a valid TAB_ID", () => {
        for (const id of TAB_IDS) {
            expect(resolveActiveTab(id)).toBe(id);
        }
    });

    test("falls back to 'general' for empty string", () => {
        expect(resolveActiveTab("")).toBe("general");
    });

    test("falls back to 'general' for traversal-like input", () => {
        expect(resolveActiveTab("../etc/passwd")).toBe("general");
        expect(resolveActiveTab("../foo")).toBe("general");
        expect(resolveActiveTab("/general")).toBe("general");
    });

    test("falls back to 'general' for undefined / null / non-strings", () => {
        expect(resolveActiveTab(undefined)).toBe("general");
        expect(resolveActiveTab(null)).toBe("general");
        expect(resolveActiveTab(0)).toBe("general");
        expect(resolveActiveTab(42)).toBe("general");
        expect(resolveActiveTab({})).toBe("general");
        expect(resolveActiveTab([])).toBe("general");
    });

    test("falls back to 'general' for unknown values", () => {
        expect(resolveActiveTab("invalid")).toBe("general");
        expect(resolveActiveTab("trust")).toBe("general"); // not in canonical list
    });
});
