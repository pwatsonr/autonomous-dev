// PLAN-037-2 — shared types for the action-route modules.
//
// The action routes (approvals / settings / agents / gate+request) all use a
// thin, structural audit-appender + logger surface so they don't depend on
// the full AuditLogger class (which requires HMAC key initialization). The
// production wiring in server.ts adapts AuditLogger into this surface via a
// small lambda; tests inject a capture object that records the calls. This
// keeps the route handlers pure (no module-level state, no I/O coupling).
//
// `SSEBroadcaster` mirrors the subset of `SSEEventBus` the action routes
// need. The handlers fire-and-forget broadcasts so a slow/closed bus never
// blocks a route response.

export interface AuditAppender {
    /**
     * Append a single audit entry. Implementations MUST be safe to call
     * without an `await` block from the handler (i.e. the route's response
     * may be flushed before the I/O completes). The production wiring uses
     * `void audit.append(...)` for HTMX responses to keep latency tight.
     */
    append(entry: {
        event: string;
        actor?: string;
        [k: string]: unknown;
    }): Promise<void>;
}

export interface ActionLogger {
    warn(event: string, fields?: Record<string, unknown>): void;
    error(event: string, fields?: Record<string, unknown>): void;
    info?(event: string, fields?: Record<string, unknown>): void;
}

/** Subset of SSEEventBus the action routes need. */
export interface SSEBroadcaster {
    /**
     * Fire-and-forget broadcast. Implementations MUST swallow internal
     * errors; the route is not responsible for bus-level retry policy.
     */
    publish(topic: string, payload: Record<string, unknown>): void;
}

/** Resolve the actor (source_user_id) from a Hono context. */
export function resolveActor(ctxAuth: unknown): string {
    if (ctxAuth === null || typeof ctxAuth !== "object") return "unknown";
    const a = ctxAuth as { source_user_id?: unknown };
    if (typeof a.source_user_id === "string" && a.source_user_id.length > 0) {
        return a.source_user_id;
    }
    return "unknown";
}

/**
 * Default no-op logger sink. Production wiring should inject the project's
 * structured logger (matching the kill-switch route pattern).
 */
export function noopActionLogger(): ActionLogger {
    return {
        warn: () => undefined,
        error: () => undefined,
        info: () => undefined,
    };
}

/** Default no-op broadcaster. Tests use a capture; production injects the bus. */
export function noopBroadcaster(): SSEBroadcaster {
    return { publish: () => undefined };
}
