// SPEC-014-1-04 §Task 4.3 — RFC 6749 §4.1.3 token exchange.
//
// POSTs the authorization_code grant to the provider's /token endpoint and
// parses the access_token response. The same wire format is used by both
// GitHub and Google so this helper is provider-agnostic.
//
// Logging hard rules (acceptance criteria, never deviate):
//   - The function NEVER logs `code`, `code_verifier`, `client_secret`,
//     or `access_token`.
//   - On failure the error message includes ONLY the HTTP status code
//     and the provider name. The response body is intentionally not
//     surfaced because providers occasionally echo the rejected code.

import { SecurityError } from "../types";
import type { OAuthClientCredentials, OAuthProviderAdapter, OAuthTokens } from "./providers/types";

export interface ExchangeCodeOptions {
    /** Provider adapter (used for endpoint URL + identifier). */
    adapter: OAuthProviderAdapter;
    /** Client credentials (client_id, client_secret, redirect_uri). */
    credentials: OAuthClientCredentials;
    /** Authorization code from the callback query string. */
    code: string;
    /** PKCE code_verifier paired with the issued state. */
    codeVerifier: string;
    /** Test seam — defaults to globalThis.fetch. */
    fetchImpl?: typeof fetch;
}

/**
 * Exchange the authorization code for an access token. Throws SecurityError
 * with a stable error code on every failure path so callers can render the
 * documented error page.
 *
 * Returns the parsed token payload on success.
 */
export async function exchangeCodeForToken(
    opts: ExchangeCodeOptions,
): Promise<OAuthTokens> {
    const { adapter, credentials, code, codeVerifier } = opts;
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
        throw new SecurityError(
            "OAUTH_TOKEN_EXCHANGE_FAILED",
            "fetch is not available in this runtime",
        );
    }

    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("client_id", credentials.client_id);
    body.set("client_secret", credentials.client_secret);
    body.set("code", code);
    body.set("code_verifier", codeVerifier);
    body.set("redirect_uri", credentials.redirect_uri);

    let res: Response;
    try {
        res = await fetchImpl(adapter.endpoints.token_url, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
            },
            body: body.toString(),
        });
    } catch (err) {
        // Network / DNS failures — surface a stable error code so the
        // callback handler can render a generic page.
        throw new SecurityError(
            "OAUTH_TOKEN_EXCHANGE_FAILED",
            `Token endpoint request failed for provider ${adapter.id}: ${(err as Error).message}`,
        );
    }

    if (!res.ok) {
        // Status-only — response body MUST NOT be surfaced (may echo code).
        throw new SecurityError(
            "OAUTH_TOKEN_EXCHANGE_FAILED",
            `Token endpoint returned status ${String(res.status)} for provider ${adapter.id}`,
        );
    }

    let parsed: unknown;
    try {
        parsed = await res.json();
    } catch (err) {
        throw new SecurityError(
            "OAUTH_TOKEN_EXCHANGE_FAILED",
            `Token endpoint returned malformed JSON for provider ${adapter.id}: ${(err as Error).message}`,
        );
    }

    if (parsed === null || typeof parsed !== "object") {
        throw new SecurityError(
            "OAUTH_TOKEN_EXCHANGE_FAILED",
            `Token endpoint returned a non-object payload for provider ${adapter.id}`,
        );
    }

    const obj = parsed as Record<string, unknown>;
    const accessToken = obj["access_token"];
    if (typeof accessToken !== "string" || accessToken.length === 0) {
        throw new SecurityError(
            "OAUTH_NO_ACCESS_TOKEN",
            `Token endpoint response missing access_token for provider ${adapter.id}`,
        );
    }
    const tokenType =
        typeof obj["token_type"] === "string" ? (obj["token_type"] as string) : "Bearer";
    const scope = typeof obj["scope"] === "string" ? (obj["scope"] as string) : undefined;

    return scope === undefined
        ? { access_token: accessToken, token_type: tokenType }
        : { access_token: accessToken, token_type: tokenType, scope };
}
