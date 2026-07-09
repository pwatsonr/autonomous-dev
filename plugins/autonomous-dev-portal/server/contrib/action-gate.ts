// #671 — Action-through-gate bridge for portal contributions.
//
// Mounts `POST /portal/<id>/action/<actionId>` for each registered action
// descriptor. Every call follows this flow:
//
//   1. Auth + CSRF run globally (handled by core middleware — this module
//      never bypasses them).
//   2. RBAC check: actor's role ≥ action's `minRole`. Denied → 403 + audit.
//   3. Destructiveness check:
//      a. `read-only` → execute handler immediately.
//      b. `reversible` / `irreversible` / `destructive` → requires a
//         typed-CONFIRM token:
//         - No `X-Contribution-Action-Token` header present:
//           Issue a fresh token, respond 202 with `{requiresConfirmation, token, phrase}`.
//         - Header present: validate token → execute handler.
//   4. Execute: invoke `action.handler(ActionContext)`. Any throw → 500 JSON.
//   5. Emit audit entry after every call (denied or executed).
//
// The token store is separate from the core `TypedConfirmationService`
// because contributed actions have dynamic, plugin-defined names — they
// cannot be pre-registered in the static `CONFIRMATION_PHRASES` allowlist.

import { Hono } from "hono";
import { randomBytes } from "node:crypto";

import type { AuditAppender, ActionLogger } from "../routes/_action-deps";
import { resolveActor, noopActionLogger } from "../routes/_action-deps";
import { hasRole, resolveRole } from "./rbac";
import type {
    PortalContribution,
    ContributionAction,
    ActionContext,
    PortalRole,
    ActionDestructiveness,
} from "./types";
import type { PortalRolesConfig } from "./rbac";

// ---------------------------------------------------------------------------
// Confirmation-phrase ladder (parallels the core gate's destructiveness map)
// ---------------------------------------------------------------------------

const DESTRUCTIVENESS_PHRASES: Record<Exclude<ActionDestructiveness, "read-only">, string> = {
    reversible: "CONFIRM ACTION",
    irreversible: "CONFIRM PERMANENT",
    destructive: "CONFIRM DESTROY",
};

/** TTL for contribution action tokens (60 seconds). */
const TOKEN_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// In-process token store (separate from core TypedConfirmationService)
// ---------------------------------------------------------------------------

interface ContribToken {
    actionKey: string; // "<contributionId>:<actionId>"
    phrase: string;
    issuedAt: number;
    metadata: Record<string, unknown>;
    actor: string;
}

class ContribTokenStore {
    private readonly store = new Map<string, ContribToken>();

    issue(actionKey: string, phrase: string, actor: string, metadata: Record<string, unknown>): string {
        const token = randomBytes(16).toString("hex");
        this.store.set(token, { actionKey, phrase, issuedAt: Date.now(), metadata, actor });
        return token;
    }

    /**
     * Consume and validate a token. Returns the stored entry on success,
     * undefined when the token is missing, expired, or belongs to a different action.
     */
    consume(token: string, actionKey: string): ContribToken | undefined {
        const entry = this.store.get(token);
        if (entry === undefined) return undefined;
        // Always delete to enforce one-time use.
        this.store.delete(token);
        if (entry.actionKey !== actionKey) return undefined;
        if (Date.now() - entry.issuedAt > TOKEN_TTL_MS) return undefined;
        return entry;
    }
}

// Module-level store; one per process (same pattern as InMemoryConfirmationStore).
const contribTokenStore = new ContribTokenStore();

// ---------------------------------------------------------------------------
// Deps interface for the action-gate builder
// ---------------------------------------------------------------------------

export interface ActionGateDeps {
    audit: AuditAppender;
    logger?: ActionLogger;
    rolesConfig?: PortalRolesConfig;
}

// ---------------------------------------------------------------------------
// Route builder
// ---------------------------------------------------------------------------

/**
 * Build a Hono sub-router that mounts all action routes for `contribution`.
 *
 * Each action is mounted at:
 *   `POST /portal/<contribution.id>/action/<action.id>`
 *
 * The sub-router is returned unmounted; `registerContribRoutes` splices it
 * onto the main app via `app.route("/", ...)`.
 */
export function buildActionRoutes(
    contribution: PortalContribution,
    deps: ActionGateDeps,
): Hono {
    const router = new Hono();
    const log = deps.logger ?? noopActionLogger();

    for (const action of contribution.actions ?? []) {
        const path = `/portal/${contribution.id}/action/${action.id}`;
        const actionKey = `${contribution.id}:${action.id}`;
        const minRole: PortalRole = action.minRole ?? "admin";
        const destructiveness: ActionDestructiveness =
            action.destructiveness ?? "reversible";

        router.post(path, async (c) => {
            const actor = resolveActor(c.get("auth"));
            const role = resolveRole(actor, deps.rolesConfig);

            // ----------------------------------------------------------------
            // Step 1: RBAC check.
            // ----------------------------------------------------------------
            if (!hasRole(role, minRole)) {
                void deps.audit.append({
                    event: "contrib_action_denied",
                    actor,
                    contribution: contribution.id,
                    action: action.id,
                    reason: "insufficient-role",
                    role,
                    minRole,
                });
                log.warn("contrib_action_denied", {
                    actor,
                    action: actionKey,
                    role,
                    minRole,
                });
                return c.json(
                    { error: "insufficient-role", required: minRole, actual: role },
                    403,
                );
            }

            // ----------------------------------------------------------------
            // Step 2: read-only → execute immediately without gate.
            // ----------------------------------------------------------------
            if (destructiveness === "read-only") {
                return executeAction(c, action, actor, role, {}, contribution.id, deps, log);
            }

            // ----------------------------------------------------------------
            // Step 3: Reversible/irreversible/destructive → typed-CONFIRM gate.
            // ----------------------------------------------------------------
            const tokenHeader = c.req.header("x-contribution-action-token");

            if (tokenHeader === undefined || tokenHeader.length === 0) {
                // No token presented — issue one and ask the client to confirm.
                const phrase = DESTRUCTIVENESS_PHRASES[destructiveness];
                const token = contribTokenStore.issue(actionKey, phrase, actor, {});
                log.info?.("contrib_action_confirm_issued", { actor, action: actionKey });
                return c.json(
                    {
                        requiresConfirmation: true,
                        token,
                        phrase,
                        label: action.label,
                        ttlSeconds: Math.floor(TOKEN_TTL_MS / 1000),
                    },
                    202,
                );
            }

            // Token presented — validate.
            const entry = contribTokenStore.consume(tokenHeader, actionKey);
            if (entry === undefined) {
                void deps.audit.append({
                    event: "contrib_action_denied",
                    actor,
                    contribution: contribution.id,
                    action: action.id,
                    reason: "invalid-or-expired-token",
                });
                return c.json({ error: "invalid-or-expired-confirmation" }, 403);
            }

            // Token is valid — execute.
            return executeAction(c, action, actor, role, entry.metadata, contribution.id, deps, log);
        });
    }

    return router;
}

async function executeAction(
    c: import("hono").Context,
    action: ContributionAction,
    actor: string,
    role: PortalRole,
    metadata: Record<string, unknown>,
    contributionId: string,
    deps: ActionGateDeps,
    log: ActionLogger,
): Promise<Response> {
    const ctx: ActionContext = { c, actor, role, metadata };
    try {
        const result = await action.handler(ctx);
        void deps.audit.append({
            event: "contrib_action_executed",
            actor,
            contribution: contributionId,
            action: action.id,
            role,
        });
        log.info?.("contrib_action_executed", { actor, action: `${contributionId}:${action.id}` });
        if (result instanceof Response) return result;
        return c.json(result, 200);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("contrib_action_error", {
            actor,
            action: `${contributionId}:${action.id}`,
            error: msg,
        });
        return c.json({ error: "action-failed", message: msg }, 500);
    }
}
