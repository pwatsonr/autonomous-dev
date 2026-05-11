// SPEC-035-1-01 §ShellLayout — unit tests.
// SPEC-037-1-01 — default theme flipped from "light" to "dark"; SPEC-037-1-02
// adds the theme-toggle pill rendered as the final child of `.rail-ops`.
//
// Renders <ShellLayout> via Hono's JSX runtime and asserts the structural
// invariants from the spec acceptance criteria:
//   - <html data-theme=…> reflects the prop (defaults to "dark")
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
    test("AC (SPEC-037-1-01): <html data-theme='dark'> when theme prop is omitted", async () => {
        const html = await render(<ShellLayout activePath="/" />);
        expect(html).toMatch(/<html[^>]*\sdata-theme=["']dark["']/);
    });

    test("AC: <html data-theme='dark'> when theme='dark'", async () => {
        const html = await render(
            <ShellLayout activePath="/" theme="dark" />,
        );
        expect(html).toMatch(/<html[^>]*\sdata-theme=["']dark["']/);
    });

    test("AC (SPEC-037-1-01): <html data-theme='light'> when theme='light'", async () => {
        const html = await render(
            <ShellLayout activePath="/" theme="light" />,
        );
        expect(html).toMatch(/<html[^>]*\sdata-theme=["']light["']/);
    });

    test("AC (SPEC-037-1-01): theme=undefined resolves to 'dark' (defensive)", async () => {
        const html = await render(
            <ShellLayout
                activePath="/"
                theme={undefined as unknown as "dark"}
            />,
        );
        expect(html).toMatch(/<html[^>]*\sdata-theme=["']dark["']/);
    });

    test("AC (SPEC-037-1-01): FOUC IIFE fallback branch is 'dark'", async () => {
        const html = await render(<ShellLayout activePath="/" />);
        // The inverted ternary form: t === 'light' ? 'light' : 'dark'.
        expect(html).toContain("'light'?'light':'dark'");
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

    test("SH-10 (SPEC-037-3-04): .rail-ops contains exactly 3 .line children when mtdSpend is defined", async () => {
        const html = await render(
            <ShellLayout
                activePath="/"
                daemonStatus="running"
                daemonAgeSeconds={2}
                breakerState="OK"
                breakerCount={0}
                breakerThreshold={3}
                mtdSpend={16.84}
                mtdPctOfCap={4}
            />,
        );
        const opsStart = html.indexOf('<div class="rail-ops">');
        const opsEnd = html.indexOf("</div>", html.indexOf("kbtn"));
        const ops = html.slice(opsStart, opsEnd);
        const lineMatches = ops.match(/<div class="line">/g) ?? [];
        expect(lineMatches.length).toBe(3);
    });

    test("SH-11: .rail-ops contains 2 .line children when mtdSpend is undefined", async () => {
        const html = await render(
            <ShellLayout
                activePath="/"
                daemonStatus="running"
                breakerState="OK"
            />,
        );
        const opsStart = html.indexOf('<div class="rail-ops">');
        const opsEnd = html.indexOf("</div>", html.indexOf("kbtn"));
        const ops = html.slice(opsStart, opsEnd);
        const lineMatches = ops.match(/<div class="line">/g) ?? [];
        expect(lineMatches.length).toBe(2);
    });

    test("SH-12: daemonStatus='stale' → first dot is .warn; label includes 'stale'", async () => {
        const html = await render(
            <ShellLayout activePath="/" daemonStatus="stale" daemonAgeSeconds={120} />,
        );
        const opsStart = html.indexOf('<div class="rail-ops">');
        const ops = html.slice(opsStart, opsStart + 600);
        // First .line in rail-ops is the Daemon row.
        const firstLine = ops.match(/<div class="line">[\s\S]*?<\/div>/);
        expect(firstLine).not.toBeNull();
        expect(firstLine![0]).toContain('class="dot warn"');
        expect(firstLine![0]).toContain("stale");
    });

    test("SH-13: breakerState='TRIPPED' + 3/3 → value '3/3', dot .err", async () => {
        const html = await render(
            <ShellLayout
                activePath="/"
                breakerState="TRIPPED"
                breakerCount={3}
                breakerThreshold={3}
            />,
        );
        // Second line in rail-ops is the Breaker row.
        const opsStart = html.indexOf('<div class="rail-ops">');
        const ops = html.slice(opsStart, opsStart + 1200);
        const lines = [...ops.matchAll(/<div class="line">[\s\S]*?<\/div>/g)].map(
            (m) => m[0],
        );
        expect(lines.length).toBeGreaterThanOrEqual(2);
        const breaker = lines[1];
        expect(breaker).toContain('class="dot err"');
        expect(breaker).toContain('<span class="v">3/3</span>');
        expect(breaker).toContain("Breaker TRIPPED");
    });

    test("SH-13b: breakerCount + threshold undefined → '--/--'", async () => {
        const html = await render(
            <ShellLayout activePath="/" breakerState="unknown" />,
        );
        expect(html).toContain('<span class="v">--/--</span>');
    });

    test("SH-14: mtdPctOfCap=85 → MTD dot .warn; value contains '(85%)'", async () => {
        const html = await render(
            <ShellLayout
                activePath="/"
                mtdSpend={42.5}
                mtdPctOfCap={85}
            />,
        );
        const opsStart = html.indexOf('<div class="rail-ops">');
        const ops = html.slice(opsStart, opsStart + 1500);
        const lines = [...ops.matchAll(/<div class="line">[\s\S]*?<\/div>/g)].map(
            (m) => m[0],
        );
        // MTD row is the 3rd line when present.
        const mtdLine = lines[2];
        expect(mtdLine).toBeDefined();
        expect(mtdLine).toContain('class="dot warn"');
        expect(mtdLine).toContain("(85%)");
        expect(mtdLine).toContain("$42.50");
    });

    test("SH-14b: mtdPctOfCap >= 100 → MTD dot .err", async () => {
        const html = await render(
            <ShellLayout activePath="/" mtdSpend={200} mtdPctOfCap={110} />,
        );
        const opsStart = html.indexOf('<div class="rail-ops">');
        const ops = html.slice(opsStart);
        const lines = [...ops.matchAll(/<div class="line">[\s\S]*?<\/div>/g)].map(
            (m) => m[0],
        );
        expect(lines[2]).toContain('class="dot err"');
    });

    test("SH-15: .theme-toggle button is present after .kbtn", async () => {
        const html = await render(<ShellLayout activePath="/" />);
        const kbtnIdx = html.indexOf('class="kbtn');
        const toggleIdx = html.indexOf('class="theme-toggle"');
        expect(kbtnIdx).toBeGreaterThan(-1);
        expect(toggleIdx).toBeGreaterThan(kbtnIdx);
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
