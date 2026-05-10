// SPEC-035-1-04 §Tests — BrandWordmark component.
//
// W-01..W-05 from the spec: bracket presence, env-var default, and the
// outer `<div class="wm">` wrapper. Tests render JSX to a string the same
// way GateActionPanel tests do (await Promise.resolve(node)) so we can
// assert on the rendered HTML substring.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { BrandWordmark } from "../../server/components/brand-wordmark";

async function render(
    props: Parameters<typeof BrandWordmark>[0],
): Promise<string> {
    const node = BrandWordmark(props) as unknown;
    return String(await Promise.resolve(node));
}

const ORIGINAL_ENV = process.env["PORTAL_WORDMARK_BRACKETS"];

afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
        delete process.env["PORTAL_WORDMARK_BRACKETS"];
    } else {
        process.env["PORTAL_WORDMARK_BRACKETS"] = ORIGINAL_ENV;
    }
});

describe("BrandWordmark", () => {
    beforeEach(() => {
        // Tests own the env var explicitly so this suite does not
        // inherit a value from the parent shell.
        delete process.env["PORTAL_WORDMARK_BRACKETS"];
    });

    test("W-01: default render contains two `<span class=\"br\">` brackets", async () => {
        const html = await render({ showBrackets: true });
        const matches = html.match(/<span class="br">/g) ?? [];
        expect(matches.length).toBe(2);
        expect(html).toContain('<span class="br">[</span>');
        expect(html).toContain('<span class="br">]</span>');
    });

    test("W-02: showBrackets=false produces zero `.br` spans", async () => {
        const html = await render({ showBrackets: false });
        expect(html).not.toContain('<span class="br">');
        expect(html).toContain("autonomous-dev");
    });

    test("W-03: PORTAL_WORDMARK_BRACKETS=0 + prop omitted -> no .br spans", async () => {
        process.env["PORTAL_WORDMARK_BRACKETS"] = "0";
        const html = await render({});
        expect(html).not.toContain('<span class="br">');
    });

    test("W-04: PORTAL_WORDMARK_BRACKETS=1 + prop omitted -> two .br spans", async () => {
        process.env["PORTAL_WORDMARK_BRACKETS"] = "1";
        const html = await render({});
        const matches = html.match(/<span class="br">/g) ?? [];
        expect(matches.length).toBe(2);
    });

    test("W-04b: env unset + prop omitted defaults to brackets-on", async () => {
        delete process.env["PORTAL_WORDMARK_BRACKETS"];
        const html = await render({});
        const matches = html.match(/<span class="br">/g) ?? [];
        expect(matches.length).toBe(2);
    });

    test("W-05: output always wraps content in `<div class=\"wm\">`", async () => {
        const withBrackets = await render({ showBrackets: true });
        const withoutBrackets = await render({ showBrackets: false });
        expect(withBrackets).toContain('<div class="wm"');
        expect(withoutBrackets).toContain('<div class="wm"');
    });

    test("explicit prop overrides env var (false beats env=1)", async () => {
        process.env["PORTAL_WORDMARK_BRACKETS"] = "1";
        const html = await render({ showBrackets: false });
        expect(html).not.toContain('<span class="br">');
    });

    test("explicit prop overrides env var (true beats env=0)", async () => {
        process.env["PORTAL_WORDMARK_BRACKETS"] = "0";
        const html = await render({ showBrackets: true });
        const matches = html.match(/<span class="br">/g) ?? [];
        expect(matches.length).toBe(2);
    });

    test("theme prop is exposed as data-theme attribute", async () => {
        const dark = await render({ showBrackets: true, theme: "dark" });
        expect(dark).toContain('data-theme="dark"');
        const light = await render({ showBrackets: true, theme: "light" });
        expect(light).toContain('data-theme="light"');
    });
});
