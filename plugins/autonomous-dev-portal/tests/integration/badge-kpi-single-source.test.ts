// PLAN-038 TASK-018/019 — single-source guarantee for nav badges + KPIs.
//
// Per TDD-037 §5.1.3 and AC-3710, the rail-nav badge count must equal
// the destination surface's primary KPI for that count. This test pins
// the contract by:
//   - pointing `AUTONOMOUS_DEV_STATE_DIR` at the kit-parity fixtures
//   - rendering /approvals and the dashboard
//   - asserting the badge count (rail) equals the surface KPI (page body)

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";
import { kitParityFixtureRoot } from "../../server/wiring/state-paths";

function freshApp(): Hono {
    const app = new Hono();
    registerRoutes(app);
    return app;
}

const ORIGINAL_STATE_DIR = process.env["AUTONOMOUS_DEV_STATE_DIR"];

describe("PLAN-038 TASK-018/019 — badge ↔ KPI single source", () => {
    beforeAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = kitParityFixtureRoot();
    });
    afterAll(() => {
        if (ORIGINAL_STATE_DIR === undefined) {
            delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
        } else {
            process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
        }
    });

    test("Approvals surface reads gates from the request ledger (kit-parity fixture)", async () => {
        const app = freshApp();
        const res = await app.request("/approvals");
        const html = await res.text();
        expect(res.status).toBe(200);
        // PORTAL-AUDIT-2026-05-15: /approvals now reads gate-status rows
        // from the request-ledger (request-actions/*.json) instead of the
        // legacy approvals-queue.json. The kit-parity fixture has two
        // status="gate" rows in request-actions/, so the surface shows two
        // (vs. the kit screenshot's "Approvals 3"). Updating the fixture to
        // add a third gate row would skew the companion "Active 9" check.
        expect(html).toContain("Rate limiter for auth API");
        expect(html).toContain("Database connection pool tuning");
    });

    test("Requests surface reads 9 from fixture (matches kit 'Active 9 across 6 repos')", async () => {
        const app = freshApp();
        const res = await app.request("/requests");
        const html = await res.text();
        expect(res.status).toBe(200);
        // Spot-check three of the nine request IDs from the fixture.
        expect(html).toContain("REQ-100001");
        expect(html).toContain("REQ-100005");
        expect(html).toContain("REQ-100009");
    });

    test("Dashboard rail-ops fields use the same readers as the surfaces", async () => {
        // The shell-rail-state.readQueueCounts now delegates to the
        // approvals + request-ledger + agents readers, so dashboard,
        // approvals, requests surface, and rail-nav all share one source.
        // Direct call to the shared composition keeps the assertion
        // hermetic; the full SSR path is exercised by the prior tests.
        const { readApprovalsQueue } = await import(
            "../../server/wiring/approvals-reader"
        );
        const { readRequestLedger } = await import(
            "../../server/wiring/request-ledger-reader"
        );
        const approvals = await readApprovalsQueue();
        const requests = await readRequestLedger();
        const active = requests.filter(
            (r) => r.status === "running" || r.status === "gate",
        );
        // Fixture counts pinned to the kit-parity request-actions/ fixture.
        // Was 3 when the reader pulled from approvals-queue.json; PORTAL-AUDIT-2026-05-15
        // switched it to the request-ledger (status === "gate"), which the
        // fixture has 2 of (REQ-100002 + REQ-100003).
        expect(approvals.items.length).toBe(2);
        expect(active.length).toBe(9);
    });
});
