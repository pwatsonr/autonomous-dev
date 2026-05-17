// PORTAL-AUDIT-2026-05-16 — auto-refresh polling contract.
//
// Pins the surfaces that should auto-refresh, the interval each picks,
// and the visibility guard that pauses polling for background tabs.
// The body-id pattern (`<page>-body`) is the same shape any future SSE
// wiring would replace — keep it stable so swapping `hx-trigger` for
// `sse-swap` later doesn't ripple through every template.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";
import { kitParityFixtureRoot } from "../../server/wiring/state-paths";

function freshApp(): Hono {
    const app = new Hono();
    registerRoutes(app);
    return app;
}

const ORIGINAL_STATE_DIR = process.env["AUTONOMOUS_DEV_STATE_DIR"];

interface PolledPage {
    path: string;
    bodyId: string;
    intervalSeconds: number;
}

const POLLED_PAGES: PolledPage[] = [
    { path: "/", bodyId: "dashboard-body", intervalSeconds: 10 },
    { path: "/approvals", bodyId: "approvals-body", intervalSeconds: 10 },
    { path: "/requests", bodyId: "requests-body", intervalSeconds: 10 },
    { path: "/costs", bodyId: "costs-body", intervalSeconds: 10 },
    { path: "/ops", bodyId: "ops-body", intervalSeconds: 10 },
    { path: "/logs", bodyId: "logs-body", intervalSeconds: 5 },
    { path: "/repos", bodyId: "repos-body", intervalSeconds: 10 },
    { path: "/agents", bodyId: "agents-body", intervalSeconds: 30 },
];

// Pages intentionally NOT polled — documenting them in the test fixes the
// "is this deliberate or did we forget?" question for the next reviewer.
const NOT_POLLED_PAGES: string[] = [
    "/settings", // form-heavy: selects + textareas would lose state mid-edit
    "/audit", // date-input filter form
    "/design-system", // static reference catalog
];

describe("PORTAL-AUDIT-2026-05-16 — auto-refresh polling contract", () => {
    beforeAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = kitParityFixtureRoot();
    });
    afterAll(() => {
        if (ORIGINAL_STATE_DIR === undefined) {
            delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
        } else {
            process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
        }
    });

    for (const page of POLLED_PAGES) {
        test(`${page.path} polls every ${page.intervalSeconds}s with the visibility guard`, async () => {
            const app = freshApp();
            const res = await app.request(page.path);
            expect(res.status).toBe(200);
            const html = await res.text();

            // Body wrapper id is the polling target — must match the
            // hx-select selector for the swap to land on itself.
            expect(html).toContain(`id="${page.bodyId}"`);
            expect(html).toContain(`hx-select="#${page.bodyId}"`);

            // Polling interval with visibility guard — pinned so changes are explicit.
            // Using double quotes inside the JS expression to avoid entity encoding issues.
            expect(html).toContain(
                `hx-trigger="every ${page.intervalSeconds}s [document.visibilityState === &quot;visible&quot;]"`,
            );

            // Same path the user is on — full-page fetch + hx-select extracts
            // the body wrapper. (`hx-get="/"` is fine for the dashboard.)
            expect(html).toContain(`hx-get="${page.path}"`);

            // Swap target + mode — outerHTML on `this` keeps the wrapper id stable.
            expect(html).toContain('hx-target="this"');
            expect(html).toContain('hx-swap="outerHTML"');

            // Cypress-style smoke test (comment only - not implemented):
            // A real browser test would:
            // 1. Visit the page in Chrome/Firefox
            // 2. Open DevTools Network tab
            // 3. Background the tab (ctrl+tab or minimize window)
            // 4. Wait 15+ seconds (1.5x polling interval)
            // 5. Assert no new network requests to ${page.path} were made
            // 6. Foreground the tab
            // 7. Assert polling resumes within the next interval
        });
    }

    for (const path of NOT_POLLED_PAGES) {
        test(`${path} does NOT poll (form-heavy or static)`, async () => {
            const app = freshApp();
            const res = await app.request(path);
            expect(res.status).toBe(200);
            const html = await res.text();
            // The polled-pages bodyId pattern is unique to this PR; if a
            // not-polled page acquires one by accident, this test fires.
            // Allow `daemon-status-pill`-style targeted hx-trigger inside
            // these pages — that's separate, pre-existing polling.
            expect(html).not.toMatch(/id="[a-z-]+-body"[^>]*hx-trigger="every/);
        });
    }
});
