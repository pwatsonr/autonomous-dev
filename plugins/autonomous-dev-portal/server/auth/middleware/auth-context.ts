// SPEC-014-1-01 §Task 1.5 — Auth context middleware.
//
// Bridges the chosen AuthProvider to Hono's per-request lifecycle. Calls
// provider.evaluate(...) once, then either:
//   - allow:    sets c.set('auth', context) and proceeds
//   - redirect: returns a 302 to the provider-specified location
//   - deny:     returns JSON {error,message} with the provider's status
//
// Peer IP extraction is the security-critical step: we IGNORE
// X-Forwarded-For unless `config.trusted_reverse_proxy === true`, which
// prevents header-spoofing attacks against localhost mode (SPEC-014-1-02).

import type { Context, MiddlewareHandler } from "hono";

import type { PortalConfig } from "../../lib/config";
import type { AuthProvider } from "../types";

/** Stable literal returned when no socket peer is available. */
export const PEER_IP_UNKNOWN = "unknown";

/**
 * Returns the request's remote-IP. Forwarded headers are honored ONLY when
 * `trusted_reverse_proxy === true`. Otherwise the socket address is the
 * single source of truth, and we fall back to {@link PEER_IP_UNKNOWN} so
 * the active provider can deny.
 */
export function extractPeerIp(c: Context, config: PortalConfig): string {
    if (config.trusted_reverse_proxy === true) {
        const xff = c.req.header("x-forwarded-for");
        if (xff !== undefined && xff.length > 0) {
            const first = xff.split(",")[0]?.trim();
            if (first !== undefined && first.length > 0) return first;
        }
    }
    // Bun exposes the socket on the env object; fall back through a few
    // shapes to stay portable across Bun versions and Hono adapters.
    const env = c.env as
        | undefined
        | {
              incoming?: { socket?: { remoteAddress?: string | null } };
              remoteAddress?: string | null;
          };
    const socketAddr = env?.incoming?.socket?.remoteAddress ?? env?.remoteAddress;
    if (typeof socketAddr === "string" && socketAddr.length > 0) {
        return socketAddr;
    }
    return PEER_IP_UNKNOWN;
}

export function authContextMiddleware(
    provider: AuthProvider,
    config: PortalConfig,
): MiddlewareHandler {
    return async (c, next) => {
        const peerIp = extractPeerIp(c, config);
        const decision = await provider.evaluate(c.req.raw, peerIp);
        switch (decision.kind) {
            case "allow":
                c.set("auth", decision.context);
                return next();
            case "redirect":
                return c.redirect(decision.location, 302);
            case "deny":
                return c.json(
                    {
                        error: decision.error_code,
                        message: decision.message,
                    },
                    decision.status,
                );
        }
    };
}
