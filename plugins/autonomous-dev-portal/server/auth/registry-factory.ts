// SPEC-014-1-04 §Wiring — assemble the full AuthProviderRegistry.
//
// The middleware-factory deliberately doesn't construct providers itself
// (so tests can swap in stubs). This module is the production wiring that
// callers (server.ts, smoke tests) use to build a registry from a
// PortalConfig.
//
// Each provider entry is built only when its dependencies are available:
//   - localhost: always present (no extra deps)
//   - tailscale: requires a TailscaleClient (CliTailscaleClient by default)
//   - oauth-pkce: requires bootstrapOAuth() to mint the OAuthAuthProvider
//                 from the OAuth config block; thrown SecurityError when
//                 oauth_auth is missing for the requested mode.
//
// The function returns BOTH the registry and the supplemental wiring
// (route deps, state store) so the caller can hand them to
// registerRoutes() and the cleanup loop without re-bootstrapping.

import type { PortalConfig } from "../lib/config";
import { LocalhostAuthProvider } from "./localhost-auth";
import { CliTailscaleClient } from "./tailscale-client";
import type { TailscaleClient } from "./tailscale-client";
import { TailscaleAuthProvider } from "./tailscale-auth";
import type { AuthProviderRegistry } from "./middleware-factory";
import { bootstrapOAuth } from "./oauth/oauth-bootstrap";
import type { OAuthBootstrapResult } from "./oauth/oauth-bootstrap";
import { OAuthAuthProvider } from "./oauth/oauth-auth";
import { SecurityError } from "./types";

export interface BuildAuthRegistryOptions {
    config: PortalConfig;
    /** Test seam — replace the Tailscale client. */
    tailscaleClient?: TailscaleClient;
    /** Test seam — pass-through to bootstrapOAuth. */
    fetchImpl?: typeof fetch;
}

export interface AuthRegistryResult {
    registry: AuthProviderRegistry;
    /** Present when auth_mode is OAuth-flavoured; null otherwise. */
    oauth: OAuthBootstrapResult | null;
}

/**
 * Construct the full provider registry plus any auxiliary wiring (OAuth
 * route deps, state store) the caller will need.
 *
 * The OAuth provider is materialised only when the active mode requires
 * it — building a GithubProvider with empty credentials in localhost mode
 * would defeat the validateAuthConfig gate.
 */
export function buildAuthRegistry(opts: BuildAuthRegistryOptions): AuthRegistryResult {
    const cfg = opts.config;
    const localhost = new LocalhostAuthProvider(cfg);
    const tailscale = new TailscaleAuthProvider({
        config: cfg,
        client: opts.tailscaleClient ?? new CliTailscaleClient(),
    });

    let oauth: OAuthBootstrapResult | null = null;
    let oauthProvider: OAuthAuthProvider;

    if (cfg.auth_mode === "oauth-pkce" || cfg.auth_mode === "oauth") {
        oauth = bootstrapOAuth({ config: cfg, fetchImpl: opts.fetchImpl });
        oauthProvider = oauth.provider;
    } else {
        // The registry slot must always be populated, but the provider
        // will throw on init() if it's ever selected without OAuth config.
        // We construct a placeholder that fails closed.
        oauthProvider = makeUnconfiguredOAuthProvider();
    }

    const registry: AuthProviderRegistry = {
        localhost,
        tailscale,
        "oauth-pkce": oauthProvider,
    };
    return { registry, oauth };
}

/**
 * Returns an OAuthAuthProvider stand-in whose init() throws so a
 * misconfiguration cannot accidentally select OAuth mode without the
 * required config. The placeholder is never reached for non-OAuth modes
 * because middleware-factory looks up by `resolveProviderKey(auth_mode)`.
 */
function makeUnconfiguredOAuthProvider(): OAuthAuthProvider {
    const stub = Object.create(OAuthAuthProvider.prototype) as OAuthAuthProvider;
    Object.defineProperty(stub, "mode", { value: "oauth-pkce", writable: false });
    Object.defineProperty(stub, "init", {
        value: async (): Promise<void> => {
            throw new SecurityError(
                "OAUTH_NOT_CONFIGURED",
                "auth_mode='oauth-pkce' requires the 'oauth_auth' config block",
            );
        },
        writable: false,
    });
    Object.defineProperty(stub, "evaluate", {
        value: async (): Promise<never> => {
            throw new SecurityError(
                "OAUTH_NOT_CONFIGURED",
                "OAuth provider was not initialised",
            );
        },
        writable: false,
    });
    return stub;
}
