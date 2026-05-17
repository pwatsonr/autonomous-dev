// BUG-17 regression test: Approvals cost cap KPI label should be consistent
//
// Before the fix, the cost cap KPI tile showed a numerator (gate count: 0)
// that didn't match the sub-line (cost cap: "$25/day") - two different metrics.
// After the fix, both should refer to the same metric.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";
import { kitParityFixtureRoot } from "../../server/wiring/state-paths";

function freshApp(): Hono {
    const app = new Hono();
    registerRoutes(app);
    return app;
}

const ORIGINAL_STATE_DIR = process.env["AUTONOMOUS_DEV_STATE_DIR"];

describe("BUG-17: Approvals cost cap KPI should be consistent", () => {
    beforeAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = kitParityFixtureRoot();
    });

    afterAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
    });

    it("should render cost cap KPI with consistent numerator and sub-line", async () => {
        const app = freshApp();
        const response = await app.request("/approvals");
        expect(response.status).toBe(200);

        const html = await response.text();

        // Should contain Cost cap KPI
        expect(html).toMatch(/Cost cap/);

        // The sub-line should refer to gates blocking, not a dollar amount
        const costKpiMatch = html.match(
            /<div class="kpi">[\s\S]*?<div class="kpi-label">Cost cap<\/div>[\s\S]*?<div class="kpi-num">(\d+)<\/div>[\s\S]*?<div class="kpi-sub">([^<]+)<\/div>[\s\S]*?<\/div>/
        );

        expect(costKpiMatch).toBeTruthy();

        if (costKpiMatch) {
            const numerator = costKpiMatch[1];
            const subLine = costKpiMatch[2];

            // Sub-line should refer to the same metric (gates blocking), not the cap amount
            expect(subLine).toBe("cost-cap gates blocking");
            expect(subLine).not.toMatch(/\$\d+\/day/); // Should not contain dollar amount
        }
    });
});