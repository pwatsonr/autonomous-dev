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

    test("/agents lists real manifest agents (not kit fixtures)", async () => {
        const app = freshApp();
        const res = await app.request("/agents");
        const html = await res.text();
        // After TASK-015, /agents reads from plugins/autonomous-dev/agents/*.md
        // — the real manifest. It should list real agents like code-executor
        // (and qa-edge-case-reviewer, which is a real agent name — distinct
        // from the kit's "qa-edge-case" fixture-only name without the suffix).
        expect(html).toContain("code-executor");
        // The kit's fake bare names (no `-reviewer` suffix) from stubs/costs.ts
        // should not leak: the rendered table only has full manifest names.
        const fakeBarePattern = /\bqa-edge-case\b(?!-)/; // not followed by a `-`
        expect(html).not.toMatch(fakeBarePattern);
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
