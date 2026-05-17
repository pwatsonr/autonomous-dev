// SPEC-037-2-06 — Gate decision + generic request-action routes.
//
// Four endpoints back the RequestDetail page:
//
//   POST /repo/:repo/request/:id/gate/approve          (typed-CONFIRM gated)
//   POST /repo/:repo/request/:id/gate/request-changes  (typed-CONFIRM gated)
//   POST /repo/:repo/request/:id/gate/reject           (typed-CONFIRM gated)
//   POST /api/requests/:id/action                      (no typed-CONFIRM)
//
// Contract notes (per spec):
//   - The three gate POSTs route through the existing `requireConfirmation`
//     middleware (SPEC-014-2-02). The route MUST NOT re-implement typed
//     CONFIRM — wiring re-uses the global confirmation store from
//     confirmation-routes.ts.
//   - On `confirmation-required` the upstream middleware returns 403; we
//     map that to the documented `{error:"confirmation-required", action}`
//     envelope so the client modal can drive the request/validate dance.
//   - The generic action whitelist (`retry / skip / cancel / escalate`) is
//     recoverable — no typed CONFIRM. Unknown actions → 400.

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
import type { ConfirmationStore } from "./confirmation-routes";
import { requireConfirmation } from "./confirmation-routes";

const REPO_RE = /^[A-Za-z0-9._-]{1,128}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type GateVerb = "approve" | "request-changes" | "reject";

const GATE_VERBS: readonly GateVerb[] = [
    "approve",
    "request-changes",
    "reject",
] as const;

const REQUEST_ACTIONS: ReadonlySet<string> = new Set([
    "retry",
    "skip",
    "cancel",
    "escalate",
    "pause",
    "kill",
]);

export interface GateDecisionInput {
    repo: string;
    id: string;
    verb: GateVerb;
    actor: string;
}

export type GateDecisionResult =
    | { ok: true; fragment: JSX.Element }
    | { ok: false; reason: "not-found" }
    | { ok: false; reason: "terminal"; state: string }
    | { ok: false; reason: "internal"; message?: string };

export type RequestActionResult =
    | { ok: true; fragment: JSX.Element }
    | { ok: false; reason: string };

export interface GateAndRequestActionDeps {
    applyGateDecision: (
        input: GateDecisionInput,
    ) => Promise<GateDecisionResult>;
    applyRequestAction: (
        id: string,
        action: string,
        actor: string,
    ) => Promise<RequestActionResult>;
    audit: AuditAppender;
    confirmationStore: ConfirmationStore;
    bus?: SSEBroadcaster;
    logger?: ActionLogger;
}

interface RequestActionBody {
    action?: unknown;
}

function gateAuditEvent(verb: GateVerb): string {
    return `gate_${verb.replace("-", "_")}`;
}

/**
 * The confirmation middleware already returns 403 with
 * `{error:"confirmation-required", action}`. We translate any other
 * upstream 403 envelopes verbatim — the test suite for SPEC-014-2-02 owns
 * the exact wording.
 */
export function buildGateAndRequestActionRoutes(
    deps: GateAndRequestActionDeps,
): Hono {
    const bus = deps.bus ?? noopBroadcaster();
    const logger = deps.logger ?? noopActionLogger();
    const router = new Hono();

    const gateHandler = (verb: GateVerb) =>
        async (c: import("hono").Context): Promise<Response> => {
            const repo = c.req.param("repo");
            const id = c.req.param("id");
            if (typeof repo !== "string" || !REPO_RE.test(repo)) {
                return c.json({ error: "invalid-repo" }, 400);
            }
            if (typeof id !== "string" || !ID_RE.test(id)) {
                return c.json({ error: "invalid-id" }, 400);
            }
            const actor = resolveActor(c.get("auth"));
            let result: GateDecisionResult;
            try {
                result = await deps.applyGateDecision({ repo, id, verb, actor });
            } catch (err) {
                logger.error("gate_action_failed", {
                    repo,
                    id,
                    verb,
                    error: err instanceof Error ? err.message : String(err),
                });
                return c.json({ error: "internal" }, 500);
            }
            if (!result.ok) {
                if (result.reason === "not-found") {
                    return c.json({ error: "not-found" }, 404);
                }
                if (result.reason === "terminal") {
                    return c.json(
                        { error: "request-terminal", state: result.state },
                        409,
                    );
                }
                logger.error("gate_action_failed", {
                    repo,
                    id,
                    verb,
                    reason: result.reason,
                });
                return c.json({ error: "internal" }, 500);
            }
            await deps.audit.append({
                event: gateAuditEvent(verb),
                repo,
                id,
                actor,
            });
            bus.publish("gate", { repo, id, verb });
            return c.html(result.fragment);
        };

    for (const verb of GATE_VERBS) {
        router.post(
            `/repo/:repo/request/:id/gate/${verb}`,
            // SPEC-014-2-02 middleware. We register PER verb so the action
            // name supplied to `requireConfirmation` matches the verb the
            // client requested.
            requireConfirmation(`gate-${verb}`, {
                store: deps.confirmationStore,
            }),
            gateHandler(verb),
        );
    }

    // POST /api/requests/:id/action — generic recoverable verbs.
    router.post("/api/requests/:id/action", async (c) => {
        const id = c.req.param("id");
        if (typeof id !== "string" || !ID_RE.test(id)) {
            return c.json({ error: "invalid-id" }, 400);
        }
        let body: RequestActionBody = {};
        try {
            body = (await c.req.json()) as RequestActionBody;
        } catch {
            return c.json({ error: "invalid-body" }, 400);
        }
        if (typeof body.action !== "string" || !REQUEST_ACTIONS.has(body.action)) {
            return c.json({ error: "unknown-action" }, 400);
        }
        const action = body.action;
        const actor = resolveActor(c.get("auth"));
        let result: RequestActionResult;
        try {
            result = await deps.applyRequestAction(id, action, actor);
        } catch (err) {
            logger.error("request_action_failed", {
                id,
                action,
                error: err instanceof Error ? err.message : String(err),
            });
            return c.json({ error: "internal" }, 500);
        }
        if (!result.ok) {
            return c.json({ error: result.reason }, 500);
        }
        await deps.audit.append({
            event: `request_action_${action}`,
            id,
            actor,
        });
        return c.html(result.fragment);
    });

    return router;
}

/** Exported for tests. */
export const __test__ = {
    REPO_RE,
    ID_RE,
    REQUEST_ACTIONS,
    GATE_VERBS,
};
