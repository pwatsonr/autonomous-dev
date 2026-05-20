// PLAN-042 Phase D — operator override for VERIFICATION_FAILED.
//
// POST /repo/:repo/request/:id/override
//
// Operator authorizes one specific autonomous-dev request to advance past
// a VERIFICATION_FAILED gate by writing
// `${req_dir}/verification-override.json` with
//   { request_id, reason, operator, timestamp }.
//
// The override is per-request, audited, and non-persistent — the daemon's
// existing per-request lifecycle removes the file when the request reaches
// a terminal state. This handler is the portal mirror of the
// `autonomous-dev override-verification` CLI sub-command.
//
// Contract notes:
//   - CSRF is enforced by the global CSRF middleware (PR #312); this route
//     does NOT add a second guard. PORTAL_TEST_MODE + X-Cypress-Test: 1
//     bypasses CSRF (existing test pattern, do not invent a new one).
//   - Body shape: `{ reason: string }`. Empty / missing → 400.
//   - Success: 200 with `{ ok: true }` JSON. The route appends an audit
//     row via the shared AuditAppender (writes to portal-audit.log).
//   - The route is deps-injected (a single `writeOverride` callback) so
//     tests can stub the filesystem write without touching the real
//     state-dir.

import { Hono } from "hono";

import type {
    ActionLogger,
    AuditAppender,
    SSEBroadcaster,
} from "./_action-deps";
import {
    noopActionLogger,
    noopBroadcaster,
    resolveActor,
} from "./_action-deps";

const REPO_RE = /^[A-Za-z0-9._-]{1,128}$/;
const ID_RE = /^REQ-[0-9]{6}$/;

export interface OverrideInput {
    repo: string;
    id: string;
    reason: string;
    operator: string;
}

export type OverrideResult =
    | { ok: true }
    | { ok: false; reason: "not-found" }
    | { ok: false; reason: "internal"; message?: string };

export interface OverrideRouteDeps {
    /**
     * Write the override file to the request directory. Returns the result
     * envelope. The wiring layer owns where on disk the file lands; the
     * route is fs-agnostic so tests can stub.
     */
    writeOverride: (input: OverrideInput) => Promise<OverrideResult>;
    audit: AuditAppender;
    bus?: SSEBroadcaster;
    logger?: ActionLogger;
}

interface OverrideBody {
    reason?: unknown;
}

/**
 * Build the override sub-router. Mounted as a sibling of the gate routes.
 */
export function buildOverrideRoutes(deps: OverrideRouteDeps): Hono {
    const bus = deps.bus ?? noopBroadcaster();
    const logger = deps.logger ?? noopActionLogger();
    const router = new Hono();

    router.post("/repo/:repo/request/:id/override", async (c) => {
        const repo = c.req.param("repo");
        const id = c.req.param("id");
        if (typeof repo !== "string" || !REPO_RE.test(repo)) {
            return c.json({ error: "invalid-repo" }, 400);
        }
        if (typeof id !== "string" || !ID_RE.test(id)) {
            return c.json({ error: "invalid-id" }, 400);
        }

        let body: OverrideBody = {};
        try {
            body = (await c.req.json()) as OverrideBody;
        } catch {
            // Allow form-encoded fallback for the HTMX form.
            try {
                const form = await c.req.formData();
                const r = form.get("reason");
                if (typeof r === "string") body.reason = r;
            } catch {
                return c.json({ error: "invalid-body" }, 400);
            }
        }

        if (typeof body.reason !== "string") {
            return c.json({ error: "missing-reason" }, 400);
        }
        const reason = body.reason.trim();
        if (reason.length === 0) {
            return c.json({ error: "missing-reason" }, 400);
        }
        if (reason.length > 2048) {
            return c.json({ error: "reason-too-long" }, 400);
        }

        const operator = resolveActor(c.get("auth"));

        let result: OverrideResult;
        try {
            result = await deps.writeOverride({
                repo,
                id,
                reason,
                operator,
            });
        } catch (err) {
            logger.error("override_write_failed", {
                repo,
                id,
                error: err instanceof Error ? err.message : String(err),
            });
            return c.json({ error: "internal" }, 500);
        }

        if (!result.ok) {
            if (result.reason === "not-found") {
                return c.json({ error: "not-found" }, 404);
            }
            logger.error("override_write_failed", {
                repo,
                id,
                reason: result.reason,
            });
            return c.json({ error: "internal" }, 500);
        }

        // Audit trail — appended via the shared AuditAppender, which
        // writes the HMAC-chained portal-audit.log entry (visible in the
        // portal /audit page).
        await deps.audit.append({
            event: "verification_override",
            repo,
            id,
            actor: operator,
            reason,
        });
        bus.publish("override", { repo, id, actor: operator });
        return c.json({ ok: true });
    });

    return router;
}

/** Exported for tests. */
export const __test__ = {
    REPO_RE,
    ID_RE,
};
