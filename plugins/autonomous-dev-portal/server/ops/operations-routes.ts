// SPEC-015-4-01 §Route Handlers — Hono routes for the destructive
// operations dashboard.
//
// Three POST endpoints:
//   POST /ops/kill-switch/engage  body: { reason, confirmationToken, typedPhrase }
//   POST /ops/kill-switch/reset   body: { confirmationToken, typedPhrase }
//   POST /ops/circuit-breaker/reset body: { confirmationToken, typedPhrase }
//
// One token-issuance endpoint:
//   POST /ops/confirm-token       body: { action }
//   → { token, phrase, ttl }
//
// Wiring expectations:
//   - Routes registered AFTER CSRF middleware so every mutation carries
//     a CSRF token (PLAN-014-2).
//   - Routes registered AFTER `requireHealthyDaemon` middleware
//     (SPEC-015-4-03) so 503s short-circuit before token validation.
//   - The session id is read from `c.var.sessionId`; the operator id
//     from `c.var.operatorId`. Both are set by upstream auth middleware.

import type { Context, Hono } from "hono";

import {
    isOpsAction,
    type OperationsHandler,
    type OpsAction,
} from "./operations-handlers";

interface OpsBody {
    confirmationToken?: unknown;
    typedPhrase?: unknown;
    reason?: unknown;
}

interface ConfirmTokenBody {
    action?: unknown;
}

/** Reads sessionId / operatorId from context with safe fallbacks. */
function readActor(c: Context): { sessionId: string; operatorId: string } {
    const session = c.get("sessionId");
    const operator = c.get("operatorId");
    return {
        sessionId: typeof session === "string" ? session : "anonymous",
        operatorId: typeof operator === "string" ? operator : "anonymous",
    };
}

async function readJsonBody<T>(c: Context): Promise<T | null> {
    try {
        const json = await c.req.json();
        return json as T;
    } catch {
        return null;
    }
}

function asString(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Wires every /ops POST endpoint into `app`. Caller is responsible for
 * mounting CSRF + daemon-health middleware at `/ops/*` BEFORE invoking.
 */
export function registerOperationsRoutes(
    app: Hono,
    handler: OperationsHandler,
    confirmService: {
        generateConfirmationToken(
            sessionId: string,
            req: { action: string },
        ): {
            success: boolean;
            token?: string;
            phrase?: string;
            ttl?: number;
            error?: string;
        };
    },
): void {
    app.post("/ops/confirm-token", async (c) => {
        const body = (await readJsonBody<ConfirmTokenBody>(c)) ?? {};
        const action = asString(body.action);
        if (action === null || !isOpsAction(action)) {
            return c.json(
                { success: false, error: "UNKNOWN_ACTION" },
                400,
            );
        }
        const { sessionId } = readActor(c);
        const result = confirmService.generateConfirmationToken(sessionId, {
            action,
        });
        if (!result.success) {
            const status = result.error === "rate-limit-exceeded" ? 429 : 400;
            return c.json(
                { success: false, error: result.error ?? "UNKNOWN_ACTION" },
                status,
            );
        }
        return c.json(
            {
                success: true,
                token: result.token,
                phrase: result.phrase,
                action,
                expiresIn: result.ttl,
            },
            200,
        );
    });

    app.post("/ops/kill-switch/engage", async (c) =>
        await handleMutation(c, handler, "kill-switch.engage"),
    );

    app.post("/ops/kill-switch/reset", async (c) =>
        await handleMutation(c, handler, "kill-switch.reset"),
    );

    app.post("/ops/circuit-breaker/reset", async (c) =>
        await handleMutation(c, handler, "circuit-breaker.reset"),
    );
}

/**
 * Common dispatch: parse body, route to the right handler method,
 * translate the OperationResult into HTTP semantics.
 */
async function handleMutation(
    c: Context,
    handler: OperationsHandler,
    action: OpsAction,
): Promise<Response> {
    const body = (await readJsonBody<OpsBody>(c)) ?? {};
    const token = asString(body.confirmationToken);
    const typedPhrase = asString(body.typedPhrase);
    const reason = asString(body.reason);
    const { sessionId, operatorId } = readActor(c);

    if (token === null || typedPhrase === null) {
        return c.json(
            {
                success: false,
                error: "Missing confirmationToken or typedPhrase.",
                errorCode: "INVALID_TOKEN",
            },
            400,
        );
    }

    const confirmation = { token, typedPhrase, sessionId };

    let result;
    switch (action) {
        case "kill-switch.engage":
            result = await handler.engageKillSwitch(
                reason ?? "",
                operatorId,
                confirmation,
            );
            break;
        case "kill-switch.reset":
            result = await handler.resetKillSwitch(operatorId, confirmation);
            break;
        case "circuit-breaker.reset":
            result = await handler.resetCircuitBreaker(operatorId, confirmation);
            break;
    }

    if (result.success) {
        return c.json(result, 200);
    }
    // INTAKE_FAILED is a downstream / network failure → 502 so operator
    // dashboards distinguish from operator-input errors.
    const status = result.errorCode === "INTAKE_FAILED" ? 502 : 400;
    return c.json(result, status);
}
