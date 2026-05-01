// SPEC-014-2-02 §Acceptance Criteria — Typed-CONFIRM service smoke suite.
//
// Mirrors the unit-level acceptance criteria; multi-step end-to-end
// scenarios live in tests/security/csrf-attack-tests.spec.ts (SPEC-014-2-05).

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import {
    CONFIRMATION_PHRASES,
    getConfirmationPhrase,
    isConfirmableAction,
} from "../../server/security/confirmation-phrases";
import {
    DEFAULT_CONFIRMATION_CONFIG,
    TypedConfirmationService,
} from "../../server/security/confirmation-tokens";
import {
    InMemoryConfirmationStore,
    registerConfirmationRoutes,
    requireConfirmation,
} from "../../server/routes/confirmation-routes";

describe("CONFIRMATION_PHRASES allowlist", () => {
    test("contains the documented action set", () => {
        expect(getConfirmationPhrase("kill-switch")).toBe("EMERGENCY STOP");
        expect(getConfirmationPhrase("delete-pipeline")).toBe(
            "DELETE FOREVER",
        );
        expect(getConfirmationPhrase("circuit-breaker-reset")).toBe(
            "RESET BREAKER",
        );
    });

    test("returns null for unknown action", () => {
        expect(getConfirmationPhrase("not-a-real-action")).toBeNull();
        expect(isConfirmableAction("not-a-real-action")).toBe(false);
    });

    test("is frozen so accidental mutation fails fast", () => {
        expect(() => {
            (CONFIRMATION_PHRASES as Record<string, string>)["new-action"] =
                "X";
        }).toThrow();
    });
});

describe("TypedConfirmationService.generateConfirmationToken", () => {
    test("returns 32-char hex token, phrase, and ttl in seconds", () => {
        const svc = new TypedConfirmationService();
        const r = svc.generateConfirmationToken("session-1", {
            action: "kill-switch",
        });
        expect(r.success).toBe(true);
        expect(r.token).toMatch(/^[0-9a-f]{32}$/);
        expect(r.phrase).toBe("EMERGENCY STOP");
        expect(r.ttl).toBe(60);
    });

    test("rejects unknown action", () => {
        const svc = new TypedConfirmationService();
        const r = svc.generateConfirmationToken("s", { action: "evil" });
        expect(r.success).toBe(false);
        expect(r.error).toBe("unknown-action");
    });

    test("rate-limits at maxTokensPerSession in window", () => {
        const svc = new TypedConfirmationService({
            maxTokensPerSession: 3,
        });
        for (let i = 0; i < 3; i += 1) {
            expect(
                svc.generateConfirmationToken("s", { action: "kill-switch" })
                    .success,
            ).toBe(true);
        }
        const r = svc.generateConfirmationToken("s", {
            action: "kill-switch",
        });
        expect(r.success).toBe(false);
        expect(r.error).toBe("rate-limit-exceeded");
    });

    test("LRU evicts beyond maxTokensInMemory", () => {
        const svc = new TypedConfirmationService({
            maxTokensInMemory: 5,
            maxTokensPerSession: 100,
            rateLimitWindow: 60_000,
        });
        for (let i = 0; i < 7; i += 1) {
            svc.generateConfirmationToken(`s${String(i)}`, {
                action: "kill-switch",
            });
        }
        expect(svc.storeSize).toBeLessThan(7);
    });

    test("passes metadata through opaque", () => {
        const svc = new TypedConfirmationService();
        const r = svc.generateConfirmationToken("s", {
            action: "delete-pipeline",
            metadata: { pipeline_id: "p-123" },
        });
        expect(r.success).toBe(true);
    });
});

describe("TypedConfirmationService.validateConfirmation", () => {
    test("accepts exact phrase match and consumes the token", () => {
        const svc = new TypedConfirmationService();
        const r = svc.generateConfirmationToken("s1", {
            action: "kill-switch",
        });
        const v = svc.validateConfirmation(
            r.token ?? "",
            "s1",
            "EMERGENCY STOP",
        );
        expect(v.valid).toBe(true);
        expect(v.action).toBe("kill-switch");
        expect(svc.has(r.token ?? "")).toBe(false);
    });

    test("rejects case-mismatch (no normalization)", () => {
        const svc = new TypedConfirmationService();
        const r = svc.generateConfirmationToken("s1", {
            action: "kill-switch",
        });
        const v = svc.validateConfirmation(
            r.token ?? "",
            "s1",
            "emergency stop",
        );
        expect(v.valid).toBe(false);
        expect(v.error).toBe("phrase-mismatch");
    });

    test("rejects trailing whitespace (no trim)", () => {
        const svc = new TypedConfirmationService();
        const r = svc.generateConfirmationToken("s1", {
            action: "kill-switch",
        });
        const v = svc.validateConfirmation(
            r.token ?? "",
            "s1",
            "EMERGENCY STOP ",
        );
        expect(v.valid).toBe(false);
        expect(v.error).toBe("phrase-mismatch");
    });

    test("rejects unknown token", () => {
        const svc = new TypedConfirmationService();
        const v = svc.validateConfirmation(
            "deadbeef".repeat(4),
            "s",
            "x",
        );
        expect(v.valid).toBe(false);
        expect(v.error).toBe("invalid-or-expired-token");
    });

    test("rejects session mismatch WITHOUT deleting the token", () => {
        const svc = new TypedConfirmationService();
        const r = svc.generateConfirmationToken("s-victim", {
            action: "kill-switch",
        });
        const v = svc.validateConfirmation(
            r.token ?? "",
            "s-attacker",
            "EMERGENCY STOP",
        );
        expect(v.valid).toBe(false);
        expect(v.error).toBe("session-mismatch");
        // Token MUST still be present so the legitimate session can use it.
        expect(svc.has(r.token ?? "")).toBe(true);
    });

    test("phrase-mismatch leaves token in place (retry allowed)", () => {
        const svc = new TypedConfirmationService();
        const r = svc.generateConfirmationToken("s1", {
            action: "kill-switch",
        });
        svc.validateConfirmation(r.token ?? "", "s1", "wrong");
        expect(svc.has(r.token ?? "")).toBe(true);
        const ok = svc.validateConfirmation(
            r.token ?? "",
            "s1",
            "EMERGENCY STOP",
        );
        expect(ok.valid).toBe(true);
    });

    test("rejects input over maxConfirmationLength", () => {
        const svc = new TypedConfirmationService({
            maxConfirmationLength: 10,
        });
        const r = svc.generateConfirmationToken("s1", {
            action: "kill-switch",
        });
        const v = svc.validateConfirmation(
            r.token ?? "",
            "s1",
            "x".repeat(50),
        );
        expect(v.valid).toBe(false);
        expect(v.error).toBe("input-too-long");
    });
});

describe("DEFAULT_CONFIRMATION_CONFIG", () => {
    test("matches spec defaults", () => {
        expect(DEFAULT_CONFIRMATION_CONFIG.tokenTTL).toBe(60_000);
        expect(DEFAULT_CONFIRMATION_CONFIG.maxTokensPerSession).toBe(3);
        expect(DEFAULT_CONFIRMATION_CONFIG.maxConfirmationLength).toBe(100);
        expect(DEFAULT_CONFIRMATION_CONFIG.maxTokensInMemory).toBe(5_000);
    });
});

describe("InMemoryConfirmationStore", () => {
    test("record + consume returns the value once", () => {
        const store = new InMemoryConfirmationStore();
        store.record("s1", "tok", {
            action: "kill-switch",
            metadata: {},
            validatedAt: Date.now(),
            expiresAt: Date.now() + 30_000,
        });
        expect(store.consume("s1", "tok")?.action).toBe("kill-switch");
        // Second consume after the first deletes the record.
        expect(store.consume("s1", "tok")).toBeUndefined();
    });

    test("returns undefined past expiry", () => {
        const store = new InMemoryConfirmationStore();
        store.record("s1", "tok", {
            action: "kill-switch",
            metadata: {},
            validatedAt: Date.now() - 60_000,
            expiresAt: Date.now() - 30_000,
        });
        expect(store.consume("s1", "tok")).toBeUndefined();
    });

    test("scoped per session — cross-session consume returns undefined", () => {
        const store = new InMemoryConfirmationStore();
        store.record("s-alice", "tok", {
            action: "kill-switch",
            metadata: {},
            validatedAt: Date.now(),
            expiresAt: Date.now() + 30_000,
        });
        expect(store.consume("s-bob", "tok")).toBeUndefined();
    });
});

describe("Confirmation routes (Hono integration)", () => {
    function buildApp(opts: { sessionId?: string | undefined } = {}) {
        const svc = new TypedConfirmationService();
        const store = new InMemoryConfirmationStore();
        const app = new Hono();
        registerConfirmationRoutes(app, {
            service: svc,
            store,
            getSessionId: () => opts.sessionId,
        });
        return { app, svc, store };
    }

    test("/request 200 with phrase + token", async () => {
        const { app } = buildApp({ sessionId: "s1" });
        const r = await app.request("/api/security/confirmation/request", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "kill-switch" }),
        });
        expect(r.status).toBe(200);
        const body = (await r.json()) as {
            token: string;
            phrase: string;
            ttl: number;
        };
        expect(body.phrase).toBe("EMERGENCY STOP");
        expect(body.token).toMatch(/^[0-9a-f]{32}$/);
        expect(body.ttl).toBe(60);
    });

    test("/request 401 when no session", async () => {
        const { app } = buildApp({ sessionId: undefined });
        const r = await app.request("/api/security/confirmation/request", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "kill-switch" }),
        });
        expect(r.status).toBe(401);
    });

    test("/request 400 for unknown action", async () => {
        const { app } = buildApp({ sessionId: "s1" });
        const r = await app.request("/api/security/confirmation/request", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "evil" }),
        });
        expect(r.status).toBe(400);
        const body = (await r.json()) as { error: string };
        expect(body.error).toBe("unknown-action");
    });

    test("/request 429 when rate-limited", async () => {
        const { app } = buildApp({ sessionId: "s1" });
        for (let i = 0; i < 3; i += 1) {
            await app.request("/api/security/confirmation/request", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "kill-switch" }),
            });
        }
        const r = await app.request("/api/security/confirmation/request", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "kill-switch" }),
        });
        expect(r.status).toBe(429);
    });

    test("/validate 200 then 400 on replay", async () => {
        const { app, svc } = buildApp({ sessionId: "s1" });
        const issued = svc.generateConfirmationToken("s1", {
            action: "kill-switch",
        });
        const r1 = await app.request(
            "/api/security/confirmation/validate",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    token: issued.token,
                    userInput: "EMERGENCY STOP",
                }),
            },
        );
        expect(r1.status).toBe(200);
        const r2 = await app.request(
            "/api/security/confirmation/validate",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    token: issued.token,
                    userInput: "EMERGENCY STOP",
                }),
            },
        );
        expect(r2.status).toBe(400);
        const body = (await r2.json()) as { error: string };
        expect(body.error).toBe("invalid-or-expired-token");
    });

    test("/validate 400 with phrase-mismatch error", async () => {
        const { app, svc } = buildApp({ sessionId: "s1" });
        const issued = svc.generateConfirmationToken("s1", {
            action: "kill-switch",
        });
        const r = await app.request(
            "/api/security/confirmation/validate",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    token: issued.token,
                    userInput: "WRONG",
                }),
            },
        );
        expect(r.status).toBe(400);
        const body = (await r.json()) as { error: string };
        expect(body.error).toBe("phrase-mismatch");
    });
});

describe("requireConfirmation middleware", () => {
    test("blocks request with no confirmation token", async () => {
        const store = new InMemoryConfirmationStore();
        const app = new Hono();
        app.post(
            "/admin/kill-switch",
            requireConfirmation("kill-switch", {
                store,
                getSessionId: () => "s1",
            }),
            (c) => c.text("ok"),
        );
        const r = await app.request("/admin/kill-switch", {
            method: "POST",
        });
        expect(r.status).toBe(403);
        const body = (await r.json()) as { error: string };
        expect(body.error).toBe("confirmation-required");
    });

    test("admits request when valid confirmation present and consumes it", async () => {
        const store = new InMemoryConfirmationStore();
        store.record("s1", "tok", {
            action: "kill-switch",
            metadata: {},
            validatedAt: Date.now(),
            expiresAt: Date.now() + 30_000,
        });
        const app = new Hono();
        app.post(
            "/admin/kill-switch",
            requireConfirmation("kill-switch", {
                store,
                getSessionId: () => "s1",
            }),
            (c) => c.text("ok"),
        );
        const r = await app.request("/admin/kill-switch", {
            method: "POST",
            headers: { "x-confirmation-token": "tok" },
        });
        expect(r.status).toBe(200);
        // Replay should now fail: consume() deleted the record.
        const r2 = await app.request("/admin/kill-switch", {
            method: "POST",
            headers: { "x-confirmation-token": "tok" },
        });
        expect(r2.status).toBe(403);
    });

    test("rejects token belonging to a different action", async () => {
        const store = new InMemoryConfirmationStore();
        store.record("s1", "tok", {
            action: "kill-switch",
            metadata: {},
            validatedAt: Date.now(),
            expiresAt: Date.now() + 30_000,
        });
        const app = new Hono();
        app.post(
            "/admin/delete",
            requireConfirmation("delete-pipeline", {
                store,
                getSessionId: () => "s1",
            }),
            (c) => c.text("ok"),
        );
        const r = await app.request("/admin/delete", {
            method: "POST",
            headers: { "x-confirmation-token": "tok" },
        });
        expect(r.status).toBe(403);
        const body = (await r.json()) as { error: string };
        expect(body.error).toBe("wrong-action-confirmed");
    });
});
