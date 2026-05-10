// SPEC-035-3-05 — KillSwitch state-machine integration tests.
//
// SAFETY-CRITICAL: this suite is the regression gate for the entire
// kill-switch state machine (SPECs -01..-04). The five canonical scenarios
// (KS-I-CANON1..5) are the no-skip tests required by TDD-035 §10.5; any
// PR that regresses one of them MUST fail CI before merge.
//
// Test approach:
//   - In-memory Hono app via `app.request()` — no real socket, no real
//     daemon. The route handlers are wired identically to production
//     except the upstream auth + CSRF middleware are simulated by a tiny
//     fixture middleware (see `simulateCsrfChain`) that mirrors the
//     csrfMiddleware contract from server/security/csrf-protection.ts.
//   - Daemon CLI is replaced via `operationsHandlers.engageKillSwitch =
//     spy` per SPEC-035-3-05 FR-3 — the namespace export from
//     server/lib/daemon-halt.ts is the documented injection point.
//   - Log capture wires a `KillSwitchLogger` stub onto the route builder.
//
// Coverage:
//   §4.1  KS-I-CANON1..5  five canonical
//   §4.2  KS-I-A01..A07   GET arm handler
//   §4.3  KS-I-C01..C10   confirm POST
//   §4.4  KS-I-R01..R08   reset POST

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    test,
    mock,
} from "bun:test";
import { Hono } from "hono";

import { buildKillSwitchRoutes } from "../../server/routes/kill-switch";
import { operationsHandlers } from "../../server/lib/daemon-halt";

// ---------------------------------------------------------------------------
// Log capture — matches the KillSwitchLogger surface.
// ---------------------------------------------------------------------------

interface LogLine {
    event: string;
    fields: Record<string, unknown>;
}

class LogCapture {
    public readonly lines: LogLine[] = [];
    error(event: string, fields?: Record<string, unknown>): void {
        this.lines.push({ event, fields: fields ?? {} });
    }
    clear(): void {
        this.lines.length = 0;
    }
    has(event: string): boolean {
        return this.lines.some((l) => l.event === event);
    }
    findOne(event: string): LogLine | undefined {
        return this.lines.find((l) => l.event === event);
    }
}

// ---------------------------------------------------------------------------
// CSRF middleware simulator
//
// The production server registers `csrfMiddleware` from
// server/security/csrf-protection.ts BEFORE the kill-switch routes. That
// middleware accepts/rejects POSTs based on cookie+header double-submit;
// for hermetic tests we simulate the same contract:
//
//   - GET requests: set c.csrfToken = "csrf-token-test" (mimicking the
//     upstream csrfTokenIssuer). NO 403 path on GET.
//   - POST requests: require body["_csrf"] === "csrf-token-test", else
//     return 403 with the same JSON shape the real middleware emits for
//     HTMX callers. On success, set c.csrfToken to the same token.
// ---------------------------------------------------------------------------

const VALID_CSRF = "csrf-token-test";

function simulateCsrfChain(): import("hono").MiddlewareHandler {
    return async (c, next) => {
        const setLoose = c.set as (k: string, v: unknown) => void;
        if (c.req.method === "GET") {
            setLoose("csrfToken", VALID_CSRF);
            return next();
        }
        if (c.req.method === "POST") {
            // Snapshot the body BEFORE the route handler reads it so we
            // don't double-consume the stream. parseBody() caches the
            // result on the request so this is safe.
            let body: Record<string, unknown> = {};
            try {
                body = (await c.req.parseBody()) as Record<string, unknown>;
            } catch {
                body = {};
            }
            const token = body["_csrf"];
            if (typeof token !== "string" || token !== VALID_CSRF) {
                return c.json(
                    {
                        error: "CSRF_TOKEN_INVALID",
                        message:
                            "Security token validation failed. Please refresh the page.",
                        code: "SECURITY_VIOLATION",
                        reason: "missing-or-invalid-token",
                    },
                    403,
                );
            }
            setLoose("csrfToken", VALID_CSRF);
            return next();
        }
        return next();
    };
}

interface Harness {
    app: Hono;
    log: LogCapture;
}

function buildHarness(): Harness {
    const app = new Hono();
    const log = new LogCapture();
    app.use("*", simulateCsrfChain());
    app.route("/", buildKillSwitchRoutes({ logger: log }));
    return { app, log };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function postForm(
    app: Hono,
    path: string,
    fields: Record<string, string>,
): Promise<Response> {
    const body = new URLSearchParams(fields).toString();
    return app.request(path, {
        method: "POST",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: "http://127.0.0.1",
        },
        body,
    });
}

function getReq(app: Hono, path: string): Promise<Response> {
    return app.request(path, { method: "GET" });
}

/**
 * Mint an armed_at relative to the current Date.now(). Positive offset =
 * future, negative offset = past. Used to test the 30s window and
 * clock-skew defenses without manipulating fake timers.
 */
function armedAtOffset(offsetMs: number): string {
    return new Date(Date.now() + offsetMs).toISOString();
}

/** Extract the `armed_at` value from a rendered KillSwitch fragment. */
function extractArmedAt(html: string): string | null {
    const m = html.match(/<input[^>]*name="armed_at"[^>]*value="([^"]*)"/);
    return m === null ? null : (m[1] ?? null);
}

/** Extract the `_csrf` token value from a rendered fragment. */
function extractCsrf(html: string): string | null {
    const m = html.match(/<input[^>]*name="_csrf"[^>]*value="([^"]*)"/);
    return m === null ? null : (m[1] ?? null);
}

// ---------------------------------------------------------------------------
// Spy harness — replaces operationsHandlers per SPEC-035-3-05 §3.5.
// Reset before every test to ensure call counts are per-test.
// ---------------------------------------------------------------------------

const ORIGINAL_ENGAGE = operationsHandlers.engageKillSwitch;
const ORIGINAL_RESET = operationsHandlers.resetKillSwitch;

let engageSpy: ReturnType<typeof mock>;
let resetSpy: ReturnType<typeof mock>;

beforeEach(() => {
    engageSpy = mock(async (_opts: { reason: string }) => undefined);
    resetSpy = mock(async () => undefined);
    operationsHandlers.engageKillSwitch = engageSpy as unknown as typeof operationsHandlers.engageKillSwitch;
    operationsHandlers.resetKillSwitch = resetSpy as unknown as typeof operationsHandlers.resetKillSwitch;
});

afterEach(() => {
    operationsHandlers.engageKillSwitch = ORIGINAL_ENGAGE;
    operationsHandlers.resetKillSwitch = ORIGINAL_RESET;
});

// ===========================================================================
// §4.1 Five canonical scenarios — TDD-035 §10.5 / PLAN-035-3 Task 8
// ===========================================================================

describe("KillSwitch §4.1 — five canonical scenarios", () => {
    test("KS-I-CANON1: happy path → 200 + engaged + spy called once", async () => {
        const h = buildHarness();
        const armedAt = armedAtOffset(-1_000); // 1s ago
        const res = await postForm(h.app, "/ops/kill-switch", {
            _csrf: VALID_CSRF,
            confirmation: "CONFIRM",
            armed_at: armedAt,
        });
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain('<span class="chip err">ENGAGED</span>');
        expect(body).toContain('<form method="POST" action="/ops/kill-switch/reset">');
        expect(engageSpy).toHaveBeenCalledTimes(1);
        expect(engageSpy.mock.calls[0]).toEqual([
            { reason: "portal-operator-manual" },
        ]);
        expect(h.log.has("kill_switch_engage_failed")).toBe(false);
        expect(res.headers.get("cache-control")).toBe("no-store");
    });

    test("KS-I-CANON2: expired armed_at (31s old) → 422 + idle + no spy", async () => {
        const h = buildHarness();
        const armedAt = armedAtOffset(-31_000); // 31s ago
        const res = await postForm(h.app, "/ops/kill-switch", {
            _csrf: VALID_CSRF,
            confirmation: "CONFIRM",
            armed_at: armedAt,
        });
        expect(res.status).toBe(422);
        const body = await res.text();
        expect(body).toContain('<div class="ks-panel">');
        expect(body).not.toContain('<div class="ks-panel armed">');
        expect(body).toContain("Engage kill switch");
        expect(engageSpy).toHaveBeenCalledTimes(0);
        expect(h.log.has("kill_switch_engage_failed")).toBe(false);
    });

    test("KS-I-CANON3: wrong CONFIRM (lowercase) → 422 + armed + no spy", async () => {
        const h = buildHarness();
        const armedAt = armedAtOffset(-1_000);
        const res = await postForm(h.app, "/ops/kill-switch", {
            _csrf: VALID_CSRF,
            confirmation: "confirm",
            armed_at: armedAt,
        });
        expect(res.status).toBe(422);
        const body = await res.text();
        expect(body).toContain('<div class="ks-panel armed">');
        expect(body).toContain('name="confirmation"');
        expect(body).toContain('name="armed_at"');
        expect(extractArmedAt(body)).toBe(armedAt);
        expect(engageSpy).toHaveBeenCalledTimes(0);
        expect(h.log.has("kill_switch_engage_failed")).toBe(false);
    });

    test("KS-I-CANON4: daemon halt failure → 500 + ks-error + structured log", async () => {
        const h = buildHarness();
        operationsHandlers.engageKillSwitch = mock(async () => {
            throw new Error("daemon unreachable");
        }) as unknown as typeof operationsHandlers.engageKillSwitch;
        const armedAt = armedAtOffset(-1_000);
        const res = await postForm(h.app, "/ops/kill-switch", {
            _csrf: VALID_CSRF,
            confirmation: "CONFIRM",
            armed_at: armedAt,
        });
        expect(res.status).toBe(500);
        const body = await res.text();
        expect(body).toContain('class="ks-panel armed ks-error"');
        expect(body).toContain('<span class="chip err">ERROR</span>');
        expect(body).toContain("Retry");
        expect(body).not.toContain("ENGAGED");
        const line = h.log.findOne("kill_switch_engage_failed");
        expect(line).toBeDefined();
        expect(line?.fields["error"]).toBe("daemon unreachable");
        expect(line?.fields["armed_at"]).toBe(armedAt);
    });

    test("KS-I-CANON5: missing CSRF → 403 + no spy", async () => {
        const h = buildHarness();
        const armedAt = armedAtOffset(-1_000);
        const res = await postForm(h.app, "/ops/kill-switch", {
            // no _csrf
            confirmation: "CONFIRM",
            armed_at: armedAt,
        });
        expect(res.status).toBe(403);
        const body = await res.text();
        expect(body).not.toContain("ENGAGED");
        expect(body).not.toContain("ks-panel");
        expect(engageSpy).toHaveBeenCalledTimes(0);
    });
});

// ===========================================================================
// §4.2 GET arm handler — SPEC-035-3-02
// ===========================================================================

describe("KillSwitch §4.2 — GET arm handler", () => {
    test("KS-I-A01: step=arm happy path", async () => {
        const h = buildHarness();
        const res = await getReq(h.app, "/ops/kill-switch-modal?step=arm");
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type") ?? "").toContain("text/html");
        const body = await res.text();
        expect(body).toContain('<div class="ks-panel armed">');
        const armedAt = extractArmedAt(body);
        expect(armedAt).not.toBeNull();
        expect(armedAt ?? "").toMatch(
            /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        );
        const t = Date.parse(armedAt ?? "");
        expect(Math.abs(Date.now() - t)).toBeLessThan(2_000);
        expect(extractCsrf(body)).toBe(VALID_CSRF);
    });

    test("KS-I-A02: step missing → idle fragment", async () => {
        const h = buildHarness();
        const res = await getReq(h.app, "/ops/kill-switch-modal");
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain('<div class="ks-panel">');
        expect(body).not.toContain('<div class="ks-panel armed">');
        expect(extractArmedAt(body)).toBeNull();
    });

    test("KS-I-A03: step=cancel → idle fragment", async () => {
        const h = buildHarness();
        const res = await getReq(h.app, "/ops/kill-switch-modal?step=cancel");
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).not.toContain('<div class="ks-panel armed">');
        expect(extractArmedAt(body)).toBeNull();
    });

    test("KS-I-A04: Cache-Control header is no-store", async () => {
        const h = buildHarness();
        const res = await getReq(h.app, "/ops/kill-switch-modal?step=arm");
        expect(res.headers.get("cache-control")).toBe("no-store");
        // FR-6: no Set-Cookie emitted by the handler itself.
        expect(res.headers.get("set-cookie")).toBeNull();
    });

    test("KS-I-A05: armed_at query param is IGNORED (server-minted)", async () => {
        const h = buildHarness();
        const injected = "1900-01-01T00:00:00.000Z";
        const res = await getReq(
            h.app,
            `/ops/kill-switch-modal?step=arm&armed_at=${encodeURIComponent(injected)}`,
        );
        expect(res.status).toBe(200);
        const body = await res.text();
        const armedAt = extractArmedAt(body);
        expect(armedAt).not.toBe(injected);
        expect(armedAt ?? "").toMatch(/^20\d{2}-/);
    });

    // KS-I-A06 (unauthenticated → 401) is enforced by the upstream
    // authMiddleware which is NOT mounted in the route module under test.
    // Per SPEC-035-3-02 FR-9 the handler does not re-implement auth; that
    // contract is verified by tests/security/auth-middleware tests, not
    // here. We document the boundary explicitly:
    test("KS-I-A06: unauthenticated path is the responsibility of authMiddleware (documented boundary)", () => {
        // No-op: this is a contract test for the SPEC boundary. The
        // route module never re-implements auth; the upstream middleware
        // is exercised in the auth test suites.
        expect(true).toBe(true);
    });

    test("KS-I-A07: concurrent arms produce distinct armed_at values", async () => {
        const h = buildHarness();
        // Two parallel GETs. If the system clock has insufficient
        // resolution on this platform, we retry once after a 1ms gap to
        // ensure distinct ISO strings (ms-precision).
        const [r1, r2] = await Promise.all([
            getReq(h.app, "/ops/kill-switch-modal?step=arm"),
            getReq(h.app, "/ops/kill-switch-modal?step=arm"),
        ]);
        const a1 = extractArmedAt(await r1.text());
        let a2 = extractArmedAt(await r2.text());
        if (a1 === a2) {
            await new Promise((r) => setTimeout(r, 2));
            const r3 = await getReq(h.app, "/ops/kill-switch-modal?step=arm");
            a2 = extractArmedAt(await r3.text());
        }
        expect(a1).not.toBeNull();
        expect(a2).not.toBeNull();
        expect(a1).not.toBe(a2);
    });

    test("KS-I-A-extra: GET /ops/kill-switch?step=arm also routes here (idle button hx-get path)", async () => {
        const h = buildHarness();
        const res = await getReq(h.app, "/ops/kill-switch?step=arm");
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain('<div class="ks-panel armed">');
        expect(extractArmedAt(body)).not.toBeNull();
    });
});

// ===========================================================================
// §4.3 Confirm POST — SPEC-035-3-03
// ===========================================================================

describe("KillSwitch §4.3 — POST /ops/kill-switch (confirm + engage)", () => {
    test("KS-I-C01: missing CSRF → 403 + spy not called", async () => {
        const h = buildHarness();
        const res = await postForm(h.app, "/ops/kill-switch", {
            confirmation: "CONFIRM",
            armed_at: armedAtOffset(-1_000),
        });
        expect(res.status).toBe(403);
        expect(engageSpy).toHaveBeenCalledTimes(0);
    });

    test("KS-I-C02: confirmation=lowercase → 422 + armed + no spy", async () => {
        const h = buildHarness();
        const res = await postForm(h.app, "/ops/kill-switch", {
            _csrf: VALID_CSRF,
            confirmation: "confirm",
            armed_at: armedAtOffset(-1_000),
        });
        expect(res.status).toBe(422);
        const body = await res.text();
        expect(body).toContain('<div class="ks-panel armed">');
        expect(engageSpy).toHaveBeenCalledTimes(0);
    });

    test('KS-I-C03: confirmation="CONFIRMx" → 422 + armed', async () => {
        const h = buildHarness();
        const res = await postForm(h.app, "/ops/kill-switch", {
            _csrf: VALID_CSRF,
            confirmation: "CONFIRMx",
            armed_at: armedAtOffset(-1_000),
        });
        expect(res.status).toBe(422);
        const body = await res.text();
        expect(body).toContain('<div class="ks-panel armed">');
        expect(engageSpy).toHaveBeenCalledTimes(0);
    });

    test('KS-I-C04: confirmation=" CONFIRM" → 422 + armed', async () => {
        const h = buildHarness();
        const res = await postForm(h.app, "/ops/kill-switch", {
            _csrf: VALID_CSRF,
            confirmation: " CONFIRM",
            armed_at: armedAtOffset(-1_000),
        });
        expect(res.status).toBe(422);
        const body = await res.text();
        expect(body).toContain('<div class="ks-panel armed">');
        expect(engageSpy).toHaveBeenCalledTimes(0);
    });

    test("KS-I-C05: armed_at missing → 422 + 'Arming timestamp missing'", async () => {
        const h = buildHarness();
        const res = await postForm(h.app, "/ops/kill-switch", {
            _csrf: VALID_CSRF,
            confirmation: "CONFIRM",
            // armed_at omitted
        });
        expect(res.status).toBe(422);
        const body = await res.text();
        expect(body).toContain("Arming timestamp missing");
        expect(body).toContain('hx-get="/ops/kill-switch-modal?step=arm"');
        expect(engageSpy).toHaveBeenCalledTimes(0);
    });

    test("KS-I-C06: armed_at expired (31s old) → 422 + idle + NO error log", async () => {
        const h = buildHarness();
        const res = await postForm(h.app, "/ops/kill-switch", {
            _csrf: VALID_CSRF,
            confirmation: "CONFIRM",
            armed_at: armedAtOffset(-31_000),
        });
        expect(res.status).toBe(422);
        const body = await res.text();
        expect(body).toContain('<div class="ks-panel">');
        expect(body).not.toContain('<div class="ks-panel armed">');
        expect(engageSpy).toHaveBeenCalledTimes(0);
        expect(h.log.has("kill_switch_engage_failed")).toBe(false);
    });

    test("KS-I-C07: armed_at future-skewed (+10s) → 422 + idle", async () => {
        const h = buildHarness();
        const res = await postForm(h.app, "/ops/kill-switch", {
            _csrf: VALID_CSRF,
            confirmation: "CONFIRM",
            armed_at: armedAtOffset(10_000),
        });
        expect(res.status).toBe(422);
        const body = await res.text();
        expect(body).not.toContain('<div class="ks-panel armed">');
        expect(engageSpy).toHaveBeenCalledTimes(0);
    });

    test("KS-I-C08: armed_at malformed → 422 + idle", async () => {
        const h = buildHarness();
        const res = await postForm(h.app, "/ops/kill-switch", {
            _csrf: VALID_CSRF,
            confirmation: "CONFIRM",
            armed_at: "not-a-date",
        });
        expect(res.status).toBe(422);
        const body = await res.text();
        expect(body).not.toContain('<div class="ks-panel armed">');
        expect(engageSpy).toHaveBeenCalledTimes(0);
    });

    test("KS-I-C09: daemon throw → 500 + ks-error + Retry + structured log", async () => {
        const h = buildHarness();
        operationsHandlers.engageKillSwitch = mock(async () => {
            throw new Error("daemon EPIPE");
        }) as unknown as typeof operationsHandlers.engageKillSwitch;
        const armedAt = armedAtOffset(-1_000);
        const res = await postForm(h.app, "/ops/kill-switch", {
            _csrf: VALID_CSRF,
            confirmation: "CONFIRM",
            armed_at: armedAt,
        });
        expect(res.status).toBe(500);
        const body = await res.text();
        expect(body).toContain('class="ks-panel armed ks-error"');
        expect(body).toContain('<span class="chip err">ERROR</span>');
        expect(body).toContain('hx-get="/ops/kill-switch-modal?step=arm"');
        const line = h.log.findOne("kill_switch_engage_failed");
        expect(line).toBeDefined();
        expect(line?.fields["error"]).toBe("daemon EPIPE");
        expect(line?.fields["armed_at"]).toBe(armedAt);
    });

    test("KS-I-C10: happy path → 200 + engaged + reset form + fresh _csrf + Cache-Control", async () => {
        const h = buildHarness();
        const armedAt = armedAtOffset(-1_000);
        const res = await postForm(h.app, "/ops/kill-switch", {
            _csrf: VALID_CSRF,
            confirmation: "CONFIRM",
            armed_at: armedAt,
        });
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain('<span class="chip err">ENGAGED</span>');
        expect(body).toContain('<form method="POST" action="/ops/kill-switch/reset">');
        expect(extractCsrf(body)).toBe(VALID_CSRF);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(engageSpy).toHaveBeenCalledTimes(1);
        expect(engageSpy.mock.calls[0]).toEqual([
            { reason: "portal-operator-manual" },
        ]);
    });

    test("KS-I-C-order: validation chain short-circuits on first failure (CONFIRM before window)", async () => {
        // SPEC-035-3-03 AC-10 — wrong CONFIRM + expired armed_at: the
        // CONFIRM check fires first per FR-3, so we get the ARMED
        // fragment (with the expired armed_at echoed) — NOT the idle
        // fragment that the window check would emit. This protects the
        // operator's retry path consistency.
        const h = buildHarness();
        const expired = armedAtOffset(-31_000);
        const res = await postForm(h.app, "/ops/kill-switch", {
            _csrf: VALID_CSRF,
            confirmation: "wrong",
            armed_at: expired,
        });
        expect(res.status).toBe(422);
        const body = await res.text();
        expect(body).toContain('<div class="ks-panel armed">');
        expect(extractArmedAt(body)).toBe(expired);
        expect(engageSpy).toHaveBeenCalledTimes(0);
    });
});

// ===========================================================================
// §4.4 Reset POST — SPEC-035-3-04
// ===========================================================================

describe("KillSwitch §4.4 — POST /ops/kill-switch/reset", () => {
    test("KS-I-R01: missing CSRF → 403 + spy not called", async () => {
        const h = buildHarness();
        const res = await postForm(h.app, "/ops/kill-switch/reset", {});
        expect(res.status).toBe(403);
        expect(resetSpy).toHaveBeenCalledTimes(0);
    });

    test("KS-I-R02: happy path → 200 + idle + Cache-Control no-store", async () => {
        const h = buildHarness();
        const res = await postForm(h.app, "/ops/kill-switch/reset", {
            _csrf: VALID_CSRF,
        });
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain('<span class="chip ok">DISENGAGED</span>');
        expect(body).toContain("Engage kill switch");
        // The idle fragment is HTMX-driven (no form), so it carries no
        // _csrf input itself; the next state-changing flow (re-arm via
        // GET) re-issues a token via the upstream csrfTokenIssuer.
        expect(extractCsrf(body)).toBeNull();
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(resetSpy).toHaveBeenCalledTimes(1);
        expect(resetSpy.mock.calls[0]).toEqual([]);
    });

    test("KS-I-R03: idempotent — two consecutive resets → both 200 + idle", async () => {
        const h = buildHarness();
        const r1 = await postForm(h.app, "/ops/kill-switch/reset", {
            _csrf: VALID_CSRF,
        });
        const r2 = await postForm(h.app, "/ops/kill-switch/reset", {
            _csrf: VALID_CSRF,
        });
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        const body1 = await r1.text();
        const body2 = await r2.text();
        expect(body1).toContain("DISENGAGED");
        expect(body2).toContain("DISENGAGED");
        expect(resetSpy).toHaveBeenCalledTimes(2);
        expect(h.log.has("kill_switch_reset_failed")).toBe(false);
    });

    test("KS-I-R04: daemon throw → 500 + ks-error + Retry + structured log", async () => {
        const h = buildHarness();
        operationsHandlers.resetKillSwitch = mock(async () => {
            throw new Error("daemon unreachable");
        }) as unknown as typeof operationsHandlers.resetKillSwitch;
        const res = await postForm(h.app, "/ops/kill-switch/reset", {
            _csrf: VALID_CSRF,
        });
        expect(res.status).toBe(500);
        const body = await res.text();
        expect(body).toContain('<div class="ks-panel ks-error">');
        expect(body).toContain('<span class="chip err">RESET FAILED</span>');
        expect(body).toContain('action="/ops/kill-switch/reset"');
        expect(body).toContain("Retry reset");
        expect(body).not.toContain("DISENGAGED");
        const line = h.log.findOne("kill_switch_reset_failed");
        expect(line).toBeDefined();
        expect(line?.fields["error"]).toBe("daemon unreachable");
        // FR-7: error fragment must include a fresh _csrf token.
        expect(extractCsrf(body)).toBe(VALID_CSRF);
    });

    test("KS-I-R05: confirmation field on reset is silently ignored", async () => {
        const h = buildHarness();
        const res = await postForm(h.app, "/ops/kill-switch/reset", {
            _csrf: VALID_CSRF,
            confirmation: "anything",
        });
        expect(res.status).toBe(200);
        expect(resetSpy).toHaveBeenCalledTimes(1);
    });

    test("KS-I-R06: unauthenticated path is the responsibility of authMiddleware (documented boundary)", () => {
        // Same boundary as KS-I-A06 — auth is upstream, not here.
        expect(true).toBe(true);
    });

    test("KS-I-R07: success path emits NO log line", async () => {
        const h = buildHarness();
        const res = await postForm(h.app, "/ops/kill-switch/reset", {
            _csrf: VALID_CSRF,
        });
        expect(res.status).toBe(200);
        const matching = h.log.lines.filter((l) =>
            l.event.includes("kill_switch_reset"),
        );
        expect(matching).toHaveLength(0);
    });

    test("KS-I-R08: error fragment retry form has fresh _csrf", async () => {
        const h = buildHarness();
        operationsHandlers.resetKillSwitch = mock(async () => {
            throw new Error("boom");
        }) as unknown as typeof operationsHandlers.resetKillSwitch;
        const res = await postForm(h.app, "/ops/kill-switch/reset", {
            _csrf: VALID_CSRF,
        });
        expect(res.status).toBe(500);
        const body = await res.text();
        const tok = extractCsrf(body);
        expect(tok).toBe(VALID_CSRF);
        expect(tok ?? "").toHaveLength(VALID_CSRF.length);
    });
});

// ===========================================================================
// §AC-6: failure-path bodies are unmistakable (cross-cutting)
// ===========================================================================

describe("KillSwitch failure-path body invariants", () => {
    test("daemon-engage failure body never contains ENGAGED", async () => {
        const h = buildHarness();
        operationsHandlers.engageKillSwitch = mock(async () => {
            throw new Error("x");
        }) as unknown as typeof operationsHandlers.engageKillSwitch;
        const res = await postForm(h.app, "/ops/kill-switch", {
            _csrf: VALID_CSRF,
            confirmation: "CONFIRM",
            armed_at: armedAtOffset(-1_000),
        });
        const body = await res.text();
        expect(body).not.toContain("ENGAGED");
        expect(body).toContain("Retry");
    });

    test("daemon-reset failure body never contains DISENGAGED", async () => {
        const h = buildHarness();
        operationsHandlers.resetKillSwitch = mock(async () => {
            throw new Error("x");
        }) as unknown as typeof operationsHandlers.resetKillSwitch;
        const res = await postForm(h.app, "/ops/kill-switch/reset", {
            _csrf: VALID_CSRF,
        });
        const body = await res.text();
        expect(body).not.toContain("DISENGAGED");
        expect(body).toContain("Retry reset");
    });
});
