// #500 — artifact-comments store unit tests.
//
// Verifies capture + persistence of operator comments on a rendered artifact:
//   - doc-level + inline (anchored) comments persist to the canonical in-repo
//     path when the repo resolves via the daemon config allowlist,
//   - to the portal-store fallback when it does not,
//   - read returns a well-formed empty file before any write,
//   - corrupt files degrade to empty (graceful),
//   - resolve flips the flag and persists,
//   - validation rejects bad keys / empty / oversized bodies.
//
// State isolation: every test points AUTONOMOUS_DEV_STATE_DIR +
// AUTONOMOUS_DEV_USER_CONFIG at a per-test temp dir (the global preload
// already redirects them, but we set explicit fixtures here). Operator data
// is never touched.

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
    addArtifactComment,
    commentsFilePath,
    readArtifactComments,
    resolveArtifactComment,
    unresolvedCount,
    type ArtifactCommentsFile,
} from "../../server/wiring/artifact-comments-store";

const REPO = "demo-repo";
const ID = "REQ-000500";
const PHASE = "prd";

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

beforeEach(async () => {
    root = join(tmpdir(), `ac-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    repoPath = join(root, "repos", REPO);
    cfgPath = join(root, "autonomous-dev.json");
    await mkdir(repoPath, { recursive: true });
    await mkdir(join(root), { recursive: true });
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

describe("artifact-comments store (#500)", () => {
    test("read returns a well-formed empty file before any write", async () => {
        const file = await readArtifactComments(REPO, ID, PHASE);
        expect(file.v).toBe(1);
        expect(file.id).toBe(ID);
        expect(file.repo).toBe(REPO);
        expect(file.phase).toBe(PHASE);
        expect(file.comments).toEqual([]);
    });

    test("doc-level comment persists to the CANONICAL in-repo path", async () => {
        const { comment } = await addArtifactComment({
            repo: REPO,
            id: ID,
            phase: PHASE,
            body: "Tighten the scope section.",
            author: "operator",
        });
        expect(comment.anchor).toBeNull();
        expect(comment.id).toMatch(/^cmt-/);
        expect(comment.resolved).toBe(false);

        const { path, canonical } = await commentsFilePath(REPO, ID, PHASE);
        expect(canonical).toBe(true);
        expect(path).toBe(
            join(
                repoPath,
                ".autonomous-dev",
                "requests",
                ID,
                "artifact-comments",
                `${PHASE}.json`,
            ),
        );
        const onDisk = JSON.parse(
            await readFile(path, "utf-8"),
        ) as ArtifactCommentsFile;
        expect(onDisk.comments).toHaveLength(1);
        expect(onDisk.comments[0]!.body).toBe("Tighten the scope section.");
    });

    test("inline comment stores the anchor (quote + offsets)", async () => {
        const { comment } = await addArtifactComment({
            repo: REPO,
            id: ID,
            phase: PHASE,
            body: "This requirement is ambiguous.",
            author: "operator",
            anchor: { quote: "the system shall", start: 10, end: 26 },
        });
        expect(comment.anchor).not.toBeNull();
        expect(comment.anchor!.quote).toBe("the system shall");
        expect(comment.anchor!.start).toBe(10);
        expect(comment.anchor!.end).toBe(26);

        const file = await readArtifactComments(REPO, ID, PHASE);
        expect(file.comments).toHaveLength(1);
        expect(file.comments[0]!.anchor!.quote).toBe("the system shall");
    });

    test("an inline comment with an empty quote degrades to doc-level", async () => {
        const { comment } = await addArtifactComment({
            repo: REPO,
            id: ID,
            phase: PHASE,
            body: "general note",
            author: "operator",
            anchor: { quote: "   ".trim(), start: 0, end: 0 },
        });
        expect(comment.anchor).toBeNull();
    });

    test("falls back to the PORTAL store when the repo is not allowlisted", async () => {
        await writeConfig(false); // empty allowlist → repo won't resolve
        const { path, canonical } = await commentsFilePath(REPO, ID, PHASE);
        expect(canonical).toBe(false);
        expect(path).toBe(
            join(root, "artifact-comments", `${REPO}__${ID}`, `${PHASE}.json`),
        );

        await addArtifactComment({
            repo: REPO,
            id: ID,
            phase: PHASE,
            body: "saved to fallback",
            author: "operator",
        });
        const onDisk = JSON.parse(
            await readFile(path, "utf-8"),
        ) as ArtifactCommentsFile;
        expect(onDisk.comments[0]!.body).toBe("saved to fallback");
    });

    test("multiple comments accumulate in insertion order", async () => {
        await addArtifactComment({ repo: REPO, id: ID, phase: PHASE, body: "one", author: "operator" });
        await addArtifactComment({ repo: REPO, id: ID, phase: PHASE, body: "two", author: "operator" });
        const file = await readArtifactComments(REPO, ID, PHASE);
        expect(file.comments.map((c) => c.body)).toEqual(["one", "two"]);
    });

    test("resolve flips the flag and persists; unresolvedCount tracks it", async () => {
        const { comment } = await addArtifactComment({
            repo: REPO,
            id: ID,
            phase: PHASE,
            body: "fix this",
            author: "operator",
        });
        let file = await readArtifactComments(REPO, ID, PHASE);
        expect(unresolvedCount(file)).toBe(1);

        file = await resolveArtifactComment(REPO, ID, PHASE, comment.id, true);
        expect(file.comments[0]!.resolved).toBe(true);
        expect(unresolvedCount(file)).toBe(0);

        // Persisted across a fresh read.
        const reread = await readArtifactComments(REPO, ID, PHASE);
        expect(reread.comments[0]!.resolved).toBe(true);
    });

    test("resolve is a no-op for an unknown comment id", async () => {
        await addArtifactComment({ repo: REPO, id: ID, phase: PHASE, body: "x", author: "operator" });
        const file = await resolveArtifactComment(REPO, ID, PHASE, "cmt-nope", true);
        expect(file.comments[0]!.resolved).toBe(false);
    });

    test("a corrupt comments file degrades to an empty list (no throw)", async () => {
        const { path } = await commentsFilePath(REPO, ID, PHASE);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, "{ this is not json", "utf-8");
        const file = await readArtifactComments(REPO, ID, PHASE);
        expect(file.comments).toEqual([]);
    });

    test("rejects an empty body", async () => {
        await expect(
            addArtifactComment({ repo: REPO, id: ID, phase: PHASE, body: "   ", author: "operator" }),
        ).rejects.toThrow("empty-body");
    });

    test("rejects an oversized body", async () => {
        await expect(
            addArtifactComment({
                repo: REPO,
                id: ID,
                phase: PHASE,
                body: "x".repeat(5000),
                author: "operator",
            }),
        ).rejects.toThrow("body-too-long");
    });

    test("rejects malformed keys (defense-in-depth on the filename)", async () => {
        await expect(
            addArtifactComment({ repo: REPO, id: "bad-id", phase: PHASE, body: "x", author: "operator" }),
        ).rejects.toThrow("invalid-id");
        await expect(
            readArtifactComments(REPO, ID, "../escape"),
        ).rejects.toThrow("invalid-phase");
    });
});
