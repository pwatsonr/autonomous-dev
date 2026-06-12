// Settings form encoding compatibility — the HTMX flow POSTs URL-encoded
// bodies, so the settings/approvals routes must accept that content type
// and not reject with `{ error: "invalid-body" }`/400.
//
// Pre-PR-#312 this suite hit a live portal on `localhost:19281`; that
// required a side-car server and tests now run in-process. We register
// the production routes against an isolated Hono app and assert the
// content-type contract is preserved.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerRoutes } from "../../server/routes";
import { FileSettingsStore } from "../../server/wiring/settings-store";
import { buildFileWebhookDispatcher } from "../../server/wiring/notification-dispatcher";
import type { AuditAppender } from "../../server/routes/_action-deps";

let TEST_CONFIG_DIR: string;
let TEST_CONFIG_PATH: string;
const ORIGINAL_USER_CONFIG = process.env["AUTONOMOUS_DEV_USER_CONFIG"];

function freshApp(): Hono {
    const app = new Hono();
    const settingsStore = new FileSettingsStore(TEST_CONFIG_PATH);
    const notificationDispatcher = buildFileWebhookDispatcher(
        fetch,
        TEST_CONFIG_PATH,
    );
    const audit: AuditAppender = {
        async append() {
            // noop
        },
    };
    registerRoutes(app, {
        settingsActions: {
            store: settingsStore,
            notifications: notificationDispatcher,
            audit,
        },
    });
    return app;
}

describe("Settings form encoding compatibility", () => {
    beforeAll(() => {
        // CSRF middleware short-circuits when PORTAL_TEST_MODE=1 + the
        // X-Cypress-Test: 1 request header is present. We rely on that
        // bypass below.
        process.env["PORTAL_TEST_MODE"] = "1";
    });

    beforeEach(() => {
        TEST_CONFIG_DIR = mkdtempSync(
            join(tmpdir(), "settings-form-encoding-"),
        );
        TEST_CONFIG_PATH = join(TEST_CONFIG_DIR, "autonomous-dev.json");
        writeFileSync(TEST_CONFIG_PATH, "{}", "utf-8");
        process.env["AUTONOMOUS_DEV_USER_CONFIG"] = TEST_CONFIG_PATH;
        // Incident fix: the store ALSO writes config-change markers to
        // ${AUTONOMOUS_DEV_STATE_DIR}/config-changes — without this the
        // suite wrote REAL markers the daemon applied (wiping the
        // operator's webhook). The global preload guards this too.
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = TEST_CONFIG_DIR;
    });

    afterAll(() => {
        if (ORIGINAL_USER_CONFIG === undefined) {
            delete process.env["AUTONOMOUS_DEV_USER_CONFIG"];
        } else {
            process.env["AUTONOMOUS_DEV_USER_CONFIG"] = ORIGINAL_USER_CONFIG;
        }
        try {
            rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
        } catch {
            // best-effort
        }
    });

    it("should accept form-encoded body for /api/settings/allowlist", async () => {
        const app = freshApp();
        const response = await app.request("/api/settings/allowlist", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "HX-Request": "true",
                "X-Cypress-Test": "1",
            },
            body: "path=/Users/test/fake-repo",
        });

        // Contract: form-encoded bodies must parse — the route either
        // accepts or rejects on a domain rule (403 path-outside-home,
        // 422 not-a-git-repo). It must NOT return the "invalid-body" 400
        // that indicates the body parser refused the content type.
        expect(response.status).not.toBe(400);

        if (response.status === 400) {
            const body = (await response.json()) as { error?: string };
            expect(body.error).not.toBe("invalid-body");
        }
    });

    it("should accept form-encoded body for /api/settings/notifications", async () => {
        const app = freshApp();
        const response = await app.request("/api/settings/notifications", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "HX-Request": "true",
                "X-Cypress-Test": "1",
            },
            body: "discordWebhook=&slackWebhook=&dndEnabled=false",
        });

        expect(response.status).not.toBe(400);

        if (response.status === 400) {
            const body = await response.text();
            expect(body).not.toContain("invalid form body");
        }
    });

    it("should accept form-encoded body for /api/approvals/bulk-approve", async () => {
        const app = freshApp();
        const response = await app.request("/api/approvals/bulk-approve", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "HX-Request": "true",
                "X-Cypress-Test": "1",
            },
            body: "filter=all",
        });

        expect(response.status).not.toBe(400);

        if (response.status === 400) {
            const body = (await response.json()) as { error?: string };
            expect(body.error).not.toBe("invalid-body");
        }
    });
});
