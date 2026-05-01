// SPEC-014-1-04 §Wiring — assemble the OAuth runtime from PortalConfig.
//
// Single factory called by server.ts (and by tests) to materialise:
//   - the provider adapter (GitHub or Google)
//   - the SessionManager + storage backend
//   - the OAuthStateStore
//   - the OAuthAuthProvider
//   - the route deps that registerAuthRoutes() needs
//
// Keeping the wiring in one place makes the dependency graph explicit and
// prevents server.ts from importing every leaf module. Tests pass a stub
// PortalConfig and override `fetchImpl` / store to avoid network/disk.

import { homedir } from "node:os";
import { join } from "node:path";

import type { PortalConfig } from "../../lib/config";
import { SecurityError } from "../types";
import { OAuthAuthProvider } from "./oauth-auth";
import { OAuthStateStore } from "./oauth-state";
import { exchangeCodeForToken } from "./token-exchange";
import { GithubProvider } from "./providers/github-provider";
import { GoogleProvider } from "./providers/google-provider";
import type {
    OAuthClientCredentials,
    OAuthProviderAdapter,
    OAuthTokens,
} from "./providers/types";
import { FileSessionStore } from "../session/file-session-store";
import {
    MemorySessionStore,
    SessionManager,
} from "../session/session-manager";
import type { SessionStore } from "../session/session-manager";
import type { AuthRouteDeps } from "../../routes/auth";

export interface OAuthBootstrapOptions {
    config: PortalConfig;
    /** Test seam — defaults to globalThis.fetch via the providers. */
    fetchImpl?: typeof fetch;
    /** Test seam — provide an in-memory store rather than touching disk. */
    sessionStore?: SessionStore;
}

export interface OAuthBootstrapResult {
    provider: OAuthAuthProvider;
    routeDeps: AuthRouteDeps;
    /** Exposed so the cleanup loop can invoke cleanupExpired(). */
    stateStore: OAuthStateStore;
}

function defaultSessionDir(config: PortalConfig): string {
    if (config.oauth_auth?.session_dir !== undefined) {
        return config.oauth_auth.session_dir;
    }
    const root = process.env["CLAUDE_PLUGIN_DATA"] ?? join(homedir(), ".autonomous-dev");
    return join(root, "sessions");
}

function buildAdapter(
    config: PortalConfig,
    credentials: OAuthClientCredentials,
    fetchImpl: typeof fetch,
): OAuthProviderAdapter {
    const provider = config.oauth_auth?.provider;
    if (provider === "github") {
        return new GithubProvider({ credentials, fetchImpl });
    }
    if (provider === "google") {
        return new GoogleProvider({ credentials, fetchImpl });
    }
    throw new SecurityError(
        "OAUTH_INVALID_PROVIDER",
        `Unsupported oauth_auth.provider: ${String(provider)}`,
    );
}

function resolveSecret(envName: string, label: string): string {
    const value = process.env[envName];
    if (typeof value !== "string" || value.length === 0) {
        throw new SecurityError(
            "OAUTH_MISSING_SECRET",
            `Environment variable '${envName}' (${label}) is not set`,
        );
    }
    return value;
}

/**
 * Build the OAuth runtime from a PortalConfig. Throws SecurityError when
 * the config does not satisfy `validateAuthConfig` (which should have
 * already run before this function).
 */
export function bootstrapOAuth(opts: OAuthBootstrapOptions): OAuthBootstrapResult {
    const cfg = opts.config;
    const oa = cfg.oauth_auth;
    if (oa === undefined) {
        throw new SecurityError(
            "OAUTH_MISSING_CONFIG",
            "bootstrapOAuth called without oauth_auth in PortalConfig",
        );
    }
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

    const clientSecret = resolveSecret(
        oa.client_secret_env,
        "oauth_auth.client_secret_env",
    );
    const cookieSecret = resolveSecret(
        oa.cookie_secret_env,
        "oauth_auth.cookie_secret_env",
    );

    const credentials: OAuthClientCredentials = {
        client_id: oa.client_id,
        client_secret: clientSecret,
        redirect_uri: oa.redirect_url,
    };

    const adapter = buildAdapter(cfg, credentials, fetchImpl);

    const sessionStore: SessionStore =
        opts.sessionStore ??
        new FileSessionStore({ sessionDir: defaultSessionDir(cfg) });
    const sessionManager = new SessionManager(sessionStore);

    const stateStore = new OAuthStateStore();

    const provider = new OAuthAuthProvider({
        config: cfg,
        sessionManager,
        cookieSecret,
    });

    const isSecure = cfg.bind_host !== "127.0.0.1";

    const tokenExchange = (
        code: string,
        codeVerifier: string,
    ): Promise<OAuthTokens> =>
        exchangeCodeForToken({
            adapter,
            credentials,
            code,
            codeVerifier,
            fetchImpl,
        });

    const routeDeps: AuthRouteDeps = {
        enabled: cfg.auth_mode === "oauth-pkce" || cfg.auth_mode === "oauth",
        stateStore,
        providerAdapter: adapter,
        sessionManager,
        tokenExchange,
        cookieSecret,
        isSecure,
    };

    return { provider, routeDeps, stateStore };
}
