// SPEC-014-1-04 §Task 4.11 — Smoke tests for the OAuth + PKCE flow.
//
// Coverage matrix (mirrors the deliverable scope, not the full Task 10
// suite — that lives in PLAN-014-2 / PLAN-014-3 follow-ups):
//
//   pkce-utils: verifier length + alphabet, RFC 7636 Appendix B vector,
//               two verifiers differ.
//   oauth-state: round-trip, TTL eviction, expired→undefined,
//               distinct-states-no-collision, sanitizeReturnTo bypasses.
//   session-cookie: encode/decode round-trip, tampered MAC rejected,
//               malformed session_id rejected.
//   OAuthAuthProvider.evaluate: missing cookie → redirect /auth/login,
//               valid session → allow with the userinfo identity.
//   /auth/callback: missing/invalid state → 400/403, replayed state
//               rejected, happy path sets cookie + redirects to return_to.

import { Hono } from "hono";
import { describe, expect, test } from "bun:test";

import {
    PKCE_VERIFIER_MIN_LEN,
    base64UrlEncode,
    deriveCodeChallenge,
    generateCodeVerifier,
} from "../../server/auth/oauth/pkce-utils";
import {
    OAUTH_STATE_TTL_MS,
    OAuthStateStore,
    sanitizeReturnTo,
} from "../../server/auth/oauth/oauth-state";
import {
    SESSION_COOKIE_NAME,
    buildSetCookieHeader,
    decodeCookie,
    encodeCookie,
    parseSessionCookie,
} from "../../server/auth/session/session-cookie";
import {
    MemorySessionStore,
    SessionManager,
    generateSessionId,
} from "../../server/auth/session/session-manager";
import { OAuthAuthProvider } from "../../server/auth/oauth/oauth-auth";
import { registerAuthRoutes } from "../../server/routes/auth";
import type { AuthRouteDeps } from "../../server/routes/auth";
import type { OAuthProviderAdapter } from "../../server/auth/oauth/providers/types";
import type { PortalConfig } from "../../server/lib/config";
import { SecurityError } from "../../server/auth/types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function baseConfig(overrides: Partial<PortalConfig> = {}): PortalConfig {
    return {
        port: 30100,
        auth_mode: "oauth-pkce",
        bind_host: "127.0.0.1",
        allowed_origins: [],
        logging: { level: "info" },
        paths: {
            state_dir: "~/.autonomous-dev",
            logs_dir: "~/.autonomous-dev/logs",
            user_config: "~/.autonomous-dev/config.json",
        },
        shutdown: { grace_period_ms: 1000, force_timeout_ms: 2000 },
        oauth_auth: {
            provider: "github",
            client_id: "client-abc",
            client_secret_env: "TEST_OAUTH_CLIENT_SECRET",
            redirect_url: "http://127.0.0.1:30100/auth/callback",
            cookie_secret_env: "TEST_OAUTH_COOKIE_SECRET",
        },
        ...overrides,
    };
}

const STRONG_COOKIE_SECRET = "k".repeat(48); // 48 utf-8 bytes >= 32

/**
 * Stub provider adapter — buildAuthorizeUrl returns a deterministic URL
 * containing the state and challenge so tests can assert on it; the
 * fetchUserProfile result is fixed so tests can assert on the
 * propagated identity.
 */
function stubProvider(): OAuthProviderAdapter {
    return {
        id: "github",
        endpoints: {
            authorize_url: "https://stub-idp.example/authorize",
            token_url: "https://stub-idp.example/token",
            user_url: "https://stub-idp.example/user",
            scope: "read:user",
        },
        buildAuthorizeUrl(state, challenge) {
            return `https://stub-idp.example/authorize?state=${state}&challenge=${challenge}`;
        },
        async fetchUserProfile(token) {
            // Token is opaque to the test; we just record we got one.
            return {
                user_id: `gh-user-${token.slice(-4)}`,
                email: "alice@example.com",
                display_name: "Alice Example",
                provider: "github",
            };
        },
    };
}

interface BuiltDeps {
    app: Hono;
    routeDeps: AuthRouteDeps;
    sessionManager: SessionManager;
    stateStore: OAuthStateStore;
    cookieSecret: string;
}

function buildAppWithRoutes(opts: { isSecure?: boolean } = {}): BuiltDeps {
    const app = new Hono();
    const sessionManager = new SessionManager(new MemorySessionStore());
    const stateStore = new OAuthStateStore();
    const cookieSecret = STRONG_COOKIE_SECRET;
    const routeDeps: AuthRouteDeps = {
        enabled: true,
        stateStore,
        providerAdapter: stubProvider(),
        sessionManager,
        tokenExchange: async () => ({
            access_token: "access-XYZ1",
            token_type: "Bearer",
        }),
        cookieSecret,
        isSecure: opts.isSecure ?? false,
    };
    registerAuthRoutes(app, routeDeps);
    return { app, routeDeps, sessionManager, stateStore, cookieSecret };
}

// ---------------------------------------------------------------------------
// pkce-utils
// ---------------------------------------------------------------------------

describe("pkce-utils", () => {
    test("generateCodeVerifier returns a 43-char URL-safe base64 string", () => {
        const v = generateCodeVerifier();
        expect(v.length).toBe(PKCE_VERIFIER_MIN_LEN);
        // RFC 7636 §4.1 alphabet: ALPHA / DIGIT / "-" / "." / "_" / "~"
        // Our generator uses URL-safe base64 (no padding) so only -_ from
        // the symbol set appear.
        expect(/^[A-Za-z0-9_-]+$/.test(v)).toBe(true);
    });

    test("two consecutive generateCodeVerifier() calls differ", () => {
        const a = generateCodeVerifier();
        const b = generateCodeVerifier();
        expect(a).not.toBe(b);
    });

    test("deriveCodeChallenge matches the RFC 7636 Appendix B vector", () => {
        // RFC 7636 §Appendix B test vector.
        const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        expect(deriveCodeChallenge(verifier)).toBe(expected);
    });

    test("deriveCodeChallenge rejects verifiers outside the allowed length", () => {
        let caught: unknown = null;
        try {
            deriveCodeChallenge("too-short");
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(SecurityError);
        expect((caught as SecurityError).code).toBe("PKCE_INVALID_VERIFIER");
    });

    test("base64UrlEncode strips padding and remaps + and /", () => {
        // Two zero bytes encode to "AA==" in standard base64 → "AA" url-safe.
        expect(base64UrlEncode(Buffer.from([0, 0]))).toBe("AA");
        // 0xfb 0xff encodes to "+/8=" standard → "-_8" url-safe.
        expect(base64UrlEncode(Buffer.from([0xfb, 0xff]))).toBe("-_8");
    });
});

// ---------------------------------------------------------------------------
// oauth-state
// ---------------------------------------------------------------------------

describe("OAuthStateStore", () => {
    test("generate + consume round-trip returns the same record", () => {
        const store = new OAuthStateStore();
        const { state, code_verifier } = store.generate("/dashboard");
        const rec = store.consume(state);
        expect(rec).not.toBeNull();
        if (rec === null) return;
        expect(rec.code_verifier).toBe(code_verifier);
        expect(rec.return_to).toBe("/dashboard");
        expect(rec.used).toBe(true);
    });

    test("a second consume() of the same state is rejected (replay)", () => {
        const store = new OAuthStateStore();
        const { state } = store.generate("/");
        const first = store.consume(state);
        const second = store.consume(state);
        expect(first).not.toBeNull();
        expect(second).toBeNull();
    });

    test("expired states are evicted on consume", () => {
        let now = 1_000_000;
        const store = new OAuthStateStore({
            ttlMs: 100,
            now: () => now,
        });
        const { state } = store.generate("/");
        now += OAUTH_STATE_TTL_MS + 1; // way past 100ms
        expect(store.consume(state)).toBeNull();
        // Internal record must also be evicted.
        expect(store.size()).toBe(0);
    });

    test("two freshly generated states never collide", () => {
        const store = new OAuthStateStore();
        const seen = new Set<string>();
        for (let i = 0; i < 64; i++) {
            const { state } = store.generate("/");
            expect(seen.has(state)).toBe(false);
            seen.add(state);
        }
    });

    test("cleanupExpired removes expired records", () => {
        let now = 1_000_000;
        const store = new OAuthStateStore({
            ttlMs: 100,
            now: () => now,
        });
        const a = store.generate("/");
        const b = store.generate("/");
        // Both were created at the same `now`; advancing past the ttl
        // makes them both expired in a single sweep.
        now += 1_000;
        const removed = store.cleanupExpired();
        expect(removed).toBe(2);
        expect(store.size()).toBe(0);
        // Sanity — distinct states were generated.
        expect(a.state).not.toBe(b.state);
    });

    test("sanitizeReturnTo blocks open-redirect bypasses", () => {
        expect(sanitizeReturnTo("/dashboard")).toBe("/dashboard");
        expect(sanitizeReturnTo("/")).toBe("/");
        expect(sanitizeReturnTo(undefined)).toBe("/");
        expect(sanitizeReturnTo("")).toBe("/");
        // Protocol-relative URL.
        expect(sanitizeReturnTo("//evil.com/path")).toBe("/");
        // Absolute URL with scheme.
        expect(sanitizeReturnTo("https://evil.com")).toBe("/");
        // Backslash bypass.
        expect(sanitizeReturnTo("/\\evil")).toBe("/");
        // Embedded query string.
        expect(sanitizeReturnTo("/foo?next=//bad")).toBe("/");
        // Doesn't start with /.
        expect(sanitizeReturnTo("dashboard")).toBe("/");
    });
});

// ---------------------------------------------------------------------------
// session-cookie
// ---------------------------------------------------------------------------

describe("session-cookie", () => {
    test("encode + decode round-trip returns the same id", () => {
        const id = generateSessionId();
        const value = encodeCookie(id, STRONG_COOKIE_SECRET);
        expect(decodeCookie(value, STRONG_COOKIE_SECRET)).toBe(id);
    });

    test("tampered MAC returns null (no throw)", () => {
        const id = generateSessionId();
        const value = encodeCookie(id, STRONG_COOKIE_SECRET);
        // Flip the last character of the MAC.
        const tampered =
            value.slice(0, -1) + (value.endsWith("a") ? "b" : "a");
        expect(decodeCookie(tampered, STRONG_COOKIE_SECRET)).toBeNull();
    });

    test("malformed session_id is rejected before the HMAC compare", () => {
        // Encode a valid id, then replace it with a path-traversal string.
        const validId = generateSessionId();
        const validValue = encodeCookie(validId, STRONG_COOKIE_SECRET);
        const macPart = validValue.split(".")[1] ?? "";
        const evil = `../etc/passwd.${macPart}`;
        expect(decodeCookie(evil, STRONG_COOKIE_SECRET)).toBeNull();
    });

    test("parseSessionCookie pulls portal_session out of a multi-cookie header", () => {
        const id = generateSessionId();
        const value = encodeCookie(id, STRONG_COOKIE_SECRET);
        const header = `csrf=abc; ${SESSION_COOKIE_NAME}=${value}; theme=dark`;
        expect(parseSessionCookie(header, STRONG_COOKIE_SECRET)).toBe(id);
    });

    test("buildSetCookieHeader includes Secure only when isSecure=true", () => {
        const v = "anything.value";
        const insecure = buildSetCookieHeader(v, { isSecure: false });
        const secure = buildSetCookieHeader(v, { isSecure: true });
        expect(insecure.includes("HttpOnly")).toBe(true);
        expect(insecure.includes("SameSite=Strict")).toBe(true);
        expect(insecure.includes("Path=/")).toBe(true);
        expect(insecure.includes("Secure")).toBe(false);
        expect(secure.includes("Secure")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// OAuthAuthProvider
// ---------------------------------------------------------------------------

describe("OAuthAuthProvider.evaluate", () => {
    test("missing cookie redirects to /auth/login", async () => {
        const sm = new SessionManager(new MemorySessionStore());
        const provider = new OAuthAuthProvider({
            config: baseConfig(),
            sessionManager: sm,
            cookieSecret: STRONG_COOKIE_SECRET,
        });
        await provider.init();
        const decision = await provider.evaluate(
            new Request("http://127.0.0.1/dashboard"),
            "127.0.0.1",
        );
        expect(decision.kind).toBe("redirect");
        if (decision.kind !== "redirect") return;
        expect(decision.location).toBe("/auth/login");
    });

    test("tampered cookie redirects to /auth/login (no 500)", async () => {
        const sm = new SessionManager(new MemorySessionStore());
        const provider = new OAuthAuthProvider({
            config: baseConfig(),
            sessionManager: sm,
            cookieSecret: STRONG_COOKIE_SECRET,
        });
        await provider.init();
        const id = generateSessionId();
        const value = encodeCookie(id, STRONG_COOKIE_SECRET);
        const tampered = value.slice(0, -1) + (value.endsWith("a") ? "b" : "a");
        const decision = await provider.evaluate(
            new Request("http://127.0.0.1/dashboard", {
                headers: { cookie: `${SESSION_COOKIE_NAME}=${tampered}` },
            }),
            "127.0.0.1",
        );
        expect(decision.kind).toBe("redirect");
    });

    test("valid session allows with userinfo identity", async () => {
        const sm = new SessionManager(new MemorySessionStore());
        const session = await sm.create({
            user_id: "alice@example.com",
            email: "alice@example.com",
            display_name: "Alice",
            provider: "github",
        });
        const provider = new OAuthAuthProvider({
            config: baseConfig(),
            sessionManager: sm,
            cookieSecret: STRONG_COOKIE_SECRET,
        });
        await provider.init();
        const cookie = encodeCookie(session.session_id, STRONG_COOKIE_SECRET);
        const decision = await provider.evaluate(
            new Request("http://127.0.0.1/dashboard", {
                headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
            }),
            "127.0.0.1",
        );
        expect(decision.kind).toBe("allow");
        if (decision.kind !== "allow") return;
        expect(decision.context.source_user_id).toBe("alice@example.com");
        expect(decision.context.display_name).toBe("Alice");
        expect(decision.context.details).toEqual({
            email: "alice@example.com",
            provider: "github",
            session_id: session.session_id,
        });
    });

    test("init rejects a cookie secret shorter than 32 bytes", async () => {
        const sm = new SessionManager(new MemorySessionStore());
        const provider = new OAuthAuthProvider({
            config: baseConfig(),
            sessionManager: sm,
            cookieSecret: "too-short",
        });
        let caught: unknown = null;
        try {
            await provider.init();
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(SecurityError);
        expect((caught as SecurityError).code).toBe("OAUTH_WEAK_COOKIE_SECRET");
    });

    test("init accepts a base64-encoded 32-byte secret", async () => {
        // 32 random bytes, base64-encoded.
        const secret = base64UrlEncode(
            new Uint8Array([
                1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
                19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
            ]),
        );
        const provider = new OAuthAuthProvider({
            config: baseConfig(),
            sessionManager: new SessionManager(new MemorySessionStore()),
            cookieSecret: secret,
        });
        await provider.init();
    });
});

// ---------------------------------------------------------------------------
// /auth/login + /auth/callback + /auth/logout
// ---------------------------------------------------------------------------

describe("/auth/login", () => {
    test("returns a 302 to the provider's authorize URL", async () => {
        const { app, stateStore } = buildAppWithRoutes();
        const res = await app.fetch(
            new Request("http://localhost/auth/login?return_to=/dashboard"),
        );
        expect(res.status).toBe(302);
        const location = res.headers.get("location") ?? "";
        expect(location.startsWith("https://stub-idp.example/authorize?")).toBe(
            true,
        );
        expect(location.includes("state=")).toBe(true);
        expect(location.includes("challenge=")).toBe(true);
        // State was persisted with the sanitized return_to.
        expect(stateStore.size()).toBe(1);
    });

    test("returns 404 OAUTH_DISABLED when enabled=false", async () => {
        const app = new Hono();
        const sm = new SessionManager(new MemorySessionStore());
        registerAuthRoutes(app, {
            enabled: false,
            stateStore: new OAuthStateStore(),
            providerAdapter: stubProvider(),
            sessionManager: sm,
            tokenExchange: async () => ({
                access_token: "x",
                token_type: "Bearer",
            }),
            cookieSecret: STRONG_COOKIE_SECRET,
            isSecure: false,
        });
        const res = await app.fetch(new Request("http://localhost/auth/login"));
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe("OAUTH_DISABLED");
    });
});

describe("/auth/callback", () => {
    test("missing state returns 400 OAUTH_BAD_CALLBACK", async () => {
        const { app } = buildAppWithRoutes();
        const res = await app.fetch(
            new Request("http://localhost/auth/callback?code=abc"),
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe("OAUTH_BAD_CALLBACK");
    });

    test("invalid state returns 403 OAUTH_STATE_INVALID", async () => {
        const { app } = buildAppWithRoutes();
        const res = await app.fetch(
            new Request(
                "http://localhost/auth/callback?state=does-not-exist&code=abc",
            ),
        );
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe("OAUTH_STATE_INVALID");
    });

    test("expired state returns 403 OAUTH_STATE_INVALID", async () => {
        const app = new Hono();
        let now = 1_000_000;
        const stateStore = new OAuthStateStore({
            ttlMs: 100,
            now: () => now,
        });
        const sm = new SessionManager(new MemorySessionStore());
        registerAuthRoutes(app, {
            enabled: true,
            stateStore,
            providerAdapter: stubProvider(),
            sessionManager: sm,
            tokenExchange: async () => ({
                access_token: "x",
                token_type: "Bearer",
            }),
            cookieSecret: STRONG_COOKIE_SECRET,
            isSecure: false,
        });
        const { state } = stateStore.generate("/");
        now += 10_000; // expire it
        const res = await app.fetch(
            new Request(`http://localhost/auth/callback?state=${state}&code=c`),
        );
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe("OAUTH_STATE_INVALID");
    });

    test("provider error param returns 403 OAUTH_PROVIDER_ERROR", async () => {
        const { app } = buildAppWithRoutes();
        const res = await app.fetch(
            new Request(
                "http://localhost/auth/callback?error=access_denied",
            ),
        );
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe("OAUTH_PROVIDER_ERROR");
    });

    test("happy path sets session cookie and redirects to return_to", async () => {
        const { app, stateStore, sessionManager, cookieSecret } =
            buildAppWithRoutes();
        const { state } = stateStore.generate("/dashboard");
        const res = await app.fetch(
            new Request(`http://localhost/auth/callback?state=${state}&code=c`),
        );
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/dashboard");
        const setCookie = res.headers.get("set-cookie") ?? "";
        expect(setCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
        expect(setCookie.includes("HttpOnly")).toBe(true);
        expect(setCookie.includes("SameSite=Strict")).toBe(true);

        // Pull the session_id back out of the cookie and verify it
        // resolves to a real session in the store.
        const cookieValue = setCookie.split(";")[0]?.split("=").slice(1).join("=") ?? "";
        const sessionId = decodeCookie(cookieValue, cookieSecret);
        expect(sessionId).not.toBeNull();
        if (sessionId === null) return;
        const session = await sessionManager.validate(sessionId);
        expect(session).not.toBeNull();
        expect(session?.user_id).toBe("gh-user-XYZ1");
        expect(session?.email).toBe("alice@example.com");
    });

    test("regenerated session_id differs from the original (defeats fixation)", async () => {
        // Verify the regenerate-after-create flow by spying on the
        // sessionManager: the final cookie's id must NOT equal the id
        // returned by the FIRST create() call inside the handler.
        const sessionStore = new MemorySessionStore();
        const realManager = new SessionManager(sessionStore);
        const createIds: string[] = [];
        const regenerateIds: string[] = [];
        const sessionManager = {
            create: async (profile: Parameters<SessionManager["create"]>[0]) => {
                const s = await realManager.create(profile);
                createIds.push(s.session_id);
                return s;
            },
            validate: realManager.validate.bind(realManager),
            regenerate: async (oldId: string) => {
                const s = await realManager.regenerate(oldId);
                regenerateIds.push(s.session_id);
                return s;
            },
            destroy: realManager.destroy.bind(realManager),
        } as unknown as SessionManager;

        const stateStore = new OAuthStateStore();
        const cookieSecret = STRONG_COOKIE_SECRET;
        const app = new Hono();
        registerAuthRoutes(app, {
            enabled: true,
            stateStore,
            providerAdapter: stubProvider(),
            sessionManager,
            tokenExchange: async () => ({
                access_token: "access-XYZ1",
                token_type: "Bearer",
            }),
            cookieSecret,
            isSecure: false,
        });
        const { state } = stateStore.generate("/");
        const res = await app.fetch(
            new Request(`http://localhost/auth/callback?state=${state}&code=c`),
        );
        expect(res.status).toBe(302);
        const cookie = res.headers.get("set-cookie") ?? "";
        const cookieValue = cookie.split(";")[0]?.split("=").slice(1).join("=") ?? "";
        const finalId = decodeCookie(cookieValue, cookieSecret);
        expect(finalId).not.toBeNull();
        // The cookie id is the regenerated id, not the original create id.
        expect(createIds).toHaveLength(1);
        expect(regenerateIds).toHaveLength(1);
        expect(finalId).toBe(regenerateIds[0] ?? "");
        expect(finalId).not.toBe(createIds[0] ?? "");
        // Only one session should remain in the store — the regenerate()
        // path deleted the original.
        expect(sessionStore.size()).toBe(1);
    });

    test("happy path with isSecure=true emits the Secure cookie attribute", async () => {
        const { app, stateStore } = buildAppWithRoutes({ isSecure: true });
        const { state } = stateStore.generate("/");
        const res = await app.fetch(
            new Request(`http://localhost/auth/callback?state=${state}&code=c`),
        );
        const setCookie = res.headers.get("set-cookie") ?? "";
        expect(setCookie.includes("Secure")).toBe(true);
    });
});

describe("/auth/logout", () => {
    test("GET returns 405 (POST required)", async () => {
        const { app } = buildAppWithRoutes();
        const res = await app.fetch(new Request("http://localhost/auth/logout"));
        expect(res.status).toBe(405);
    });

    test("POST clears the cookie and destroys the session", async () => {
        const { app, sessionManager, cookieSecret } = buildAppWithRoutes();
        // Pre-populate a session and craft a cookie.
        const session = await sessionManager.create({
            user_id: "alice",
            email: "alice@example.com",
            display_name: "Alice",
            provider: "github",
        });
        const cookie = encodeCookie(session.session_id, cookieSecret);
        const res = await app.fetch(
            new Request("http://localhost/auth/logout", {
                method: "POST",
                headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
            }),
        );
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/");
        const setCookie = res.headers.get("set-cookie") ?? "";
        expect(setCookie.includes("Max-Age=0")).toBe(true);
        // Session was destroyed.
        expect(await sessionManager.validate(session.session_id)).toBeNull();
    });
});
