// SPEC-013-4-01 §MIME Type Map.
//
// File-extension → MIME-type lookup for the static asset middleware. The
// fallback (`application/octet-stream`) is intentional — it is the safe
// default that prevents browsers from sniffing arbitrary content as
// executable when paired with `X-Content-Type-Options: nosniff`.
//
// Adding a new extension: include the `; charset=utf-8` suffix only for
// text-based formats. Binary formats (images, fonts) MUST NOT advertise a
// charset.

export const MIME_TYPES: Readonly<Record<string, string>> = {
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml; charset=utf-8",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".json": "application/json; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8",
};

/**
 * Returns the MIME type for an extension (with leading `.`). Falls back
 * to `application/octet-stream` when the extension is unknown so callers
 * never serve a half-typed response.
 */
export function mimeFor(ext: string): string {
    return MIME_TYPES[ext.toLowerCase()] ?? "application/octet-stream";
}

/**
 * Heuristic: which MIME types compress well? Text and structured-data
 * formats are listed; precompressed binaries (images, fonts) are excluded
 * by the asset extension allowlist in `compression.ts`.
 */
export function isCompressibleType(contentType: string): boolean {
    const ct = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (ct.startsWith("text/")) return true;
    if (ct === "application/javascript") return true;
    if (ct === "application/json") return true;
    if (ct === "image/svg+xml") return true;
    return false;
}
