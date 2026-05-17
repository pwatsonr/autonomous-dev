import { describe, it, expect } from "bun:test";

describe("Settings form encoding compatibility", () => {
    const BASE_URL = "http://localhost:19281";

    it("should accept form-encoded body for /api/settings/allowlist", async () => {
        const response = await fetch(`${BASE_URL}/api/settings/allowlist`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "HX-Request": "true",
            },
            body: "path=/Users/test/fake-repo",
        });

        // Should NOT return 400 "invalid-body"
        // Acceptable statuses: 200/201 (success), 403 (auth), 422 (validation)
        expect(response.status).not.toBe(400);

        if (response.status === 400) {
            const body = await response.json();
            expect(body.error).not.toBe("invalid-body");
        }
    });

    it("should accept form-encoded body for /api/settings/notifications", async () => {
        const response = await fetch(`${BASE_URL}/api/settings/notifications`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "HX-Request": "true",
            },
            body: "discordWebhook=&slackWebhook=&dndEnabled=false",
        });

        // Should NOT return 400 "invalid-body"
        expect(response.status).not.toBe(400);

        if (response.status === 400) {
            const body = await response.text();
            expect(body).not.toContain("invalid form body");
        }
    });

    it("should accept form-encoded body for /api/approvals/bulk-approve", async () => {
        const response = await fetch(`${BASE_URL}/api/approvals/bulk-approve`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "HX-Request": "true",
            },
            body: "filter=all",
        });

        // Should NOT return 400 "invalid-body"
        expect(response.status).not.toBe(400);

        if (response.status === 400) {
            const body = await response.json();
            expect(body.error).not.toBe("invalid-body");
        }
    });
});