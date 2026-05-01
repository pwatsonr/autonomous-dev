// SPEC-013-3-02 §`serverError(err, c)` Handler.
// SPEC-013-4-03 §Error Handler Middleware: replaces the constant-message
// 500 with a sanitized `ErrorContext` rendered via `<ErrorPage>`. Stack
// traces are still kept on the server-side log only — the client receives
// only the sanitized view returned by `buildErrorContext`.
//
// HTMX-aware:
//   - HX-Request: true → returns the standalone <ErrorDetails> fragment
//     so an hx-target swap inserts a small piece in place of a full page.
//   - non-HTMX → returns the full <BaseLayout> + <ErrorPage>.
//
// The 404 helper continues to live in `response-utils.ts` because it is
// reused by individual route handlers (e.g. request-detail) before the
// path reaches `app.notFound`.

import type { Context } from "hono";

import { ErrorDetails } from "../templates/fragments/error-details";
import { ErrorPage } from "../templates/pages/error";
import { BaseLayout } from "../templates/layout/base";
import { buildErrorContext } from "./error-context";
import { isHtmxRequest } from "./response-utils";

interface MaybeLogger {
    error: (obj: unknown, msg?: string) => void;
}

function tryGetLogger(c: Context): MaybeLogger | null {
    // c.get is typed against ContextVariableMap. The structured-logger
    // middleware (SPEC-013-2-02) does not currently advertise a typed
    // "logger" key; treat it as best-effort and bail on any access error.
    try {
        const candidate = (c as unknown as {
            get: (k: string) => unknown;
        }).get("logger");
        if (
            candidate !== null &&
            candidate !== undefined &&
            typeof (candidate as MaybeLogger).error === "function"
        ) {
            return candidate as MaybeLogger;
        }
    } catch {
        // ignore — logger not available
    }
    return null;
}

/**
 * Resolve a JSX node returned from Hono's runtime into an HTML string.
 * The runtime returns an `HtmlEscapedString` (already a `string`) but
 * may also return a Promise; awaiting handles both shapes.
 */
async function jsxToString(node: unknown): Promise<string> {
    const v = await Promise.resolve(node);
    return typeof v === "string" ? v : String(v);
}

export async function serverError(err: Error, c: Context): Promise<Response> {
    // SPEC-013-4-03 acceptance: server logs MUST contain the full
    // unredacted stack via console.error('[error-handler]', err) for
    // every 5xx. We continue to forward to the request-scoped structured
    // logger when present so existing log-aggregation pipelines work.
    const logger = tryGetLogger(c);
    if (logger !== null) {
        try {
            logger.error({ err, path: c.req.path }, "request failed");
        } catch {
            // logger threw → swallow, we must still respond.
        }
    }
    // eslint-disable-next-line no-console
    console.error("[error-handler]", err);

    const ctx = buildErrorContext(err, c);

    // HTMX fragment requests get the error fragment only — no layout —
    // so an hx-swap target is replaced cleanly.
    if (isHtmxRequest(c)) {
        const fragment = await jsxToString(
            <ErrorDetails details={ctx.details ?? ""} requestPath={ctx.requestPath} />,
        );
        return c.html(fragment, ctx.statusCode);
    }

    const page = await jsxToString(
        <BaseLayout activePath="/" cspNonce={c.get("cspNonce") ?? ""}>
            <ErrorPage {...ctx} />
        </BaseLayout>,
    );
    return c.html(`<!doctype html>${page}`, ctx.statusCode);
}
