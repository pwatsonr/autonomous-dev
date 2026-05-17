// BUG-13 regression test: Audit page should render filter form and pagination
// when audit reader is properly wired.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { registerRoutes } from "../../server/routes";
import { setAuditReader } from "../../server/routes/audit";
import { AuditLogReader, StaticAuditChainVerifier } from "../../server/services/audit-log-reader";
import { kitParityFixtureRoot } from "../../server/wiring/state-paths";

function freshApp(): Hono {
    const app = new Hono();

    // Wire up audit reader with test audit log
    const testAuditPath = join(kitParityFixtureRoot(), "portal-audit.log");
    const auditVerifier = new StaticAuditChainVerifier(Buffer.from("test-key-for-audit"));
    const auditReader = new AuditLogReader(testAuditPath, auditVerifier);
    setAuditReader(auditReader);

    registerRoutes(app, {});
    return app;
}

const ORIGINAL_STATE_DIR = process.env["AUTONOMOUS_DEV_STATE_DIR"];

describe("Audit filter form (BUG-13 regression)", () => {
    beforeAll(async () => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = kitParityFixtureRoot();

        // Create test audit log file if it doesn't exist
        const testAuditPath = join(kitParityFixtureRoot(), "portal-audit.log");
        try {
            await fs.access(testAuditPath);
        } catch {
            // Create empty audit log for testing
            await fs.writeFile(testAuditPath, "", { encoding: "utf8" });
        }
    });

    afterAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
        // Reset audit reader to avoid state pollution
        setAuditReader(null);
    });

    test("should render filter form with required inputs when audit reader is wired", async () => {
        const app = freshApp();
        const response = await app.request("/audit");

        expect(response.status).toBe(200);

        const html = await response.text();

        // Should contain a form element for filters
        expect(html).toMatch(/class="audit-filters"/);

        // Should contain required filter inputs
        expect(html).toMatch(/name="operatorId"/);
        expect(html).toMatch(/name="action"/);
        expect(html).toMatch(/name="startDate"/);
        expect(html).toMatch(/name="endDate"/);

        // Should contain pagination component structure
        expect(html).toMatch(/audit-pagination|Page \d+ of \d+/);
    });

    test("should accept query parameters for filtering", async () => {
        const app = freshApp();
        const response = await app.request("/audit?operatorId=alice&action=kill-switch&startDate=2026-01-01&endDate=2026-12-31");

        expect(response.status).toBe(200);

        const html = await response.text();

        // Filter form should be populated with query values
        expect(html).toMatch(/value="alice"/);
        expect(html).toMatch(/value="kill-switch"/);
        expect(html).toMatch(/value="2026-01-01"/);
        expect(html).toMatch(/value="2026-12-31"/);
    });
});