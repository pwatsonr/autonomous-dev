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
// `state.json` is absent. This exercises `loadRequestRecord`'s sparse-state
// branch, which previously triggered the `null is not an object (evaluating
// 'res.isEscaped')` 500 because the minimal record's empty `phases` array
// fed `request-timeline.tsx` and the TimelineActions fragment's
// `return null;` short-circuit. Asserts 200 or 404 — never 500.
describe("Request Detail — tier-2 sparse-state path (PLAN-041)", () => {
    const originalStateDir = process.env["AUTONOMOUS_DEV_STATE_DIR"];
    const tier2Id = "REQ-041041";
    let tmpRoot: string;

    beforeAll(() => {
        tmpRoot = mkdtempSync(join(tmpdir(), "plan-041-tier2-"));
        const actionsDir = join(tmpRoot, "request-actions");
        mkdirSync(actionsDir, { recursive: true });
        // Tier-2 fixture: request-action present, no state.json in any repo
        // (resolveRepoPath returns null for an unconfigured repo slug, so
        // the reader takes the sparse-state branch).
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
        // The page must render (200) OR be a clean not-found (404). The
        // forbidden outcome is 500 — that was the bug closed by replacing
        // `return null;` in region templates with `return <></>;`.
        expect(res.status).not.toBe(500);
        expect([200, 404]).toContain(res.status);
        // If the template rendered, sanity-check it produced a string body
        // and not an empty/garbage response.
        if (res.status === 200) {
            const html = await res.text();
            expect(html).toContain(tier2Id);
        }
    });
});
