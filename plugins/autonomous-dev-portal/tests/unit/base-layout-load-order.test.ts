// SPEC-034-1-06 §base.tsx integration — CSS load-order invariant.
//
// PRD-018 / TDD-034 §5.1 require `/static/design-tokens.css` to load
// FIRST so the `--color-*`, `--space-*`, etc. CSS variables are defined
// before any consumer (`portal.css`, page-level rules) references them.
// A wrong load order produces visibly broken pages because every
// `var(--…)` resolves to its fallback (or transparent).
//
// This suite renders <BaseLayout> via Hono's SSR pipeline and asserts
// the substring ordering of stylesheet/script tags in the emitted HTML.
// It also asserts the SPEC-034-1-06 FOUC-prevention IIFE is present in
// <head> so `<html data-theme>` is set before first paint.

import { describe, expect, test } from "bun:test";

import { renderFullPage } from "../../server/templates/index";

/**
 * Helper: render the dashboard view via the same pipeline routes use.
 * Returns the full `<!doctype html>...</html>` string.
 */
async function renderHomeHtml(): Promise<string> {
    return renderFullPage("dashboard", { data: { repos: [] } });
}

/** Returns the substring between `<head>` and `</head>` (inclusive of tags). */
function extractHead(html: string): string {
    const start = html.indexOf("<head>");
    const end = html.indexOf("</head>");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return html.slice(start, end + "</head>".length);
}

describe("BaseLayout — SPEC-034-1-06 stylesheet & script load order", () => {
    test("AC-01/03: design-tokens.css is the FIRST <link rel=\"stylesheet\"> in <head>", async () => {
        const html = await renderHomeHtml();
        const head = extractHead(html);

        // Capture the href of the very first stylesheet link in <head>.
        const firstLink = head.match(
            /<link[^>]*rel=["']stylesheet["'][^>]*>/i,
        );
        expect(firstLink).not.toBeNull();
        expect(firstLink![0]).toContain("/static/design-tokens.css");
    });

    test("AC-02: design-tokens.css appears before portal.css in source order", async () => {
        const html = await renderHomeHtml();
        const tokensIdx = html.indexOf("/static/design-tokens.css");
        const portalIdx = html.indexOf("/static/portal.css");

        expect(tokensIdx).toBeGreaterThan(-1);
        expect(portalIdx).toBeGreaterThan(-1);
        expect(tokensIdx).toBeLessThan(portalIdx);
    });

    test("FOUC-prevention IIFE is inline in <head> and precedes both stylesheets", async () => {
        const html = await renderHomeHtml();
        const head = extractHead(html);

        // The IIFE reads `portal-theme` from localStorage and writes
        // `dataset.theme` on the documentElement. Match a stable
        // substring rather than the full minified source.
        expect(head).toContain("localStorage.getItem('portal-theme')");
        expect(head).toContain("documentElement.dataset.theme");

        const iifeIdx = head.indexOf("localStorage.getItem('portal-theme')");
        const tokensIdx = head.indexOf("/static/design-tokens.css");
        const portalIdx = head.indexOf("/static/portal.css");

        expect(iifeIdx).toBeGreaterThan(-1);
        expect(iifeIdx).toBeLessThan(tokensIdx);
        expect(iifeIdx).toBeLessThan(portalIdx);
    });

    test("<html> carries a default data-theme attribute the IIFE can override", async () => {
        const html = await renderHomeHtml();
        // Match either `data-theme="light"` or `data-theme='light'`.
        expect(html).toMatch(/<html[^>]*\sdata-theme=["']light["']/);
    });

    test("htmx.min.js script appears AFTER both stylesheets (load-order invariant)", async () => {
        const html = await renderHomeHtml();
        const portalIdx = html.indexOf("/static/portal.css");
        const htmxIdx = html.indexOf("/static/htmx.min.js");

        expect(portalIdx).toBeGreaterThan(-1);
        expect(htmxIdx).toBeGreaterThan(-1);
        expect(portalIdx).toBeLessThan(htmxIdx);
    });

    test("CSP nonce is propagated to the inline FOUC-prevention <script>", async () => {
        const NONCE = "test-nonce-abc123";
        const html = await renderFullPage(
            "dashboard",
            { data: { repos: [] } },
            undefined,
            NONCE,
        );

        // The inline script tag (the one with the IIFE) must carry the
        // nonce; otherwise the policy will block it in production.
        const inlineScriptMatch = html.match(
            /<script[^>]*>\(function\(\)\{[\s\S]*?\}\)\(\);<\/script>/,
        );
        expect(inlineScriptMatch).not.toBeNull();
        expect(inlineScriptMatch![0]).toContain(`nonce="${NONCE}"`);
    });
});
