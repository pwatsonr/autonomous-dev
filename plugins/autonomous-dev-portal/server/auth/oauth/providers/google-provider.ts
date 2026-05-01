// SPEC-014-1-04 §Task 4.4 — Google OAuth provider adapter.
//
// Endpoints from
// https://developers.google.com/identity/protocols/oauth2/openid-connect.
// We use the v2 userinfo endpoint (returns id, email, name, picture).
//
// `prompt=select_account` is set so a user with multiple Google accounts
// can pick the one they intend to use rather than silently re-authing
// whichever account the browser remembered.

import { SecurityError } from "../../types";
import type { OAuthClientCredentials, OAuthProfile, OAuthProviderAdapter, OAuthProviderEndpoints } from "./types";

export const GOOGLE_ENDPOINTS: OAuthProviderEndpoints = Object.freeze({
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    user_url: "https://www.googleapis.com/oauth2/v2/userinfo",
    scope: "openid email profile",
});

export interface GoogleProviderOptions {
    credentials: OAuthClientCredentials;
    /** Test seam — defaults to globalThis.fetch. */
    fetchImpl?: typeof fetch;
}

interface GoogleUser {
    id?: unknown;
    email?: unknown;
    name?: unknown;
    verified_email?: unknown;
}

export class GoogleProvider implements OAuthProviderAdapter {
    readonly endpoints = GOOGLE_ENDPOINTS;
    readonly id = "google" as const;
    private readonly credentials: OAuthClientCredentials;
    private readonly fetchImpl: typeof fetch;

    constructor(opts: GoogleProviderOptions) {
        this.credentials = opts.credentials;
        this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    }

    buildAuthorizeUrl(state: string, codeChallenge: string): string {
        const u = new URL(this.endpoints.authorize_url);
        u.searchParams.set("client_id", this.credentials.client_id);
        u.searchParams.set("redirect_uri", this.credentials.redirect_uri);
        u.searchParams.set("scope", this.endpoints.scope);
        u.searchParams.set("response_type", "code");
        u.searchParams.set("access_type", "online");
        u.searchParams.set("prompt", "select_account");
        u.searchParams.set("state", state);
        u.searchParams.set("code_challenge", codeChallenge);
        u.searchParams.set("code_challenge_method", "S256");
        return u.toString();
    }

    async fetchUserProfile(accessToken: string): Promise<OAuthProfile> {
        const res = await this.fetchImpl(this.endpoints.user_url, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/json",
            },
        });
        if (!res.ok) {
            throw new SecurityError(
                "OAUTH_USER_FETCH_FAILED",
                `Google userinfo returned status ${String(res.status)}`,
            );
        }
        const user = (await res.json()) as GoogleUser;
        const id = typeof user.id === "string" && user.id.length > 0 ? user.id : null;
        const email =
            typeof user.email === "string" && user.email.length > 0
                ? user.email
                : null;
        const name =
            typeof user.name === "string" && user.name.length > 0
                ? user.name
                : (email ?? id);
        if (id === null || email === null) {
            throw new SecurityError(
                "OAUTH_USER_FETCH_FAILED",
                "Google userinfo payload missing id or email",
            );
        }
        if (user.verified_email === false) {
            throw new SecurityError(
                "OAUTH_USER_FETCH_FAILED",
                "Google account email is not verified",
            );
        }
        return {
            user_id: id,
            email,
            display_name: name ?? id,
            provider: "google",
        };
    }
}
