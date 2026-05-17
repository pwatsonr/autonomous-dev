/**
 * Integration tests for BUG-9 and BUG-10 fixes on the request detail page.
 *
 * BUG-9: Pause/Kill buttons should have proper HTMX wiring and work with the backend.
 * BUG-10: Phase buttons should open modals with artifact content.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";

function freshApp(): Hono {
    const app = new Hono();
    registerRoutes(app);
    return app;
}

describe("Request Detail Actions", () => {
    describe("BUG-9: Pause/Kill buttons", () => {
        test("should render Pause button with proper hx-post wiring", async () => {
            const app = freshApp();
            const response = await app.request("/repo/acme/request/REQ-000001");
            const html = await response.text();

            // Check that Pause button has the required HTMX attributes
            expect(html).toContain('hx-post="/api/requests/REQ-000001/action"');
            expect(html).toContain('hx-vals=\'{"action":"pause"}\'');
            expect(html).toContain('data-request-action="pause"');
            expect(html).toContain('>Pause</');
        });

        test("should render Kill button with proper hx-post wiring", async () => {
            const app = freshApp();
            const response = await app.request("/repo/acme/request/REQ-000001");
            const html = await response.text();

            // Check that Kill button has the required HTMX attributes
            expect(html).toContain('hx-post="/api/requests/REQ-000001/action"');
            expect(html).toContain('hx-vals=\'{"action":"kill"}\'');
            expect(html).toContain('data-request-action="kill"');
            expect(html).toContain('>Kill</');
        });

        test("should accept pause action via POST /api/requests/:id/action", async () => {
            const app = freshApp();
            const response = await app.request("/api/requests/REQ-000001/action", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "HX-Request": "true",
                },
                body: JSON.stringify({ action: "pause" }),
            });

            // Should not return 400 "unknown-action" now that pause is whitelisted
            expect(response.status).not.toBe(400);
            if (response.status === 400) {
                const error = await response.json();
                expect(error.error).not.toBe("unknown-action");
            }
        });

        test("should accept kill action via POST /api/requests/:id/action", async () => {
            const app = freshApp();
            const response = await app.request("/api/requests/REQ-000001/action", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "HX-Request": "true",
                },
                body: JSON.stringify({ action: "kill" }),
            });

            // Should not return 400 "unknown-action" now that kill is whitelisted
            expect(response.status).not.toBe(400);
            if (response.status === 400) {
                const error = await response.json();
                expect(error.error).not.toBe("unknown-action");
            }
        });

        test("should still reject unknown actions", async () => {
            const app = freshApp();
            const response = await app.request("/api/requests/REQ-000001/action", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "HX-Request": "true",
                },
                body: JSON.stringify({ action: "invalid-action" }),
            });

            expect(response.status).toBe(400);
            const error = await response.json();
            expect(error.error).toBe("unknown-action");
        });
    });

    describe("BUG-10: Phase artifact modals", () => {
        test("should render modal dialogs for all pipeline phases", async () => {
            const app = freshApp();
            const response = await app.request("/repo/acme/request/REQ-000001");
            const html = await response.text();

            // Check that modal dialogs are rendered for each phase
            const defaultPipeline = ["prd", "tdd", "plan", "spec", "code", "review", "deploy", "observe"];

            for (const phase of defaultPipeline) {
                expect(html).toContain(`data-modal="artifact-${phase}"`);
                expect(html).toContain(`id="artifact-modal-${phase}-title"`);
            }
        });

        test("should render phase buttons with modal-open attributes", async () => {
            const app = freshApp();
            const response = await app.request("/repo/acme/request/REQ-000001");
            const html = await response.text();

            // Check that pipeline phase buttons have the correct modal trigger attributes
            const defaultPipeline = ["prd", "tdd", "plan", "spec", "code", "review", "deploy", "observe"];

            for (const phase of defaultPipeline) {
                expect(html).toContain(`data-modal-open="artifact-${phase}"`);
                expect(html).toContain(`data-phase="${phase}"`);
            }
        });

        test("should include modal.js script for modal functionality", async () => {
            const app = freshApp();
            const response = await app.request("/repo/acme/request/REQ-000001");
            const html = await response.text();

            // Check that the modal.js script is included
            expect(html).toContain('src="/static/modal.js"');
        });

        test("should render artifact content in modals", async () => {
            const app = freshApp();
            const response = await app.request("/repo/acme/request/REQ-000001");
            const html = await response.text();

            // Each modal should have an artifact body section
            expect(html).toContain('<div class="artifact-body">');

            // Should contain phase-specific content
            expect(html).toContain("PRD phase artifact");
            expect(html).toContain("TDD phase artifact");
        });
    });
});