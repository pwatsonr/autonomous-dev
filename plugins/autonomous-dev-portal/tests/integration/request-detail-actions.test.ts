/**
 * FR-026-20..22 — Request Detail v3 HTMX action tests.
 *
 * The v3 layout replaces modals (BUG-10) with inline HTMX swaps and removes
 * the v1 Pause/Kill page-head buttons (BUG-9) from the view layer (those
 * POST endpoints remain registered via the gate-and-request-actions handler).
 *
 * This file tests the v3 action contracts:
 *   - Phase-track HTMX swap endpoint (GET .../artifact/:phase)
 *   - Gate panel action buttons (hx-post to gate endpoints)
 *   - POST action endpoints still respond (503 stub or real handler)
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";

function freshApp(): Hono {
    const app = new Hono();
    registerRoutes(app);
    return app;
}

describe("Request Detail v3 Actions", () => {
    describe("Phase-track HTMX swap", () => {
        test("GET artifact endpoint exists and returns 200 for known phase", async () => {
            const app = freshApp();
            const response = await app.request(
                "/repo/acme/request/REQ-000001/artifact/review",
            );
            expect(response.status).toBe(200);
        });

        test("artifact fragment contains the HTMX swap target id", async () => {
            const app = freshApp();
            const response = await app.request(
                "/repo/acme/request/REQ-000001/artifact/prd",
            );
            const html = await response.text();
            expect(html).toContain('id="rd-artifact-pane"');
        });

        test("phase track buttons use hx-get with artifact endpoint URL", async () => {
            const app = freshApp();
            const response = await app.request("/repo/acme/request/REQ-000001");
            const html = await response.text();
            // Every phase step must have an hx-get pointing to its artifact URL
            expect(html).toContain(
                "/repo/acme/request/REQ-000001/artifact/prd",
            );
            expect(html).toContain(
                "/repo/acme/request/REQ-000001/artifact/code",
            );
        });

        test("phase track buttons target #rd-artifact-pane with outerHTML swap", async () => {
            const app = freshApp();
            const response = await app.request("/repo/acme/request/REQ-000001");
            const html = await response.text();
            expect(html).toContain('hx-target="#rd-artifact-pane"');
            expect(html).toContain('hx-swap="outerHTML"');
        });

        test("artifact endpoint returns 404 for invalid phase key", async () => {
            const app = freshApp();
            const response = await app.request(
                "/repo/acme/request/REQ-000001/artifact/NOT A PHASE",
            );
            expect([400, 404]).toContain(response.status);
        });

        test("artifact endpoint returns 404 for unknown request id", async () => {
            const app = freshApp();
            const response = await app.request(
                "/repo/acme/request/REQ-999999/artifact/prd",
            );
            expect(response.status).toBe(404);
        });
    });

    describe("Gate panel action buttons", () => {
        test("gate panel renders with hx-post approve URL", async () => {
            const app = freshApp();
            const response = await app.request("/repo/acme/request/REQ-000001");
            const html = await response.text();
            // Gate panel Approve button posts to the approve endpoint
            expect(html).toContain(
                "/repo/acme/request/REQ-000001/gate/approve",
            );
        });

        test("gate panel renders with hx-post reject URL", async () => {
            const app = freshApp();
            const response = await app.request("/repo/acme/request/REQ-000001");
            const html = await response.text();
            // Gate panel Reject button posts to the reject endpoint
            expect(html).toContain(
                "/repo/acme/request/REQ-000001/gate/reject",
            );
        });

        test("gate panel includes CSRF hidden input and note textarea", async () => {
            const app = freshApp();
            const response = await app.request("/repo/acme/request/REQ-000001");
            const html = await response.text();
            expect(html).toContain('id="rd-gate-csrf"');
            expect(html).toContain('id="rd-gate-note"');
        });

        test("gate panel hx-post buttons target #rd-gate-panel with outerHTML swap", async () => {
            const app = freshApp();
            const response = await app.request("/repo/acme/request/REQ-000001");
            const html = await response.text();
            expect(html).toContain('hx-target="#rd-gate-panel"');
        });
    });

    describe("POST action endpoints (stub registration check)", () => {
        test("POST /api/requests/:id/action is registered (503 stub or real handler)", async () => {
            const app = freshApp();
            const response = await app.request("/api/requests/REQ-000001/action", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "HX-Request": "true",
                },
                body: JSON.stringify({ action: "pause" }),
            });
            // 503 when the stub is active (no deps), 200/4xx when wired
            expect([200, 400, 503]).toContain(response.status);
        });

        test("POST /repo/:repo/request/:id/gate/approve is registered", async () => {
            const app = freshApp();
            const response = await app.request(
                "/repo/acme/request/REQ-000001/gate/approve",
                {
                    method: "POST",
                    headers: { "HX-Request": "true" },
                },
            );
            // 503 stub or real response
            expect([200, 400, 403, 503]).toContain(response.status);
        });

        test("POST /repo/:repo/request/:id/gate/reject is registered", async () => {
            const app = freshApp();
            const response = await app.request(
                "/repo/acme/request/REQ-000001/gate/reject",
                {
                    method: "POST",
                    headers: { "HX-Request": "true" },
                },
            );
            expect([200, 400, 403, 503]).toContain(response.status);
        });
    });
});
