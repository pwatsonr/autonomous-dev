// SPEC-013-4-03 §Error Context Builder.
//
// Pure logic for translating an arbitrary thrown value into a sanitized
// `ErrorContext` consumed by `ErrorPage`. The single responsibility is to
// keep the "what does the client see" decision in ONE place, separated
// from any HTTP / Hono concerns. Templates accept the resulting context
// and render — they never inspect the raw error.
//
// Production posture (default when NODE_ENV !== 'development'):
//   - For known PortalError instances: surface only the curated, safe
//     `userMessage` (or the per-status default).
//   - For unknown errors: NEVER include err.message, err.stack, file
//     paths, env vars, or SQL fragments. Return only the generic per-
//     status message.
//   - `details` is undefined → `<ErrorDetails>` renders nothing.
//
// Development posture (NODE_ENV === 'development'):
//   - `message` echoes err.message (truncated at 500 chars).
//   - `details` includes err.stack with home directory paths replaced
//     by `~` (so screenshots / pasted reports don't leak usernames).
//
// The full unredacted error is logged server-side by the caller; this
// module returns the client-safe view only.

import type { Context } from "hono";

import { PortalError } from "../middleware/error-handler";

export type ErrorStatusCode = 403 | 404 | 422 | 500 | 503;

/**
 * Daemon health snapshot used by the 503 troubleshooting fragment. Kept
 * deliberately optional — when the upstream middleware that injects
 * health into `c` is not present, the fragment renders nothing.
 */
export interface DaemonHealth {
    status: string;
    message: string;
    lastHeartbeat?: Date;
    stalenessSeconds?: number;
}

/**
 * Sanitized view of an error suitable for rendering to clients. Built by
 * `buildErrorContext`. Never carries a stack trace, file path, or
 * unredacted `err.message` in production.
 */
export interface ErrorContext {
    statusCode: ErrorStatusCode;
    /** User-safe message. NEVER raw `err.message` for unknown errors in prod. */
    message: string;
    /** Sanitized stack/details, undefined in production. */
    details?: string;
    requestPath?: string;
    daemonHealth?: DaemonHealth;
}

/** Per-status fallback messages. Bland by design — operators see full
 * detail in server logs, clients see only this. */
export const STATUS_DEFAULT_MESSAGES: Readonly<Record<ErrorStatusCode, string>> = {
    403: "You do not have permission to access this resource.",
    404: "The requested page does not exist.",
    422: "The request contains invalid data. Please check your input.",
    500: "Something went wrong. The error has been logged.",
    503: "The service is temporarily unavailable.",
};

/** Per-status human-readable titles for `<h1>` and `<title>`. */
export const STATUS_TITLES: Readonly<Record<ErrorStatusCode, string>> = {
    403: "Forbidden",
    404: "Page Not Found",
    422: "Invalid Request",
    500: "Internal Server Error",
    503: "Service Unavailable",
};

const MAX_DEV_MESSAGE_LEN = 500;

interface MaybeUserFacingError {
    userMessage?: unknown;
    statusCode?: unknown;
    code?: unknown;
}

/**
 * Resolve the operating mode WITHOUT inverting it (the inversion is the
 * caller's job). Production is the default — only the literal string
 * `"development"` enables developer-mode rendering. This is the security
 * boundary referenced in the SPEC §Notes: prod-mode redaction must NOT
 * be bypassable by misconfigured / unset env vars.
 */
function effectiveMode(
    mode?: "development" | "production",
): "development" | "production" {
    if (mode === "development" || mode === "production") return mode;
    return process.env["NODE_ENV"] === "development"
        ? "development"
        : "production";
}

/**
 * Replace home-directory prefixes (e.g. `/Users/<user>/`, `/home/<user>/`)
 * with `~/` in a stack-trace string. Keeps the file path structure intact
 * so the developer can navigate to the file, but redacts the username
 * from screenshots, pasted reports, and bug tickets.
 */
function redactHomePaths(input: string): string {
    return input
        .replace(/\/Users\/[^/\s)]+/g, "~")
        .replace(/\/home\/[^/\s)]+/g, "~");
}

/** Truncate a string at `max` chars, adding an ellipsis when shortened. */
function truncate(input: string, max: number): string {
    if (input.length <= max) return input;
    return `${input.slice(0, max - 1)}…`;
}

/**
 * Returns the HTTP status code for `err`, mapped from PortalError /
 * known names. Falls back to 500 for everything unrecognized.
 */
export function statusCodeFor(err: unknown): ErrorStatusCode {
    if (err instanceof PortalError) {
        const sc = err.statusCode;
        if (sc === 403 || sc === 404 || sc === 422 || sc === 500 || sc === 503) {
            return sc;
        }
        // 4xx that we map to 422 by default to avoid leaking new status
        // codes through the unified template; this is the conservative
        // choice. PortalError 401/413/etc still go through the
        // JSON-oriented errorHandler middleware.
        return 500;
    }
    if (err instanceof Error) {
        // Allow legacy / contributor code to set a `statusCode` field.
        const sc = (err as MaybeUserFacingError).statusCode;
        if (sc === 403 || sc === 404 || sc === 422 || sc === 500 || sc === 503) {
            return sc;
        }
        // Check `name` for the spec's named error classes. We do not
        // import them — the spec lists them as future additions in
        // server/lib/errors.ts — so we match by name string instead.
        switch (err.name) {
            case "NotFoundError":
                return 404;
            case "ValidationError":
                return 422;
            case "ForbiddenError":
                return 403;
            case "DaemonUnreachableError":
                return 503;
            default:
                return 500;
        }
    }
    return 500;
}

/**
 * Pure sanitizer: produces the user-safe `{ message, details? }` for an
 * arbitrary thrown value. This is the function called from production
 * code; it never logs or throws.
 */
export function sanitizeError(
    err: unknown,
    mode?: "development" | "production",
): { message: string; details?: string } {
    const effective = effectiveMode(mode);
    const status = statusCodeFor(err);
    const fallback = STATUS_DEFAULT_MESSAGES[status];

    if (effective === "production") {
        // Known PortalError → curated message. We accept the message
        // because PortalError's contract requires safe text.
        if (err instanceof PortalError) {
            return { message: err.message };
        }
        // Allow opt-in through a `userMessage` property. Anything else
        // is replaced with the bland default.
        if (err !== null && typeof err === "object") {
            const candidate = (err as MaybeUserFacingError).userMessage;
            if (typeof candidate === "string" && candidate.length > 0) {
                return { message: candidate };
            }
        }
        return { message: fallback };
    }

    // Development mode: show the actual error info but redact home dirs.
    if (err instanceof Error) {
        const message = truncate(err.message || fallback, MAX_DEV_MESSAGE_LEN);
        const stack = typeof err.stack === "string" ? err.stack : "";
        const details = stack.length > 0 ? redactHomePaths(stack) : undefined;
        return { message, details };
    }
    if (typeof err === "string") {
        return { message: truncate(err, MAX_DEV_MESSAGE_LEN) };
    }
    return { message: fallback };
}

/**
 * Best-effort accessor for `c.get('daemonHealth')` — typed loosely
 * because the upstream middleware that injects this is owned by a
 * different spec and may not be present in every deployment.
 */
function tryGetDaemonHealth(c: Context): DaemonHealth | undefined {
    try {
        const candidate = (c as unknown as {
            get: (k: string) => unknown;
        }).get("daemonHealth");
        if (candidate !== null && typeof candidate === "object") {
            const obj = candidate as Record<string, unknown>;
            const status = obj["status"];
            const message = obj["message"];
            if (typeof status === "string" && typeof message === "string") {
                const lastHeartbeat =
                    obj["lastHeartbeat"] instanceof Date
                        ? (obj["lastHeartbeat"] as Date)
                        : undefined;
                const staleness =
                    typeof obj["stalenessSeconds"] === "number"
                        ? (obj["stalenessSeconds"] as number)
                        : undefined;
                const out: DaemonHealth = { status, message };
                if (lastHeartbeat !== undefined) out.lastHeartbeat = lastHeartbeat;
                if (staleness !== undefined) out.stalenessSeconds = staleness;
                return out;
            }
        }
    } catch {
        // ignore; daemonHealth is optional context
    }
    return undefined;
}

/** Strip the query string from a request path (e.g. `/foo?x=1` → `/foo`). */
function pathWithoutQuery(path: string): string {
    const q = path.indexOf("?");
    return q < 0 ? path : path.slice(0, q);
}

/**
 * Builds the full sanitized `ErrorContext` for a thrown value within a
 * Hono request. The caller (typically `app.onError`) is responsible for
 * logging the unredacted error to stderr; this function never logs.
 */
export function buildErrorContext(
    err: unknown,
    c: Context,
    mode?: "development" | "production",
): ErrorContext {
    const statusCode = statusCodeFor(err);
    const { message, details } = sanitizeError(err, mode);
    const ctx: ErrorContext = {
        statusCode,
        message,
        requestPath: pathWithoutQuery(c.req.path),
    };
    if (details !== undefined) ctx.details = details;
    if (statusCode === 503) {
        const health = tryGetDaemonHealth(c);
        if (health !== undefined) ctx.daemonHealth = health;
    }
    return ctx;
}
