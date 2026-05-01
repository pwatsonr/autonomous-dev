// SPEC-014-1-04 §Task 4.7 — Signed session cookie encode/decode.
//
// The cookie value is `<session_id>.<HMAC-SHA256(secret, session_id)>`.
// Verification uses a timing-safe compare to defeat MAC-byte-leak attacks.
//
// Why a signed cookie that just carries the session_id (rather than a JWT
// with embedded user claims):
//   - The server-side store (file/memory) holds the authoritative session
//     state. The cookie is just a pointer.
//   - Rotating the secret invalidates every existing cookie immediately
//     (callers can no longer recompute a matching MAC); we don't need a
//     separate revocation list.
//   - Tampering with the session_id invalidates the MAC; tampering with the
//     MAC fails the compare. Either way the cookie is rejected.
//
// Cookie attributes (buildSetCookieHeader):
//   HttpOnly         — JS cannot read the cookie (defeats XSS exfil).
//   SameSite=Strict  — browser refuses to send the cookie on cross-site
//                      navigations (defeats most CSRF; defense-in-depth
//                      with PLAN-014-2's CSRF tokens).
//   Path=/           — applies to every portal route.
//   Max-Age=2592000  — 30 days (matches the absolute session timeout).
//   Secure           — included unless the bind is localhost (browsers
//                      refuse Secure cookies over http://127.0.0.1).

import { createHmac, timingSafeEqual } from "node:crypto";

/** Cookie name used everywhere in the portal. */
export const SESSION_COOKIE_NAME = "portal_session";

/** Session-ID format: 43 chars of URL-safe base64 (matches generator). */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** 30 days in seconds — the absolute session timeout. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Compute HMAC-SHA256 of `data` using `secret`, returned as lowercase hex.
 * Both inputs are treated as UTF-8 strings; the secret bytes are hashed
 * verbatim by the underlying createHmac key.
 */
export function hmacSha256Hex(secret: string, data: string): string {
    return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

/**
 * Constant-time equality check for two equal-length hex strings. Returns
 * false (without crashing) on length mismatch or non-hex input.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (a.length !== b.length) return false;
    if (a.length === 0) return false;
    let aBuf: Buffer;
    let bBuf: Buffer;
    try {
        aBuf = Buffer.from(a, "hex");
        bBuf = Buffer.from(b, "hex");
    } catch {
        return false;
    }
    if (aBuf.length === 0 || aBuf.length !== bBuf.length) return false;
    return timingSafeEqual(aBuf, bBuf);
}

/**
 * Encode a session_id into the cookie value `<id>.<mac>`. The caller is
 * responsible for wrapping it with `buildSetCookieHeader` (which adds the
 * security attributes).
 */
export function encodeCookie(sessionId: string, secret: string): string {
    if (!SESSION_ID_RE.test(sessionId)) {
        throw new TypeError(
            `encodeCookie: session_id must match ${SESSION_ID_RE.source}`,
        );
    }
    if (typeof secret !== "string" || secret.length === 0) {
        throw new TypeError("encodeCookie: secret must be a non-empty string");
    }
    const mac = hmacSha256Hex(secret, sessionId);
    return `${sessionId}.${mac}`;
}

/**
 * Decode a `<id>.<mac>` cookie value back into the session_id.
 *
 * Returns null when:
 *   - the value is not a string or does not contain exactly one `.`
 *   - the session_id portion fails the SESSION_ID_RE format check
 *     (defeats path-traversal in any later filesystem use of the id)
 *   - the MAC does not match the secret-derived expected MAC under a
 *     timing-safe compare
 */
export function decodeCookie(value: string, secret: string): string | null {
    if (typeof value !== "string" || value.length === 0) return null;
    const parts = value.split(".");
    if (parts.length !== 2) return null;
    const id = parts[0];
    const mac = parts[1];
    if (typeof id !== "string" || typeof mac !== "string") return null;
    if (!SESSION_ID_RE.test(id)) return null;
    const expected = hmacSha256Hex(secret, id);
    if (!timingSafeEqualHex(mac, expected)) return null;
    return id;
}

/**
 * Parse the raw `Cookie:` header and return our session cookie's id (or
 * null if absent / tampered).
 */
export function parseSessionCookie(
    cookieHeader: string,
    secret: string,
): string | null {
    if (typeof cookieHeader !== "string" || cookieHeader.length === 0) {
        return null;
    }
    // Cookie header is `name=value; name=value; ...`. Names are
    // case-sensitive; values may contain `=` after the first one.
    for (const pair of cookieHeader.split(";")) {
        const trimmed = pair.trim();
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const name = trimmed.slice(0, eq);
        if (name !== SESSION_COOKIE_NAME) continue;
        const raw = trimmed.slice(eq + 1);
        return decodeCookie(raw, secret);
    }
    return null;
}

export interface SetCookieOptions {
    /** Toggle the `Secure` flag. Should mirror `bind_host !== '127.0.0.1'`. */
    isSecure: boolean;
    /** Override `Max-Age` (seconds); 0 clears the cookie. */
    maxAgeSeconds?: number;
}

/**
 * Build the full `Set-Cookie:` header value with the documented security
 * attributes. Pass `maxAgeSeconds: 0` for the logout flow.
 */
export function buildSetCookieHeader(
    cookieValue: string,
    opts: SetCookieOptions,
): string {
    const maxAge = opts.maxAgeSeconds ?? SESSION_COOKIE_MAX_AGE_SECONDS;
    const parts = [
        `${SESSION_COOKIE_NAME}=${cookieValue}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        `Max-Age=${String(maxAge)}`,
    ];
    if (opts.isSecure) parts.push("Secure");
    return parts.join("; ");
}
