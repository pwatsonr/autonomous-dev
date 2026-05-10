// SPEC-036-3-01 — Request Detail integration tests.
//
// Asserts:
//   - 200 + shell on a populated stub
//   - 404 path on unknown id format
//   - SSE OOB-swap target ids present (request-${id}-meta / -phase /
//     -artifact / -deploy)
//   - region-ordering DOM contract
//   - cache-control: no-store
//   - gate-action buttons appear for status === "gate"
//   - run-history table renders for stub with runs
//   - artifact pane renders the diff variant (stub `acme/REQ-000001` is
//     `currentArtifact.format === "diff"`)

import { describe, expect, test } from "bun:test";
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

    test("emits OOB swap target ids for meta / phase / artifact", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000001");
        const html = await res.text();
        expect(html).toContain('id="request-REQ-000001-meta"');
        expect(html).toContain('id="request-REQ-000001-phase"');
        expect(html).toContain('id="request-REQ-000001-artifact"');
    });

    test("renders Request <code>{id}</code> head", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000001");
        const html = await res.text();
        expect(html).toContain("Request <code>REQ-000001</code>");
    });

    test("renders pipeline-vis with the canonical 8 phases", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000001");
        const html = await res.text();
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
            expect(html).toContain(`data-phase="${p}"`);
        }
    });

    test("renders artifact pane diff content with classified line spans", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000001");
        const html = await res.text();
        expect(html).toContain('class="artifact-pre artifact-diff"');
        expect(html).toContain('class="diff-add"');
        expect(html).toContain('class="diff-del"');
        expect(html).toContain('class="diff-hunk"');
    });

    test("renders gate detail with three action buttons (status=gate)", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000001");
        const html = await res.text();
        expect(html).toContain('data-gate-action="approve"');
        expect(html).toContain('data-gate-action="request-changes"');
        expect(html).toContain('data-gate-action="reject"');
        expect(html).toContain("Gate · Reviewer chain");
    });

    test("renders reviewer chain with Score primitives", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000001");
        const html = await res.text();
        expect(html).toContain('class="rev-card');
        expect(html).toContain('class="score-inline"');
    });

    test("renders run-history table with prepared rows", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000001");
        const html = await res.text();
        expect(html).toContain('<table class="tbl tight">');
        expect(html).toContain("run-2026-05-09-04");
    });
});

describe("Request Detail — region ordering", () => {
    test("header → pipeline → artifact appear in DOM order", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000001");
        const html = await res.text();
        const headerIdx = html.indexOf("request-REQ-000001-meta");
        const phaseIdx = html.indexOf("request-REQ-000001-phase");
        const artifactIdx = html.indexOf("request-REQ-000001-artifact");
        expect(headerIdx).toBeGreaterThan(-1);
        expect(phaseIdx).toBeGreaterThan(headerIdx);
        expect(artifactIdx).toBeGreaterThan(phaseIdx);
    });
});

describe("Request Detail — deploy variant (REQ-000004)", () => {
    test("emits deploy-pipeline section + OOB id", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000004");
        const html = await res.text();
        expect(html).toContain('id="request-REQ-000004-deploy"');
        expect(html).toContain('class="deploy-pipe"');
        expect(html).toContain('data-stage="build"');
    });

    test("artifact pane renders empty state when artifact absent", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-000004");
        const html = await res.text();
        expect(html).toContain("No artifact available for this phase");
    });
});

describe("Request Detail — 404 path", () => {
    test("malformed REQ id returns 404", async () => {
        const app = freshApp();
        const res = await app.request("/repo/acme/request/REQ-1234567");
        expect([400, 404]).toContain(res.status);
    });
});
