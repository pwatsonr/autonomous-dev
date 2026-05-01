// SPEC-013-2-03 §Task 4 — OAuth+PKCE extension hook (empty surface).
//
// This module ships ONLY the contract: `auth_mode === 'oauth'` MUST refuse
// to start unless an extension is registered. The actual OAuth+PKCE flow,
// token storage, and session middleware are implemented by TDD-014 plans
// and registered via `registerOAuthExtension(...)` BEFORE startServer().

import type { Hono } from "hono";

export interface OAuthConfig {
    authorize_url: string;
    token_url: string;
    client_id: string;
    redirect_uri: string;
    scopes: string[];
    pkce: { code_challenge_method: "S256" };
}

export interface OAuthExtension {
    /** Registered by TDD-014 plans before startServer() runs. */
    attach(app: Hono, config: OAuthConfig): void;
}

let registered: OAuthExtension | null = null;

export function registerOAuthExtension(ext: OAuthExtension): void {
    if (registered !== null) {
        throw new Error("OAuth extension already registered");
    }
    registered = ext;
}

export function isOAuthExtensionRegistered(): boolean {
    return registered !== null;
}

export function getOAuthExtension(): OAuthExtension | null {
    return registered;
}

/** Test-only: clear the registered extension between tests. */
export function __resetOAuthExtensionForTesting(): void {
    registered = null;
}
