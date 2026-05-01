// SPEC-014-1-04 §Task 4.4 — OAuth provider adapter contract.
//
// Each supported identity provider (GitHub, Google) ships a concrete
// adapter implementing this interface. The adapter encapsulates the
// provider-specific URL builders and user-info parser so the rest of the
// OAuth flow (state store, token exchange, callback handler) stays
// provider-agnostic.

import type { SessionProfile } from "../../session/session-manager";

/** Cleaned profile shape that becomes the SessionProfile sans session_id. */
export type OAuthProfile = Omit<SessionProfile, "provider"> & {
    provider: SessionProfile["provider"];
};

/** Token-exchange payload returned from the provider's /token endpoint. */
export interface OAuthTokens {
    access_token: string;
    token_type: string;
    scope?: string;
}

/** Wire-level provider URLs and scope. */
export interface OAuthProviderEndpoints {
    authorize_url: string;
    token_url: string;
    user_url: string;
    /** Some providers expose emails on a separate endpoint (GitHub). */
    user_email_url?: string;
    scope: string;
}

/** Configuration the adapter needs at request time. */
export interface OAuthClientCredentials {
    client_id: string;
    client_secret: string;
    redirect_uri: string;
}

/**
 * Provider adapter — a tiny strategy interface implemented by
 * github-provider.ts and google-provider.ts. Token exchange uses the
 * generic exchangeCodeForToken helper because the wire format is the
 * RFC 6749 §4.1.3 standard for both providers.
 */
export interface OAuthProviderAdapter {
    readonly endpoints: OAuthProviderEndpoints;
    readonly id: SessionProfile["provider"];
    /**
     * Build the redirect URL the user is sent to in /auth/login.
     * Includes client_id, redirect_uri, scope, state, code_challenge.
     */
    buildAuthorizeUrl(state: string, codeChallenge: string): string;
    /**
     * Fetch the authenticated user's profile using the access_token.
     * Throws SecurityError('OAUTH_USER_FETCH_FAILED', ...) on non-200.
     */
    fetchUserProfile(accessToken: string): Promise<OAuthProfile>;
}
