// SPEC-015-4-04 — Operations routes (typed-CONFIRM gate) tests.
//
// In-memory route testing using `new Hono()` + `app.request()`. The
// OperationsHandler is replaced with a recording stub so we can drive
// every branch of the route layer (good token, missing fields, intake
// failure) without standing up a real intake-router socket or audit
// log.
//
// Route surface under test:
//   POST /ops/confirm-token              issue a typed-CONFIRM token
//   POST /ops/kill-switch/engage         engage with token + phrase
//   POST /ops/kill-switch/reset
//   POST /ops/circuit-breaker/reset

import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { registerOperationsRoutes } from "../../server/ops/operations-routes";
import type {
    OperationResult,
    OperationsHandler,
    OpsAction,
} from "../../server/ops/operations-handlers";

// ----- Recording stub for OperationsHandler --------------------------------
// We emulate the surface the routes consume. A real OperationsHandler
// instance would also run validateReason / typed-CONFIRM internally, but
// the route layer treats the handler as a black box.

interface RecordedCall {
    method: "engage" | "reset-kill" | "reset-cb";
    operatorId: string;
    confirmation: { token: string; typedPhrase: string; sessionId: string };
    reason?: string;
}

class StubOperationsHandler {
    public readonly calls: RecordedCall[] = [];
    public nextResult: OperationResult = { success: true, intakeRequestId: "req-1" };

    async engageKillSwitch(
        reason: string,
        operatorId: string,
        confirmation: RecordedCall["confirmation"],
    ): Promise<OperationResult> {
        this.calls.push({ method: "engage", operatorId, confirmation, reason });
        return this.nextResult;
    }
    async resetKillSwitch(
        operatorId: string,
        confirmation: RecordedCall["confirmation"],
    ): Promise<OperationResult> {
        this.calls.push({ method: "reset-kill", operatorId, confirmation });
        return this.nextResult;
    }
    async resetCircuitBreaker(
        operatorId: string,
        confirmation: RecordedCall["confirmation"],
    ): Promise<OperationResult> {
        this.calls.push({ method: "reset-cb", operatorId, confirmation });
        return this.nextResult;
    }
    /** Cast helper so TS lets us pass the stub in the registerOperationsRoutes call. */
    asHandler(): OperationsHandler {
        return this as unknown as OperationsHandler;
    }
}

interface StubTokenIssuance {
    success: boolean;
    token?: string;
    phrase?: string;
    ttl?: number;
    error?: string;
}

class StubConfirmService {
    public readonly issuances: { sessionId: string; action: string }[] = [];
    public nextResult: StubTokenIssuance = {
        success: true,
        token: "tok-abc",
        phrase: "EMERGENCY STOP",
        ttl: 60,
    };

    generateConfirmationToken(
        sessionId: string,
        req: { action: string },
    ): StubTokenIssuance {
        this.issuances.push({ sessionId, action: req.action });
        return this.nextResult;
    }
}

interface Harness {
    app: Hono;
    handler: StubOperationsHandler;
    confirmService: StubConfirmService;
    sessionId: string;
    operatorId: string;
}

function buildHarness(opts: { sessionId?: string; operatorId?: string } = {}): Harness {
    const app = new Hono();
    const handler = new StubOperationsHandler();
    const confirmService = new StubConfirmService();
    const sessionId = opts.sessionId ?? "session-test";
    const operatorId = opts.operatorId ?? "alice";
    // Inject session/operator vars exactly as upstream auth middleware would.
    // sessionId / operatorId are NOT declared in ContextVariableMap (the
    // production wiring uses dedicated auth middleware that does the cast),
    // so we cast to a loose setter type here to mirror that pattern.
    app.use("*", async (c, next) => {
        const setLoose = c.set as (k: string, v: unknown) => void;
        setLoose("sessionId", sessionId);
        setLoose("operatorId", operatorId);
        await next();
    });
    registerOperationsRoutes(app, handler.asHandler(), confirmService);
    return { app, handler, confirmService, sessionId, operatorId };
}

async function jsonRequest(
    app: Hono,
    path: string,
    body: unknown,
): Promise<Response> {
    return await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
    });
}

let h: Harness;
beforeEach(() => {
    h = buildHarness();
});

describe("/ops/confirm-token", () => {
    test("400 when action missing", async () => {
        const res = await jsonRequest(h.app, "/ops/confirm-token", {});
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("UNKNOWN_ACTION");
    });

    test("400 when action is not in OPS_ACTIONS allowlist", async () => {
        const res = await jsonRequest(h.app, "/ops/confirm-token", {
            action: "delete-everything",
        });
        expect(res.status).toBe(400);
    });

    test("200 with token+phrase for kill-switch.engage", async () => {
        const res = await jsonRequest(h.app, "/ops/confirm-token", {
            action: "kill-switch.engage",
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            success: boolean;
            token: string;
            phrase: string;
            action: string;
            expiresIn: number;
        };
        expect(body.success).toBe(true);
        expect(body.token).toBe("tok-abc");
        expect(body.phrase).toBe("EMERGENCY STOP");
        expect(body.action).toBe("kill-switch.engage");
        expect(body.expiresIn).toBe(60);
    });

    test("forwards sessionId to the confirm service", async () => {
        await jsonRequest(h.app, "/ops/confirm-token", {
            action: "kill-switch.engage",
        });
        expect(h.confirmService.issuances).toHaveLength(1);
        expect(h.confirmService.issuances[0]?.sessionId).toBe(h.sessionId);
        expect(h.confirmService.issuances[0]?.action).toBe("kill-switch.engage");
    });

    test("429 when service reports rate-limit-exceeded", async () => {
        h.confirmService.nextResult = {
            success: false,
            error: "rate-limit-exceeded",
        };
        const res = await jsonRequest(h.app, "/ops/confirm-token", {
            action: "kill-switch.engage",
        });
        expect(res.status).toBe(429);
    });

    test("400 when service reports a non-rate-limit failure", async () => {
        h.confirmService.nextResult = {
            success: false,
            error: "unknown-action",
        };
        const res = await jsonRequest(h.app, "/ops/confirm-token", {
            action: "kill-switch.engage",
        });
        expect(res.status).toBe(400);
    });

    test("malformed JSON body falls back to empty body → 400", async () => {
        const res = await h.app.request("/ops/confirm-token", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{not json",
        });
        expect(res.status).toBe(400);
    });
});

describe("/ops/kill-switch/engage — typed-CONFIRM gate", () => {
    test("400 when confirmationToken missing", async () => {
        const res = await jsonRequest(h.app, "/ops/kill-switch/engage", {
            reason: "test",
            typedPhrase: "EMERGENCY STOP",
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { errorCode: string };
        expect(body.errorCode).toBe("INVALID_TOKEN");
        expect(h.handler.calls).toHaveLength(0);
    });

    test("400 when typedPhrase missing", async () => {
        const res = await jsonRequest(h.app, "/ops/kill-switch/engage", {
            reason: "test",
            confirmationToken: "tok-abc",
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { errorCode: string };
        expect(body.errorCode).toBe("INVALID_TOKEN");
        expect(h.handler.calls).toHaveLength(0);
    });

    test("400 with empty body", async () => {
        const res = await jsonRequest(h.app, "/ops/kill-switch/engage", {});
        expect(res.status).toBe(400);
        expect(h.handler.calls).toHaveLength(0);
    });

    test("200 happy path: forwards token, phrase, reason, identities", async () => {
        const res = await jsonRequest(h.app, "/ops/kill-switch/engage", {
            reason: "incident-response",
            confirmationToken: "tok-abc",
            typedPhrase: "EMERGENCY STOP",
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as OperationResult;
        expect(body.success).toBe(true);
        expect(body.intakeRequestId).toBe("req-1");

        expect(h.handler.calls).toHaveLength(1);
        const call = h.handler.calls[0];
        expect(call?.method).toBe("engage");
        expect(call?.reason).toBe("incident-response");
        expect(call?.operatorId).toBe(h.operatorId);
        expect(call?.confirmation).toEqual({
            token: "tok-abc",
            typedPhrase: "EMERGENCY STOP",
            sessionId: h.sessionId,
        });
    });

    test("400 when handler reports a validation failure (not INTAKE_FAILED)", async () => {
        h.handler.nextResult = {
            success: false,
            error: "Token expired",
            errorCode: "EXPIRED_TOKEN",
        };
        const res = await jsonRequest(h.app, "/ops/kill-switch/engage", {
            reason: "test",
            confirmationToken: "old-token",
            typedPhrase: "EMERGENCY STOP",
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as OperationResult;
        expect(body.errorCode).toBe("EXPIRED_TOKEN");
    });

    test("502 when handler reports INTAKE_FAILED", async () => {
        h.handler.nextResult = {
            success: false,
            error: "intake unreachable",
            errorCode: "INTAKE_FAILED",
        };
        const res = await jsonRequest(h.app, "/ops/kill-switch/engage", {
            reason: "test",
            confirmationToken: "tok-abc",
            typedPhrase: "EMERGENCY STOP",
        });
        expect(res.status).toBe(502);
        const body = (await res.json()) as OperationResult;
        expect(body.errorCode).toBe("INTAKE_FAILED");
    });

    test("falls back to anonymous when no upstream identity is set", async () => {
        const app = new Hono();
        const handler = new StubOperationsHandler();
        const confirmService = new StubConfirmService();
        registerOperationsRoutes(app, handler.asHandler(), confirmService);
        const res = await jsonRequest(app, "/ops/kill-switch/engage", {
            reason: "x",
            confirmationToken: "t",
            typedPhrase: "p",
        });
        expect(res.status).toBe(200);
        const call = handler.calls[0];
        expect(call?.operatorId).toBe("anonymous");
        expect(call?.confirmation.sessionId).toBe("anonymous");
    });
});

describe("/ops/kill-switch/reset", () => {
    test("200 happy path: routes to resetKillSwitch (no reason needed)", async () => {
        const res = await jsonRequest(h.app, "/ops/kill-switch/reset", {
            confirmationToken: "tok-abc",
            typedPhrase: "EMERGENCY STOP",
        });
        expect(res.status).toBe(200);
        const call = h.handler.calls[0];
        expect(call?.method).toBe("reset-kill");
        expect(call?.confirmation.token).toBe("tok-abc");
    });

    test("400 without typed-CONFIRM token", async () => {
        const res = await jsonRequest(h.app, "/ops/kill-switch/reset", {});
        expect(res.status).toBe(400);
        expect(h.handler.calls).toHaveLength(0);
    });
});

describe("/ops/circuit-breaker/reset", () => {
    test("200 happy path: routes to resetCircuitBreaker", async () => {
        const res = await jsonRequest(h.app, "/ops/circuit-breaker/reset", {
            confirmationToken: "tok-cb",
            typedPhrase: "RESET BREAKER",
        });
        expect(res.status).toBe(200);
        const call = h.handler.calls[0];
        expect(call?.method).toBe("reset-cb");
        expect(call?.confirmation).toEqual({
            token: "tok-cb",
            typedPhrase: "RESET BREAKER",
            sessionId: h.sessionId,
        });
    });

    test("400 without typed-CONFIRM token", async () => {
        const res = await jsonRequest(h.app, "/ops/circuit-breaker/reset", {});
        expect(res.status).toBe(400);
        expect(h.handler.calls).toHaveLength(0);
    });

    test("502 when handler reports INTAKE_FAILED", async () => {
        h.handler.nextResult = {
            success: false,
            error: "boom",
            errorCode: "INTAKE_FAILED",
        };
        const res = await jsonRequest(h.app, "/ops/circuit-breaker/reset", {
            confirmationToken: "tok-cb",
            typedPhrase: "RESET BREAKER",
        });
        expect(res.status).toBe(502);
    });
});

describe("Route guarding — only registered ops paths exist", () => {
    test("unrelated paths return 404", async () => {
        const res = await h.app.request("/ops/totally-fake", {
            method: "POST",
        });
        expect(res.status).toBe(404);
    });

    test("GET on a mutation endpoint returns 404 (POST-only)", async () => {
        const res = await h.app.request("/ops/kill-switch/engage", {
            method: "GET",
        });
        expect(res.status).toBe(404);
    });

    test("each registered action only fires its own handler method", async () => {
        // Hit each endpoint once with a valid body.
        const validBody = (extra: Record<string, unknown> = {}) => ({
            confirmationToken: "tok",
            typedPhrase: "phrase",
            ...extra,
        });
        await jsonRequest(h.app, "/ops/kill-switch/engage", validBody({ reason: "r" }));
        await jsonRequest(h.app, "/ops/kill-switch/reset", validBody());
        await jsonRequest(h.app, "/ops/circuit-breaker/reset", validBody());

        const methods = h.handler.calls.map((c) => c.method);
        expect(methods).toEqual(["engage", "reset-kill", "reset-cb"]);
    });
});

interface OpsActionAssertion {
    action: OpsAction;
    path: string;
}
const ALL_OPS: OpsActionAssertion[] = [
    { action: "kill-switch.engage", path: "/ops/kill-switch/engage" },
    { action: "kill-switch.reset", path: "/ops/kill-switch/reset" },
    { action: "circuit-breaker.reset", path: "/ops/circuit-breaker/reset" },
];

describe("typed-CONFIRM gate — applies uniformly to every mutation", () => {
    for (const { action, path } of ALL_OPS) {
        test(`${action}: missing token → 400`, async () => {
            const res = await jsonRequest(h.app, path, {});
            expect(res.status).toBe(400);
            expect(h.handler.calls).toHaveLength(0);
        });
    }
});
