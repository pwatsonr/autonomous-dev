// Unit tests for the ONBOARD answer writer (#594). State-isolated (BOTH env
// vars); asserts the safety invariants: validate choice ∈ options, preserve all
// other fields/questions, refuse shape-mismatch / already-answered / corrupt.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { answerQuestion, setEnrollment } from "../../server/wiring/onboard-writers";
import { onboardQuestionsPath, userConfigPath } from "../../server/wiring/state-paths";

interface Ctx {
    stateDir: string;
    configFile: string;
    prevState: string | undefined;
    prevConfig: string | undefined;
}
const ctx: Ctx = { stateDir: "", configFile: "", prevState: undefined, prevConfig: undefined };

beforeEach(() => {
    ctx.stateDir = mkdtempSync(join(tmpdir(), "onboard-writer-state-"));
    ctx.configFile = join(mkdtempSync(join(tmpdir(), "onboard-writer-cfg-")), "autonomous-dev.json");
    ctx.prevState = process.env["AUTONOMOUS_DEV_STATE_DIR"];
    ctx.prevConfig = process.env["AUTONOMOUS_DEV_USER_CONFIG"];
    process.env["AUTONOMOUS_DEV_STATE_DIR"] = ctx.stateDir;
    process.env["AUTONOMOUS_DEV_USER_CONFIG"] = ctx.configFile;
});

afterEach(() => {
    if (ctx.prevState === undefined) delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
    else process.env["AUTONOMOUS_DEV_STATE_DIR"] = ctx.prevState;
    if (ctx.prevConfig === undefined) delete process.env["AUTONOMOUS_DEV_USER_CONFIG"];
    else process.env["AUTONOMOUS_DEV_USER_CONFIG"] = ctx.prevConfig;
    rmSync(ctx.stateDir, { recursive: true, force: true });
    rmSync(dirname(ctx.configFile), { recursive: true, force: true });
});

function seedQuestions(questions: unknown[]): void {
    const p = onboardQuestionsPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(questions), "utf8");
}

function readBack(): any[] {
    return JSON.parse(readFileSync(onboardQuestionsPath(), "utf8"));
}

describe("answerQuestion", () => {
    test("a valid answer writes status:answered + answer, preserving other fields", async () => {
        seedQuestions([
            {
                id: "q1",
                repoId: "acme/site",
                question: "which project?",
                options: ["payments", "web"],
                status: "pending",
                // a daemon-side field the portal doesn't model — MUST survive.
                createdAt: "2026-06-20T00:00:00Z",
                signals: { score: 3 },
            },
        ]);
        const res = await answerQuestion("q1", "web");
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.question.repoId).toBe("acme/site");

        const after = readBack();
        expect(after).toHaveLength(1);
        expect(after[0].status).toBe("answered");
        expect(after[0].answer).toBe("web");
        // Untouched daemon-side fields preserved byte-for-byte.
        expect(after[0].createdAt).toBe("2026-06-20T00:00:00Z");
        expect(after[0].signals).toEqual({ score: 3 });
    });

    test("preserves OTHER questions in the file", async () => {
        seedQuestions([
            { id: "q1", repoId: "a/x", question: "?", options: ["1", "2"], status: "pending" },
            { id: "q2", repoId: "a/y", question: "?", options: ["3", "4"], status: "pending" },
        ]);
        await answerQuestion("q1", "1");
        const after = readBack();
        expect(after).toHaveLength(2);
        expect(after.find((q) => q.id === "q1").status).toBe("answered");
        // q2 untouched.
        expect(after.find((q) => q.id === "q2").status).toBe("pending");
        expect(after.find((q) => q.id === "q2").answer).toBeUndefined();
    });

    test("rejects a choice that isn't one of the options (no write)", async () => {
        seedQuestions([{ id: "q1", repoId: "a/x", question: "?", options: ["1", "2"], status: "pending" }]);
        const res = await answerQuestion("q1", "99");
        expect(res).toEqual({ ok: false, reason: "invalid-choice" });
        expect(readBack()[0].status).toBe("pending"); // unchanged
    });

    test("unknown id → unknown", async () => {
        seedQuestions([{ id: "q1", repoId: "a/x", question: "?", options: ["1"], status: "pending" }]);
        expect(await answerQuestion("nope", "1")).toEqual({ ok: false, reason: "unknown" });
    });

    test("no questions file → unknown (not a crash)", async () => {
        expect(await answerQuestion("q1", "1")).toEqual({ ok: false, reason: "unknown" });
    });

    test("shape-mismatched options → not-answerable (no write)", async () => {
        seedQuestions([{ id: "q1", repoId: "a/x", question: "?", options: "not-an-array", status: "pending" }]);
        expect(await answerQuestion("q1", "1")).toEqual({ ok: false, reason: "not-answerable" });
        expect(readBack()[0].options).toBe("not-an-array"); // untouched
    });

    test("already-answered question → not-answerable (no clobber of recorded answer)", async () => {
        seedQuestions([
            { id: "q1", repoId: "a/x", question: "?", options: ["1", "2"], status: "answered", answer: "1" },
        ]);
        expect(await answerQuestion("q1", "2")).toEqual({ ok: false, reason: "not-answerable" });
        expect(readBack()[0].answer).toBe("1"); // original answer preserved
    });

    test("corrupt (unparseable) questions file → io (refuses to clobber)", async () => {
        const p = onboardQuestionsPath();
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, "{ not json", "utf8");
        expect(await answerQuestion("q1", "1")).toEqual({ ok: false, reason: "io" });
        // The corrupt file is left exactly as-is (not overwritten).
        expect(readFileSync(p, "utf8")).toBe("{ not json");
    });
});

function seedManifest(manifest: unknown): void {
    const p = userConfigPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(manifest), "utf8");
}

function readManifest(): any {
    return JSON.parse(readFileSync(userConfigPath(), "utf8"));
}

describe("setEnrollment", () => {
    test("enrolls a not-enrolled repo (participate flag = true on disk)", async () => {
        seedManifest({
            ownership: { org: "acme", projects: [], repos: [{ id: "acme/x", projectId: null, tags: {} }] },
        });
        const res = await setEnrollment("acme/x", true);
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.repo.enrolled).toBe(true);
        expect(readManifest().ownership.repos[0].participate_in_auto_improvement).toBe(true);
    });

    test("unenrolls an enrolled repo (participate flag = false on disk)", async () => {
        seedManifest({
            ownership: {
                org: "acme",
                projects: [],
                repos: [{ id: "acme/x", projectId: null, tags: {}, participate_in_auto_improvement: true }],
            },
        });
        const res = await setEnrollment("acme/x", false);
        expect(res.ok).toBe(true);
        expect(readManifest().ownership.repos[0].participate_in_auto_improvement).toBe(false);
    });

    test("preserves OTHER top-level keys, OTHER repos, and extra fields on the toggled repo", async () => {
        seedManifest({
            schemaVersion: 7,
            settings: { trust: "high" },
            ownership: {
                org: "acme",
                projects: [{ id: "p1", name: "P1", tags: {} }],
                repos: [
                    { id: "acme/x", projectId: "p1", tags: { team: "a" }, note: "keep-me" },
                    { id: "acme/y", projectId: null, tags: {}, participate_in_auto_improvement: true },
                ],
            },
        });
        await setEnrollment("acme/x", true);
        const after = readManifest();
        // Other top-level keys intact.
        expect(after.schemaVersion).toBe(7);
        expect(after.settings).toEqual({ trust: "high" });
        // Project list intact.
        expect(after.ownership.projects).toEqual([{ id: "p1", name: "P1", tags: {} }]);
        // Toggled repo: flag set, extra field + tags preserved.
        const x = after.ownership.repos.find((r: any) => r.id === "acme/x");
        expect(x.participate_in_auto_improvement).toBe(true);
        expect(x.note).toBe("keep-me");
        expect(x.tags).toEqual({ team: "a" });
        // Other repo untouched.
        const y = after.ownership.repos.find((r: any) => r.id === "acme/y");
        expect(y.participate_in_auto_improvement).toBe(true);
    });

    test("unknown repo id → unknown (no write)", async () => {
        seedManifest({ ownership: { org: "acme", projects: [], repos: [{ id: "acme/x", projectId: null, tags: {} }] } });
        expect(await setEnrollment("acme/nope", true)).toEqual({ ok: false, reason: "unknown" });
        // file unchanged: repo still has no flag
        expect(readManifest().ownership.repos[0].participate_in_auto_improvement).toBeUndefined();
    });

    test("no manifest file → unknown", async () => {
        expect(await setEnrollment("acme/x", true)).toEqual({ ok: false, reason: "unknown" });
    });

    test("refuses a manifest whose ownership is not an object (corrupt, no write)", async () => {
        seedManifest({ ownership: "nope" });
        expect(await setEnrollment("acme/x", true)).toEqual({ ok: false, reason: "corrupt" });
        expect(readManifest().ownership).toBe("nope"); // untouched
    });

    test("refuses a manifest whose repos is not an array (corrupt, no write)", async () => {
        seedManifest({ ownership: { org: "acme", projects: [], repos: { not: "array" } } });
        expect(await setEnrollment("acme/x", true)).toEqual({ ok: false, reason: "corrupt" });
    });

    test("refuses an unparseable manifest file (corrupt, leaves it as-is)", async () => {
        const p = userConfigPath();
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, "{ broken", "utf8");
        expect(await setEnrollment("acme/x", true)).toEqual({ ok: false, reason: "corrupt" });
        expect(readFileSync(p, "utf8")).toBe("{ broken");
    });
});
