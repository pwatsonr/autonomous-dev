// SPEC-030-1-04: stateful OAuth authorization-code flow tests.
//
// Covers oauth/{oauth-state.ts, oauth-bootstrap.ts, oauth-auth.ts,
// token-exchange.ts}. The PKCE math itself is covered by
// SPEC-030-1-02 / pkce-utils.test.ts; this suite exercises the FLOW
// (state issuance, replay rejection, token exchange happy path,
// token-exchange failure surfaces, and bootstrap wiring).
//
// Mocking strategy (TDD-030 §5.4 Option A):
//   - OAuth provider HTTP -> hand-rolled fetch mock (no `nock` dep)
//   - Filesystem (session store) -> in-memory MemorySessionStore
//   - Time -> real time (state-store TTL is the only timer; tests use
//             constructor seam `now: () => fakeNow`)
//
// Every typed assertion uses `error.code` (the SecurityError code) -
// no `error.message` substring matching.

import {
    OAUTH_STATE_TTL_MS,
    OAuthStateStore,
    sanitizeReturnTo,
} from "../oauth/oauth-state";
import { exchangeCodeForToken } from "../oauth/token-exchange";
import { bootstrapOAuth } from "../oauth/oauth-bootstrap";
import { OAuthAuthProvider, effectiveCookieSecretBytes } from "../oauth/oauth-auth";
import {
    MemorySessionStore,
    SessionManager,
} from "../session/session-manager";
import { encodeCookie, SESSION_COOKIE_NAME } from "../session/session-cookie";
import { SecurityError } from "../types";
import type { OAuthProviderAdapter, OAuthClientCredentials } from "../oauth/providers/types";

// -----------------------------------------------------------------------------
// Hand-rolled fetch mock helpers
// -----------------------------------------------------------------------------

interface FetchCall {
    url: string;
    init?: RequestInit;
}

interface MockResponseSpec {
    status?: number;
    body?: unknown;
    /** Throw a network error before responding. */
    networkError?: Error;
}

function mockFetch(responses: MockResponseSpec[]): {
    fetch: typeof fetch;
    calls: FetchCall[];
    pending: () => number;
} {
    const calls: FetchCall[] = [];
    let i = 0;
    const fn = ((url: RequestInfo | URL, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.toString();
        calls.push({ url: u, init });
        const spec = responses[i++];
        if (spec === undefined) {
            return Promise.reject(
                new Error(`mockFetch: unexpected call #${i} to ${u}`),
            );
        }
        if (spec.networkError) {
            return Promise.reject(spec.networkError);
        }
        const status = spec.status ?? 200;
        const body = spec.body ?? {};
        return Promise.resolve(
            new Response(JSON.stringify(body), {
                status,
                headers: { "Content-Type": "application/json" },
            }),
        );
    }) as unknown as typeof fetch;
    return {
        fetch: fn,
        calls,
        pending: () => Math.max(0, responses.length - i),
    };
}

const TEST_CREDS: OAuthClientCredentials = {
    client_id: "client-abc",
    client_secret: "secret-xyz",
    redirect_uri: "https://portal.example.test/auth/callback",
};

const TEST_ADAPTER: OAuthProviderAdapter = {
    id: "github",
    endpoints: {
        authorize_url: "https://github.example.test/oauth/authorize",
        token_url: "https://github.example.test/oauth/token",
        user_url: "https://github.example.test/user",
        scope: "read:user",
    },
    buildAuthorizeUrl(_state: string, _challenge: string): string {
        return "https://github.example.test/oauth/authorize";
    },
    fetchUserProfile: async (_t: string) => ({
        user_id: "u-1",
        email: "alice@example.test",
        display_name: "Alice",
        provider: "github",
    }),
};

// -----------------------------------------------------------------------------
// OAuthStateStore — state issuance + replay defense
// -----------------------------------------------------------------------------

describe("OAuthStateStore — state lifecycle", () => {
    it("generates state + verifier; consume() returns once and rejects on replay", () => {
        const store = new OAuthStateStore();
        const { state, code_verifier } = store.generate("/dashboard");
        expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(code_verifier).toMatch(/^[A-Za-z0-9._~-]+$/);

        const first = store.consume(state);
        expect(first).not.toBeNull();
        expect(first?.code_verifier).toBe(code_verifier);
        expect(first?.return_to).toBe("/dashboard");

        // Replay attempt — second consume() must reject without exposing record.
        const replay = store.consume(state);
        expect(replay).toBeNull();
    });

    it("rejects an unknown state value (never issued)", () => {
        const store = new OAuthStateStore();
        const result = store.consume("not-a-real-state-value");
        expect(result).toBeNull();
    });

    it("expires records past the TTL window", () => {
        let now = 1_000_000;
        const store = new OAuthStateStore({ now: () => now });
        const { state } = store.generate("/");
        // Advance past TTL (10 minutes default).
        now += OAUTH_STATE_TTL_MS + 1;
        const result = store.consume(state);
        expect(result).toBeNull();
    });

    it("cleanupExpired() removes expired AND used records", () => {
        let now = 1_000;
        const store = new OAuthStateStore({ now: () => now });
        const a = store.generate("/").state;
        const b = store.generate("/").state;
        // Use 'a' so it is marked used.
        store.consume(a);
        // Advance past TTL so 'b' is expired.
        now += OAUTH_STATE_TTL_MS + 1;
        const removed = store.cleanupExpired();
        expect(removed).toBeGreaterThanOrEqual(1);
        expect(store.size()).toBe(0);
    });

    it("sanitizeReturnTo collapses unsafe targets to '/'", () => {
        expect(sanitizeReturnTo("/repo/x")).toBe("/repo/x");
        expect(sanitizeReturnTo("//evil.example")).toBe("/");
        expect(sanitizeReturnTo("https://evil")).toBe("/");
        expect(sanitizeReturnTo("/foo?x=1")).toBe("/");
        expect(sanitizeReturnTo(undefined)).toBe("/");
        expect(sanitizeReturnTo("")).toBe("/");
    });
});

// -----------------------------------------------------------------------------
// exchangeCodeForToken — happy path + typed failure surfaces
// -----------------------------------------------------------------------------

describe("exchangeCodeForToken", () => {
    it("returns parsed tokens on a 200 OK provider response", async () => {
        const { fetch: f, calls, pending } = mockFetch([
            { status: 200, body: { access_token: "AT-123", token_type: "Bearer", scope: "read:user" } },
        ]);
        const tokens = await exchangeCodeForToken({
            adapter: TEST_ADAPTER,
            credentials: TEST_CREDS,
            code: "auth-code-1",
            codeVerifier: "verifier-1",
            fetchImpl: f,
        });
        expect(tokens.access_token).toBe("AT-123");
        expect(tokens.token_type).toBe("Bearer");
        expect(tokens.scope).toBe("read:user");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe(TEST_ADAPTER.endpoints.token_url);
        // Body must include grant_type + code + verifier — but never logged
        // and not asserted on `code` to avoid leaking it into snapshot diffs.
        const body = String(calls[0]?.init?.body ?? "");
        expect(body).toContain("grant_type=authorization_code");
        expect(body).toContain("code_verifier=verifier-1");
        expect(pending()).toBe(0);
    });

    it("rejects with typed code OAUTH_TOKEN_EXCHANGE_FAILED on 400 invalid_grant", async () => {
        const { fetch: f } = mockFetch([
            { status: 400, body: { error: "invalid_grant" } },
        ]);
        await expect(
            exchangeCodeForToken({
                adapter: TEST_ADAPTER,
                credentials: TEST_CREDS,
                code: "bad",
                codeVerifier: "v",
                fetchImpl: f,
            }),
        ).rejects.toMatchObject({
            code: "OAUTH_TOKEN_EXCHANGE_FAILED",
        } satisfies Partial<SecurityError>);
    });

    it("rejects with typed code on a network error (fetch rejects)", async () => {
        const { fetch: f } = mockFetch([
            { networkError: new Error("ECONNREFUSED") },
        ]);
        const promise = exchangeCodeForToken({
            adapter: TEST_ADAPTER,
            credentials: TEST_CREDS,
            code: "c",
            codeVerifier: "v",
            fetchImpl: f,
        });
        await expect(promise).rejects.toBeInstanceOf(SecurityError);
        await expect(promise).rejects.toMatchObject({
            code: "OAUTH_TOKEN_EXCHANGE_FAILED",
        });
    });

    it("rejects with OAUTH_NO_ACCESS_TOKEN when provider omits access_token", async () => {
        const { fetch: f } = mockFetch([
            { status: 200, body: { token_type: "Bearer" } }, // missing access_token
        ]);
        await expect(
            exchangeCodeForToken({
                adapter: TEST_ADAPTER,
                credentials: TEST_CREDS,
                code: "c",
                codeVerifier: "v",
                fetchImpl: f,
            }),
        ).rejects.toMatchObject({ code: "OAUTH_NO_ACCESS_TOKEN" });
    });

    it("rejects with typed code when fetch is not available", async () => {
        await expect(
            exchangeCodeForToken({
                adapter: TEST_ADAPTER,
                credentials: TEST_CREDS,
                code: "c",
                codeVerifier: "v",
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                fetchImpl: undefined as any,
            }),
        ).rejects.toMatchObject({ code: "OAUTH_TOKEN_EXCHANGE_FAILED" });
    });
});

// -----------------------------------------------------------------------------
// State-replay defense at the FLOW level (the same state value cannot
// drive two successful token exchanges)
// -----------------------------------------------------------------------------

describe("OAuth flow — state replay across the callback boundary", () => {
    it("the same state value cannot consume() twice; second attempt rejects before token exchange", () => {
        const store = new OAuthStateStore();
        const { state } = store.generate("/");

        const first = store.consume(state);
        const second = store.consume(state);

        expect(first).not.toBeNull();
        expect(second).toBeNull();
        // nock not used — the replay path rejects before the token endpoint
        // is ever called.
    });

    it("a state value not previously issued cannot be consumed", () => {
        const store = new OAuthStateStore();
        const result = store.consume("never-issued-state-value");
        expect(result).toBeNull();
        // nock not used — wrong-state rejects before the token endpoint.
    });
});

// -----------------------------------------------------------------------------
// OAuthAuthProvider.init — cookie-secret entropy gate
// -----------------------------------------------------------------------------

describe("OAuthAuthProvider — init() cookie secret gate", () => {
    function makeProvider(secret: string): OAuthAuthProvider {
        return new OAuthAuthProvider({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            config: { oauth_auth: { provider: "github" } } as any,
            sessionManager: new SessionManager(new MemorySessionStore()),
            cookieSecret: secret,
        });
    }

    it("init() resolves on a >=32-byte raw secret", async () => {
        const secret = "a".repeat(32);
        await expect(makeProvider(secret).init()).resolves.toBeUndefined();
    });

    it("init() resolves on a base64 secret that decodes to >=32 bytes", async () => {
        // 'openssl rand -base64 32' yields 44 chars decoding to 32 bytes.
        const secret = Buffer.alloc(32, 7).toString("base64");
        expect(effectiveCookieSecretBytes(secret)).toBeGreaterThanOrEqual(32);
        await expect(makeProvider(secret).init()).resolves.toBeUndefined();
    });

    it("init() rejects with OAUTH_WEAK_COOKIE_SECRET below threshold", async () => {
        await expect(makeProvider("too-short").init()).rejects.toMatchObject({
            code: "OAUTH_WEAK_COOKIE_SECRET",
        });
    });
});

// -----------------------------------------------------------------------------
// OAuthAuthProvider.evaluate — cookie -> session lookup -> AuthDecision
// -----------------------------------------------------------------------------

describe("OAuthAuthProvider — evaluate()", () => {
    const COOKIE_SECRET = "x".repeat(32);

    async function buildProvider(): Promise<{
        provider: OAuthAuthProvider;
        sm: SessionManager;
    }> {
        const sm = new SessionManager(new MemorySessionStore());
        const provider = new OAuthAuthProvider({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            config: { oauth_auth: { provider: "github" } } as any,
            sessionManager: sm,
            cookieSecret: COOKIE_SECRET,
        });
        await provider.init();
        return { provider, sm };
    }

    it("redirects to /auth/login when no cookie is present", async () => {
        const { provider } = await buildProvider();
        const req = new Request("https://portal.example.test/dashboard");
        const decision = await provider.evaluate(req, "127.0.0.1");
        expect(decision.kind).toBe("redirect");
        if (decision.kind === "redirect") {
            expect(decision.location).toBe("/auth/login");
        }
    });

    it("redirects when cookie is malformed / has wrong MAC", async () => {
        const { provider } = await buildProvider();
        const headers = new Headers();
        headers.set("cookie", `${SESSION_COOKIE_NAME}=garbage.deadbeef`);
        const req = new Request("https://portal.example.test/dashboard", {
            headers,
        });
        const decision = await provider.evaluate(req, "127.0.0.1");
        expect(decision.kind).toBe("redirect");
    });

    it("allows the request when the cookie maps to a live session", async () => {
        const { provider, sm } = await buildProvider();
        const session = await sm.create({
            user_id: "u-1",
            email: "alice@example.test",
            display_name: "Alice",
            provider: "github",
        });
        const cookieValue = encodeCookie(session.session_id, COOKIE_SECRET);
        const headers = new Headers();
        headers.set("cookie", `${SESSION_COOKIE_NAME}=${cookieValue}`);
        const req = new Request("https://portal.example.test/dashboard", {
            headers,
        });
        const decision = await provider.evaluate(req, "127.0.0.1");
        expect(decision.kind).toBe("allow");
        if (decision.kind === "allow") {
            expect(decision.context.source_user_id).toBe("u-1");
            expect(decision.context.display_name).toBe("Alice");
        }
    });

    it("redirects when the cookie references a destroyed session", async () => {
        const { provider, sm } = await buildProvider();
        const session = await sm.create({
            user_id: "u-1",
            email: "a@example.test",
            display_name: "A",
            provider: "github",
        });
        await sm.destroy(session.session_id);
        const cookieValue = encodeCookie(session.session_id, COOKIE_SECRET);
        const headers = new Headers();
        headers.set("cookie", `${SESSION_COOKIE_NAME}=${cookieValue}`);
        const req = new Request("https://portal.example.test/dashboard", {
            headers,
        });
        const decision = await provider.evaluate(req, "127.0.0.1");
        expect(decision.kind).toBe("redirect");
    });
});

// -----------------------------------------------------------------------------
// bootstrapOAuth — wiring + missing-config + missing-secret
// -----------------------------------------------------------------------------

describe("bootstrapOAuth", () => {
    afterEach(() => {
        delete process.env["TEST_OAUTH_CLIENT_SECRET"];
        delete process.env["TEST_OAUTH_COOKIE_SECRET"];
    });

    function buildConfig(provider: "github" | "google"): unknown {
        return {
            auth_mode: "oauth-pkce",
            bind_host: "127.0.0.1",
            oauth_auth: {
                provider,
                client_id: "client-abc",
                client_secret_env: "TEST_OAUTH_CLIENT_SECRET",
                cookie_secret_env: "TEST_OAUTH_COOKIE_SECRET",
                redirect_url: "https://portal.example.test/auth/callback",
            },
        };
    }

    it("throws OAUTH_MISSING_CONFIG when oauth_auth absent", () => {
        expect(() =>
            bootstrapOAuth({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                config: { auth_mode: "localhost" } as any,
            }),
        ).toThrow(SecurityError);
    });

    it("throws OAUTH_MISSING_SECRET when client_secret env not set", () => {
        process.env["TEST_OAUTH_COOKIE_SECRET"] = "z".repeat(32);
        try {
            bootstrapOAuth({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                config: buildConfig("github") as any,
                sessionStore: new MemorySessionStore(),
            });
            throw new Error("expected throw");
        } catch (err) {
            expect((err as SecurityError).code).toBe("OAUTH_MISSING_SECRET");
        }
    });

    it("throws OAUTH_INVALID_PROVIDER for unsupported provider literal", () => {
        process.env["TEST_OAUTH_CLIENT_SECRET"] = "cs";
        process.env["TEST_OAUTH_COOKIE_SECRET"] = "z".repeat(32);
        // Force an invalid provider through a casted config.
        const cfg = buildConfig("github") as { oauth_auth: { provider: string } };
        cfg.oauth_auth.provider = "facebook";
        try {
            bootstrapOAuth({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                config: cfg as any,
                sessionStore: new MemorySessionStore(),
            });
            throw new Error("expected throw");
        } catch (err) {
            expect((err as SecurityError).code).toBe("OAUTH_INVALID_PROVIDER");
        }
    });

    it("returns provider + routeDeps + stateStore on a valid github config", () => {
        process.env["TEST_OAUTH_CLIENT_SECRET"] = "cs";
        process.env["TEST_OAUTH_COOKIE_SECRET"] = "z".repeat(32);
        const result = bootstrapOAuth({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            config: buildConfig("github") as any,
            sessionStore: new MemorySessionStore(),
        });
        expect(result.provider).toBeInstanceOf(OAuthAuthProvider);
        expect(result.routeDeps.enabled).toBe(true);
        expect(result.stateStore).toBeInstanceOf(OAuthStateStore);
        // bind_host=127.0.0.1 → isSecure=false (Set-Cookie omits Secure)
        expect(result.routeDeps.isSecure).toBe(false);
    });

    it("returns provider + routeDeps + stateStore on a valid google config", () => {
        process.env["TEST_OAUTH_CLIENT_SECRET"] = "cs";
        process.env["TEST_OAUTH_COOKIE_SECRET"] = "z".repeat(32);
        const result = bootstrapOAuth({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            config: buildConfig("google") as any,
            sessionStore: new MemorySessionStore(),
        });
        expect(result.provider).toBeInstanceOf(OAuthAuthProvider);
        expect(result.routeDeps.enabled).toBe(true);
    });
});
