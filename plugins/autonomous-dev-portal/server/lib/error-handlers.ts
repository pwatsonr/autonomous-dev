// SPEC-013-3-02 §`serverError(err, c)` Handler.
//
// HTMX-aware 500 handler wired via `app.onError(serverError)` in
// `server/server.ts`. Logs the original error through the request-scoped
// logger when present and returns a constant message to the client so
// internal details (stack trace, error message) never leak.
//
// The 404 handler lives in `response-utils.ts` because it is reused by
// individual route handlers (e.g. request-detail) that detect bad paths
// before reaching `app.notFound`.
//
// Acceptance contract (SPEC-013-3-02):
//   - status 500
//   - body NEVER echoes err.message (verified by sentinel test in
//     SPEC-013-3-04)
//   - request-scoped logger receives the original error
//   - response uses fragment vs full-page based on HX-Request

import type { Context } from "hono";

import { renderFragment, renderFullPage } from "../templates";
import type { RenderProps } from "../types/render";
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

export async function serverError(err: Error, c: Context): Promise<Response> {
    const logger = tryGetLogger(c);
    if (logger !== null) {
        try {
            logger.error({ err, path: c.req.path }, "request failed");
        } catch {
            // logger threw → swallow, we must still respond.
        }
    }
    // Constant message; never include err.message or err.stack in the body.
    const props: RenderProps["500"] = {
        message: "An unexpected error occurred.",
    };
    const html = isHtmxRequest(c)
        ? await renderFragment("500", props)
        : await renderFullPage("500", props);
    return c.html(html, 500);
}
