// Route tests for the ONBOARD browser (#594): GET /onboard (filters + pagination)
// + GET /onboard/repo/:repo (memory drill-in). State-isolated fixtures.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { registerRoutes } from "../../server/routes";
import { __resetOnboardReaderCacheForTests } from "../../server/wiring/onboard-readers";
import {
    userConfigPath,
    onboardRepoMemoryDir,
    onboardQuestionsPath,
} from "../../server/wiring/state-paths";

interface Ctx {
    stateDir: string;
    configFile: string;
    prevState: string | undefined;
    prevConfig: string | undefined;
}
const ctx: Ctx = { stateDir: "", configFile: "", prevState: undefined, prevConfig: undefined };

function app(): Hono {
    const a = new Hono();
    registerRoutes(a);
    return a;
}

beforeEach(() => {
    ctx.stateDir = mkdtempSync(join(tmpdir(), "onboard-route-state-"));
    ctx.configFile = join(mkdtempSync(join(tmpdir(), "onboard-route-cfg-")), "autonomous-dev.json");
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

function seed(): void {
    writeFileSync(
        userConfigPath(),
        JSON.stringify({
            ownership: {
                org: "acme",
                projects: [{ id: "payments", name: "Payments", tags: { team: "pay" } }],
                repos: [
                    { id: "acme/orders", projectId: "payments", tags: { team: "pay" }, participate_in_auto_improvement: true },
                    { id: "acme/billing", projectId: "payments", tags: { team: "pay" } },
                    { id: "acme/site", projectId: null, tags: { team: "web" } },
                ],
            },
        }),
        "utf8",
    );
    const dir = onboardRepoMemoryDir("acme/orders");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "overview.md"), "# Overview\n\nOrders service.", "utf8");
    mkdirSync(dirname(onboardQuestionsPath()), { recursive: true });
    writeFileSync(
        onboardQuestionsPath(),
        JSON.stringify([{ id: "q1", repoId: "acme/site", question: "which project?", options: ["payments", "web"], status: "pending" }]),
        "utf8",
    );
}

describe("GET /onboard", () => {
    test("renders the browser with repos + the enrolled/blocked state", async () => {
        seed();
        const res = await app().request("/onboard");
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("acme/orders");
        expect(html).toContain("acme/site");
        expect(html).toContain("enrolled"); // orders is enrolled
        expect(html).toContain("blocked"); // site has a pending question
    });

    test("?q= filters by repo id", async () => {
        seed();
        const html = await (await app().request("/onboard?q=orders")).text();
        expect(html).toContain("acme/orders");
        expect(html).not.toContain("acme/billing");
    });

    test("?project= filters by project", async () => {
        seed();
        const html = await (await app().request("/onboard?project=payments")).text();
        expect(html).toContain("acme/orders");
        expect(html).not.toContain("acme/site"); // site is standalone
    });

    test("?tag=k=v filters by tag", async () => {
        seed();
        const html = await (await app().request("/onboard?tag=team%3Dweb")).text();
        expect(html).toContain("acme/site");
        expect(html).not.toContain("acme/orders");
    });

    test("no org → honest empty state (no fabricated rows)", async () => {
        writeFileSync(userConfigPath(), JSON.stringify({}), "utf8");
        const res = await app().request("/onboard");
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("No org linked");
    });
});

describe("GET /onboard/ingestion", () => {
    test("renders the aggregate + per-repo progress (ingested/blocked/pending)", async () => {
        seed();
        const res = await app().request("/onboard/ingestion");
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("Ingestion");
        expect(html).toContain("ingested"); // acme/orders has memory
        expect(html).toContain("blocked"); // acme/site has a pending question
        expect(html).toContain("pending"); // acme/billing: no memory, not blocked
    });

    test("no org → honest empty state", async () => {
        writeFileSync(userConfigPath(), JSON.stringify({}), "utf8");
        const html = await (await app().request("/onboard/ingestion")).text();
        expect(html).toContain("No org linked");
    });
});

describe("GET /onboard/questions", () => {
    test("renders the pending question with its options as a form", async () => {
        seed();
        const res = await app().request("/onboard/questions");
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("which project?");
        expect(html).toContain("acme/site");
        expect(html).toContain('value="payments"');
        expect(html).toContain('value="web"');
        // CSRF-carrying form posts to the answer route.
        expect(html).toContain("/onboard/questions/q1/answer");
    });

    test("no org → honest empty state", async () => {
        writeFileSync(userConfigPath(), JSON.stringify({}), "utf8");
        const html = await (await app().request("/onboard/questions")).text();
        expect(html).toContain("No org linked");
    });
});

describe("POST /onboard/questions/:id/answer", () => {
    async function post(id: string, body: string): Promise<Response> {
        return app().request(`/onboard/questions/${id}/answer`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body,
        });
    }

    test("a valid answer writes the file + returns the answered fragment", async () => {
        seed();
        const res = await post("q1", "choice=web");
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("answered");
        expect(html).toContain("web");
        // Persisted to disk.
        const after = JSON.parse(readFileSync(onboardQuestionsPath(), "utf8"));
        expect(after[0].status).toBe("answered");
        expect(after[0].answer).toBe("web");
    });

    test("a choice not in the options → 422 (no write)", async () => {
        seed();
        const res = await post("q1", "choice=bogus");
        expect(res.status).toBe(422);
        const after = JSON.parse(readFileSync(onboardQuestionsPath(), "utf8"));
        expect(after[0].status).toBe("pending");
    });

    test("a missing choice → 422", async () => {
        seed();
        expect((await post("q1", "")).status).toBe(422);
    });

    test("an unknown question id → 404", async () => {
        seed();
        expect((await post("does-not-exist", "choice=web")).status).toBe(404);
    });
});

describe("GET /onboard/repo/:repo", () => {
    test("drill-in renders the repo's memory topics", async () => {
        seed();
        const res = await app().request("/onboard/repo/acme/orders");
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("overview");
        expect(html).toContain("acme/orders");
    });

    test("a repo with no memory → honest empty fragment", async () => {
        seed();
        const html = await (await app().request("/onboard/repo/acme/billing")).text();
        expect(html).toContain("No scoped memory");
    });
});
