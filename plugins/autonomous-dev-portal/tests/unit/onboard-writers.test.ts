// Unit tests for the ONBOARD answer writer (#594). State-isolated (BOTH env
// vars); asserts the safety invariants: validate choice ∈ options, preserve all
// other fields/questions, refuse shape-mismatch / already-answered / corrupt.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { answerQuestion } from "../../server/wiring/onboard-writers";
import { onboardQuestionsPath } from "../../server/wiring/state-paths";

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
