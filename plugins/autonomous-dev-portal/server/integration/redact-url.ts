// SPEC-030-2-03 — Local URL-key redaction utility.
//
// `redaction.ts` covers user:password@host URL credentials but does NOT
// strip `?api_key=` style query parameters (TDD-030 OQ-30-07). Per
// NG-3004 we MUST NOT modify `redaction.ts` to add this case; instead
// the cost pipeline calls into this small file-local helper.
//
// Internal to the integration module — not imported from elsewhere.

const KEY_PARAM_NAMES = new Set(["api_key", "apikey", "api-key"]);

/**
 * Returns the input with api_key-style query params replaced by
 * `REDACTED`. Non-URL strings pass through unchanged. Never throws.
 */
export function stripApiKeyParams(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return value;
    }
    let mutated = false;
    for (const key of [...url.searchParams.keys()]) {
        if (KEY_PARAM_NAMES.has(key.toLowerCase())) {
            url.searchParams.set(key, "REDACTED");
            mutated = true;
        }
    }
    return mutated ? url.toString() : value;
}

/**
 * Walks a payload depth-first; returns a copy with URL strings
 * sanitized. Input is not mutated.
 */
export function redactPayloadUrls<T>(payload: T): T {
    return walk(payload) as T;
}

function walk(node: unknown): unknown {
    if (typeof node === "string") return stripApiKeyParams(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            out[k] = walk(v);
        }
        return out;
    }
    return node;
}
