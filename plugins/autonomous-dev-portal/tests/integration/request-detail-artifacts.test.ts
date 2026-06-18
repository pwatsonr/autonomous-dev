// #499 / #501 / #502 / #503 — Request Detail view integration tests over a
// REAL on-disk request (request-action + state.json + phase-result-*.json +
// docs). Asserts the rendered page surfaces:
//   - #502 plain-language summary card
//   - #499 artifact index with readable-doc HTMX rows
//   - #501 PR link (github_pr URL)
//   - #503 live-poll region (#rd-live with hx-get / hx-trigger)
//   - #499 the artifact endpoint serving an EARLIER phase's real markdown

import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";

function freshApp(): Hono {
    const app = new Hono();
    registerRoutes(app);
    return app;
}

describe("Request Detail — real artifacts (#499/#501/#502/#503)", () => {
    const repo = "art-int-repo";
    const id = "REQ-000777";
    const prUrl = "https://github.com/pwatsonr/autonomous-dev/pull/77";

    const prevState = process.env["AUTONOMOUS_DEV_STATE_DIR"];
    const prevHome = process.env["HOME"];
    const prevCfg = process.env["AUTONOMOUS_DEV_USER_CONFIG"];

    let root: string;
    let repoPath: string;

    beforeAll(async () => {
        root = join(tmpdir(), `rd-art-int-${Date.now()}`);
        const home = join(root, "home");
        repoPath = join(root, "repos", repo);
        await mkdir(join(home, ".claude"), { recursive: true });
        await mkdir(repoPath, { recursive: true });

        process.env["AUTONOMOUS_DEV_STATE_DIR"] = root;
        process.env["HOME"] = home;
        process.env["AUTONOMOUS_DEV_USER_CONFIG"] = join(
            home,
            ".claude",
            "autonomous-dev.json",
        );

        await writeFile(
            process.env["AUTONOMOUS_DEV_USER_CONFIG"],
            JSON.stringify({
                repositories: { allowlist: [{ id: repo, path: repoPath }] },
            }),
        );

        const actionsDir = join(root, "request-actions");
        await mkdir(actionsDir, { recursive: true });
        await writeFile(
            join(actionsDir, `${id}.json`),
            JSON.stringify({
                id,
                repo,
                title: "Add a dark-mode toggle",
                phase: "code",
                status: "running",
                createdAt: "2026-06-10T09:00:00Z",
            }),
        );

        const reqDir = join(repoPath, ".autonomous-dev", "requests", id);
        await mkdir(reqDir, { recursive: true });
        await writeFile(
            join(reqDir, "state.json"),
            JSON.stringify({
                id,
                status: "running",
                current_phase: "code",
                title: "Add a dark-mode toggle",
                target_repo: repoPath,
                phase_history: [
                    { phase: "prd", status: "completed", completed_at: "2026-06-10T09:05:00Z" },
                    { phase: "code", status: "completed", completed_at: "2026-06-10T10:00:00Z" },
                ],
                cost_accrued_usd: 2.0,
                created_at: "2026-06-10T09:00:00Z",
            }),
        );

        await mkdir(join(repoPath, "docs", "prd"), { recursive: true });
        await writeFile(
            join(repoPath, "docs", "prd", "req-000777-dark-mode.md"),
            "# PRD: Dark mode\n\nUnique-PRD-Marker: add a persistent dark-mode toggle.",
        );

        await writeFile(
            join(reqDir, "phase-result-prd.json"),
            JSON.stringify({
                status: "pass",
                phase: "prd",
                feedback: "PRD for the dark-mode toggle drafted.",
                artifacts: [
                    { kind: "prd", path: "docs/prd/req-000777-dark-mode.md", title: "Dark-mode PRD" },
                ],
            }),
        );
        await writeFile(
            join(reqDir, "phase-result-code.json"),
            JSON.stringify({
                status: "pass",
                phase: "code",
                feedback: "Implemented the toggle and opened a PR.",
                artifacts: [
                    { kind: "github_pr", url: prUrl, title: "feat: dark-mode toggle" },
                ],
            }),
        );
    });

    afterAll(async () => {
        if (prevState === undefined) delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
        else process.env["AUTONOMOUS_DEV_STATE_DIR"] = prevState;
        if (prevHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = prevHome;
        if (prevCfg === undefined) delete process.env["AUTONOMOUS_DEV_USER_CONFIG"];
        else process.env["AUTONOMOUS_DEV_USER_CONFIG"] = prevCfg;
        await rm(root, { recursive: true, force: true }).catch(() => {});
    });

    test("#502 — renders the plain-language summary card", async () => {
        const res = await freshApp().request(`/repo/${repo}/request/${id}`);
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('class="rd-summary card"');
        expect(html).toContain("Add a dark-mode toggle"); // requested
        expect(html).toContain("Implemented the toggle"); // outcome feedback
    });

    test("#499 — renders the artifact index with a readable PRD row", async () => {
        const res = await freshApp().request(`/repo/${repo}/request/${id}`);
        const html = await res.text();
        expect(html).toContain('class="rd-artifacts card"');
        // PRD row is an HTMX tab targeting the artifact pane for the prd phase
        expect(html).toContain(
            `/repo/${repo}/request/${id}/artifact/prd`,
        );
        expect(html).toContain("data-artifact-row");
    });

    test("#501 — surfaces the PR link as a clickable anchor", async () => {
        const res = await freshApp().request(`/repo/${repo}/request/${id}`);
        const html = await res.text();
        expect(html).toContain(`href="${prUrl}"`);
        expect(html).toContain("rd-prlink");
    });

    test("#503 — wraps the pipeline in a live-poll region (#rd-live)", async () => {
        const res = await freshApp().request(`/repo/${repo}/request/${id}`);
        const html = await res.text();
        expect(html).toContain('id="rd-live"');
        expect(html).toContain(`hx-get="/repo/${repo}/request/${id}"`);
        expect(html).toContain('hx-select="#rd-live"');
        // running request → polling trigger present (not terminal)
        expect(html).toContain("every 5s");
        // phase pipeline lives inside the live region
        expect(html).toContain("phase-track");
    });

    test("#503 — the live region self-selects so HX poll returns it", async () => {
        // An HX request returns the bare fragment; it must still contain
        // #rd-live so hx-select can extract it.
        const res = await freshApp().request(`/repo/${repo}/request/${id}`, {
            headers: { "HX-Request": "true" },
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('id="rd-live"');
        expect(html).toContain("phase-track");
    });

    test("#499 — artifact endpoint serves an EARLIER phase's real markdown", async () => {
        // current phase is "code"; fetching the prd artifact must return the
        // PRD's rendered markdown, not a pending placeholder.
        const res = await freshApp().request(
            `/repo/${repo}/request/${id}/artifact/prd`,
        );
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('id="rd-artifact-pane"');
        expect(html).toContain("Unique-PRD-Marker");
    });

    test("does not render a polling trigger for a terminal request", async () => {
        // Flip status to done and re-request.
        const reqDir = join(repoPath, ".autonomous-dev", "requests", id);
        const state = JSON.parse(
            await Bun.file(join(reqDir, "state.json")).text(),
        );
        const original = JSON.stringify(state);
        state.status = "done";
        await writeFile(join(reqDir, "state.json"), JSON.stringify(state));
        try {
            const res = await freshApp().request(`/repo/${repo}/request/${id}`);
            const html = await res.text();
            // terminal → data-terminal marker present, no 5s trigger
            expect(html).toContain("data-terminal");
            expect(html).not.toContain("every 5s");
        } finally {
            await writeFile(join(reqDir, "state.json"), original);
        }
    });
});
