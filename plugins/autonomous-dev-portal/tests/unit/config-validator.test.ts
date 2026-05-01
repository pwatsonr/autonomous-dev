// SPEC-015-2-02 — ConfigurationValidator unit tests.
//
// Allowlist rules require a filesystem probe; we inject a stub so each test
// describes its own filesystem reality without touching disk.

import { describe, expect, test } from "bun:test";

import {
    ConfigurationValidator,
    type FsProbe,
    type ValidationContext,
} from "../../server/lib/config-validator";

function makeProbe(
    fs: Record<string, "dir" | "file" | "missing">,
): FsProbe {
    return {
        async probe(p: string) {
            return fs[p] ?? "missing";
        },
    };
}

function ctx(over: Partial<ValidationContext> = {}): ValidationContext {
    return {
        fullConfig: {},
        userHomeDir: "/Users/op",
        allowedRoots: ["/Users/op"],
        operatorId: "op1",
        ...over,
    };
}

describe("costCaps", () => {
    test("daily cap zero → invalid", async () => {
        const v = new ConfigurationValidator();
        const r = await v.validateConfiguration(
            { costCaps: { daily: 0, monthly: 100 } },
            ctx(),
        );
        expect(r.valid).toBe(false);
        expect(r.fieldErrors["costCaps.daily"]).toMatch(/positive/);
    });

    test("daily cap negative → invalid", async () => {
        const v = new ConfigurationValidator();
        const r = await v.validateConfiguration(
            { costCaps: { daily: -5, monthly: 100 } },
            ctx(),
        );
        expect(r.valid).toBe(false);
    });

    test("daily cap above 10000 → invalid", async () => {
        const v = new ConfigurationValidator();
        const r = await v.validateConfiguration(
            { costCaps: { daily: 99_999, monthly: 100 } },
            ctx(),
        );
        expect(r.valid).toBe(false);
    });

    test("daily cap null → invalid", async () => {
        const v = new ConfigurationValidator();
        const r = await v.validateConfiguration(
            { costCaps: { daily: null } },
            ctx(),
        );
        expect(r.valid).toBe(false);
    });

    test("monthly < daily*28 emits warning but stays valid", async () => {
        const v = new ConfigurationValidator();
        const r = await v.validateConfiguration(
            { costCaps: { daily: 10, monthly: 100 } },
            ctx(),
        );
        expect(r.valid).toBe(true);
        expect(r.warnings.length).toBeGreaterThanOrEqual(1);
    });
});

describe("allowlist", () => {
    test("path outside allowed roots → invalid", async () => {
        const v = new ConfigurationValidator({
            fsProbe: makeProbe({ "/etc/passwd": "file" }),
        });
        const r = await v.validateConfiguration(
            { allowlist: ["/etc/passwd"] },
            ctx({ allowedRoots: ["/Users/op"] }),
        );
        expect(r.valid).toBe(false);
        expect(r.fieldErrors["allowlist[0]"]).toMatch(/not in an allowed root/);
    });

    test("missing path → invalid", async () => {
        const v = new ConfigurationValidator({
            fsProbe: makeProbe({}),
        });
        const r = await v.validateConfiguration(
            { allowlist: ["/Users/op/missing"] },
            ctx({ allowedRoots: ["/Users/op"] }),
        );
        expect(r.valid).toBe(false);
        expect(r.fieldErrors["allowlist[0]"]).toMatch(
            /does not exist|not a directory/,
        );
    });

    test("dir without .git → invalid", async () => {
        const v = new ConfigurationValidator({
            fsProbe: makeProbe({ "/Users/op/foo": "dir" }),
        });
        const r = await v.validateConfiguration(
            { allowlist: ["/Users/op/foo"] },
            ctx({ allowedRoots: ["/Users/op"] }),
        );
        expect(r.valid).toBe(false);
        expect(r.fieldErrors["allowlist[0]"]).toMatch(/not a git repository/);
    });

    test("dir with .git → valid", async () => {
        const v = new ConfigurationValidator({
            fsProbe: makeProbe({
                "/Users/op/repo": "dir",
                "/Users/op/repo/.git": "dir",
            }),
        });
        const r = await v.validateConfiguration(
            { allowlist: ["/Users/op/repo"] },
            ctx({ allowedRoots: ["/Users/op"] }),
        );
        expect(r.valid).toBe(true);
    });
});

describe("trustLevels", () => {
    test("invalid enum value → invalid", async () => {
        const v = new ConfigurationValidator();
        const r = await v.validateConfiguration(
            { trustLevels: { repoA: "godmode" } },
            ctx(),
        );
        expect(r.valid).toBe(false);
        expect(r.fieldErrors["trustLevels.repoA"]).toMatch(
            /Invalid trust level/,
        );
    });

    test("valid enum value → valid", async () => {
        const v = new ConfigurationValidator();
        const r = await v.validateConfiguration(
            { trustLevels: { repoA: "trusted", repoB: "basic" } },
            ctx(),
        );
        expect(r.valid).toBe(true);
    });
});

describe("notifications", () => {
    test("invalid slack webhook → invalid", async () => {
        const v = new ConfigurationValidator();
        const r = await v.validateConfiguration(
            {
                notifications: {
                    slack: { webhook: "http://evil.example.com" },
                },
            },
            ctx(),
        );
        expect(r.valid).toBe(false);
    });

    test("empty slack webhook → valid (skipped)", async () => {
        const v = new ConfigurationValidator();
        const r = await v.validateConfiguration(
            { notifications: { slack: { webhook: "" } } },
            ctx(),
        );
        expect(r.valid).toBe(true);
    });

    test("invalid email → invalid", async () => {
        const v = new ConfigurationValidator();
        const r = await v.validateConfiguration(
            { notifications: { email: { to: "not-an-email" } } },
            ctx(),
        );
        expect(r.valid).toBe(false);
    });
});
