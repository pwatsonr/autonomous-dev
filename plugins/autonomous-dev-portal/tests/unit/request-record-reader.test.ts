import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadRequestRecord } from "../../server/wiring/request-record-reader";

describe("loadRequestRecord", () => {
    let tmpStateDir: string;
    let tmpHomeDir: string;
    let tmpRepo: string;
    let repoBasename: string;

    beforeEach(async () => {
        // Create temp directories
        tmpStateDir = join(tmpdir(), `portal-test-${Date.now()}-${Math.random().toString(36).substring(2)}`);
        tmpHomeDir = join(tmpStateDir, "home");
        tmpRepo = join(tmpStateDir, "repos", "test-repo");
        repoBasename = "test-repo";

        await mkdir(tmpStateDir, { recursive: true });
        await mkdir(tmpHomeDir, { recursive: true });
        await mkdir(tmpRepo, { recursive: true });

        // Set environment variables
        process.env.AUTONOMOUS_DEV_STATE_DIR = tmpStateDir;
        process.env.HOME = tmpHomeDir;
        process.env.AUTONOMOUS_DEV_USER_CONFIG = join(tmpHomeDir, ".claude", "autonomous-dev.json");
    });

    afterEach(async () => {
        // Clean up
        delete process.env.AUTONOMOUS_DEV_STATE_DIR;
        delete process.env.HOME;
        delete process.env.AUTONOMOUS_DEV_USER_CONFIG;

        try {
            await rm(tmpStateDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    test("returns RequestRecord with real data from request-action and state.json", async () => {
        // Create daemon config
        const daemonConfigPath = join(tmpHomeDir, ".claude", "autonomous-dev.json");
        await mkdir(join(tmpHomeDir, ".claude"), { recursive: true });
        await writeFile(daemonConfigPath, JSON.stringify({
            repositories: {
                allowlist: [{ id: repoBasename, path: tmpRepo }]
            }
        }));

        // Create request-action
        const requestActionsDir = join(tmpStateDir, "request-actions");
        await mkdir(requestActionsDir, { recursive: true });
        await writeFile(join(requestActionsDir, "REQ-000099.json"), JSON.stringify({
            id: "REQ-000099",
            repo: repoBasename,
            title: "Test Request",
            phase: "code",
            status: "running",
            cost: 1.23,
            variant: "standard",
            createdAt: "2026-05-11T10:00:00Z",
            turns: 5,
            waitedMin: 10
        }));

        // Create daemon state.json
        const reqStateDir = join(tmpRepo, ".autonomous-dev", "requests", "REQ-000099");
        await mkdir(reqStateDir, { recursive: true });
        await writeFile(join(reqStateDir, "state.json"), JSON.stringify({
            id: "REQ-000099",
            status: "running",
            current_phase: "review",
            title: "Test Request from State",
            description: "A test request",
            target_repo: tmpRepo,
            type: "feature",
            phase_history: [
                {
                    phase: "prd",
                    status: "completed",
                    completed_at: "2026-05-11T10:05:00Z",
                    artifacts: [
                        {
                            kind: "prd",
                            path: ".autonomous-dev/requests/REQ-000099/prd.md",
                            title: "PRD Document"
                        }
                    ]
                },
                {
                    phase: "code_review",
                    status: "failed",
                    completed_at: "2026-05-11T10:15:00Z",
                    artifacts: []
                }
            ],
            current_phase_metadata: {},
            cost_accrued_usd: 2.45,
            created_at: "2026-05-11T10:00:00Z",
            updated_at: "2026-05-11T10:15:00Z",
            turn_count: 7
        }));

        // Create PRD artifact
        await writeFile(join(tmpRepo, ".autonomous-dev", "requests", "REQ-000099", "prd.md"),
            "# Product Requirements\n\nThis is a test PRD document.");

        const result = await loadRequestRecord(repoBasename, "REQ-000099");

        expect(result).toBeDefined();
        expect(result!.id).toBe("REQ-000099");
        expect(result!.repo).toBe(repoBasename);
        expect(result!.summary).toBe("Test Request from State"); // Daemon state wins over action
        expect(result!.currentPhase).toBe("review"); // From daemon state
        expect(result!.status).toBe("running");
        expect(result!.cost).toBe(2.45); // Daemon cost wins over action cost
        expect(result!.turns).toBe(7); // From daemon state
        expect(result!.startedAt).toBe("2026-05-11T10:00:00Z");

        // Check runs built from phase_history
        expect(result!.runs).toHaveLength(2);
        expect(result!.runs![0].phase).toBe("prd");
        expect(result!.runs![0].outcome).toBe("pass");
        expect(result!.runs![1].phase).toBe("code_review");
        expect(result!.runs![1].outcome).toBe("fail");

        // Check reviewers built from _review phases
        expect(result!.reviewers).toHaveLength(1);
        expect(result!.reviewers![0].name).toBe("code_review-agent");
        expect(result!.reviewers![0].blocking).toBe(true); // Failed review

        // Check PRD artifact was read
        expect(result!.currentArtifact).toBeDefined();
        expect(result!.currentArtifact!.phase).toBe("prd");
        expect(result!.currentArtifact!.format).toBe("markdown");
        expect(result!.currentArtifact!.content).toContain("This is a test PRD document");
    });

    test("falls back to stub for known stub data", async () => {
        // No request-action file, should fall back to stub
        const result = await loadRequestRecord("acme", "REQ-000001");

        // Should get the stub data
        expect(result).toBeDefined();
        expect(result!.id).toBe("REQ-000001");
        expect(result!.repo).toBe("acme");
        expect(result!.summary).toBe("Add login retry policy"); // From stub
    });

    test("returns null for totally unknown request", async () => {
        const result = await loadRequestRecord("unknown-repo", "REQ-999999");
        expect(result).toBeNull();
    });

    test("builds minimal record when request-action exists but state.json is missing", async () => {
        // Create request-action only
        const requestActionsDir = join(tmpStateDir, "request-actions");
        await mkdir(requestActionsDir, { recursive: true });
        await writeFile(join(requestActionsDir, "REQ-000098.json"), JSON.stringify({
            id: "REQ-000098",
            repo: "some-repo",
            title: "Minimal Test",
            phase: "planning",
            status: "queued",
            cost: 0.5
        }));

        const result = await loadRequestRecord("some-repo", "REQ-000098");

        expect(result).toBeDefined();
        expect(result!.id).toBe("REQ-000098");
        expect(result!.repo).toBe("some-repo");
        expect(result!.summary).toBe("Minimal Test");
        expect(result!.currentPhase).toBe("planning");
        expect(result!.status).toBe("queued");
        expect(result!.cost).toBe(0.5);

        // Should have empty arrays for missing data
        expect(result!.runs).toEqual([]);
        expect(result!.reviewers).toEqual([]);
        expect(result!.currentArtifact).toBeUndefined();
    });

    test("handles missing daemon config gracefully", async () => {
        // Create request-action
        const requestActionsDir = join(tmpStateDir, "request-actions");
        await mkdir(requestActionsDir, { recursive: true });
        await writeFile(join(requestActionsDir, "REQ-000097.json"), JSON.stringify({
            id: "REQ-000097",
            repo: "no-config-repo",
            title: "No Config Test",
            status: "running"
        }));

        // No daemon config file created
        const result = await loadRequestRecord("no-config-repo", "REQ-000097");

        expect(result).toBeDefined();
        expect(result!.id).toBe("REQ-000097");
        expect(result!.summary).toBe("No Config Test");
        // Should still work, just without state.json data
    });

    test("handles corrupt JSON files gracefully", async () => {
        // Create corrupt request-action file
        const requestActionsDir = join(tmpStateDir, "request-actions");
        await mkdir(requestActionsDir, { recursive: true });
        await writeFile(join(requestActionsDir, "REQ-000096.json"), "{ invalid json }");

        const result = await loadRequestRecord("corrupt-repo", "REQ-000096");

        // Should fall back to stub (which will return null for unknown repo/id)
        expect(result).toBeNull();
    });
});