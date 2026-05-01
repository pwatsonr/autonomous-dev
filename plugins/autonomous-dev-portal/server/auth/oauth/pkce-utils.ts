// SPEC-014-1-04 §Task 4.1 — RFC 7636 PKCE primitives.
//
// Two pure functions implementing the §4.1-4.2 algorithm:
//
//   generateCodeVerifier()         — 43-char URL-safe base64 (32 random bytes
//                                    after stripping padding).
//   deriveCodeChallenge(verifier)  — base64url(SHA256(ASCII(verifier))).
//
// No third-party dependencies: random bytes come from `crypto.randomBytes`
// and the digest from `crypto.createHash('sha256')`. Both of those Node
// built-ins are exposed verbatim in the Bun runtime, so the same code path
// runs in dev (`bun test`) and prod (`bun run server.ts`).
//
// IMPORTANT: never log the verifier. It is the secret half of the PKCE
// pair; the challenge MAY be logged (it travels in the public authorize
// URL anyway) but the verifier MUST stay in the OAuthStateStore until it
// is consumed by the token exchange.

import { createHash, randomBytes } from "node:crypto";

import { SecurityError } from "../types";

/** Min/max verifier length per RFC 7636 §4.1. */
export const PKCE_VERIFIER_MIN_LEN = 43;
export const PKCE_VERIFIER_MAX_LEN = 128;

/** Charset that defines the verifier alphabet (unreserved per §4.1). */
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]+$/;

/**
 * Encode a byte buffer as URL-safe base64 with the trailing `=` padding
 * stripped. Mirrors RFC 4648 §5 with the §3.2 padding-omission rule that
 * RFC 7636 references for both the verifier and challenge encodings.
 */
export function base64UrlEncode(bytes: Uint8Array | Buffer): string {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * RFC 7636 §4.1 — generate a high-entropy `code_verifier`.
 *
 * 32 random bytes encode to a 43-character URL-safe base64 string after the
 * padding is stripped, which falls inside the §4.1 length range
 * `[43, 128]`. The charset is the strict §4.1 unreserved subset
 * `[A-Za-z0-9_-]` (no `.~` since we don't pre-pad).
 */
export function generateCodeVerifier(): string {
    return base64UrlEncode(randomBytes(32));
}

/**
 * RFC 7636 §4.2 — derive the S256 `code_challenge` from a verifier.
 *
 * `code_challenge = base64url(SHA256(ASCII(code_verifier)))`. The verifier
 * is treated as a US-ASCII string per §4.2 paragraph 2; we throw a
 * SecurityError if the caller passes something outside the allowed length
 * or alphabet so a misuse fails closed instead of silently producing a
 * malformed challenge.
 */
export function deriveCodeChallenge(verifier: string): string {
    if (typeof verifier !== "string") {
        throw new SecurityError(
            "PKCE_INVALID_VERIFIER",
            "code_verifier must be a string",
        );
    }
    if (
        verifier.length < PKCE_VERIFIER_MIN_LEN ||
        verifier.length > PKCE_VERIFIER_MAX_LEN
    ) {
        throw new SecurityError(
            "PKCE_INVALID_VERIFIER",
            `code_verifier length ${String(verifier.length)} outside [${String(
                PKCE_VERIFIER_MIN_LEN,
            )}, ${String(PKCE_VERIFIER_MAX_LEN)}]`,
        );
    }
    if (!PKCE_VERIFIER_RE.test(verifier)) {
        throw new SecurityError(
            "PKCE_INVALID_VERIFIER",
            "code_verifier contains characters outside the RFC 7636 §4.1 alphabet",
        );
    }
    const digest = createHash("sha256").update(verifier, "ascii").digest();
    return base64UrlEncode(digest);
}
