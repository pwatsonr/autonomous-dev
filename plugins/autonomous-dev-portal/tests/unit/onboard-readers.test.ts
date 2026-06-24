// Unit tests for `server/wiring/onboard-readers.ts` (ONBOARD Phase 3, #594).
//
// State isolation: each test points AUTONOMOUS_DEV_STATE_DIR + AUTONOMOUS_DEV_USER_CONFIG
// at fresh tmpdirs (BOTH — the 2026-06-12 wipe came from isolating only one) and
// resets the module cache.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
    __resetOnboardReaderCacheForTests,
    readOnboardOwnership,
    readOnboardQuestions,
    readOnboardProposalsPending,
    readRepoMemoryTopics,
    readIngestionStatus,
} from "../../server/wiring/onboard-readers";
import {
    userConfigPath,
    onboardRepoMemoryDir,
    onboardQuestionsPath,
    onboardProposalsPath,
} from "../../server/wiring/state-paths";

interface Ctx {
    stateDir: string;
    configFile: string;
    prevState: string | undefined;
    prevConfig: string | undefined;
}
const ctx: Ctx = { stateDir: "", configFile: "", prevState: undefined, prevConfig: undefined };

beforeEach(() => {
    ctx.stateDir = mkdtempSync(join(tmpdir(), "onboard-state-"));
    ctx.configFile = join(mkdtempSync(join(tmpdir(), "onboard-cfg-")), "autonomous-dev.json");
    ctx.prevState = process.env["AUTONOMOUS_DEV_STATE_DIR"];
    ctx.prevConfig = process.env["AUTONOMOUS_DEV_USER_CONFIG"];
    process.env["AUTONOMOUS_DEV_STATE_DIR"] = ctx.stateDir;
    process.env["AUTONOMOUS_DEV_USER_CONFIG"] = ctx.configFile;
    __resetOnboardReaderCacheForTests();
});

afterEach(() => {
    if (ctx.prevState === undefined) delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
    else process.env["AUTONOMOUS_DEV_STATE_DIR"] = ctx.prevState;
    if (ctx.prevConfig === undefined) delete process.env["AUTONOMOUS_DEV_USER_CONFIG"];
    else process.env["AUTONOMOUS_DEV_USER_CONFIG"] = ctx.prevConfig;
    rmSync(ctx.stateDir, { recursive: true, force: true });
    rmSync(dirname(ctx.configFile), { recursive: true, force: true });
});

function seedOwnership(ownership: unknown): void {
    writeFileSync(userConfigPath(), JSON.stringify({ repositories: { allowlist: [] }, ownership }), "utf8");
}
function seedQuestions(qs: unknown): void {
    mkdirSync(dirname(onboardQuestionsPath()), { recursive: true });
    writeFileSync(onboardQuestionsPath(), JSON.stringify(qs), "utf8");
}
function seedProposals(ps: unknown): void {
    mkdirSync(dirname(onboardProposalsPath()), { recursive: true });
    writeFileSync(onboardProposalsPath(), JSON.stringify(ps), "utf8");
}
function seedMemory(repoId: string, topic: string, content: string): void {
    const dir = onboardRepoMemoryDir(repoId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${topic}.md`), content, "utf8");
}

describe("onboard-readers / ownership", () => {
    test("missing config → empty ownership (never throws)", async () => {
        const own = await readOnboardOwnership();
        expect(own).toEqual({ org: null, projects: [], repos: [] });
    });

    test("parses projects + repos; enrolled is === true ONLY", async () => {
        seedOwnership({
            org: "acme",
            projects: [{ id: "payments", name: "Payments", tags: { team: "pay" } }],
            repos: [
                { id: "acme/orders", projectId: "payments", tags: {}, participate_in_auto_improvement: true },
                { id: "acme/billing", projectId: "payments", tags: {}, participate_in_auto_improvement: false },
                { id: "acme/site", projectId: null, tags: {}, participate_in_auto_improvement: "true" },
            ],
        });
        const own = await readOnboardOwnership();
        expect(own.org).toBe("acme");
        expect(own.projects.length).toBe(1);
        expect(own.repos.length).toBe(3);
        expect(own.repos.find((r) => r.id === "acme/orders")?.enrolled).toBe(true);
        expect(own.repos.find((r) => r.id === "acme/billing")?.enrolled).toBe(false);
        // a STRING "true" must NOT enroll (=== true only)
        expect(own.repos.find((r) => r.id === "acme/site")?.enrolled).toBe(false);
    });

    test("malformed ownership (not an object) → empty", async () => {
        seedOwnership("nope");
        expect((await readOnboardOwnership()).repos).toEqual([]);
        __resetOnboardReaderCacheForTests();
        seedOwnership({ repos: "notarray", projects: 42 });
        const own = await readOnboardOwnership();
        expect(own.repos).toEqual([]);
        expect(own.projects).toEqual([]);
    });

    test("corrupt manifest JSON → empty (never throws)", async () => {
        writeFileSync(userConfigPath(), "{ broken", "utf8");
        expect((await readOnboardOwnership()).org).toBeNull();
    });
});

describe("onboard-readers / questions", () => {
    test("missing → []; valid pending + answered; bad options → read-only", async () => {
        expect(await readOnboardQuestions()).toEqual([]);
        __resetOnboardReaderCacheForTests();
        seedQuestions([
            { id: "q1", repoId: "acme/a", question: "which?", options: ["x", "y"], status: "pending" },
            { id: "q2", repoId: "acme/b", question: "?", options: ["a"], status: "answered", answer: "a" },
            { id: "q3", repoId: "acme/c", question: "?", options: "not-array", status: "pending" },
            { repoId: "acme/d", question: "no id" }, // skipped
        ]);
        const qs = await readOnboardQuestions();
        expect(qs.length).toBe(3);
        expect(qs.find((q) => q.id === "q1")?.optionsValid).toBe(true);
        expect(qs.find((q) => q.id === "q2")?.answer).toBe("a");
        const q3 = qs.find((q) => q.id === "q3");
        expect(q3?.optionsValid).toBe(false);
        expect(q3?.options).toEqual([]);
    });
});

describe("onboard-readers / proposals + memory", () => {
    test("proposalsPending counts meta_approved only", async () => {
        seedProposals([
            { id: "a", status: "meta_approved" },
            { id: "b", status: "meta_rejected" },
            { id: "c", status: "meta_approved" },
            { id: "d", status: "promoted" },
        ]);
        expect(await readOnboardProposalsPending()).toBe(2);
    });

    test("memory topics: summary = first non-empty line; missing/traversal → []", async () => {
        seedMemory("acme/api", "overview", "# Overview\n\nThe orders service.");
        seedMemory("acme/api", "ownership", "# Ownership\n\n@acme/pay");
        const topics = await readRepoMemoryTopics("acme/api");
        expect(topics.map((t) => t.topic).sort()).toEqual(["overview", "ownership"]);
        expect(topics.find((t) => t.topic === "overview")?.summary).toBe("# Overview");
        expect(await readRepoMemoryTopics("acme/missing")).toEqual([]);
        expect(await readRepoMemoryTopics("../../etc")).toEqual([]); // traversal guarded
    });
});

describe("onboard-readers / ingestion status", () => {
    test("aggregate is correct", async () => {
        seedOwnership({
            org: "acme",
            projects: [],
            repos: [
                { id: "acme/a", projectId: null, tags: {} },
                { id: "acme/b", projectId: null, tags: {} },
                { id: "acme/c", projectId: null, tags: {} },
            ],
        });
        seedMemory("acme/a", "overview", "# A");
        seedMemory("acme/b", "overview", "# B");
        seedQuestions([{ id: "q1", repoId: "acme/c", question: "?", options: ["x"], status: "pending" }]);
        seedProposals([{ id: "p", status: "meta_approved" }]);

        const s = await readIngestionStatus();
        expect(s.reposTotal).toBe(3);
        expect(s.reposWithMemory).toBe(2);
        expect(s.reposBlocked).toBe(1); // acme/c has a pending question
        expect(s.questionsPending).toBe(1);
        expect(s.proposalsPending).toBe(1);
    });
});

describe("onboard-readers / cache", () => {
    test("same-tick reads hit cache; >5s refreshes", async () => {
        seedOwnership({ org: "one", projects: [], repos: [] });
        const a = await readOnboardOwnership(() => 1000);
        expect(a.org).toBe("one");
        seedOwnership({ org: "two", projects: [], repos: [] });
        const b = await readOnboardOwnership(() => 1000); // same tick → cached
        expect(b.org).toBe("one");
        const c = await readOnboardOwnership(() => 7000); // >5s → refresh
        expect(c.org).toBe("two");
    });
});
