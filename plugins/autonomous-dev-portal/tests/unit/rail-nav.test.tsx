// SPEC-035-1-02 §Tests — RailNav component.
//
// Renders <RailNav> via Hono's JSX runtime and asserts the structural
// invariants from the user-task acceptance criteria:
//   - Five anchors render in two groups (Operate: Dashboard/Approvals/Costs/Ops,
//     System: Settings) in the documented order
//   - The matching item gets `aria-current="page"` AND class `.active`;
//     no other item is marked active
//   - Approvals shows `<span class="count">N</span>` only when
//     `approvalsCount > 0` (omitted / 0 → no badge)

import { describe, expect, test } from "bun:test";

import { NAV_ITEMS, RailNav } from "../../server/components/rail-nav";

/** Resolve a Hono JSX node to a plain HTML string. */
async function render(node: unknown): Promise<string> {
    const v = await Promise.resolve(node);
    return typeof v === "string" ? v : String(v);
}

describe("RailNav — SPEC-035-1-02", () => {
    test("renders five anchors with the documented hrefs in order", async () => {
        const html = await render(<RailNav activePath="/" />);
        const hrefs = [...html.matchAll(/href=["']([^"']+)["']/g)].map(
            (m) => m[1],
        );
        expect(hrefs).toEqual([
            "/",
            "/approvals",
            "/costs",
            "/ops",
            "/settings",
        ]);
    });

    test("wraps anchors in <nav class=\"rail-nav\" aria-label=\"Primary\">", async () => {
        const html = await render(<RailNav activePath="/" />);
        expect(html).toMatch(
            /<nav[^>]*class=["']rail-nav["'][^>]*aria-label=["']Primary["']/,
        );
    });

    test("renders two rail-nav-group containers (operate + system)", async () => {
        const html = await render(<RailNav activePath="/" />);
        const groups = [...html.matchAll(/data-group=["']([^"']+)["']/g)].map(
            (m) => m[1],
        );
        expect(groups).toEqual(["operate", "system"]);
    });

    test("active item gets aria-current=\"page\" AND class includes 'active'", async () => {
        const html = await render(<RailNav activePath="/approvals" />);
        // Find the approvals anchor (it's the second <a>).
        const approvalsAnchor = html.match(
            /<a[^>]*href=["']\/approvals["'][^>]*>/,
        );
        expect(approvalsAnchor).not.toBeNull();
        expect(approvalsAnchor![0]).toContain('aria-current="page"');
        expect(approvalsAnchor![0]).toMatch(/class=["'][^"']*\bactive\b/);
    });

    test("non-active items omit aria-current entirely", async () => {
        const html = await render(<RailNav activePath="/approvals" />);
        // Count occurrences of aria-current — should be exactly one.
        const matches = html.match(/aria-current=/g) ?? [];
        expect(matches.length).toBe(1);
    });

    test("activePath=\"/\" marks Dashboard active and nothing else", async () => {
        const html = await render(<RailNav activePath="/" />);
        const dashboardAnchor = html.match(/<a[^>]*href=["']\/["'][^>]*>/);
        expect(dashboardAnchor).not.toBeNull();
        expect(dashboardAnchor![0]).toContain('aria-current="page"');
        expect(dashboardAnchor![0]).toMatch(/class=["'][^"']*\bactive\b/);
        // Exactly one active.
        const ariaCurrents = html.match(/aria-current=/g) ?? [];
        expect(ariaCurrents.length).toBe(1);
    });

    test("activePath that matches no item leaves zero anchors active", async () => {
        const html = await render(<RailNav activePath="/no-such-route" />);
        expect(html).not.toContain("aria-current=");
        expect(html).not.toContain('class="rail-nav-item active"');
    });

    test("approvalsCount=3 renders <span class=\"count\">3</span> on Approvals", async () => {
        const html = await render(
            <RailNav activePath="/" approvalsCount={3} />,
        );
        // The count span lives inside the approvals anchor — the anchor's
        // markup runs from `<a href="/approvals"` through the next `</a>`.
        const start = html.indexOf('href="/approvals"');
        const end = html.indexOf("</a>", start);
        expect(start).toBeGreaterThan(-1);
        const approvalsHtml = html.slice(start, end);
        expect(approvalsHtml).toContain('<span class="count">3</span>');
    });

    test("approvalsCount=0 suppresses the count badge", async () => {
        const html = await render(
            <RailNav activePath="/" approvalsCount={0} />,
        );
        expect(html).not.toContain('class="count"');
    });

    test("approvalsCount omitted suppresses the count badge", async () => {
        const html = await render(<RailNav activePath="/" />);
        expect(html).not.toContain('class="count"');
    });

    test("count badge only appears on the Approvals anchor (not Dashboard etc.)", async () => {
        const html = await render(
            <RailNav activePath="/" approvalsCount={7} />,
        );
        const countMatches = html.match(/<span class="count">/g) ?? [];
        expect(countMatches.length).toBe(1);
        // The single count span must sit inside the /approvals anchor.
        const start = html.indexOf('href="/approvals"');
        const end = html.indexOf("</a>", start);
        expect(html.slice(start, end)).toContain('<span class="count">7</span>');
    });

    test("NAV_ITEMS exposes 5 entries split 4/1 across operate/system", () => {
        expect(NAV_ITEMS.length).toBe(5);
        const operate = NAV_ITEMS.filter((i) => i.group === "operate");
        const system = NAV_ITEMS.filter((i) => i.group === "system");
        expect(operate.map((i) => i.href)).toEqual([
            "/",
            "/approvals",
            "/costs",
            "/ops",
        ]);
        expect(system.map((i) => i.href)).toEqual(["/settings"]);
    });
});
