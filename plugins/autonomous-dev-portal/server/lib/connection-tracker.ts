// SPEC-013-2-04 §Task 1 — Active-request counter for shutdown drain.
//
// Bun's Server has no connection-level drain primitive (as of Bun 1.0).
// Request-level tracking is sufficient for our drain semantics: we drain
// requests, not raw sockets. SSE/long-poll connections introduced by
// later plans register their own shutdown hook to close their streams.
//
// Module-level state is intentional — there is exactly one server
// instance per Bun process. `__resetForTesting()` clears state between
// unit tests.

import type { MiddlewareHandler } from "hono";

let active = 0;
let drainResolver: (() => void) | null = null;

export function connectionCounter(): MiddlewareHandler {
    return async (c, next) => {
        active++;
        try {
            await next();
        } finally {
            active--;
            if (active === 0 && drainResolver !== null) {
                const r = drainResolver;
                drainResolver = null;
                r();
            }
        }
    };
}

export function getActiveRequestCount(): number {
    return active;
}

export function waitForDrain(
    timeoutMs: number,
): Promise<{ drained: boolean; remaining: number }> {
    if (active === 0) {
        return Promise.resolve({ drained: true, remaining: 0 });
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            drainResolver = null;
            resolve({ drained: false, remaining: active });
        }, timeoutMs);
        drainResolver = (): void => {
            clearTimeout(timer);
            resolve({ drained: true, remaining: 0 });
        };
    });
}

/** Test-only: reset module state between tests. */
export function __resetForTesting(): void {
    active = 0;
    drainResolver = null;
}
