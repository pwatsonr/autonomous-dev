// SPEC-013-4-01 §Static Asset Middleware.
//
// Serves files from a configured root directory under a URL prefix with:
//   - directory-traversal protection (blocks `..`, NUL bytes, encoded
//     traversal, absolute paths) BEFORE any filesystem call
//   - MIME-type detection via `mimeFor(extname(...))`
//   - weak ETag (`<size>-<mtimeMs base36>`) — no body hashing per request
//   - 304 short-circuit on `If-None-Match`
//   - `Cache-Control` policy: hashed assets get `immutable, max-age=1y`,
//     unhashed get `max-age=24h`
//   - `Range: bytes=N-M` partial content (206) with malformed-range
//     fallback to 200
//   - `X-Content-Type-Options: nosniff` on every response
//
// Layered with `compression()` middleware which wraps this handler so
// downstream compressed bytes still pass through.

import { extname, normalize, resolve, sep } from "node:path";

import type { MiddlewareHandler } from "hono";

import { mimeFor } from "../lib/mime-types";

export interface StaticAssetsOptions {
    /** Filesystem root that may serve files. Resolved to an absolute path on use. */
    rootDir: string;
    /** URL path prefix (e.g. `/static`) stripped before filesystem resolution. */
    urlPrefix: string;
}

// Hashed-asset filename: `<basename>-<8+hex>.<ext>` — matches the
// output of `scripts/hash-assets.sh`.
const HASHED_ASSET_RE = /-[a-f0-9]{8,}\.[a-z0-9]+$/i;

// Allowed unencoded characters in a static URL path segment. Anything
// outside this set is treated as a traversal attempt.
const SAFE_PATH_RE = /^[A-Za-z0-9._\-/]+$/;

const CACHE_CONTROL_HASHED = "public, max-age=31536000, immutable";
const CACHE_CONTROL_UNHASHED = "public, max-age=86400";

interface ParsedRange {
    start: number;
    end: number;
}

/**
 * Parses `Range: bytes=N-M` against `totalSize`. Returns `null` for any
 * malformed or unsatisfiable range so the caller falls back to 200.
 *
 * Spec-required behaviour: do NOT 416 — degrade gracefully to 200.
 */
function parseRange(header: string, totalSize: number): ParsedRange | null {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (match === null) return null;
    const startStr = match[1] ?? "";
    const endStr = match[2] ?? "";
    if (startStr === "" && endStr === "") return null;

    let start: number;
    let end: number;
    if (startStr === "") {
        // Suffix range: last N bytes. e.g. `bytes=-100` → last 100.
        const suffix = Number.parseInt(endStr, 10);
        if (!Number.isFinite(suffix) || suffix <= 0) return null;
        start = Math.max(0, totalSize - suffix);
        end = totalSize - 1;
    } else {
        start = Number.parseInt(startStr, 10);
        end =
            endStr === ""
                ? totalSize - 1
                : Number.parseInt(endStr, 10);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    }
    if (start < 0 || end < start || start >= totalSize) return null;
    if (end >= totalSize) end = totalSize - 1;
    return { start, end };
}

/**
 * Validates the requested URL path is safe to translate into a
 * filesystem path. Rejects:
 *   - empty / root paths
 *   - URL-encoded traversal (%2e, %2f, %00, etc.)
 *   - absolute paths (leading `/`, `\`)
 *   - any segment containing `..` after URL decode
 *   - NUL bytes (defense in depth — Bun.file usually rejects already)
 *   - unsafe characters outside [A-Za-z0-9._-/]
 */
function isSafeRequestPath(rawPath: string): boolean {
    if (rawPath === "" || rawPath === "/") return false;
    // Reject double-slash and backslash before any decoding
    if (rawPath.includes("//") || rawPath.includes("\\")) return false;
    // Reject any percent-encoded sequence — assets MUST have plain names.
    if (rawPath.includes("%")) return false;
    if (rawPath.includes("\0")) return false;
    if (!SAFE_PATH_RE.test(rawPath)) return false;
    // Final guard: literal `..` segment after split
    const segments = rawPath.split("/").filter((s) => s.length > 0);
    for (const segment of segments) {
        if (segment === "..") return false;
        if (segment === ".") return false;
    }
    return true;
}

function buildEtag(size: number, mtimeMs: number): string {
    return `"${String(size)}-${Math.floor(mtimeMs).toString(36)}"`;
}

function isHashedAsset(filename: string): boolean {
    return HASHED_ASSET_RE.test(filename);
}

/**
 * Trims `urlPrefix` from `c.req.path`. Returns the suffix (e.g.
 * `portal.css` for `/static/portal.css`). Returns `null` when the path
 * does not start with the prefix (caller should call `next()`).
 */
function stripPrefix(path: string, urlPrefix: string): string | null {
    const prefix = urlPrefix.endsWith("/") ? urlPrefix : `${urlPrefix}/`;
    if (path === urlPrefix) return ""; // empty → caller will 404
    if (!path.startsWith(prefix)) return null;
    return path.slice(prefix.length);
}

export function staticAssets(opts: StaticAssetsOptions): MiddlewareHandler {
    const absoluteRoot = resolve(opts.rootDir);
    const urlPrefix = opts.urlPrefix.startsWith("/")
        ? opts.urlPrefix
        : `/${opts.urlPrefix}`;

    return async (c, next) => {
        if (c.req.method !== "GET" && c.req.method !== "HEAD") {
            return next();
        }

        const requested = stripPrefix(c.req.path, urlPrefix);
        if (requested === null) {
            // Not under our prefix — let other handlers run.
            return next();
        }
        if (requested === "" || !isSafeRequestPath(requested)) {
            return c.body(null, 404);
        }

        // Resolve and re-check containment. `path.resolve` collapses `..`
        // segments deterministically; the startsWith check is the
        // authoritative containment guard.
        const absolutePath = resolve(absoluteRoot, normalize(requested));
        if (
            absolutePath !== absoluteRoot &&
            !absolutePath.startsWith(absoluteRoot + sep)
        ) {
            return c.body(null, 404);
        }

        const file = Bun.file(absolutePath);
        const exists = await file.exists();
        if (!exists) {
            return c.body(null, 404);
        }
        const size = file.size;
        // Bun.file lastModified is ms since epoch; defaults to 0 when
        // unavailable. Coerce defensively.
        const mtimeMs =
            typeof file.lastModified === "number" && file.lastModified > 0
                ? file.lastModified
                : 0;

        const etag = buildEtag(size, mtimeMs);
        const ext = extname(absolutePath);
        const contentType = mimeFor(ext);
        const filename = absolutePath.slice(
            absolutePath.lastIndexOf(sep) + 1,
        );
        const cacheControl = isHashedAsset(filename)
            ? CACHE_CONTROL_HASHED
            : CACHE_CONTROL_UNHASHED;

        // Common headers applied to every 200/206/304 response.
        const baseHeaders: Record<string, string> = {
            "Content-Type": contentType,
            "X-Content-Type-Options": "nosniff",
            ETag: etag,
            "Cache-Control": cacheControl,
            "Accept-Ranges": "bytes",
        };

        // 304 short-circuit on If-None-Match. Match against the
        // exact ETag (weak comparison — both sides identical here).
        const ifNoneMatch = c.req.header("If-None-Match");
        if (ifNoneMatch !== undefined && ifNoneMatch === etag) {
            return new Response(null, { status: 304, headers: baseHeaders });
        }

        // Range request handling. Malformed → fall through to full 200.
        const rangeHeader = c.req.header("Range");
        if (rangeHeader !== undefined && size > 0) {
            const range = parseRange(rangeHeader, size);
            if (range !== null) {
                const slice = file.slice(range.start, range.end + 1);
                const buf = await slice.arrayBuffer();
                const length = range.end - range.start + 1;
                const headers: Record<string, string> = {
                    ...baseHeaders,
                    "Content-Range": `bytes ${String(range.start)}-${String(
                        range.end,
                    )}/${String(size)}`,
                    "Content-Length": String(length),
                };
                return new Response(buf, { status: 206, headers });
            }
        }

        const buf = await file.arrayBuffer();
        const headers: Record<string, string> = {
            ...baseHeaders,
            "Content-Length": String(size),
        };
        if (c.req.method === "HEAD") {
            return new Response(null, { status: 200, headers });
        }
        return new Response(buf, { status: 200, headers });
    };
}
