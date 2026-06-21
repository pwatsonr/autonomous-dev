// #562 / FR-938 — end-to-end: the Ops page renders the production-intelligence
// tile from `<stateDir>/production-intelligence.json`.
//
// Exercises route → readOpsHealth → OpsView → OpsProductionIntelligenceTile so
// the full vertical slice (reader + view) is covered, not just the reader unit.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";

const ORIGINAL_STATE_DIR = process.env["AUTONOMOUS_DEV_STATE_DIR"];

function freshApp(): Hono {
    const app = new Hono();
    registerRoutes(app);
    return app;
}

describe("#562: Ops renders production-intelligence tile", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "ops-pi-route-"));
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = dir;
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        if (ORIGINAL_STATE_DIR === undefined) {
            delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
        } else {
            process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
        }
    });

    it("shows last-cycle counts when production-intelligence.json exists", async () => {
        writeFileSync(
            join(dir, "production-intelligence.json"),
            JSON.stringify({
                last_run_id: "RUN-20260621-040000",
                last_run_at: "2026-06-21T04:00:00Z",
                services_scanned: 3,
                observations_generated: 12,
                observations_filtered: 4,
                triage_processed: 7,
                error_count: 0,
                updated_at: "2026-06-21T04:00:05Z",
            }),
            "utf-8",
        );

        const html = await (await freshApp().request("/ops")).text();
        expect(html).toContain("Production intelligence");
        expect(html).toContain("RUN-20260621-040000");
        expect(html).toContain("Services scanned");
        // Observation count + filtered annotation both surface.
        expect(html).toContain("12");
        expect(html).toContain("4 filtered");
        // No fabricated empty-state copy when data is present.
        expect(html).not.toContain("no observe cycle yet");
    });

    it("shows the honest empty state when no observe cycle has run", async () => {
        const html = await (await freshApp().request("/ops")).text();
        expect(html).toContain("Production intelligence");
        expect(html).toContain("no observe cycle yet");
    });
});
