// PLAN-042 Phase D — operator verification-override route tests.
//
// Verifies the new POST /repo/:repo/request/:id/override endpoint:
//   1. happy path: valid body + matching request_dir returns 200 + ok
//   2. missing reason: returns 400
//   3. empty reason: returns 400
//   4. unknown request: returns 404 from the writer
//   5. unmounted-route stub: 503 override-disabled
//   6. invalid request id: 400 invalid-id
//
// CSRF gating is exercised by the existing CSRF wiring test suite — the
// route relies on the central middleware (PR #312) and does not add a
// second guard. PORTAL_TEST_MODE + X-Cypress-Test: 1 bypasses CSRF for
// e2e tests (existing pattern, do not invent a new one).

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";
import type {
    OverrideInput,
    OverrideResult,
    OverrideRouteDeps,
} from "../../server/routes/override";

interface AuditCapture {
    events: Array<Record<string, unknown>>;
}

function captureAudit(): { audit: OverrideRouteDeps["audit"]; capture: AuditCapture } {
    const capture: AuditCapture = { events: [] };
    return {
        capture,
        audit: {
            async append(entry) {
                capture.events.push(entry);
            },
        },
    };
}

function appWithOverride(
    writeOverride: (input: OverrideInput) => Promise<OverrideResult>,
): { app: Hono; auditCapture: AuditCapture } {
    const { audit, capture } = captureAudit();
    const app = new Hono();
    registerRoutes(app, {
        overrideAction: { writeOverride, audit },
    });
    return { app, auditCapture: capture };
}

describe("POST /repo/:repo/request/:id/override", () => {
    test("happy path: returns 200 + ok and appends audit row", async () => {
        const writes: OverrideInput[] = [];
        const { app, auditCapture } = appWithOverride(async (input) => {
            writes.push(input);
            return { ok: true };
        });
        const res = await app.request(
            "/repo/acme/request/REQ-000042/override",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ reason: "flaky network test" }),
            },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean };
        expect(body.ok).toBe(true);
        expect(writes).toHaveLength(1);
        expect(writes[0]!.id).toBe("REQ-000042");
        expect(writes[0]!.repo).toBe("acme");
        expect(writes[0]!.reason).toBe("flaky network test");
        // Audit row appended.
        expect(auditCapture.events).toHaveLength(1);
        expect(auditCapture.events[0]!.event).toBe("verification_override");
        expect(auditCapture.events[0]!.reason).toBe("flaky network test");
    });

    test("missing reason: returns 400", async () => {
        const { app } = appWithOverride(async () => ({ ok: true }));
        const res = await app.request(
            "/repo/acme/request/REQ-000042/override",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({}),
            },
        );
        expect(res.status).toBe(400);
    });

    test("empty/whitespace reason: returns 400", async () => {
        const { app } = appWithOverride(async () => ({ ok: true }));
        const res = await app.request(
            "/repo/acme/request/REQ-000042/override",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ reason: "   " }),
            },
        );
        expect(res.status).toBe(400);
    });

    test("unknown request: writer returns not-found → 404", async () => {
        const { app } = appWithOverride(async () => ({
            ok: false,
            reason: "not-found",
        }));
        const res = await app.request(
            "/repo/acme/request/REQ-999999/override",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ reason: "ok" }),
            },
        );
        expect(res.status).toBe(404);
    });

    test("invalid request id: returns 400 invalid-id", async () => {
        const { app } = appWithOverride(async () => ({ ok: true }));
        const res = await app.request(
            "/repo/acme/request/not-a-req/override",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ reason: "ok" }),
            },
        );
        expect(res.status).toBe(400);
    });

    test("unmounted (no overrideAction dep): returns 503 override-disabled", async () => {
        const app = new Hono();
        registerRoutes(app);
        const res = await app.request(
            "/repo/acme/request/REQ-000042/override",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ reason: "ok" }),
            },
        );
        expect(res.status).toBe(503);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("override-disabled");
    });
});
