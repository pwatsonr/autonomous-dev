// SPEC-014-2-01 — CSRF protection: token store, double-submit cookie,
// origin validation, and Hono middleware factory.
//
// The implementation follows the spec literally with one mapping: the spec
// describes Express middleware, but the portal runs on Hono, so the
// middleware factory returns a `MiddlewareHandler` and reads request shape
// via `c.req` (`header()`, `parseBody()`, `query()`, `path`, `method`).
// The "session id" is taken from `c.get('auth')?.source_user_id` — the
// existing auth middleware (PLAN-014-1) populates this on every
// authenticated request. The `excludePaths` default also includes
// `/auth/*` so the OAuth callback flow does not require its own CSRF token
// (the OAuth state parameter already provides equivalent protection).
//
// Token store and rate state are module-instance state — single-instance
// only. Multi-instance moves to a shared store in PLAN-014-3.

import type { Context, MiddlewareHandler } from "hono";

import { hmacSign, randomToken, timingSafeCompare } from "./crypto-utils";
import type {
    CSRFConfig,
    CSRFToken,
    OriginValidationResult,
} from "./types";
import { SecurityError } from "./types";

/** State-changing methods subject to CSRF enforcement. */
const PROTECTED_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/** Methods explicitly skipped (safe per RFC 9110 §9.2.1). */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Cleanup cadence — see SPEC-014-2-01 §Token Infrastructure. */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Default exclusion list — public endpoints that must accept anon POSTs. */
const DEFAULT_EXCLUDE_PATHS = [
    "/api/public",
    "/health",
    "/metrics",
    "/csp-violation-report",
    "/auth", // OAuth callback uses state-param protection
];

/**
 * Build a {@link CSRFConfig} from environment-provided overrides. Pure
 * function so callers (and tests) can supply their own values without
 * touching `process.env`. Throws SecurityError when the secret is the
 * documented placeholder and NODE_ENV === 'production'.
 */
export function buildCSRFConfig(
    overrides: Partial<CSRFConfig> = {},
    env: NodeJS.ProcessEnv = process.env,
): CSRFConfig {
    const secretKey =
        overrides.secretKey ??
        env["CSRF_SECRET_KEY"] ??
        "change-me-in-production";
    if (
        secretKey === "change-me-in-production" &&
        env["NODE_ENV"] === "production"
    ) {
        throw new SecurityError(
            "CSRF_SECRET_NOT_CONFIGURED",
            "CSRF_SECRET_KEY must be set to a non-default value in production",
        );
    }
    return {
        tokenTTL: overrides.tokenTTL ?? 24 * 60 * 60 * 1000,
        cookieName: overrides.cookieName ?? "__csrf_signature",
        headerName: overrides.headerName ?? "X-CSRF-Token",
        excludePaths: overrides.excludePaths ?? DEFAULT_EXCLUDE_PATHS,
        secretKey,
        maxTokensInMemory: overrides.maxTokensInMemory ?? 10_000,
    };
}

/**
 * In-memory CSRF token store with double-submit cookie pattern. Per
 * SPEC-014-2-01 §Token Infrastructure:
 *
 *   token = randomBytes(32).hex            (64 chars)
 *   sig   = HMAC-SHA256(secret, token + ':' + sessionId).hex
 *
 * The token goes into the request as a header (or form field), the sig
 * goes into an httpOnly cookie. An attacker on a different origin can set
 * neither — that IS the double-submit guarantee.
 */
export class CSRFProtection {
    private readonly config: CSRFConfig;
    private readonly tokenStore = new Map<string, CSRFToken>();
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

    constructor(config: CSRFConfig) {
        this.config = config;
    }

    /**
     * Issue a fresh token for a session. Returns both the raw token (sent
     * to the client as a header / meta tag) and the signature (set as the
     * httpOnly double-submit cookie). LRU evicts the oldest 10% when the
     * store exceeds {@link CSRFConfig.maxTokensInMemory}.
     */
    async generateTokenForSession(
        sessionId: string,
    ): Promise<{ token: string; signature: string }> {
        const token = randomToken(32);
        const signature = await hmacSign(
            this.config.secretKey,
            `${token}:${sessionId}`,
        );
        this.tokenStore.set(token, {
            value: token,
            createdAt: Date.now(),
            sessionId,
        });
        if (this.tokenStore.size > this.config.maxTokensInMemory) {
            this.evictOldest();
        }
        return { token, signature };
    }

    /**
     * Validate a (token, signature, sessionId) triple. Returns true only
     * when the token exists, the session matches, the TTL has not lapsed,
     * and the signature matches in constant time. Expired tokens are
     * deleted from the store as a side-effect (lazy cleanup); a periodic
     * sweep handles the rest (see {@link startCleanup}).
     */
    async validateToken(
        token: string,
        signature: string,
        sessionId: string,
    ): Promise<boolean> {
        const stored = this.tokenStore.get(token);
        if (stored === undefined) return false;
        if (stored.sessionId !== sessionId) return false;
        if (Date.now() - stored.createdAt > this.config.tokenTTL) {
            this.tokenStore.delete(token);
            return false;
        }
        const expected = await hmacSign(
            this.config.secretKey,
            `${token}:${sessionId}`,
        );
        // Length check FIRST (see SPEC-014-2-01 §Notes — timingSafeEqual
        // throws on length mismatch).
        if (signature.length !== expected.length) return false;
        return timingSafeCompare(signature, expected);
    }

    /** Drop a single token (e.g. on logout or after destructive confirm). */
    invalidateToken(token: string): void {
        this.tokenStore.delete(token);
    }

    /**
     * Sweep tokens older than `tokenTTL`. Iteration over `entries()` is
     * snapshot-safe in single-threaded JS — see SPEC-014-2-02 §Notes for
     * the same rationale.
     */
    cleanupExpiredTokens(): void {
        const cutoff = Date.now() - this.config.tokenTTL;
        for (const [k, v] of this.tokenStore.entries()) {
            if (v.createdAt < cutoff) this.tokenStore.delete(k);
        }
    }

    /** Start the 5-minute cleanup interval. Test-only: pass an immediate=true. */
    startCleanup(): void {
        if (this.cleanupTimer !== null) return;
        this.cleanupTimer = setInterval(
            () => this.cleanupExpiredTokens(),
            CLEANUP_INTERVAL_MS,
        );
        // Bun / Node: don't keep the event loop alive on a daemon that's
        // otherwise idle.
        const t = this.cleanupTimer as { unref?: () => void };
        if (typeof t.unref === "function") t.unref();
    }

    /** Stop the cleanup interval (graceful shutdown). */
    stopCleanup(): void {
        if (this.cleanupTimer !== null) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }

    /** Test introspection: how many tokens are alive right now. */
    get storeSize(): number {
        return this.tokenStore.size;
    }

    /** Test introspection: does the store still have this token? */
    has(token: string): boolean {
        return this.tokenStore.has(token);
    }

    private evictOldest(): void {
        const target = Math.ceil(this.config.maxTokensInMemory * 0.1);
        const entries = Array.from(this.tokenStore.entries()).sort(
            (a, b) => a[1].createdAt - b[1].createdAt,
        );
        for (let i = 0; i < target && i < entries.length; i += 1) {
            const entry = entries[i];
            if (entry !== undefined) this.tokenStore.delete(entry[0]);
        }
    }
}

/**
 * Configuration for {@link OriginValidator}. `allowedOrigins` is matched
 * exactly except for wildcard entries like `*.example.com` which are
 * accepted ONLY when `nodeEnv !== 'production'`.
 */
export interface OriginValidatorConfig {
    allowedOrigins: string[];
    nodeEnv: string;
}

/**
 * Validates the Origin / Referer header for state-changing requests. Pure
 * with respect to the request — no IO, no logging — so the middleware
 * controls error response shape.
 */
export class OriginValidator {
    private readonly config: OriginValidatorConfig;
    private readonly cache = new Map<string, string>();
    private static readonly CACHE_LIMIT = 256;

    constructor(config: OriginValidatorConfig) {
        this.config = config;
    }

    validateRequest(
        method: string,
        origin: string | undefined,
        referer: string | undefined,
    ): OriginValidationResult {
        if (SAFE_METHODS.has(method.toUpperCase())) return { valid: true };

        const raw = origin ?? referer;
        if (raw === undefined || raw.length === 0) {
            return { valid: false, reason: "missing-origin-and-referer" };
        }

        let normalized: string;
        const cached = this.cache.get(raw);
        if (cached !== undefined) {
            normalized = cached;
        } else {
            try {
                const url = new URL(raw);
                normalized = `${url.protocol}//${url.host}`;
            } catch {
                return { valid: false, reason: "malformed-origin" };
            }
            // Bounded cache; drop arbitrary entry on overflow.
            if (this.cache.size >= OriginValidator.CACHE_LIMIT) {
                const first = this.cache.keys().next().value;
                if (first !== undefined) this.cache.delete(first);
            }
            this.cache.set(raw, normalized);
        }

        for (const allowed of this.config.allowedOrigins) {
            if (allowed === normalized) return { valid: true };
            if (allowed.startsWith("*.")) {
                if (this.config.nodeEnv === "production") {
                    return {
                        valid: false,
                        reason: "wildcard-rejected-in-production",
                    };
                }
                const suffix = allowed.slice(1); // ".example.com"
                if (normalized.endsWith(suffix)) return { valid: true };
            }
        }
        return { valid: false, reason: "origin-not-allowed" };
    }
}

/**
 * Minimal log surface — the spec keeps this internal so providers can
 * inject their own structured loggers (e.g. `defaultAuthLogger`).
 */
export interface CSRFLogger {
    info(event: string, fields?: Record<string, unknown>): void;
    warn(event: string, fields?: Record<string, unknown>): void;
    error(event: string, fields?: Record<string, unknown>): void;
}

function noopLogger(): CSRFLogger {
    return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

/**
 * Build the cookie attribute string for the double-submit signature.
 * Cookie name is configurable; secure flag flips with NODE_ENV=production.
 */
export function buildCSRFCookie(
    config: CSRFConfig,
    signature: string,
    nodeEnv: string = process.env["NODE_ENV"] ?? "development",
): string {
    const parts = [
        `${config.cookieName}=${signature}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        `Max-Age=${Math.floor(config.tokenTTL / 1000)}`,
    ];
    if (nodeEnv === "production") parts.push("Secure");
    return parts.join("; ");
}

/**
 * Read a single cookie value out of the request's Cookie header. Returns
 * undefined when not present or when the header is malformed.
 */
function readCookie(
    cookieHeader: string | undefined,
    name: string,
): string | undefined {
    if (cookieHeader === undefined) return undefined;
    for (const piece of cookieHeader.split(";")) {
        const [k, ...rest] = piece.trim().split("=");
        if (k === name) return rest.join("=");
    }
    return undefined;
}

function isHtmxRequest(c: Context): boolean {
    if (c.req.header("hx-request") === "true") return true;
    if (c.req.header("x-requested-with") === "XMLHttpRequest") return true;
    const accept = c.req.header("accept") ?? "";
    return accept.includes("application/json");
}

/**
 * Build the deny response for a CSRF violation. HTMX/JSON callers get a
 * stable JSON envelope; browser callers get a minimal HTML page that does
 * NOT leak token/session details (matches PLAN-014-1 error envelope).
 */
async function sendCSRFError(
    c: Context,
    reason: string,
    logger: CSRFLogger,
): Promise<Response> {
    logger.warn("csrf_violation", {
        reason,
        method: c.req.method,
        path: c.req.path,
        request_id: c.var.requestId ?? "unknown",
    });
    if (isHtmxRequest(c)) {
        return c.json(
            {
                error: "CSRF_TOKEN_INVALID",
                message:
                    "Security token validation failed. Please refresh the page.",
                code: "SECURITY_VIOLATION",
                reason,
            },
            403,
        );
    }
    return c.html(
        `<!doctype html><html><head><title>Security Error</title></head>` +
            `<body><h1>Security Error</h1><p>Your request could not be processed due to a security check failure. Please refresh the page and try again.</p>` +
            `<p><small>Code: CSRF_INVALID</small></p></body></html>`,
        403,
    );
}

/**
 * Public deps for the CSRF middleware factory. Tests and `server.ts` both
 * inject these so the module can be exercised without process-global state.
 */
export interface CSRFMiddlewareDeps {
    csrf: CSRFProtection;
    origin: OriginValidator;
    config: CSRFConfig;
    logger?: CSRFLogger;
    /**
     * Resolves the session-id used to bind the token. Defaults to the
     * authenticated user's `source_user_id`. Tests may inject a fixed id.
     */
    getSessionId?: (c: Context) => string | undefined;
}

/**
 * Hono middleware that enforces CSRF on state-changing requests. The
 * factory shape mirrors `auth/middleware/auth-context.ts` so wiring in
 * `applyMiddlewareChain` is symmetrical.
 *
 * Order requirement (set by SPEC-014-2-01 §Middleware Registration):
 *   request-id → logger → secure-headers → CSP → auth → CSRF
 */
export function csrfMiddleware(deps: CSRFMiddlewareDeps): MiddlewareHandler {
    const log = deps.logger ?? noopLogger();
    const getSession =
        deps.getSessionId ??
        ((c: Context): string | undefined => c.get("auth")?.source_user_id);

    return async (c, next) => {
        const method = c.req.method.toUpperCase();
        const path = c.req.path;

        // Safe methods are not CSRF-relevant.
        if (SAFE_METHODS.has(method)) return next();

        // Defensive: only the documented set of methods reaches enforcement.
        if (!PROTECTED_METHODS.has(method)) return next();

        // Excluded paths (CSP report, /health, public APIs, OAuth callback).
        for (const prefix of deps.config.excludePaths) {
            if (path.startsWith(prefix)) return next();
        }

        // Origin / Referer fence. Cheap; runs before token lookup.
        const originResult = deps.origin.validateRequest(
            method,
            c.req.header("origin"),
            c.req.header("referer"),
        );
        if (!originResult.valid) {
            return sendCSRFError(c, originResult.reason ?? "origin-invalid", log);
        }

        const sessionId = getSession(c);
        if (sessionId === undefined || sessionId.length === 0) {
            return sendCSRFError(c, "no-valid-session", log);
        }

        // Header is canonical; body / query are fallbacks for non-HTMX
        // forms. Body parse is best-effort — failures are treated as
        // missing token, not server errors.
        let token = c.req.header(deps.config.headerName.toLowerCase());
        if (token === undefined || token.length === 0) {
            try {
                const body = (await c.req.parseBody()) as Record<
                    string,
                    unknown
                >;
                const fromBody = body["_csrf"];
                if (typeof fromBody === "string") token = fromBody;
            } catch {
                /* no body or wrong content-type — fall through */
            }
        }
        if (token === undefined || token.length === 0) {
            const fromQuery = c.req.query("_csrf");
            if (fromQuery !== undefined && fromQuery.length > 0) token = fromQuery;
        }

        const signature = readCookie(
            c.req.header("cookie"),
            deps.config.cookieName,
        );

        if (
            token === undefined ||
            token.length === 0 ||
            signature === undefined ||
            signature.length === 0
        ) {
            return sendCSRFError(c, "missing-token-or-signature", log);
        }

        const ok = await deps.csrf.validateToken(token, signature, sessionId);
        if (!ok) return sendCSRFError(c, "invalid-csrf-token", log);

        c.set("csrfToken", token);
        return next();
    };
}

/**
 * Per-GET token refresh middleware. Issues a fresh token for the
 * authenticated session and stores it on the context (for templates) +
 * sets the double-submit cookie. Callers SHOULD mount this on the page-
 * rendering routes, not on JSON APIs (which already have a token from a
 * prior page render).
 */
export function csrfTokenIssuer(deps: CSRFMiddlewareDeps): MiddlewareHandler {
    const getSession =
        deps.getSessionId ??
        ((c: Context): string | undefined => c.get("auth")?.source_user_id);
    return async (c, next) => {
        if (c.req.method.toUpperCase() !== "GET") return next();
        const sessionId = getSession(c);
        if (sessionId === undefined || sessionId.length === 0) return next();

        const { token, signature } = await deps.csrf.generateTokenForSession(
            sessionId,
        );
        c.set("csrfToken", token);
        c.header("Set-Cookie", buildCSRFCookie(deps.config, signature));
        return next();
    };
}
