// SPEC-014-1-01 §Task 1.4 — Auth provider registry + middleware factory.
//
// Selects the active provider strictly by `config.auth_mode` (no fallback)
// and calls its `init()` exactly once before returning the per-request
// middleware. The registry is injected so SPEC-014-1-02/03/04 isolation
// tests can swap stub providers without touching real subprocesses or
// session stores.

import type { MiddlewareHandler } from "hono";

import type { PortalConfig } from "../lib/config";
import { authContextMiddleware } from "./middleware/auth-context";
import { SecurityError } from "./types";
import type { AuthProvider } from "./types";

export interface AuthProviderRegistry {
    localhost: AuthProvider;
    tailscale: AuthProvider;
    "oauth-pkce": AuthProvider;
}

/**
 * Normalize legacy `oauth` mode literal to the canonical `oauth-pkce`.
 * Both keys read the same provider so user configs written before
 * SPEC-014-1-04 keep working.
 */
function resolveProviderKey(
    mode: PortalConfig["auth_mode"],
): keyof AuthProviderRegistry {
    if (mode === "oauth") return "oauth-pkce";
    return mode;
}

export async function createAuthMiddleware(
    config: PortalConfig,
    providers: AuthProviderRegistry,
): Promise<MiddlewareHandler> {
    const key = resolveProviderKey(config.auth_mode);
    const provider = providers[key];
    if (provider === undefined) {
        throw new SecurityError(
            "UNKNOWN_AUTH_MODE",
            `No provider registered for auth_mode='${config.auth_mode}'`,
        );
    }
    await provider.init();
    return authContextMiddleware(provider, config);
}
