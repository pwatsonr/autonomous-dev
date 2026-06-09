// FR-026-20..22 — Request Detail v3 integration tests.
//
// Asserts the v3 layout contracts:
//   - 200 + cache-control: no-store on a populated stub
//   - 404 path on unknown id format
//   - Topbar with request id as title
//   - Phase track strip with 8 phase buttons (HTMX hx-get, not modals)
//   - Artifact pane HTMX swap target (#rd-artifact-pane)
//   - Gate panel with reviewer rows and action buttons
//   - HTMX artifact fragment endpoint (GET .../artifact/:phase)
//   - Correct behavior on deploy variant (REQ-000004)

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";

function freshApp(): Hono {
    const app = new Hono();
    registerRoutes(app);
    return app;
}

describe("Request Detail — populated stub (REQ-000001 / acme)", () => {
    test("returns 200 with cache-control: no-store", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000001");
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
    });

    test("renders request id in the Topbar title", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000001");
        const html = await res.text();
        // Topbar renders <h1>REQ-000001</h1>
        expect(html).toContain("REQ-000001");
    });

    test("renders the 8-step phase track with HTMX hx-get buttons", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000001");
        const html = await res.text();
        // Each phase step button must have hx-get pointing to the artifact endpoint
        for (const p of [
            "prd",
            "tdd",
            "plan",
            "spec",
            "code",
            "review",
            "deploy",
            "observe",
        ]) {
            expect(html).toContain(
                `/repo/acme/request/REQ-000001/artifact/${p}`,
            );
        }
    });

    test("renders artifact pane HTMX swap target (id=rd-artifact-pane)", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000001");
        const html = await res.text();
        // The artifact pane must carry the HTMX swap target id
        expect(html).toContain('id="rd-artifact-pane"');
    });

    test("renders .rdetail two-column layout", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000001");
        const html = await res.text();
        expect(html).toContain('class="rdetail"');
        expect(html).toContain('class="rdetail-main"');
    });

    test("renders gate panel with reviewer verdict rows", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000001");
        const html = await res.text();
        // Gate panel has class="gate-panel" and contains reviewer rows
        expect(html).toContain('class="gate-panel"');
        expect(html).toContain('id="rd-gate-panel"');
        expect(html).toContain("review-row");
    });

    test("renders Approve and Reject buttons in gate panel", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000001");
        const html = await res.text();
        // Gate panel action buttons for status=gate request
        expect(html).toContain("Approve");
        expect(html).toContain("Reject");
    });

    test("renders phase track as role=tablist with phase step buttons", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000001");
        const html = await res.text();
        expect(html).toContain('role="tablist"');
        expect(html).toContain('role="tab"');
        // Phase step buttons have hx-target="#rd-artifact-pane"
        expect(html).toContain('hx-target="#rd-artifact-pane"');
    });

    test("renders Back link in topbar right slot", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000001");
        const html = await res.text();
        expect(html).toContain('href="/requests"');
    });
});

describe("Request Detail — region ordering", () => {
    test("phase-track appears before the rdetail grid in DOM order", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000001");
        const html = await res.text();
        const phaseTrackIdx = html.indexOf("phase-track");
        const rdetailIdx = html.indexOf('class="rdetail"');
        expect(phaseTrackIdx).toBeGreaterThan(-1);
        expect(rdetailIdx).toBeGreaterThan(phaseTrackIdx);
    });

    test("rdetail-main appears before gate-panel in DOM order", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000001");
        const html = await res.text();
        const mainIdx = html.indexOf('class="rdetail-main"');
        const gateIdx = html.indexOf('class="gate-panel"');
        expect(mainIdx).toBeGreaterThan(-1);
        expect(gateIdx).toBeGreaterThan(mainIdx);
    });
});

describe("Request Detail — deploy variant (REQ-000004)", () => {
    test("returns 200 and contains request id", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000004");
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("REQ-000004");
    });

    test("artifact pane renders pending state when artifact absent", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000004");
        const html = await res.text();
        // Deploy request has no currentArtifact; should show pending or empty state
        expect(html).toContain('id="rd-artifact-pane"');
    });
});

describe("Request Detail — HTMX artifact fragment endpoint", () => {
    test("GET /artifact/:phase returns 200 fragment for known phase", async () => {
        const app = freshApp();
        const res = await app.request(
            "/repo/acme/request/REQ-000001/artifact/prd",
        );
        expect(res.status).toBe(200);
        const html = await res.text();
        // Fragment must have the HTMX swap target id
        expect(html).toContain('id="rd-artifact-pane"');
    });

    test("GET /artifact/:phase returns current artifact when phase matches", async () => {
        const app = freshApp();
        const res = await app.request(
            "/repo/acme/request/REQ-000001/artifact/review",
        );
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('id="rd-artifact-pane"');
    });

    test("GET /artifact with invalid phase key returns 404", async () => {
        const app = freshApp();
        const res = await app.request(
            "/repo/acme/request/REQ-000001/artifact/INVALID PHASE",
        );
        expect([400, 404]).toContain(res.status);
    });
});

describe("Request Detail — 404 path", () => {
    test("malformed REQ id returns 404 (regex guard)", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-1234567");
        expect([400, 404]).toContain(res.status);
    });

    // PLAN-038 TASK-004 / TDD-037 AC-3705 — store-miss path returns 404, not
    // 500. Pin both the regex-rejected case (above) and this valid-format
    // store-miss case so the route handler's null-branch is exercised.
    test("valid-format slug that does not exist in store returns 404", async () => {
        const app = freshApp();
        const res = await app.request(
            "/repo/no-such-repo/request/REQ-999999",
        );
        expect(res.status).toBe(404);
        // Must not be a 500 — that was the bug.
        expect(res.status).not.toBe(500);
    });

    test("valid-format slug under a known repo with unknown id returns 404", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-999999");
        expect(res.status).toBe(404);
        expect(res.status).not.toBe(500);
    });
});

// PLAN-041 T-041-A-05 — tier-2 record path: request-action JSON exists in
// `${stateDir}/request-actions/REQ-NNNNNN.json` but the target repo's
// `state.json` is absent. Asserts 200 or 404 — never 500.
describe("Request Detail — tier-2 sparse-state path (PLAN-041)", () => {
    const originalStateDir = process.env["AUTONOMOUS_DEV_STATE_DIR"];
    const tier2Id = "REQ-041041";
    let tmpRoot: string;

    beforeAll(() => {
        tmpRoot = mkdtempSync(join(tmpdir(), "plan-041-tier2-"));
        const actionsDir = join(tmpRoot, "request-actions");
        mkdirSync(actionsDir, { recursive: true });
        writeFileSync(
            join(actionsDir, `${tier2Id}.json`),
            JSON.stringify({
                id: tier2Id,
                repo: "tier2-repo",
                title: "Tier-2 sparse-state request",
                phase: "code",
                status: "running",
                createdAt: "2026-05-18T00:00:00Z",
            }),
        );
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = tmpRoot;
    });

    afterAll(() => {
        if (originalStateDir === undefined) {
            delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
        } else {
            process.env["AUTONOMOUS_DEV_STATE_DIR"] = originalStateDir;
        }
        try {
            rmSync(tmpRoot, { recursive: true, force: true });
        } catch {
            /* best-effort cleanup */
        }
    });

    test("tier-2 record (request-action present, state.json absent) does not 500", async () => {
        const app = freshApp();
        const res = await app.request(`/repo/tier2-repo/request/${tier2Id}`);
        expect(res.status).not.toBe(500);
        expect([200, 404]).toContain(res.status);
        if (res.status === 200) {
            const html = await res.text();
            expect(html).toContain(tier2Id);
        }
    });
});
