// PLAN-038 TASK-010 + TASK-011 — atomic + composition reader tests.
//
// Verifies:
//   - readRequestLedger aggregates request-actions/ correctly (9 entries
//     in kit-parity matches kit "Active 9 across 6 repos")
//   - readRepoAggregates produces 6 repos with non-zero MTD
//   - readAgentStates picks up frozen/shadowed from agent-states.json
//     and defaults the rest to "baseline"
//   - readDashboardData / readAgentsData / readReposData emit empty
//     view-input shapes when state-dir is empty (honesty contract)

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readAgentStates } from "../../server/wiring/agent-states-reader";
import { readAgentsData } from "../../server/wiring/agents-readers";
import { readDashboardData } from "../../server/wiring/dashboard-readers";
import {
    kitParityFixtureRoot,
} from "../../server/wiring/state-paths";
import { readRepoAggregates } from "../../server/wiring/repo-aggregation-reader";
import { readReposData } from "../../server/wiring/repos-readers";
import { readRequestLedger } from "../../server/wiring/request-ledger-reader";

const FIXTURE_ROOT = kitParityFixtureRoot();
const FIXTURE_ACTIONS = join(FIXTURE_ROOT, "request-actions");
const FIXTURE_DECISIONS = join(FIXTURE_ROOT, "gate-decisions");

describe("readRequestLedger — kit-parity fixtures", () => {
    test("aggregates the 9 fixture requests", async () => {
        const requests = await readRequestLedger({
            actionsDir: FIXTURE_ACTIONS,
            decisionsDir: FIXTURE_DECISIONS,
        });
        expect(requests.length).toBe(9);
        // All requests have a non-empty id and repo.
        for (const r of requests) {
            expect(r.id).toMatch(/^REQ-\d+/);
            expect(r.repo.length).toBeGreaterThan(0);
        }
    });

    test("preserves status from action files", async () => {
        const requests = await readRequestLedger({
            actionsDir: FIXTURE_ACTIONS,
            decisionsDir: FIXTURE_DECISIONS,
        });
        const gates = requests.filter((r) => r.status === "gate");
        // REQ-100002 and REQ-100003 have status=gate in the fixture set.
        expect(gates.length).toBe(2);
    });
});

describe("readRepoAggregates — kit-parity fixtures", () => {
    test("emits 6 distinct repos from the fixture allowlist", async () => {
        const { byRepo } = await readRepoAggregates({
            actionsDir: FIXTURE_ACTIONS,
            decisionsDir: FIXTURE_DECISIONS,
            allowlistRepos: [
                "my-app",
                "critical-service",
                "docs-site",
                "homelab-api",
                "sentry-watch",
                "profile-svc",
            ],
        });
        expect(byRepo.size).toBe(6);
        // my-app has REQ-100001 (running) and REQ-100008 (running) → 2 active.
        const myApp = byRepo.get("my-app");
        expect(myApp?.activeRequests).toBe(2);
        // critical-service has REQ-100002 (gate) and REQ-100003 (gate).
        const critical = byRepo.get("critical-service");
        expect(critical?.attentionCount).toBe(2);
    });
});

describe("readAgentStates — kit-parity fixtures", () => {
    test("returns the canonical agent set with frozen/shadowed overlay", async () => {
        const agents = await readAgentStates({
            statesPath: join(FIXTURE_ROOT, "agent-states.json"),
        });
        expect(agents.length).toBeGreaterThan(0);
        // Fixture marks security-reviewer + deploy-executor as frozen.
        const securityReviewer = agents.find((a) => a.name === "security-reviewer");
        expect(securityReviewer?.status).toBe("frozen");
        // Fixture marks code-executor as shadowed.
        const codeExecutor = agents.find((a) => a.name === "code-executor");
        expect(codeExecutor?.status).toBe("shadow");
        // Any other agent defaults to baseline.
        const planAuthor = agents.find((a) => a.name === "plan-author");
        expect(planAuthor?.status).toBe("baseline");
    });

    test("untracked fields render as null (daemon doesn't track them)", async () => {
        const agents = await readAgentStates({
            statesPath: join(FIXTURE_ROOT, "agent-states.json"),
        });
        for (const a of agents) {
            expect(a.runs30d).toBeNull();
            expect(a.fpRate).toBeNull();
            expect(a.lastDispatchAt).toBeNull();
        }
    });
});

// ---------- Empty-state honesty contract ----------

describe("Honesty contract — empty state dir produces zero KPIs", () => {
    let emptyDir: string;
    beforeAll(() => {
        emptyDir = mkdtempSync(join(tmpdir(), "PLAN-038-empty-"));
    });
    afterAll(() => {
        rmSync(emptyDir, { recursive: true, force: true });
    });

    test("readDashboardData against empty state-dir returns honest zeros", async () => {
        const data = await readDashboardData({
            actionsDir: join(emptyDir, "request-actions"),
            decisionsDir: join(emptyDir, "gate-decisions"),
            stateRoot: emptyDir,
        });
        expect(data.repos.length).toBe(0);
        expect(data.requests?.length ?? 0).toBe(0);
    });

    test("readAgentsData against empty state-dir returns the manifest set with all baseline", async () => {
        // Force an empty agent-states.json file so the overlay yields no
        // frozen / shadowed entries. The manifest scan still runs and
        // produces the canonical agent list.
        const stateFile = join(emptyDir, "agent-states.json");
        writeFileSync(stateFile, "{}", "utf-8");
        const data = await readAgentsData({ statesPath: stateFile });
        expect(data.kpis.frozenCount).toBe(0);
        expect(data.kpis.shadowCount).toBe(0);
        for (const a of data.agents) {
            expect(a.status).toBe("baseline");
        }
    });

    test("readReposData against empty state-dir returns zero repos", async () => {
        const data = await readReposData({
            actionsDir: join(emptyDir, "request-actions"),
            decisionsDir: join(emptyDir, "gate-decisions"),
            stateRoot: emptyDir,
        });
        expect(data.kpis.totalRepos).toBe(0);
        expect(data.kpis.activeRepos).toBe(0);
        expect(data.repos.length).toBe(0);
    });
});
