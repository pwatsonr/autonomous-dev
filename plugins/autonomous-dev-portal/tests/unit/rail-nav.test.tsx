// SPEC-035-1-02 §Tests — RailNav component.
// SPEC-037-3-01 / SPEC-037-3-02 — extended for 7-item nav with group
// labels, inline icons, and three optional count-badge props.
//
// Renders <RailNav> via Hono's JSX runtime and asserts the structural
// invariants from the user-task acceptance criteria:
//   - Seven anchors render in two groups (OPERATE: Dashboard / Approvals /
//     Requests / Costs, SYSTEM: Agents / Settings / Ops) in the
//     documented order with inline Lucide SVG icons.
//   - The matching item gets `aria-current="page"` AND class `.active`;
//     no other item is marked active.
//   - Each group opens with a `<div class="rail-nav-group-label">` heading.
//   - Approvals / Requests / Agents show `<span class="count">N</span>`
//     only when their corresponding count prop is `> 0`.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { NAV_ITEMS, RailNav } from "../../server/components/rail-nav";
import { icon } from "../../server/lib/icons";

/** Resolve a Hono JSX node to a plain HTML string. */
async function render(node: unknown): Promise<string> {
    const v = await Promise.resolve(node);
    return typeof v === "string" ? v : String(v);
}

describe("RailNav — SPEC-037-3-01 (7-item nav)", () => {
    test("N-08: renders seven anchors with the documented hrefs in order", async () => {
        const html = await render(<RailNav activePath="/" />);
        const hrefs = [...html.matchAll(/href=["']([^"']+)["']/g)].map(
            (m) => m[1],
        );
        expect(hrefs).toEqual([
            "/",
            "/approvals",
            "/requests",
            "/costs",
            "/agents",
            "/settings",
            "/ops",
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

    test("N-10: Operate group has 4 items, System group has 3", () => {
        const operate = NAV_ITEMS.filter((i) => i.group === "operate");
        const system = NAV_ITEMS.filter((i) => i.group === "system");
        expect(operate.map((i) => i.href)).toEqual([
            "/",
            "/approvals",
            "/requests",
            "/costs",
        ]);
        expect(system.map((i) => i.href)).toEqual([
            "/agents",
            "/settings",
            "/ops",
        ]);
    });

    test("N-11: each rail-nav-group begins with a rail-nav-group-label", async () => {
        const html = await render(<RailNav activePath="/" />);
        // The operate group label comes before the system group label.
        const operateIdx = html.indexOf(
            '<div class="rail-nav-group-label">OPERATE</div>',
        );
        const systemIdx = html.indexOf(
            '<div class="rail-nav-group-label">SYSTEM</div>',
        );
        expect(operateIdx).toBeGreaterThan(-1);
        expect(systemIdx).toBeGreaterThan(operateIdx);
        // Each label must sit immediately inside its group container
        // (i.e. before the first <a> in that group).
        const operateGroupStart = html.indexOf('data-group="operate"');
        const firstOperateAnchor = html.indexOf("<a", operateGroupStart);
        expect(operateIdx).toBeGreaterThan(operateGroupStart);
        expect(operateIdx).toBeLessThan(firstOperateAnchor);
    });

    test("N-09: each anchor contains a <span class=\"ic\"> with a non-empty SVG", async () => {
        const html = await render(<RailNav activePath="/" />);
        const anchorSegments = [...html.matchAll(/<a[^>]*>[\s\S]*?<\/a>/g)].map(
            (m) => m[0],
        );
        expect(anchorSegments.length).toBe(7);
        for (const segment of anchorSegments) {
            // Each anchor has an `<span class="ic">` that contains an
            // inline <svg> (Lucide markup).
            expect(segment).toMatch(/<span class="ic"[^>]*>[\s\S]*<svg/);
        }
    });

    test("N-12: vendored sliders.svg exists on disk and icon() returns SVG", () => {
        const svgPath = join(
            import.meta.dir,
            "..",
            "..",
            "static",
            "icons",
            "sliders.svg",
        );
        expect(existsSync(svgPath)).toBe(true);
        const markup = icon("sliders");
        expect(markup).toContain("<svg");
        expect(markup).toContain("</svg>");
    });

    test("N-13: /homelab is NOT in any rendered href (Homelab is plugin-contributed)", async () => {
        const html = await render(<RailNav activePath="/" />);
        expect(html).not.toContain("/homelab");
        expect(html).not.toContain("homelab");
    });

    test("active item gets aria-current=\"page\" AND class includes 'active'", async () => {
        const html = await render(<RailNav activePath="/approvals" />);
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

    test("NAV_ITEMS exposes 7 entries split 4/3 across operate/system", () => {
        expect(NAV_ITEMS.length).toBe(7);
        const operate = NAV_ITEMS.filter((i) => i.group === "operate");
        const system = NAV_ITEMS.filter((i) => i.group === "system");
        expect(operate.length).toBe(4);
        expect(system.length).toBe(3);
    });
});

describe("RailNav — SPEC-037-3-02 (count badges)", () => {
    test("N-13b: requestsCount=5 renders <span class=\"count\">5</span> on Requests only", async () => {
        const html = await render(<RailNav activePath="/" requestsCount={5} />);
        const countMatches = html.match(/<span class="count">/g) ?? [];
        expect(countMatches.length).toBe(1);
        const start = html.indexOf('href="/requests"');
        const end = html.indexOf("</a>", start);
        expect(html.slice(start, end)).toContain(
            '<span class="count">5</span>',
        );
    });

    test("N-14: agentsAlertCount=4 renders the badge on the Agents anchor only", async () => {
        const html = await render(
            <RailNav activePath="/" agentsAlertCount={4} />,
        );
        const countMatches = html.match(/<span class="count">/g) ?? [];
        expect(countMatches.length).toBe(1);
        const start = html.indexOf('href="/agents"');
        const end = html.indexOf("</a>", start);
        expect(html.slice(start, end)).toContain(
            '<span class="count">4</span>',
        );
    });

    test("N-15: all three badge props at 0 → no .count spans anywhere", async () => {
        const html = await render(
            <RailNav
                activePath="/"
                approvalsCount={0}
                requestsCount={0}
                agentsAlertCount={0}
            />,
        );
        expect(html).not.toContain('class="count"');
    });

    test("N-16: requestsCount=NaN and requestsCount=-1 both suppress the badge", async () => {
        const nan = await render(
            <RailNav activePath="/" requestsCount={Number.NaN} />,
        );
        expect(nan).not.toContain('class="count"');
        const negative = await render(
            <RailNav activePath="/" requestsCount={-1} />,
        );
        expect(negative).not.toContain('class="count"');
    });

    test("N-17: aria-label is augmented with the count when a badge renders", async () => {
        const html = await render(
            <RailNav activePath="/" approvalsCount={3} requestsCount={5} />,
        );
        const approvals = html.match(/<a[^>]*href=["']\/approvals["'][^>]*>/);
        const requests = html.match(/<a[^>]*href=["']\/requests["'][^>]*>/);
        expect(approvals).not.toBeNull();
        expect(approvals![0]).toContain('aria-label="Approvals (3 pending)"');
        expect(requests).not.toBeNull();
        expect(requests![0]).toContain('aria-label="Requests (5 active)"');
    });

    test("count badge does not appear on Dashboard / Costs / Settings / Ops", async () => {
        const html = await render(
            <RailNav
                activePath="/"
                approvalsCount={7}
                requestsCount={9}
                agentsAlertCount={11}
            />,
        );
        // Three count badges expected — exactly one per badge-enabled anchor.
        const countMatches = html.match(/<span class="count">/g) ?? [];
        expect(countMatches.length).toBe(3);
        // Dashboard / Costs / Settings / Ops anchors must contain no badge.
        for (const href of ["/", "/costs", "/settings", "/ops"]) {
            const start = html.indexOf(`href="${href}"`);
            const end = html.indexOf("</a>", start);
            expect(html.slice(start, end)).not.toContain('class="count"');
        }
    });
});
