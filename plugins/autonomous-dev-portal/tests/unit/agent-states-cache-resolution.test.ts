// #394 regression — the agent-manifest directory must resolve in the
// INSTALLED plugin-cache layout (versioned dirs), not just the repo
// checkout; and lifecycle-overlay agents (frozen/shadowed) must surface
// even when the manifest scan finds nothing.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    readAgentStates,
    resolveManifestDir,
} from "../../server/wiring/agent-states-reader";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agents394-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeCache(versions: Record<string, string[]>): string {
    const root = join(dir, "cache");
    for (const [v, agents] of Object.entries(versions)) {
        const agentsDir = join(root, v, "agents");
        mkdirSync(agentsDir, { recursive: true });
        for (const name of agents) {
            writeFileSync(
                join(agentsDir, `${name}.md`),
                `---\nname: ${name}\nversion: "1.0.0"\n---\nbody`,
            );
        }
    }
    return root;
}

describe("resolveManifestDir (#394)", () => {
    test("repo layout missing → resolves the HIGHEST cache version with agents/", async () => {
        const cacheRoot = makeCache({
            "0.3.9": ["old-agent"],
            "0.3.11": ["code-executor", "qa-reviewer"],
        });
        const resolved = await resolveManifestDir(cacheRoot, join(dir, "no-repo"));
        expect(resolved).toBe(join(cacheRoot, "0.3.11", "agents"));
    });

    test("no repo layout and no cache → null (reader degrades, not throws)", async () => {
        const resolved = await resolveManifestDir(join(dir, "no-cache"), join(dir, "no-repo"));
        expect(resolved).toBeNull();
    });
});

describe("readAgentStates installed-layout behavior (#394)", () => {
    test("agents load from the cache manifest dir with state overlay applied", async () => {
        const cacheRoot = makeCache({ "0.3.11": ["code-executor", "qa-reviewer"] });
        const statesPath = join(dir, "agent-states.json");
        writeFileSync(statesPath, JSON.stringify({ shadowed: ["code-executor"], frozen: [] }));
        const rows = await readAgentStates({
            manifestDir: join(cacheRoot, "0.3.11", "agents"),
            statesPath,
        });
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.name === "code-executor")!.status).toBe("shadow");
        expect(rows.find((r) => r.name === "qa-reviewer")!.status).toBe("baseline");
    });

    test("state-only agents surface even when the manifest scan is empty", async () => {
        const emptyDir = join(dir, "empty-agents");
        mkdirSync(emptyDir, { recursive: true });
        const statesPath = join(dir, "agent-states.json");
        writeFileSync(statesPath, JSON.stringify({ shadowed: ["code-executor"], frozen: ["a11y-reviewer"] }));
        const rows = await readAgentStates({ manifestDir: emptyDir, statesPath });
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.name === "code-executor")!.status).toBe("shadow");
        expect(rows.find((r) => r.name === "a11y-reviewer")!.status).toBe("frozen");
    });
});
