// SPEC-036-4-04..06 — Form validation predicate unit tests.
//
// Loads `static/js/form-validation.js` into a jsdom window so we can
// invoke the named exports through `window.__formValidation`. Pure-
// predicate tests run without a DOM mutation; the integration of
// `setError` + `recomputeFormState` is covered separately in the
// settings-modals jsdom test.

import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = readFileSync(
    join(
        import.meta.dir,
        "..",
        "..",
        "static",
        "js",
        "form-validation.js",
    ),
    "utf8",
);

interface FvNs {
    validateCostCap: (
        input: { value: string; dataset: { costCapField?: string } } | string,
        ctx?: { perRequest?: number; daily?: number; monthly?: number },
    ) => string | null;
    validateAllowlistPath: (v: string) => string | null;
    validateWebhookUrl: (v: string, ch: "discord" | "slack") => string | null;
    validateDndRange: (
        s: string,
        e: string,
        wrap?: boolean,
    ) => string | null;
}

function loadFv(): FvNs {
    const dom = new JSDOM(
        "<!doctype html><html><body></body></html>",
        { runScripts: "outside-only" },
    );
    dom.window.eval(SCRIPT);
    return (dom.window as unknown as { __formValidation: FvNs })
        .__formValidation;
}

describe("validateCostCap", () => {
    const fv = loadFv();

    test("accepts valid number", () => {
        expect(
            fv.validateCostCap(
                { value: "42.50", dataset: { costCapField: "perRequest" } },
                { daily: 100 },
            ),
        ).toBeNull();
    });

    test("rejects negative", () => {
        expect(
            fv.validateCostCap(
                { value: "-5", dataset: { costCapField: "daily" } },
                {},
            ),
        ).toBe("must be ≥ 0");
    });

    test("rejects non-numeric", () => {
        expect(
            fv.validateCostCap(
                { value: "abc", dataset: { costCapField: "daily" } },
                {},
            ),
        ).toBe("must be a number");
    });

    test("rejects per-request > daily", () => {
        expect(
            fv.validateCostCap(
                { value: "5", dataset: { costCapField: "perRequest" } },
                { daily: 2 },
            ),
        ).toBe("must be less than daily cap");
    });

    test("rejects daily > monthly", () => {
        expect(
            fv.validateCostCap(
                { value: "999", dataset: { costCapField: "daily" } },
                { monthly: 100 },
            ),
        ).toBe("must be less than monthly cap");
    });

    test("empty value yields no error (Add btn disabled separately)", () => {
        expect(
            fv.validateCostCap(
                { value: "", dataset: { costCapField: "daily" } },
                {},
            ),
        ).toBeNull();
    });
});

describe("validateAllowlistPath", () => {
    const fv = loadFv();

    test("rejects `..`", () => {
        expect(fv.validateAllowlistPath("/foo/../bar")).toBe(
            "path must not contain ..",
        );
    });

    test("accepts a tilde-resolved path", () => {
        expect(fv.validateAllowlistPath("~/repos/foo")).toBeNull();
    });

    test("rejects long paths", () => {
        const long = "x".repeat(5000);
        expect(fv.validateAllowlistPath(long)).toBe("path too long");
    });

    test("rejects $-prefixed paths", () => {
        expect(fv.validateAllowlistPath("$HOME/repos")).toBe(
            "use absolute path or a tilde-resolved path",
        );
    });

    test("empty yields no error", () => {
        expect(fv.validateAllowlistPath("")).toBeNull();
    });
});

describe("validateWebhookUrl", () => {
    const fv = loadFv();

    test("Discord: accepts canonical webhook URL", () => {
        expect(
            fv.validateWebhookUrl(
                "https://discord.com/api/webhooks/123/abc",
                "discord",
            ),
        ).toBeNull();
    });

    test("Discord: rejects non-discord host", () => {
        expect(
            fv.validateWebhookUrl("https://evil.com/abc", "discord"),
        ).toBe("Discord webhook must start with https://discord.com/");
    });

    test("Slack: accepts canonical webhook URL", () => {
        expect(
            fv.validateWebhookUrl(
                "https://hooks.slack.com/services/T/B/X",
                "slack",
            ),
        ).toBeNull();
    });

    test("Slack: rejects non-slack host", () => {
        expect(
            fv.validateWebhookUrl("https://discord.com/abc", "slack"),
        ).toBe("Slack webhook must start with https://hooks.slack.com/");
    });

    test("empty value yields no error", () => {
        expect(fv.validateWebhookUrl("", "discord")).toBeNull();
    });
});

describe("validateDndRange", () => {
    const fv = loadFv();

    test("rejects start >= end without wrap", () => {
        expect(fv.validateDndRange("10:00", "09:00", false)).toBe(
            "DND end must be after start (or wrap past midnight)",
        );
    });

    test("accepts start < end without wrap", () => {
        expect(fv.validateDndRange("09:00", "17:00", false)).toBeNull();
    });

    test("accepts wrap-past-midnight when allowed", () => {
        expect(fv.validateDndRange("23:00", "01:00", true)).toBeNull();
    });

    test("missing values yield no error", () => {
        expect(fv.validateDndRange("", "", false)).toBeNull();
    });
});
