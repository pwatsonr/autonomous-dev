// #500 — artifact-revise (hand-off) store unit tests.
//
// Verifies the "send to AI to revise" hand-off:
//   - buildFeedbackBlock renders inline (quoted) + doc-level comments,
//   - writeReviseRequest folds UNRESOLVED comments into a feedback artifact at
//     the canonical in-repo path AND writes a daemon-consumed revise marker,
//   - the folded comments are marked resolved (so a second revise is a no-op),
//   - no unresolved comments → { ok:false, reason:"no-comments" },
//   - portal-only fallback (repo not allowlisted) writes the feedback artifact
//     but NO marker, and reports wired:false,
//   - invalid keys are rejected.

import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { addArtifactComment } from "../../server/wiring/artifact-comments-store";
import {
    buildFeedbackBlock,
    reviseMarkerPath,
    writeReviseRequest,
} from "../../server/wiring/artifact-revise-store";

const REPO = "demo-repo";
const ID = "REQ-000500";
const PHASE = "spec";

let root: string;
let repoPath: string;
let cfgPath: string;
const prevState = process.env["AUTONOMOUS_DEV_STATE_DIR"];
const prevCfg = process.env["AUTONOMOUS_DEV_USER_CONFIG"];

async function writeConfig(withRepo: boolean): Promise<void> {
    const cfg = withRepo
        ? { repositories: { allowlist: [repoPath] } }
        : { repositories: { allowlist: [] as string[] } };
    await writeFile(cfgPath, JSON.stringify(cfg), "utf-8");
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
    root = join(tmpdir(), `ar-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    repoPath = join(root, "repos", REPO);
    cfgPath = join(root, "autonomous-dev.json");
    await mkdir(repoPath, { recursive: true });
    process.env["AUTONOMOUS_DEV_STATE_DIR"] = root;
    process.env["AUTONOMOUS_DEV_USER_CONFIG"] = cfgPath;
    await writeConfig(true);
});

afterEach(async () => {
    if (prevState === undefined) delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
    else process.env["AUTONOMOUS_DEV_STATE_DIR"] = prevState;
    if (prevCfg === undefined) delete process.env["AUTONOMOUS_DEV_USER_CONFIG"];
    else process.env["AUTONOMOUS_DEV_USER_CONFIG"] = prevCfg;
    await rm(root, { recursive: true, force: true });
});

describe("buildFeedbackBlock (#500)", () => {
    test("renders inline (quoted) and doc-level comments", () => {
        const block = buildFeedbackBlock("prd", [
            {
                id: "cmt-1",
                phase: "prd",
                anchor: { quote: "shall do X", start: 0, end: 10 },
                body: "too vague",
                author: "operator",
                createdAt: "2026-06-18T00:00:00Z",
                resolved: false,
            },
            {
                id: "cmt-2",
                phase: "prd",
                anchor: null,
                body: "add a non-goals section",
                author: "operator",
                createdAt: "2026-06-18T00:01:00Z",
                resolved: false,
            },
        ]);
        expect(block).toContain("PRD artifact");
        expect(block).toContain("> shall do X");
        expect(block).toContain("Comment: too vague");
        expect(block).toContain("(Document-level) add a non-goals section");
        expect(block).toContain("Revise the artifact");
    });
});

describe("writeReviseRequest (#500)", () => {
    test("folds unresolved comments into a feedback artifact + marker", async () => {
        await addArtifactComment({
            repo: REPO,
            id: ID,
            phase: PHASE,
            body: "fix the data model",
            author: "operator",
            anchor: { quote: "users table", start: 5, end: 16 },
        });
        await addArtifactComment({
            repo: REPO,
            id: ID,
            phase: PHASE,
            body: "doc-level: clarify the rollout",
            author: "operator",
        });

        const result = await writeReviseRequest({
            repo: REPO,
            id: ID,
            phase: PHASE,
            actor: "operator",
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("expected ok");
        expect(result.count).toBe(2);
        expect(result.wired).toBe(true);

        // Feedback artifact lands in the canonical in-repo location.
        const fbPath = join(
            repoPath,
            ".autonomous-dev",
            "requests",
            ID,
            "artifact-feedback",
            `${PHASE}.json`,
        );
        expect(result.feedbackPath).toBe(fbPath);
        const fb = JSON.parse(await readFile(fbPath, "utf-8")) as {
            phase: string;
            feedback: string;
            comments: Array<{ body: string }>;
        };
        expect(fb.phase).toBe(PHASE);
        expect(fb.feedback).toContain("fix the data model");
        expect(fb.feedback).toContain("clarify the rollout");
        expect(fb.comments).toHaveLength(2);

        // Daemon marker written.
        const markerPath = reviseMarkerPath(REPO, ID);
        expect(await exists(markerPath)).toBe(true);
        const marker = JSON.parse(await readFile(markerPath, "utf-8")) as {
            source: string;
            phase: string;
            id: string;
        };
        expect(marker.source).toBe("portal");
        expect(marker.phase).toBe(PHASE);
        expect(marker.id).toBe(ID);
    });

    test("marks the folded comments resolved so a second revise is a no-op", async () => {
        await addArtifactComment({
            repo: REPO,
            id: ID,
            phase: PHASE,
            body: "first round",
            author: "operator",
        });
        const first = await writeReviseRequest({ repo: REPO, id: ID, phase: PHASE, actor: "operator" });
        expect(first.ok).toBe(true);

        const second = await writeReviseRequest({ repo: REPO, id: ID, phase: PHASE, actor: "operator" });
        expect(second.ok).toBe(false);
        if (second.ok) throw new Error("expected no-comments");
        expect(second.reason).toBe("no-comments");
    });

    test("no unresolved comments → no-comments", async () => {
        const result = await writeReviseRequest({ repo: REPO, id: ID, phase: PHASE, actor: "operator" });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("expected failure");
        expect(result.reason).toBe("no-comments");
    });

    test("portal-only fallback: feedback written, NO marker, wired:false", async () => {
        await writeConfig(false); // repo not allowlisted
        await addArtifactComment({
            repo: REPO,
            id: ID,
            phase: PHASE,
            body: "comment in stub world",
            author: "operator",
        });
        const result = await writeReviseRequest({ repo: REPO, id: ID, phase: PHASE, actor: "operator" });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("expected ok");
        expect(result.wired).toBe(false);

        // Feedback exists (in the fallback location), but NO daemon marker.
        expect(await exists(result.feedbackPath)).toBe(true);
        expect(await exists(reviseMarkerPath(REPO, ID))).toBe(false);
    });

    test("rejects invalid keys", async () => {
        const r1 = await writeReviseRequest({ repo: REPO, id: "nope", phase: PHASE, actor: "operator" });
        expect(r1.ok).toBe(false);
        if (r1.ok) throw new Error("expected failure");
        expect(r1.reason).toBe("invalid");
    });
});
