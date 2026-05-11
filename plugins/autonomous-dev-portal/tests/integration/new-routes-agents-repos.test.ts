// PLAN-038 TASK-005 + TASK-006 — integration tests for the new routes.
//
// Pins:
//   - GET /agents returns 200 (was 404 — see TDD-037 §3.2)
//   - GET /repos returns 200 (was 404)
//   - GET /api/agents returns 200 with application/json
//   - Rail-nav `Agents` link points at /agents (not /settings#agents)
//   - Rendered empty-state copy is honest (no kit fixtures leak through)

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { NAV_ITEMS } from "../../server/components/rail-nav";
import { registerRoutes } from "../../server/routes";

function freshApp(): Hono {
    const app = new Hono();
    registerRoutes(app);
    return app;
}

describe("PLAN-038 new routes — /agents, /repos, /api/agents", () => {
    test("GET /agents returns 200", async () => {
        const app = freshApp();
        const res = await app.request("/agents");
        expect(res.status).toBe(200);
    });

    test("GET /repos returns 200", async () => {
        const app = freshApp();
        const res = await app.request("/repos");
        expect(res.status).toBe(200);
    });

    test("GET /api/agents returns 200 with JSON content-type", async () => {
        const app = freshApp();
        const res = await app.request("/api/agents");
        expect(res.status).toBe(200);
        const ct = res.headers.get("content-type") ?? "";
        expect(ct).toContain("application/json");
        const body = await res.json();
        expect(Array.isArray(body)).toBe(true);
    });

    test("/agents empty-state copy is honest (no kit fixtures leak)", async () => {
        const app = freshApp();
        const res = await app.request("/agents");
        const html = await res.text();
        // Honest empty-state copy from agents.tsx view.
        expect(html).toContain("No agents have been frozen or shadowed");
        // Kit-screenshot fixtures must NOT appear in the live empty-state.
        expect(html).not.toContain("qa-edge-case");
        expect(html).not.toContain("ux-ui");
        expect(html).not.toContain("rule-set");
    });

    test("/repos empty-state copy is honest (no kit fixtures leak)", async () => {
        const app = freshApp();
        const res = await app.request("/repos");
        const html = await res.text();
        expect(html).toContain("No repositories in the allowlist");
        // Kit-screenshot fake repo names must not appear.
        expect(html).not.toContain("critical-service");
        expect(html).not.toContain("docs-site");
        expect(html).not.toContain("homelab-api");
    });
});

describe("PLAN-038 TASK-006 — rail-nav Agents href", () => {
    test("NAV_ITEMS Agents entry points at /agents (not /settings#agents)", () => {
        const agentsItem = NAV_ITEMS.find((i) => i.label === "Agents");
        expect(agentsItem).toBeDefined();
        expect(agentsItem?.href).toBe("/agents");
    });
});
