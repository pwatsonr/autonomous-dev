// #499 / #501 / #502 — request-record reader: artifact aggregation from
// phase-result-<phase>.json, PR-URL surfacing, summary synthesis, and the
// per-phase artifact-body loader used by the artifact-pane endpoint.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    loadRequestRecord,
    loadArtifactForPhase,
} from "../../server/wiring/request-record-reader";

describe("request artifacts reader (#499/#501/#502)", () => {
    let tmpStateDir: string;
    let tmpHomeDir: string;
    let tmpRepo: string;
    const repoBasename = "art-repo";
    const id = "REQ-000500";

    async function writePhaseResult(
        phase: string,
        body: Record<string, unknown>,
    ): Promise<void> {
        const dir = join(tmpRepo, ".autonomous-dev", "requests", id);
        await mkdir(dir, { recursive: true });
        await writeFile(
            join(dir, `phase-result-${phase}.json`),
            JSON.stringify(body),
        );
    }

    beforeEach(async () => {
        tmpStateDir = join(
            tmpdir(),
            `portal-art-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        tmpHomeDir = join(tmpStateDir, "home");
        tmpRepo = join(tmpStateDir, "repos", repoBasename);
        await mkdir(tmpStateDir, { recursive: true });
        await mkdir(join(tmpHomeDir, ".claude"), { recursive: true });
        await mkdir(tmpRepo, { recursive: true });

        process.env.AUTONOMOUS_DEV_STATE_DIR = tmpStateDir;
        process.env.HOME = tmpHomeDir;
        process.env.AUTONOMOUS_DEV_USER_CONFIG = join(
            tmpHomeDir,
            ".claude",
            "autonomous-dev.json",
        );

        // daemon config maps the repo slug → path
        await writeFile(
            process.env.AUTONOMOUS_DEV_USER_CONFIG,
            JSON.stringify({
                repositories: {
                    // The REAL daemon config stores the allowlist as path
                    // STRINGS. Using the object {id,path} form here previously
                    // masked a resolveRepoPath bug (string entries → null →
                    // whole request-detail view empty). Primary entry is a
                    // string (real format); a legacy object entry covers the
                    // tolerated fallback path.
                    allowlist: [tmpRepo, { id: "legacy", path: "/legacy/repo" }],
                },
            }),
        );

        // request-action (tier-1 entry point)
        const actionsDir = join(tmpStateDir, "request-actions");
        await mkdir(actionsDir, { recursive: true });
        await writeFile(
            join(actionsDir, `${id}.json`),
            JSON.stringify({
                id,
                repo: repoBasename,
                title: "Add a login retry policy",
                phase: "code",
                status: "running",
                createdAt: "2026-06-01T10:00:00Z",
            }),
        );
    });

    afterEach(async () => {
        delete process.env.AUTONOMOUS_DEV_STATE_DIR;
        delete process.env.HOME;
        delete process.env.AUTONOMOUS_DEV_USER_CONFIG;
        await rm(tmpStateDir, { recursive: true, force: true }).catch(() => {});
    });

    async function seedRichRequest(): Promise<void> {
        // state.json with current_phase = code and a phase history.
        const dir = join(tmpRepo, ".autonomous-dev", "requests", id);
        await mkdir(dir, { recursive: true });
        await writeFile(
            join(dir, "state.json"),
            JSON.stringify({
                id,
                status: "running",
                current_phase: "code",
                title: "Add a login retry policy",
                target_repo: tmpRepo,
                phase_history: [
                    { phase: "prd", status: "completed", completed_at: "2026-06-01T10:05:00Z" },
                    { phase: "tdd", status: "completed", completed_at: "2026-06-01T10:20:00Z" },
                    { phase: "code", status: "completed", completed_at: "2026-06-01T11:00:00Z" },
                ],
                cost_accrued_usd: 3.5,
                created_at: "2026-06-01T10:00:00Z",
            }),
        );

        // docs on disk
        await mkdir(join(tmpRepo, "docs", "prd"), { recursive: true });
        await mkdir(join(tmpRepo, "docs", "tdd"), { recursive: true });
        await writeFile(
            join(tmpRepo, "docs", "prd", "req-000500-login-retry.md"),
            "# PRD: Login retry\n\nUsers should be able to retry login.",
        );
        await writeFile(
            join(tmpRepo, "docs", "tdd", "req-000500-login-retry.md"),
            "# TDD: Login retry\n\nWe will add exponential backoff.",
        );

        // phase-result envelopes (canonical artifact source)
        await writePhaseResult("prd", {
            status: "pass",
            phase: "prd",
            feedback: "PRD drafted: login retry with backoff.",
            artifacts: [
                { kind: "prd", path: "docs/prd/req-000500-login-retry.md", title: "Login retry PRD" },
            ],
        });
        await writePhaseResult("tdd", {
            status: "pass",
            phase: "tdd",
            feedback: "TDD complete.",
            artifacts: [
                { kind: "tdd", path: "docs/tdd/req-000500-login-retry.md", title: "Login retry TDD" },
            ],
        });
        await writePhaseResult("code", {
            status: "pass",
            phase: "code",
            feedback: "Implemented retry policy; opened PR.",
            artifacts: [
                {
                    kind: "github_pr",
                    url: "https://github.com/pwatsonr/autonomous-dev/pull/42",
                    title: "feat: login retry policy",
                },
                { kind: "test-output", path: "docs/.evidence/test.txt", title: "bun test" },
            ],
        });
    }

    test("aggregates artifactList from phase-result files in pipeline order", async () => {
        await seedRichRequest();
        const rec = await loadRequestRecord(repoBasename, id);
        expect(rec).not.toBeNull();
        const list = rec!.artifactList ?? [];
        // prd, tdd, code(github_pr), code(test-output)
        expect(list.length).toBe(4);
        expect(list.map((a) => a.kind)).toEqual([
            "prd",
            "tdd",
            "github_pr",
            "test-output",
        ]);
        // readable flags: docs are readable; pr + test-output are not.
        const prd = list.find((a) => a.kind === "prd")!;
        expect(prd.readable).toBe(true);
        expect(prd.path).toBe("docs/prd/req-000500-login-retry.md");
        const pr = list.find((a) => a.kind === "github_pr")!;
        expect(pr.readable).toBeFalsy();
    });

    test("surfaces the github_pr URL as prUrl (#501)", async () => {
        await seedRichRequest();
        const rec = await loadRequestRecord(repoBasename, id);
        expect(rec!.prUrl).toBe(
            "https://github.com/pwatsonr/autonomous-dev/pull/42",
        );
    });

    test("accepts a PR URL written into `path` instead of `url`", async () => {
        await seedRichRequest();
        // overwrite code phase-result: URL is in path (historical agent shape)
        await writePhaseResult("code", {
            status: "pass",
            phase: "code",
            artifacts: [
                {
                    kind: "github_pr",
                    path: "https://github.com/pwatsonr/autonomous-dev/pull/99",
                },
            ],
        });
        const rec = await loadRequestRecord(repoBasename, id);
        expect(rec!.prUrl).toBe(
            "https://github.com/pwatsonr/autonomous-dev/pull/99",
        );
    });

    test("does NOT treat a non-http path as a PR URL", async () => {
        await seedRichRequest();
        await writePhaseResult("code", {
            status: "pass",
            phase: "code",
            artifacts: [{ kind: "github_pr", path: "not-a-url.txt" }],
        });
        const rec = await loadRequestRecord(repoBasename, id);
        expect(rec!.prUrl).toBeUndefined();
    });

    test("synthesizes a plain-language summary from real data (#502)", async () => {
        await seedRichRequest();
        const rec = await loadRequestRecord(repoBasename, id);
        const s = rec!.outcomeSummary;
        expect(s).toBeDefined();
        expect(s!.requested).toBe("Add a login retry policy");
        // produced lists the doc kinds + the PR
        expect(s!.produced).toContain("PRD");
        expect(s!.produced).toContain("TDD");
        expect(s!.produced).toContain("pull request");
        // outcome derives from the most-recent phase feedback (code phase)
        expect(s!.outcome).toContain("Implemented retry policy");
        // running → muted tone
        expect(s!.outcomeTone).toBe("muted");
    });

    test("summary outcome tone reflects terminal status", async () => {
        await seedRichRequest();
        // flip to done
        const dir = join(tmpRepo, ".autonomous-dev", "requests", id);
        const state = JSON.parse(
            await Bun.file(join(dir, "state.json")).text(),
        );
        state.status = "done";
        state.current_phase = "observe";
        await writeFile(join(dir, "state.json"), JSON.stringify(state));
        const rec = await loadRequestRecord(repoBasename, id);
        expect(rec!.outcomeSummary!.outcomeTone).toBe("ok");
        expect(rec!.outcomeSummary!.outcome).toContain("Completed");
    });

    test("loadArtifactForPhase reads an EARLIER phase's doc body (#499)", async () => {
        await seedRichRequest();
        // current phase is "code"; ask for the PRD artifact explicitly.
        const { record, artifact } = await loadArtifactForPhase(
            repoBasename,
            id,
            "prd",
        );
        expect(record).not.toBeNull();
        expect(artifact).toBeDefined();
        expect(artifact!.phase).toBe("prd");
        expect(artifact!.format).toBe("markdown");
        expect(artifact!.content).toContain("Users should be able to retry login");
    });

    test("loadArtifactForPhase returns no artifact for a link-only phase", async () => {
        await seedRichRequest();
        // "deploy" produced nothing
        const { artifact } = await loadArtifactForPhase(
            repoBasename,
            id,
            "deploy",
        );
        expect(artifact).toBeUndefined();
    });

    test("missing docs degrade gracefully — artifact listed but body null", async () => {
        await seedRichRequest();
        // remove the PRD file on disk; the listing should still include it.
        await rm(join(tmpRepo, "docs", "prd", "req-000500-login-retry.md"));
        const rec = await loadRequestRecord(repoBasename, id);
        expect((rec!.artifactList ?? []).some((a) => a.kind === "prd")).toBe(true);
        const { artifact } = await loadArtifactForPhase(repoBasename, id, "prd");
        expect(artifact).toBeUndefined();
    });

    test("rejects path traversal in artifact paths", async () => {
        await seedRichRequest();
        await writePhaseResult("spec", {
            status: "pass",
            phase: "spec",
            artifacts: [
                { kind: "spec", path: "../../../../etc/passwd", title: "evil" },
            ],
        });
        const { artifact } = await loadArtifactForPhase(repoBasename, id, "spec");
        expect(artifact).toBeUndefined();
    });

    test("no phase-result files → empty artifactList, no crash", async () => {
        // state.json with no phase-result envelopes on disk
        const dir = join(tmpRepo, ".autonomous-dev", "requests", id);
        await mkdir(dir, { recursive: true });
        await writeFile(
            join(dir, "state.json"),
            JSON.stringify({
                id,
                status: "running",
                current_phase: "prd",
                title: "Empty request",
                phase_history: [],
                created_at: "2026-06-01T10:00:00Z",
            }),
        );
        const rec = await loadRequestRecord(repoBasename, id);
        expect(rec!.artifactList).toEqual([]);
        expect(rec!.prUrl).toBeUndefined();
    });
});
