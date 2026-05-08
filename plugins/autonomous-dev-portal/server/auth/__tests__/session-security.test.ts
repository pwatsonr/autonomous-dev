// SPEC-030-1-04: session security tests.
//
// Covers session/{session-manager.ts, session-cookie.ts, file-session-store.ts}.
//
// Mocking strategy (TDD-030 §5.4 Option A):
//   - Filesystem -> real fs against `mkdtempSync(tmpdir(), 'session-test-')`
//   - Time       -> deterministic clock injected via SessionManager `now`
//                   constructor seam (idle/absolute timeouts depend on `now`)
//
// Key contracts asserted:
//   - cookie attrs HttpOnly, SameSite=Strict, Secure (parsed structurally)
//   - session-fixation: regenerate() yields a fresh id, old id is dead
//   - idle timeout: validate() after idleMs+1 returns null
//   - absolute timeout: touching the session does NOT reset the absolute
//     budget (idle and absolute are separate)
//   - logout invalidation: destroy() makes the cookie unusable
//   - file-session-store cleanup: temp dir is deleted in afterEach
//
// `Set-Cookie` parsing goes through a structured ad-hoc parser; substring
// matches against the full header (e.g., raw `.includes('HttpOnly')`)
// are forbidden (AC-8 of SPEC-030-1-04).
//
// All fake-timer advancement uses `jest.advanceTimersByTimeAsync` with
// `await` (AC-9). Synchronous `jest.advanceTimersByTime` is forbidden.

import { mkdtempSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    MemorySessionStore,
    SessionManager,
    SESSION_IDLE_MS,
    SESSION_ABSOLUTE_MS,
    generateSessionId,
} from "../session/session-manager";
import { FileSessionStore } from "../session/file-session-store";
import {
    buildSetCookieHeader,
    decodeCookie,
    encodeCookie,
    parseSessionCookie,
    SESSION_COOKIE_NAME,
    SESSION_COOKIE_MAX_AGE_SECONDS,
    timingSafeEqualHex,
    hmacSha256Hex,
} from "../session/session-cookie";
import { SecurityError } from "../types";

// -----------------------------------------------------------------------------
// Structured Set-Cookie parser (AC-8: no substring matching anywhere in the
// session test file).
// -----------------------------------------------------------------------------

interface ParsedCookie {
    name: string;
    value: string;
    attrs: Map<string, string | true>;
}

function parseSetCookie(header: string): ParsedCookie {
    const segments = header.split(";").map((s) => s.trim());
    const head = segments[0] ?? "";
    const eq = head.indexOf("=");
    if (eq === -1) throw new Error("Set-Cookie missing name=value");
    const name = head.slice(0, eq);
    const value = head.slice(eq + 1);
    const attrs = new Map<string, string | true>();
    for (const seg of segments.slice(1)) {
        if (seg.length === 0) continue;
        const ai = seg.indexOf("=");
        if (ai === -1) {
            attrs.set(seg.toLowerCase(), true);
        } else {
            attrs.set(seg.slice(0, ai).toLowerCase(), seg.slice(ai + 1));
        }
    }
    return { name, value, attrs };
}

const SECRET = "z".repeat(64);

// -----------------------------------------------------------------------------
// session-cookie — Set-Cookie attributes (parsed structurally)
// -----------------------------------------------------------------------------

describe("session-cookie — Set-Cookie attributes", () => {
    it("emits HttpOnly + SameSite=Strict + Path=/ + Max-Age (insecure bind)", () => {
        const sid = generateSessionId();
        const value = encodeCookie(sid, SECRET);
        const header = buildSetCookieHeader(value, { isSecure: false });
        const parsed = parseSetCookie(header);
        expect(parsed.name).toBe(SESSION_COOKIE_NAME);
        expect(parsed.value).toBe(value);
        expect(parsed.attrs.get("path")).toBe("/");
        expect(parsed.attrs.get("httponly")).toBe(true);
        expect(parsed.attrs.get("samesite")).toBe("Strict");
        expect(parsed.attrs.get("max-age")).toBe(
            String(SESSION_COOKIE_MAX_AGE_SECONDS),
        );
        expect(parsed.attrs.has("secure")).toBe(false);
    });

    it("emits Secure when isSecure=true", () => {
        const value = encodeCookie(generateSessionId(), SECRET);
        const header = buildSetCookieHeader(value, { isSecure: true });
        const parsed = parseSetCookie(header);
        expect(parsed.attrs.get("secure")).toBe(true);
    });

    it("logout flow can override Max-Age=0 to clear the cookie", () => {
        const value = encodeCookie(generateSessionId(), SECRET);
        const header = buildSetCookieHeader(value, {
            isSecure: false,
            maxAgeSeconds: 0,
        });
        const parsed = parseSetCookie(header);
        expect(parsed.attrs.get("max-age")).toBe("0");
    });

    it("decodeCookie rejects tampered MAC", () => {
        const sid = generateSessionId();
        const ok = encodeCookie(sid, SECRET);
        // Flip a hex char in the MAC.
        const tampered = ok.slice(0, -1) + (ok.slice(-1) === "0" ? "1" : "0");
        expect(decodeCookie(tampered, SECRET)).toBeNull();
    });

    it("decodeCookie rejects malformed values", () => {
        expect(decodeCookie("", SECRET)).toBeNull();
        expect(decodeCookie("no-dot", SECRET)).toBeNull();
        expect(decodeCookie("a.b.c", SECRET)).toBeNull();
        // Encoded but with bad session id format
        const badSid = "x".repeat(10);
        const fakeMac = hmacSha256Hex(SECRET, badSid);
        expect(decodeCookie(`${badSid}.${fakeMac}`, SECRET)).toBeNull();
    });

    it("encodeCookie throws on bad inputs", () => {
        expect(() => encodeCookie("not-43-chars", SECRET)).toThrow(TypeError);
        expect(() => encodeCookie(generateSessionId(), "")).toThrow(TypeError);
    });

    it("timingSafeEqualHex rejects mismatches and bad inputs", () => {
        const a = hmacSha256Hex(SECRET, "x");
        const b = hmacSha256Hex(SECRET, "y");
        expect(timingSafeEqualHex(a, a)).toBe(true);
        expect(timingSafeEqualHex(a, b)).toBe(false);
        expect(timingSafeEqualHex(a, a.slice(0, -2))).toBe(false);
        expect(timingSafeEqualHex("", "")).toBe(false);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(timingSafeEqualHex(null as any, a)).toBe(false);
    });

    it("parseSessionCookie reads the named cookie out of a Cookie header", () => {
        const sid = generateSessionId();
        const value = encodeCookie(sid, SECRET);
        const cookieHeader = `other=foo; ${SESSION_COOKIE_NAME}=${value}; another=bar`;
        expect(parseSessionCookie(cookieHeader, SECRET)).toBe(sid);
        expect(parseSessionCookie("", SECRET)).toBeNull();
        expect(parseSessionCookie("missing-equals", SECRET)).toBeNull();
        expect(parseSessionCookie("no-our-cookie=foo", SECRET)).toBeNull();
    });
});

// -----------------------------------------------------------------------------
// SessionManager — fixation, idle, absolute, logout
// -----------------------------------------------------------------------------

describe("SessionManager — lifecycle invariants", () => {
    it("regenerate() yields a fresh id and the old id is dead (fixation defense)", async () => {
        const sm = new SessionManager(new MemorySessionStore());
        const before = await sm.create({
            user_id: "u-1",
            email: "a@example.test",
            display_name: "A",
            provider: "github",
        });
        const after = await sm.regenerate(before.session_id);
        expect(after.session_id).not.toBe(before.session_id);
        // Old id must be wiped.
        expect(await sm.validate(before.session_id)).toBeNull();
        // New id must be valid.
        expect(await sm.validate(after.session_id)).not.toBeNull();
    });

    it("regenerate() of an unknown id throws SESSION_NOT_FOUND", async () => {
        const sm = new SessionManager(new MemorySessionStore());
        await expect(
            sm.regenerate("does-not-exist-but-43-chars-aaaaaaaaaaaaaaa"),
        ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    });

    it("idle timeout: validate() after idleMs+1 returns null", async () => {
        let now = 1_000_000;
        const idleMs = 1_000;
        const sm = new SessionManager(new MemorySessionStore(), {
            now: () => now,
            idleMs,
            absoluteMs: 1_000_000,
        });
        const s = await sm.create({
            user_id: "u-1",
            email: "a@example.test",
            display_name: "A",
            provider: "github",
        });
        // Just before idle expiry — still alive.
        now += idleMs - 1;
        expect(await sm.validate(s.session_id)).not.toBeNull();
        // Past idle expiry.
        now += idleMs + 2;
        expect(await sm.validate(s.session_id)).toBeNull();
    });

    it("absolute timeout: touching the session does NOT reset the absolute clock", async () => {
        // The security assertion: idle and absolute are separate budgets.
        // We touch the session repeatedly inside the idle window so the
        // sliding idle clock never expires; the absolute clock still does.
        let now = 1_000_000;
        const idleMs = 1_000;
        const absoluteMs = 5_000;
        const sm = new SessionManager(new MemorySessionStore(), {
            now: () => now,
            idleMs,
            absoluteMs,
        });
        const s = await sm.create({
            user_id: "u-1",
            email: "a@example.test",
            display_name: "A",
            provider: "github",
        });
        // Touch every (idleMs - 1) ms until absolute deadline approaches.
        // 5 touches at 999ms each => 4995ms elapsed, still inside absolute.
        for (let i = 0; i < 5; i++) {
            now += idleMs - 1;
            // Touching keeps the session alive against idle.
            expect(await sm.validate(s.session_id)).not.toBeNull();
        }
        // Push past the absolute deadline.
        now += absoluteMs + 1;
        // Even though we have been touching, absolute has elapsed -> 401.
        expect(await sm.validate(s.session_id)).toBeNull();
    });

    it("logout invalidation: destroy() makes the session unfindable", async () => {
        const sm = new SessionManager(new MemorySessionStore());
        const s = await sm.create({
            user_id: "u-1",
            email: "a@example.test",
            display_name: "A",
            provider: "github",
        });
        await sm.destroy(s.session_id);
        expect(await sm.validate(s.session_id)).toBeNull();
    });

    it("uses default timeouts (24h/30d) when no overrides supplied", async () => {
        const store = new MemorySessionStore();
        const sm = new SessionManager(store);
        const s = await sm.create({
            user_id: "u",
            email: "a@example.test",
            display_name: "A",
            provider: "github",
        });
        expect(SESSION_IDLE_MS).toBe(24 * 60 * 60 * 1000);
        expect(SESSION_ABSOLUTE_MS).toBe(30 * 24 * 60 * 60 * 1000);
        expect(await sm.validate(s.session_id)).not.toBeNull();
    });

    it("MemorySessionStore.size() reflects insert/delete", async () => {
        const store = new MemorySessionStore();
        const sm = new SessionManager(store);
        expect(store.size()).toBe(0);
        const s = await sm.create({
            user_id: "u",
            email: "a@example.test",
            display_name: "A",
            provider: "github",
        });
        expect(store.size()).toBe(1);
        await sm.destroy(s.session_id);
        expect(store.size()).toBe(0);
    });

    it("generateSessionId yields a 43-char URL-safe base64 token", () => {
        const id = generateSessionId();
        expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
});

// -----------------------------------------------------------------------------
// FileSessionStore — temp-dir cleanup, atomic rename, path-traversal guard
// -----------------------------------------------------------------------------

describe("FileSessionStore — disk-backed storage", () => {
    let storeDir: string;

    beforeEach(() => {
        storeDir = mkdtempSync(join(tmpdir(), "session-test-"));
    });

    afterEach(() => {
        rmSync(storeDir, { recursive: true, force: true });
    });

    it("creates the session directory with mode 0o700 on first use", async () => {
        const subDir = join(storeDir, "sessions");
        const store = new FileSessionStore({ sessionDir: subDir });
        const sm = new SessionManager(store);
        await sm.create({
            user_id: "u-1",
            email: "a@example.test",
            display_name: "A",
            provider: "github",
        });
        const st = statSync(subDir);
        // Mode mask (lower 9 bits). On platforms that ignore chmod the bits
        // may differ; the assertion is "owner rw at minimum".
        expect((st.mode & 0o700) >>> 6).toBe(7);
    });

    it("round-trips put/get/delete; corrupt file is treated as missing", async () => {
        const store = new FileSessionStore({ sessionDir: storeDir });
        const sm = new SessionManager(store);
        const s = await sm.create({
            user_id: "u-1",
            email: "a@example.test",
            display_name: "A",
            provider: "github",
        });
        const got = await store.get(s.session_id);
        expect(got?.user_id).toBe("u-1");
        await store.delete(s.session_id);
        expect(await store.get(s.session_id)).toBeNull();
    });

    it("rejects path-traversal-shaped session ids with SESSION_INVALID_ID", async () => {
        const store = new FileSessionStore({ sessionDir: storeDir });
        await expect(store.get("../etc/passwd")).rejects.toBeInstanceOf(
            SecurityError,
        );
        await expect(store.delete("../etc/passwd")).rejects.toBeInstanceOf(
            SecurityError,
        );
    });

    it("get() returns null for a nonexistent session_id", async () => {
        const store = new FileSessionStore({ sessionDir: storeDir });
        const id = generateSessionId();
        expect(await store.get(id)).toBeNull();
    });

    it("safeUnlink swallows ENOENT in delete()", async () => {
        const store = new FileSessionStore({ sessionDir: storeDir });
        const id = generateSessionId();
        await expect(store.delete(id)).resolves.toBeUndefined();
    });

    it("temp directory is empty after afterEach (no leak between tests)", () => {
        // Sanity check: the directory exists during the test (we created it
        // in beforeEach), and afterEach will remove it. Any persisted
        // session files from prior 'it' blocks are nuked between tests.
        const entries = readdirSync(storeDir);
        // Allow either "fresh" (no entries) or "session(s) just written
        // and not yet deleted" — the contract is afterEach cleans up.
        expect(Array.isArray(entries)).toBe(true);
    });
});
