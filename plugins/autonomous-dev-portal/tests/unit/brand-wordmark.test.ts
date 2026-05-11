// SPEC-035-1-04 §Tests — BrandWordmark component.
// SPEC-037-3-03 — extended for the `CONTROL PLANE · v{version}` caption.
//
// W-01..W-05 from the spec: bracket presence, env-var default, and the
// outer `<div class="wm">` wrapper.
// BW-05..BW-09: caption text, U+00B7 middle dot, suppression via
// `showCaption=false`, version parity with `plugin.json`.

import { readFileSync } from "node:fs";
import { join } from "node:path";

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
        const html = await render({ showBrackets: true, showCaption: false });
        const matches = html.match(/<span class="br">/g) ?? [];
        expect(matches.length).toBe(2);
        expect(html).toContain('<span class="br">[</span>');
        expect(html).toContain('<span class="br">]</span>');
    });

    test("W-02: showBrackets=false produces zero `.br` spans", async () => {
        const html = await render({ showBrackets: false, showCaption: false });
        expect(html).not.toContain('<span class="br">');
        expect(html).toContain("autonomous-dev");
    });

    test("W-03: PORTAL_WORDMARK_BRACKETS=0 + prop omitted -> no .br spans", async () => {
        process.env["PORTAL_WORDMARK_BRACKETS"] = "0";
        const html = await render({ showCaption: false });
        expect(html).not.toContain('<span class="br">');
    });

    test("W-04: PORTAL_WORDMARK_BRACKETS=1 + prop omitted -> two .br spans", async () => {
        process.env["PORTAL_WORDMARK_BRACKETS"] = "1";
        const html = await render({ showCaption: false });
        const matches = html.match(/<span class="br">/g) ?? [];
        expect(matches.length).toBe(2);
    });

    test("W-04b: env unset + prop omitted defaults to brackets-on", async () => {
        delete process.env["PORTAL_WORDMARK_BRACKETS"];
        const html = await render({ showCaption: false });
        const matches = html.match(/<span class="br">/g) ?? [];
        expect(matches.length).toBe(2);
    });

    test("W-05: output always wraps content in `<div class=\"wm\">`", async () => {
        const withBrackets = await render({
            showBrackets: true,
            showCaption: false,
        });
        const withoutBrackets = await render({
            showBrackets: false,
            showCaption: false,
        });
        expect(withBrackets).toContain('<div class="wm"');
        expect(withoutBrackets).toContain('<div class="wm"');
    });

    test("explicit prop overrides env var (false beats env=1)", async () => {
        process.env["PORTAL_WORDMARK_BRACKETS"] = "1";
        const html = await render({
            showBrackets: false,
            showCaption: false,
        });
        expect(html).not.toContain('<span class="br">');
    });

    test("explicit prop overrides env var (true beats env=0)", async () => {
        process.env["PORTAL_WORDMARK_BRACKETS"] = "0";
        const html = await render({
            showBrackets: true,
            showCaption: false,
        });
        const matches = html.match(/<span class="br">/g) ?? [];
        expect(matches.length).toBe(2);
    });

    test("theme prop is exposed as data-theme attribute", async () => {
        const dark = await render({
            showBrackets: true,
            theme: "dark",
            showCaption: false,
        });
        expect(dark).toContain('data-theme="dark"');
        const light = await render({
            showBrackets: true,
            theme: "light",
            showCaption: false,
        });
        expect(light).toContain('data-theme="light"');
    });
});

describe("BrandWordmark — SPEC-037-3-03 caption", () => {
    test("BW-05: default render contains text `CONTROL PLANE · v`", async () => {
        const html = await render({});
        expect(html).toMatch(/CONTROL PLANE · v[0-9]/);
    });

    test("BW-06: caption uses U+00B7 middle dot (not hyphen or ASCII bullet)", async () => {
        const html = await render({});
        // The literal U+00B7 codepoint must appear inside the caption.
        const captionMatch = html.match(/CONTROL PLANE .+?v[0-9.]+/);
        expect(captionMatch).not.toBeNull();
        const caption = captionMatch![0];
        expect(caption).toContain("·");
        // Defensive: ensure we did not accidentally render a hyphen or
        // ASCII bullet `*` in the separator slot.
        expect(caption).not.toContain("CONTROL PLANE -");
        expect(caption).not.toContain("CONTROL PLANE *");
    });

    test("BW-07: showCaption=false suppresses the .meta-mono element", async () => {
        const html = await render({ showCaption: false });
        expect(html).not.toContain('<div class="meta-mono">');
        expect(html).not.toContain("CONTROL PLANE");
    });

    test("BW-08: version string matches plugin.json", async () => {
        const manifestPath = join(
            import.meta.dir,
            "..",
            "..",
            ".claude-plugin",
            "plugin.json",
        );
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
            version: string;
        };
        const html = await render({});
        expect(html).toContain(`v${manifest.version}`);
    });

    test("BW-09: showBrackets=false + default caption renders both wordmark + caption", async () => {
        const html = await render({ showBrackets: false });
        expect(html).toContain("autonomous-dev");
        expect(html).not.toContain('<span class="br">');
        expect(html).toContain('<div class="meta-mono">');
        expect(html).toContain("CONTROL PLANE");
    });
});
