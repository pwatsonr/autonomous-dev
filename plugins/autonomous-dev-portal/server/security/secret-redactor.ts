// SPEC-014-3-03 §Task 1 — SecretRedactor.
//
// Length-floor based redaction. Callers pass an explicit list of known
// secret strings — there is no heuristic extraction (UUIDs, hashes, and
// base64 blobs that aren't secrets produced too many false positives in
// the plan's draft). The 8-code-point minimum is the security contract:
// shorter "secrets" cannot be redacted because the marker would leak
// more entropy than the original.
//
// Unicode handling matters here. Surrogate pairs in `s.length` count as
// 2 UTF-16 code units. We use `Array.from(s)` (which iterates by code
// point) for both the floor check and the suffix slice — so multibyte
// passwords behave as a user would expect them to.

import { SecurityError } from "./types";

/** Minimum code-point count for a value to be redactable. */
const MIN_SECRET_LENGTH = 8;

/** Replacement marker — four U+2022 BULLETs. */
const MARKER = "••••";

/** Field names whose VALUES are always redacted by `redactObject`. */
export const ALWAYS_REDACT_FIELD_NAMES = new Set<string>([
    "password",
    "token",
    "api_key",
    "apiKey",
    "secret",
    "credential",
    "authorization",
]);

/**
 * Redacts known secrets in strings or whole objects. Stateless and safe
 * to share across the process.
 */
export class SecretRedactor {
    /** Mask a single known secret string. */
    redact(secret: unknown): string {
        if (typeof secret !== "string") {
            throw new SecurityError(
                "REDACT_INVALID_TYPE",
                "Invalid secret type",
            );
        }
        const codePoints = Array.from(secret);
        if (codePoints.length < MIN_SECRET_LENGTH) {
            throw new SecurityError(
                "REDACT_SECRET_TOO_SHORT",
                `Secret too short: ${String(codePoints.length)} code points (minimum: ${String(MIN_SECRET_LENGTH)})`,
            );
        }
        const tail = codePoints.length >= 12 ? 4 : 2;
        return MARKER + codePoints.slice(-tail).join("");
    }

    /**
     * Replace every literal occurrence of every secret in `text` with
     * its redacted form. Secrets shorter than the floor are silently
     * replaced with the bare MARKER so log lines never carry the raw
     * value through.
     */
    redactInText(text: string, knownSecrets: readonly string[]): string {
        let out = text;
        for (const secret of knownSecrets) {
            if (typeof secret !== "string" || secret.length === 0) continue;
            const codePoints = Array.from(secret);
            const replacement =
                codePoints.length < MIN_SECRET_LENGTH
                    ? MARKER
                    : MARKER + codePoints.slice(codePoints.length >= 12 ? -4 : -2).join("");
            // String.prototype.replaceAll with a literal string — no
            // regex, no escaping concerns. Safe across all secret bytes.
            out = out.split(secret).join(replacement);
        }
        return out;
    }

    /**
     * Walk `obj` recursively and replace any string field whose KEY is
     * in {@link ALWAYS_REDACT_FIELD_NAMES} with the marker (or redacted
     * suffix when the value is long enough). Returns a deep clone — the
     * input is not mutated.
     */
    redactObject(obj: unknown): unknown {
        return this.redactValue(obj);
    }

    private redactValue(value: unknown): unknown {
        if (value === null || value === undefined) return value;
        if (Array.isArray(value)) {
            return value.map((v) => this.redactValue(v));
        }
        if (typeof value === "object") {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
                if (ALWAYS_REDACT_FIELD_NAMES.has(k) && typeof v === "string") {
                    try {
                        out[k] = this.redact(v);
                    } catch {
                        // Short value — surface marker so the secret is
                        // still suppressed even when too short to redact
                        // meaningfully.
                        out[k] = MARKER;
                    }
                } else {
                    out[k] = this.redactValue(v);
                }
            }
            return out;
        }
        return value;
    }

    /** Marker constant exposed for tests / callers that need it. */
    static get MARKER(): string {
        return MARKER;
    }
}
