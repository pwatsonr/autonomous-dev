// SPEC-013-2-02 §Task 4 — Error boundary middleware.
//
// Catches any exception thrown inside downstream handlers, logs the full
// detail (with stack) to stderr, sanitizes the user-visible message, and
// produces JSON or HTML based on the request's Accept header. Stack traces
// and raw messages NEVER leak to clients.
//
// MUST run AFTER requestIdMiddleware (so c.var.requestId is set) and AFTER
// structuredLogger (so the access log line still records the final status
// code for failed requests).

import type { MiddlewareHandler } from "hono";

import { sanitizeErrorMessage } from "../lib/sanitize";

export class PortalError extends Error {
    public readonly code: string;
    public readonly statusCode: number;
    public readonly context: Record<string, unknown> | undefined;

    constructor(
        code: string,
        message: string,
        statusCode = 500,
        context?: Record<string, unknown>,
    ) {
        super(message);
        this.name = "PortalError";
        this.code = code;
        this.statusCode = statusCode;
        this.context = context;
    }
}

// Convenience factories for the common error shapes used by route handlers.
export const Errors = {
    NotFound: (resource = "Resource"): PortalError =>
        new PortalError("NOT_FOUND", `${resource} not found`, 404),
    BadRequest: (msg: string): PortalError =>
        new PortalError("BAD_REQUEST", msg, 400),
    Unauthorized: (msg = "Authentication required"): PortalError =>
        new PortalError("UNAUTHORIZED", msg, 401),
    Forbidden: (msg = "Access denied"): PortalError =>
        new PortalError("FORBIDDEN", msg, 403),
    ValidationError: (msg: string): PortalError =>
        new PortalError("VALIDATION_ERROR", msg, 422),
    PayloadTooLarge: (limit: number): PortalError =>
        new PortalError(
            "PAYLOAD_TOO_LARGE",
            `Request exceeds ${String(limit)} bytes`,
            413,
        ),
    Internal: (msg = "Internal server error"): PortalError =>
        new PortalError("INTERNAL_ERROR", msg, 500),
    Unavailable: (svc: string): PortalError =>
        new PortalError(
            "SERVICE_UNAVAILABLE",
            `${svc} is currently unavailable`,
            503,
        ),
};

export function errorHandler(): MiddlewareHandler {
    return async (c, next) => {
        try {
            await next();
        } catch (err) {
            const requestId = c.var.requestId ?? "unknown";
            const isPortal = err instanceof PortalError;
            const status = isPortal ? err.statusCode : 500;
            const code = isPortal ? err.code : "INTERNAL_ERROR";
            const safeMsg = isPortal
                ? sanitizeErrorMessage(err.message)
                : "An internal server error occurred";

            // Always log the FULL detail (including stack) to stderr; never
            // echo to the client.
            const e = err as Error;
            process.stderr.write(
                JSON.stringify({
                    ts: new Date().toISOString(),
                    level: "error",
                    request_id: requestId,
                    path: c.req.path,
                    method: c.req.method,
                    code,
                    message: e.message,
                    stack: e.stack,
                }) + "\n",
            );

            // Default to JSON when no Accept header is provided.
            const accept = c.req.header("accept") ?? "";
            const wantsJson =
                accept === "" ||
                accept.includes("application/json") ||
                accept === "*/*";
            if (wantsJson) {
                return c.json(
                    {
                        error: {
                            code,
                            message: safeMsg,
                            request_id: requestId,
                        },
                    },
                    // The Hono types accept ContentfulStatusCode; cast safe
                    // because all PortalError statusCodes are valid HTTP.
                    status as 400 | 401 | 403 | 404 | 413 | 422 | 500 | 503,
                );
            }
            // Inline HTML fallback. PLAN-013-3 may swap in a JSX template.
            return c.html(
                `<!doctype html><html><head><title>Error ${String(status)}</title></head>` +
                    `<body><h1>Error ${String(status)}</h1><p>${safeMsg}</p>` +
                    `<p><small>Request ID: ${requestId}</small></p></body></html>`,
                status as 400 | 401 | 403 | 404 | 413 | 422 | 500 | 503,
            );
        }
        return undefined;
    };
}
