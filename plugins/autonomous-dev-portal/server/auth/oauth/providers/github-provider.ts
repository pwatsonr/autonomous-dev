// SPEC-014-1-04 §Task 4.4 — GitHub OAuth provider adapter.
//
// Endpoints lifted verbatim from
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
// (current as of the 2024 docs revision).
//
// The user-info fetch is two requests because GitHub returns the primary
// email on a separate endpoint when the account hides it from the public
// profile. We pick the first verified, primary email.

import { SecurityError } from "../../types";
import type { OAuthClientCredentials, OAuthProfile, OAuthProviderAdapter, OAuthProviderEndpoints } from "./types";

export const GITHUB_ENDPOINTS: OAuthProviderEndpoints = Object.freeze({
    authorize_url: "https://github.com/login/oauth/authorize",
    token_url: "https://github.com/login/oauth/access_token",
    user_url: "https://api.github.com/user",
    user_email_url: "https://api.github.com/user/emails",
    scope: "read:user user:email",
});

export interface GithubProviderOptions {
    credentials: OAuthClientCredentials;
    /** Test seam — defaults to globalThis.fetch. */
    fetchImpl?: typeof fetch;
}

interface GithubUser {
    login?: unknown;
    name?: unknown;
    email?: unknown;
    id?: unknown;
}

interface GithubEmailEntry {
    email?: unknown;
    primary?: unknown;
    verified?: unknown;
}

export class GithubProvider implements OAuthProviderAdapter {
    readonly endpoints = GITHUB_ENDPOINTS;
    readonly id = "github" as const;
    private readonly credentials: OAuthClientCredentials;
    private readonly fetchImpl: typeof fetch;

    constructor(opts: GithubProviderOptions) {
        this.credentials = opts.credentials;
        this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    }

    buildAuthorizeUrl(state: string, codeChallenge: string): string {
        const u = new URL(this.endpoints.authorize_url);
        u.searchParams.set("client_id", this.credentials.client_id);
        u.searchParams.set("redirect_uri", this.credentials.redirect_uri);
        u.searchParams.set("scope", this.endpoints.scope);
        u.searchParams.set("state", state);
        u.searchParams.set("code_challenge", codeChallenge);
        u.searchParams.set("code_challenge_method", "S256");
        return u.toString();
    }

    async fetchUserProfile(accessToken: string): Promise<OAuthProfile> {
        const headers = {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "autonomous-dev-portal",
        };
        const userRes = await this.fetchImpl(this.endpoints.user_url, { headers });
        if (!userRes.ok) {
            throw new SecurityError(
                "OAUTH_USER_FETCH_FAILED",
                `GitHub /user returned status ${String(userRes.status)}`,
            );
        }
        const user = (await userRes.json()) as GithubUser;
        const login = typeof user.login === "string" ? user.login : null;
        const name =
            typeof user.name === "string" && user.name.length > 0
                ? user.name
                : login;
        const id =
            typeof user.id === "number"
                ? String(user.id)
                : typeof user.id === "string"
                  ? user.id
                  : login;
        if (login === null || id === null) {
            throw new SecurityError(
                "OAUTH_USER_FETCH_FAILED",
                "GitHub /user payload missing login or id",
            );
        }

        // Pull the email from /user first, fall back to /user/emails.
        let email =
            typeof user.email === "string" && user.email.length > 0 ? user.email : null;
        if (email === null && this.endpoints.user_email_url !== undefined) {
            const emailRes = await this.fetchImpl(this.endpoints.user_email_url, {
                headers,
            });
            if (!emailRes.ok) {
                throw new SecurityError(
                    "OAUTH_USER_FETCH_FAILED",
                    `GitHub /user/emails returned status ${String(emailRes.status)}`,
                );
            }
            const emails = (await emailRes.json()) as GithubEmailEntry[];
            const primary = Array.isArray(emails)
                ? emails.find((e) => e.primary === true && e.verified === true)
                : undefined;
            if (primary !== undefined && typeof primary.email === "string") {
                email = primary.email;
            }
        }
        if (email === null) {
            throw new SecurityError(
                "OAUTH_USER_FETCH_FAILED",
                "GitHub user has no primary verified email",
            );
        }

        return {
            user_id: id,
            email,
            display_name: name ?? login,
            provider: "github",
        };
    }
}
