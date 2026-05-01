// SPEC-014-2-01 §crypto-utils — Pure crypto helpers reused by CSRF,
// confirmation tokens, and CSP nonces.
//
// All helpers go through Bun's global `crypto` (which exposes the WebCrypto
// `crypto.subtle` and `crypto.getRandomValues`). We pull `randomBytes` and
// `timingSafeEqual` from `node:crypto` because Bun ships a Node-compatible
// implementation, and these two primitives are unambiguous (no subtle DOM
// vs Node coercion). HMAC is computed via WebCrypto subtle so the same
// helpers run identically in browser-side test fixtures if needed.

import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Generate `n` cryptographically random bytes encoded as lowercase hex.
 * Default 32 bytes → 64 hex chars (matches SPEC-014-2-01 token format).
 */
export function randomToken(bytes = 32): string {
    return randomBytes(bytes).toString("hex");
}

/**
 * Compute HMAC-SHA256(secret, payload) as lowercase hex.
 *
 * Uses WebCrypto subtle so we depend on a single, well-audited primitive
 * across all runtimes. The async `subtle.sign` call is a few microseconds —
 * not measurable next to the network round-trip cost.
 */
export async function hmacSign(
    secret: string,
    payload: string,
): Promise<string> {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const sig = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(payload),
    );
    const bytes = new Uint8Array(sig);
    let hex = "";
    for (const b of bytes) {
        hex += b.toString(16).padStart(2, "0");
    }
    return hex;
}

/**
 * Constant-time hex string comparison. Returns false for unequal-length
 * inputs WITHOUT calling `timingSafeEqual` (which throws on length
 * mismatch — see SPEC-014-2-01 §Notes "timing-safe comparison gotcha").
 *
 * The length pre-check leaks the length but not the contents. Both the
 * server-issued signature and the cookie value have the same fixed length
 * (64 hex chars) so any mismatch IS an attack.
 */
export function timingSafeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    try {
        return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
    } catch {
        // Buffer.from with invalid hex chars returns shorter buffer; reject.
        return false;
    }
}
