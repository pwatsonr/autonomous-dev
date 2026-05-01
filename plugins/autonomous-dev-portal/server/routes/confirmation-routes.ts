// SPEC-014-2-02 §Confirmation Routes — POST endpoints for the typed-CONFIRM
// flow.
//
// `POST /api/security/confirmation/request` — caller posts {action} and
// receives {token, phrase, ttl} or an error envelope. Auth + CSRF MUST run
// in front of this route (registered via registerConfirmationRoutes after
// the security middleware chain).
//
// `POST /api/security/confirmation/validate` — caller posts {token,
// userInput} and receives {valid:true, action} on success or {valid:false,
// error} on failure. Successful validations also stage a record on the
// underlying session store via the supplied `recordConfirmation` callback;
// the destructive route's `requireConfirmation(action)` middleware reads
// that record back.
//
// Both endpoints emit JSON only — no template rendering, no HX-aware
// branching. The modal is a client-rendered partial (PLAN-013-3 portal
// templates own the HTML).

import type { Hono } from "hono";

import type { TypedConfirmationService } from "../security/confirmation-tokens";

const STATUS_400 = 400;
const STATUS_401 = 401;
const STATUS_429 = 429;

/**
 * Per-request session lookup used by both endpoints to bind the token to
 * a stable session id. Defaults to the auth context's `source_user_id`.
 */
export type SessionIdResolver = (request: Request, ctxAuth: unknown) => string | undefined;

export interface RecordedConfirmation {
    action: string;
    metadata: Record<string, unknown>;
    validatedAt: number;
    expiresAt: number;
}

/**
 * Stores the result of a successful validation so the destructive route's
 * `requireConfirmation(action)` middleware can consume it. Implementations
 * SHOULD scope the storage by sessionId so cross-session reuse is not
 * possible.
 */
export interface ConfirmationStore {
    record(sessionId: string, token: string, value: RecordedConfirmation): void;
    consume(sessionId: string, token: string): RecordedConfirmation | undefined;
}

/**
 * Default in-memory store. Single-instance, like the underlying
 * confirmation token store. PLAN-014-3 will swap a Redis-backed
 * implementation in via this same interface.
 */
export class InMemoryConfirmationStore implements ConfirmationStore {
    private readonly store = new Map<string, RecordedConfirmation>();

    record(
        sessionId: string,
        token: string,
        value: RecordedConfirmation,
    ): void {
        this.store.set(this.key(sessionId, token), value);
    }

    consume(
        sessionId: string,
        token: string,
    ): RecordedConfirmation | undefined {
        const k = this.key(sessionId, token);
        const v = this.store.get(k);
        if (v === undefined) return undefined;
        if (Date.now() > v.expiresAt) {
            this.store.delete(k);
            return undefined;
        }
        // One-time use.
        this.store.delete(k);
        return v;
    }

    private key(sessionId: string, token: string): string {
        return `${sessionId}:${token}`;
    }
}

export interface ConfirmationRouteDeps {
    service: TypedConfirmationService;
    store: ConfirmationStore;
    /**
     * Resolves the session id for the request. Defaults to using the
     * authenticated user's source_user_id from `c.get('auth')`.
     */
    getSessionId?: (request: Request, auth: unknown) => string | undefined;
    /** Validation result lifetime once recorded — defaults to 30s per spec. */
    confirmationGraceMs?: number;
}

interface RequestBody {
    action?: unknown;
    metadata?: unknown;
}

interface ValidateBody {
    token?: unknown;
    userInput?: unknown;
}

function defaultSessionId(_req: Request, auth: unknown): string | undefined {
    if (auth === null || typeof auth !== "object") return undefined;
    const a = auth as { source_user_id?: unknown };
    if (typeof a.source_user_id === "string" && a.source_user_id.length > 0) {
        return a.source_user_id;
    }
    return undefined;
}

/**
 * Mounts the two confirmation endpoints on the supplied Hono app.
 *
 * NOTE: this is a route-only registration. CSRF / auth middleware must be
 * applied globally (security-middleware.ts) so that these endpoints are
 * NOT exempt from CSRF — the spec explicitly requires that the confirm
 * flow does not bypass CSRF.
 */
export function registerConfirmationRoutes(
    app: Hono,
    deps: ConfirmationRouteDeps,
): void {
    const getSession = deps.getSessionId ?? defaultSessionId;
    const grace = deps.confirmationGraceMs ?? 30_000;

    app.post("/api/security/confirmation/request", async (c) => {
        const sessionId = getSession(c.req.raw, c.get("auth"));
        if (sessionId === undefined) {
            return c.json(
                { error: "no-session", message: "Session required" },
                STATUS_401,
            );
        }
        let body: RequestBody = {};
        try {
            body = (await c.req.json()) as RequestBody;
        } catch {
            return c.json({ error: "invalid-body" }, STATUS_400);
        }
        if (typeof body.action !== "string" || body.action.length === 0) {
            return c.json({ error: "invalid-body" }, STATUS_400);
        }
        const metadata =
            body.metadata !== undefined &&
            body.metadata !== null &&
            typeof body.metadata === "object" &&
            !Array.isArray(body.metadata)
                ? (body.metadata as Record<string, unknown>)
                : {};

        const result = deps.service.generateConfirmationToken(sessionId, {
            action: body.action,
            metadata,
        });
        if (!result.success) {
            const status = result.error === "rate-limit-exceeded"
                ? STATUS_429
                : STATUS_400;
            return c.json({ error: result.error }, status);
        }
        return c.json(
            {
                token: result.token,
                phrase: result.phrase,
                ttl: result.ttl,
            },
            200,
        );
    });

    app.post("/api/security/confirmation/validate", async (c) => {
        const sessionId = getSession(c.req.raw, c.get("auth"));
        if (sessionId === undefined) {
            return c.json(
                { error: "no-session", message: "Session required" },
                STATUS_401,
            );
        }
        let body: ValidateBody = {};
        try {
            body = (await c.req.json()) as ValidateBody;
        } catch {
            return c.json({ error: "invalid-body" }, STATUS_400);
        }
        if (
            typeof body.token !== "string" ||
            body.token.length === 0 ||
            typeof body.userInput !== "string"
        ) {
            return c.json({ error: "invalid-body" }, STATUS_400);
        }
        const result = deps.service.validateConfirmation(
            body.token,
            sessionId,
            body.userInput,
        );
        if (!result.valid) {
            return c.json({ error: result.error, valid: false }, STATUS_400);
        }
        const now = Date.now();
        deps.store.record(sessionId, body.token, {
            action: result.action ?? "",
            metadata: result.metadata ?? {},
            validatedAt: now,
            expiresAt: now + grace,
        });
        return c.json(
            { valid: true, action: result.action },
            200,
        );
    });
}

/**
 * Middleware factory for protecting destructive routes. Reads the
 * `X-Confirmation-Token` header (or `_confirmationToken` body field on
 * urlencoded posts) and consumes the recorded confirmation.
 *
 * Errors:
 *   - confirmation-required:  no token presented
 *   - invalid-confirmation:   token not in store
 *   - wrong-action-confirmed: token belongs to a different action
 *   - confirmation-expired:   grace window elapsed
 */
export function requireConfirmation(
    action: string,
    deps: { store: ConfirmationStore; getSessionId?: ConfirmationRouteDeps["getSessionId"] },
): import("hono").MiddlewareHandler {
    const getSession = deps.getSessionId ?? defaultSessionId;
    return async (c, next) => {
        const sessionId = getSession(c.req.raw, c.get("auth"));
        if (sessionId === undefined) {
            return c.json(
                { error: "no-session", message: "Session required" },
                STATUS_401,
            );
        }
        let token = c.req.header("x-confirmation-token");
        if (token === undefined || token.length === 0) {
            try {
                const body = (await c.req.parseBody()) as Record<
                    string,
                    unknown
                >;
                const fromBody = body["_confirmationToken"];
                if (typeof fromBody === "string") token = fromBody;
            } catch {
                /* fall through */
            }
        }
        if (token === undefined || token.length === 0) {
            return c.json(
                { error: "confirmation-required", action },
                403,
            );
        }
        const record = deps.store.consume(sessionId, token);
        if (record === undefined) {
            // Either never recorded, or grace window elapsed (consume()
            // deletes expired entries lazily and returns undefined).
            return c.json({ error: "invalid-confirmation" }, 403);
        }
        if (record.action !== action) {
            return c.json({ error: "wrong-action-confirmed" }, 403);
        }
        return next();
    };
}
