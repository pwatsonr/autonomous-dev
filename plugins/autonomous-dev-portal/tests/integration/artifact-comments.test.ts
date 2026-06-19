// #500 — artifact-comment route integration tests.
//
// Exercises the operator comment endpoints end-to-end over the real Hono app
// (registerRoutes + the real filesystem-backed stores), with state isolated to
// a per-test temp dir:
//   GET  .../artifact/:phase/comments          → panel fragment
//   POST .../artifact/:phase/comments          → add (doc-level + inline)
//   POST .../artifact/:phase/comments/resolve  → resolve
//   POST .../artifact/:phase/revise            → hand-off (feedback + marker)
// Plus the 503 stub when the dep is omitted, and that capture/persist never
// touches real operator data.

import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";
import { defaultArtifactCommentStore } from "../../server/routes/artifact-comments";

interface AuditCapture {
    events: Array<Record<string, unknown>>;
}

const REPO = "demo-repo";
const ID = "REQ-000500";
const PHASE = "prd";
const BASE = `/repo/${REPO}/request/${ID}/artifact/${PHASE}`;

let root: string;
let repoPath: string;
let cfgPath: string;
let audit: AuditCapture;
const prevState = process.env["AUTONOMOUS_DEV_STATE_DIR"];
const prevCfg = process.env["AUTONOMOUS_DEV_USER_CONFIG"];

function buildApp(): { app: Hono; audit: AuditCapture } {
    const cap: AuditCapture = { events: [] };
    const app = new Hono();
    registerRoutes(app, {
        artifactComments: {
            ...defaultArtifactCommentStore(),
            audit: {
                async append(entry) {
                    cap.events.push(entry);
                },
            },
        },
    });
    return { app, audit: cap };
}

async function exists(p: string): Promise<boolean> {
    try {
        await stat(p);
        return true;
    } catch {
        return false;
    }
}

beforeEach(async () => {
    root = join(tmpdir(), `ac-route-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    repoPath = join(root, "repos", REPO);
    cfgPath = join(root, "autonomous-dev.json");
    await mkdir(repoPath, { recursive: true });
    process.env["AUTONOMOUS_DEV_STATE_DIR"] = root;
    process.env["AUTONOMOUS_DEV_USER_CONFIG"] = cfgPath;
    await writeFile(
        cfgPath,
        JSON.stringify({ repositories: { allowlist: [repoPath] } }),
        "utf-8",
    );
    const built = buildApp();
    audit = built.audit;
    // attach for individual tests
    (globalThis as Record<string, unknown>).__app = built.app;
});

afterEach(async () => {
    if (prevState === undefined) delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
    else process.env["AUTONOMOUS_DEV_STATE_DIR"] = prevState;
    if (prevCfg === undefined) delete process.env["AUTONOMOUS_DEV_USER_CONFIG"];
    else process.env["AUTONOMOUS_DEV_USER_CONFIG"] = prevCfg;
    await rm(root, { recursive: true, force: true });
});

function app(): Hono {
    return (globalThis as Record<string, unknown>).__app as Hono;
}

async function postForm(
    path: string,
    fields: Record<string, string>,
): Promise<Response> {
    const body = new URLSearchParams(fields).toString();
    return app().request(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
    });
}

describe("artifact-comment routes (#500)", () => {
    test("GET comments renders the (empty) panel fragment", async () => {
        const res = await app().request(`${BASE}/comments`);
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('id="rd-comment-panel"');
        expect(html).toContain("No comments yet");
        // The pane is empty so the revise button is disabled.
        expect(html).toContain("disabled");
    });

    test("POST a doc-level comment persists + re-renders + audits", async () => {
        const res = await postForm(`${BASE}/comments`, {
            body: "Tighten the scope.",
            _csrf: "test",
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("Tighten the scope.");
        expect(html).toContain('class="chip muted rd-comment-kind"'); // doc-level

        // Persisted to the canonical in-repo path.
        const path = join(
            repoPath,
            ".autonomous-dev",
            "requests",
            ID,
            "artifact-comments",
            `${PHASE}.json`,
        );
        expect(await exists(path)).toBe(true);
        const file = JSON.parse(await readFile(path, "utf-8")) as {
            comments: Array<{ body: string; anchor: unknown }>;
        };
        expect(file.comments[0]!.body).toBe("Tighten the scope.");
        expect(file.comments[0]!.anchor).toBeNull();

        // Audit row.
        expect(audit.events.some((e) => e.event === "artifact_comment_added")).toBe(true);
    });

    test("POST an inline comment stores the anchor", async () => {
        const res = await postForm(`${BASE}/comments`, {
            body: "ambiguous requirement",
            anchorQuote: "the system shall foo",
            anchorStart: "12",
            anchorEnd: "32",
            _csrf: "test",
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('class="chip brand rd-comment-kind"'); // inline
        expect(html).toContain("the system shall foo");

        const path = join(
            repoPath,
            ".autonomous-dev",
            "requests",
            ID,
            "artifact-comments",
            `${PHASE}.json`,
        );
        const file = JSON.parse(await readFile(path, "utf-8")) as {
            comments: Array<{ anchor: { quote: string; start: number } | null }>;
        };
        expect(file.comments[0]!.anchor!.quote).toBe("the system shall foo");
        expect(file.comments[0]!.anchor!.start).toBe(12);
    });

    test("POST with an empty body → 400", async () => {
        const res = await postForm(`${BASE}/comments`, { body: "   ", _csrf: "test" });
        expect(res.status).toBe(400);
    });

    test("resolve flips a comment then revise reports no open comments", async () => {
        // Add one comment, capture its id from the panel.
        await postForm(`${BASE}/comments`, { body: "please fix", _csrf: "test" });
        const path = join(
            repoPath,
            ".autonomous-dev",
            "requests",
            ID,
            "artifact-comments",
            `${PHASE}.json`,
        );
        const file = JSON.parse(await readFile(path, "utf-8")) as {
            comments: Array<{ id: string }>;
        };
        const cid = file.comments[0]!.id;

        const res = await postForm(`${BASE}/comments/resolve`, {
            commentId: cid,
            _csrf: "test",
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("rd-comment-resolved");

        // Now no open comments → revise returns 409.
        const revise = await postForm(`${BASE}/revise`, { _csrf: "test" });
        expect(revise.status).toBe(409);
    });

    test("revise writes a feedback artifact + daemon marker and audits", async () => {
        await postForm(`${BASE}/comments`, {
            body: "inline note",
            anchorQuote: "some passage",
            anchorStart: "0",
            anchorEnd: "12",
            _csrf: "test",
        });
        await postForm(`${BASE}/comments`, { body: "doc note", _csrf: "test" });

        const res = await postForm(`${BASE}/revise`, { _csrf: "test" });
        expect(res.status).toBe(200);

        // Feedback artifact written to the request's repo dir.
        const fbPath = join(
            repoPath,
            ".autonomous-dev",
            "requests",
            ID,
            "artifact-feedback",
            `${PHASE}.json`,
        );
        expect(await exists(fbPath)).toBe(true);
        const fb = JSON.parse(await readFile(fbPath, "utf-8")) as { feedback: string };
        expect(fb.feedback).toContain("inline note");
        expect(fb.feedback).toContain("doc note");

        // Daemon revise marker under the state dir.
        const markerPath = join(root, "revise-requests", `${REPO}__${ID}.json`);
        expect(await exists(markerPath)).toBe(true);

        // Audit row recorded the hand-off with the comment count + wired flag.
        const ev = audit.events.find((e) => e.event === "artifact_revise_requested");
        expect(ev).toBeDefined();
        expect(ev!.comments).toBe(2);
        expect(ev!.wired).toBe(true);
    });

    test("path params are validated (bad id → 404)", async () => {
        const res = await app().request(
            `/repo/${REPO}/request/not-a-req/artifact/${PHASE}/comments`,
        );
        expect(res.status).toBe(404);
    });

    test("unmounted (no artifactComments dep) → 503 artifact-comments-disabled", async () => {
        const bare = new Hono();
        registerRoutes(bare);
        const res = await bare.request(`${BASE}/comments`);
        expect(res.status).toBe(503);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("artifact-comments-disabled");
    });
});
