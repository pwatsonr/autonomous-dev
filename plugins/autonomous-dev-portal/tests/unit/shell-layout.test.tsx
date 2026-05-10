// SPEC-035-1-01 §ShellLayout — unit tests.
//
// Renders <ShellLayout> via Hono's JSX runtime and asserts the structural
// invariants from the spec acceptance criteria:
//   - <html data-theme=…> reflects the prop (defaults to "light")
//   - design-tokens.css is the FIRST stylesheet
//   - FOUC-prevention IIFE is present in <head>, nonce-protected
//   - body contains <div class="app"> with <aside class="rail"> + <main class="main">
//   - default modal slot renders <div id="modal-slot"> inside <main>
//   - children render inside <main class="main">
//   - pageTitle / headActions render inside <div class="page-head">

import { describe, expect, test } from "bun:test";

import { ShellLayout } from "../../server/components/shell";

/** Resolve a Hono JSX node to a plain HTML string. */
async function render(node: unknown): Promise<string> {
    const v = await Promise.resolve(node);
    return typeof v === "string" ? v : String(v);
}

describe("ShellLayout — SPEC-035-1-01", () => {
    test("AC: <html data-theme='light'> when theme prop is omitted", async () => {
        const html = await render(<ShellLayout activePath="/" />);
        expect(html).toMatch(/<html[^>]*\sdata-theme=["']light["']/);
    });

    test("AC: <html data-theme='dark'> when theme='dark'", async () => {
        const html = await render(
            <ShellLayout activePath="/" theme="dark" />,
        );
        expect(html).toMatch(/<html[^>]*\sdata-theme=["']dark["']/);
    });

    test("AC: design-tokens.css is the FIRST stylesheet in <head>", async () => {
        const html = await render(<ShellLayout activePath="/" />);
        const headStart = html.indexOf("<head>");
        const headEnd = html.indexOf("</head>");
        expect(headStart).toBeGreaterThan(-1);
        expect(headEnd).toBeGreaterThan(headStart);
        const head = html.slice(headStart, headEnd);

        const firstLink = head.match(
            /<link[^>]*rel=["']stylesheet["'][^>]*>/i,
        );
        expect(firstLink).not.toBeNull();
        expect(firstLink![0]).toContain("/static/design-tokens.css");
    });

    test("AC: shell.css is loaded after portal.css", async () => {
        const html = await render(<ShellLayout activePath="/" />);
        const portalIdx = html.indexOf("/static/portal.css");
        const shellIdx = html.indexOf("/static/shell.css");
        expect(portalIdx).toBeGreaterThan(-1);
        expect(shellIdx).toBeGreaterThan(portalIdx);
    });

    test("AC: FOUC-prevention IIFE is inline in <head> with the supplied nonce", async () => {
        const NONCE = "nonce-shell-001";
        const html = await render(
            <ShellLayout activePath="/" cspNonce={NONCE} />,
        );
        const inlineMatch = html.match(
            /<script[^>]*>\(function\(\)\{[\s\S]*?\}\)\(\);<\/script>/,
        );
        expect(inlineMatch).not.toBeNull();
        expect(inlineMatch![0]).toContain(`nonce="${NONCE}"`);
        expect(inlineMatch![0]).toContain("localStorage.getItem('portal-theme')");
    });

    test("AC: body contains <div class='app'> with rail + main children", async () => {
        const html = await render(<ShellLayout activePath="/" />);
        expect(html).toContain('<div class="app">');
        expect(html).toContain('<aside class="rail"');
        expect(html).toContain('<main class="main">');
    });

    test("AC: default modal slot renders <div id='modal-slot'> inside <main>", async () => {
        const html = await render(<ShellLayout activePath="/" />);
        const mainStart = html.indexOf('<main class="main">');
        const mainEnd = html.indexOf("</main>");
        expect(mainStart).toBeGreaterThan(-1);
        expect(mainEnd).toBeGreaterThan(mainStart);
        const main = html.slice(mainStart, mainEnd);
        expect(main).toContain('id="modal-slot"');
    });

    test("AC: children render inside <main class='main'>", async () => {
        const html = await render(
            <ShellLayout activePath="/">
                <p class="probe">child-content-marker</p>
            </ShellLayout>,
        );
        const mainStart = html.indexOf('<main class="main">');
        const mainEnd = html.indexOf("</main>");
        const main = html.slice(mainStart, mainEnd);
        expect(main).toContain("child-content-marker");
    });

    test("AC: pageTitle and headActions render inside <div class='page-head'>", async () => {
        const html = await render(
            <ShellLayout
                activePath="/"
                pageTitle="Approvals"
                headActions={<button>New</button>}
            />,
        );
        expect(html).toContain('<div class="page-head">');
        const pageHeadStart = html.indexOf('<div class="page-head">');
        // Slice a generous window since the head-actions div is nested.
        const window = html.slice(pageHeadStart, pageHeadStart + 400);
        expect(window).toContain("<h1>Approvals</h1>");
        expect(window).toContain('<div class="head-actions">');
        expect(window).toContain("<button>New</button>");
    });

    test("AC: activePath is exposed on the rail wrapper for downstream nav", async () => {
        const html = await render(<ShellLayout activePath="/costs" />);
        expect(html).toMatch(
            /<aside class="rail"[^>]*data-active-path=["']\/costs["']/,
        );
    });

    test("AC: htmx + theme-toggle scripts carry the cspNonce", async () => {
        const NONCE = "nonce-shell-002";
        const html = await render(
            <ShellLayout activePath="/" cspNonce={NONCE} />,
        );
        const htmxMatch = html.match(
            /<script[^>]*src=["']\/static\/htmx\.min\.js["'][^>]*>/,
        );
        const themeMatch = html.match(
            /<script[^>]*src=["']\/static\/theme-toggle\.js["'][^>]*>/,
        );
        expect(htmxMatch).not.toBeNull();
        expect(themeMatch).not.toBeNull();
        expect(htmxMatch![0]).toContain(`nonce="${NONCE}"`);
        expect(themeMatch![0]).toContain(`nonce="${NONCE}"`);
        expect(themeMatch![0]).toContain('type="module"');
    });
});
