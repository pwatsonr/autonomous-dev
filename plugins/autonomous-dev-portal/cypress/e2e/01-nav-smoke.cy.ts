// PLAN-021 Phase 1B — Navigation smoke test (full route matrix).
//
// Walks every operator-facing GET route registered in
// `server/routes/index.ts` and asserts each one:
//
//   1. Returns 200 (or the documented success status)
//   2. Renders an <h1> heading
//   3. Renders the rail sidebar (`aside.rail`)
//   4. Logs no console errors during render
//
// Route excluded from this matrix and the reason:
//
//   /repo/:repo/request/:id  — requires a real request-action JSON
//                              fixture in $AUTONOMOUS_DEV_STATE_DIR;
//                              the fixture builders + state seeding land
//                              in Phase 2 (FR-021-03). Without seeded
//                              state every visit returns 404 by design.
//   /health                  — JSON-only endpoint; no DOM to assert.
//   /api/*                   — JSON APIs; covered by integration tests
//                              not by Cypress.
//   /portal/events           — SSE stream; lifecycle ≠ a navigable page.
//   /favicon.svg             — static asset.
//
// FR-021-01 acceptance criterion lives here: every page must be reachable
// and render its chrome without throwing. Per-page interaction tests are
// the job of 02-*.cy.ts through 10-*.cy.ts (the Phase 2 specs).

interface RouteSpec {
    path: string;
    label: string;
    expectedHeading?: string | RegExp;
    expectStatus?: number;
    /**
     * True when the route is reachable but intentionally NOT in the
     * primary rail-nav (internal / advanced surfaces). The nav-coverage
     * sub-test only enforces primary-nav presence for `!internalOnly`
     * routes. `/logs` + `/repos` are tagged internal pending BUG-22.
     */
    internalOnly?: boolean;
}

const ROUTES: RouteSpec[] = [
    { path: "/", label: "Dashboard", expectedHeading: "Dashboard" },
    { path: "/approvals", label: "Approvals", expectedHeading: "Approvals" },
    { path: "/requests", label: "Requests", expectedHeading: "Requests" },
    { path: "/costs", label: "Costs", expectedHeading: "Costs" },
    { path: "/ops", label: "Operations", expectedHeading: "Operations" },
    { path: "/agents", label: "Agents", expectedHeading: "Agents" },
    { path: "/settings", label: "Settings", expectedHeading: "Settings" },
    // BUG-22 landed: /logs + /repos now have rail-nav entries.
    { path: "/logs", label: "Logs", expectedHeading: "Logs" },
    { path: "/repos", label: "Repositories", expectedHeading: /Repos|Repositories/ },
    { path: "/audit", label: "Audit log", expectedHeading: /Audit/, internalOnly: true },
    { path: "/design-system", label: "Design system", expectedHeading: /design/i, internalOnly: true },
];

describe("Navigation smoke (Phase 1B — full route matrix)", () => {
    for (const route of ROUTES) {
        it(`${route.path} renders <h1>, rail, no console errors`, () => {
            // Spy on console.error BEFORE visiting so we capture every error.
            // We tolerate console.warn (HTMX emits some during boot) but error
            // is the bar — if any page throws, this test fires.
            const errors: string[] = [];
            cy.on("window:before:load", (win) => {
                cy.stub(win.console, "error").callsFake((...args: unknown[]) => {
                    errors.push(args.map((a) => String(a)).join(" "));
                });
            });

            cy.request({
                url: route.path,
                failOnStatusCode: false,
            }).then((res) => {
                expect(res.status, `${route.path} status`).to.eq(
                    route.expectStatus ?? 200,
                );
            });

            cy.visit(route.path, { failOnStatusCode: false });

            // Chrome (sidebar) — present on every page via ShellLayout
            cy.get("aside.rail").should("be.visible");

            // Page-specific heading — h1 in the main column. Loose match
            // because some surfaces title differently (Operations vs Ops).
            cy.get("h1")
                .should("exist")
                .invoke("text")
                .then((text) => {
                    if (route.expectedHeading instanceof RegExp) {
                        expect(text, `${route.path} h1`).to.match(
                            route.expectedHeading,
                        );
                    } else if (route.expectedHeading) {
                        expect(text, `${route.path} h1`).to.contain(
                            route.expectedHeading,
                        );
                    }
                });

            // Tolerate console.warn from HTMX / extensions; reject error.
            // Filter Cypress's own DevTools-driven errors (they sometimes
            // surface noise from cross-origin requests we don't make).
            cy.window().then(() => {
                const real = errors.filter(
                    (e) => !e.includes("ResizeObserver"),
                );
                expect(real, `${route.path} console.error`).to.have.length(0);
            });
        });
    }

    // Sanity check: the rail-nav itself should always contain links to
    // every primary surface (i.e., every non-`internalOnly` route).
    // If a route is added without a nav entry, operators lose
    // discoverability — catch it here.
    it("rail-nav links every primary surface", () => {
        cy.visit("/");
        for (const route of ROUTES) {
            if (route.internalOnly) continue;
            cy.get(`aside.rail a[href="${route.path}"]`).should("exist");
        }
    });
});
