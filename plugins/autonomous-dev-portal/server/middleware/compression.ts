// SPEC-013-4-01 §Compression Middleware.
//
// Brotli-preferred / gzip-fallback response encoding. Runs AFTER any
// downstream handler (including `staticAssets`) so it sees the final
// response body and headers.
//
// Skip rules (any one short-circuits to a no-op):
//   - response status outside 2xx
//   - response body is null
//   - `Content-Encoding` is already set
//   - `Content-Length` < `minBytes` (default 1024) — overhead exceeds gain
//   - content-type not in compressible allowlist (text/*, application/javascript,
//     application/json, image/svg+xml)
//   - file extension is precompressed (.gz, .br, .png, .woff2, .ico)
//   - `Accept-Encoding` does not include `br` or `gzip`
//
// On apply: replaces the response body with the compressed bytes and
// sets `Content-Encoding`, `Vary: Accept-Encoding`, and a corrected
// `Content-Length`.

import type { MiddlewareHandler } from "hono";

import { isCompressibleType } from "../lib/mime-types";

export interface CompressionOptions {
    /** Skip compression below this many bytes. */
    minBytes?: number;
}

const DEFAULT_MIN_BYTES = 1024;

const PRECOMPRESSED_EXTS = new Set([
    ".gz",
    ".br",
    ".zst",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".woff",
    ".woff2",
    ".ico",
    ".mp4",
    ".webm",
    ".zip",
]);

function pathExtension(path: string): string {
    const dot = path.lastIndexOf(".");
    if (dot < 0) return "";
    const slash = path.lastIndexOf("/");
    if (slash > dot) return "";
    return path.slice(dot).toLowerCase();
}

function pickEncoding(acceptEncoding: string): "br" | "gzip" | null {
    // Honour `Accept-Encoding` ordering / preference is not strictly
    // RFC-correct but is the practical industry default: Brotli first
    // when offered at all, gzip otherwise.
    const lower = acceptEncoding.toLowerCase();
    // Reject explicit zero quality: e.g. `br;q=0`.
    const containsToken = (token: string): boolean => {
        const re = new RegExp(`(^|,\\s*)${token}\\s*(?:;[^,]*)?(?:,|$)`, "i");
        const m = re.exec(lower);
        if (m === null) return false;
        // Block when q=0 explicitly.
        const segment = lower.slice(m.index, m.index + m[0].length);
        if (/q\s*=\s*0(?:\.0+)?\b/.test(segment)) return false;
        return true;
    };
    if (containsToken("br")) return "br";
    if (containsToken("gzip")) return "gzip";
    return null;
}

/**
 * Compresses a Uint8Array via Web Streams `CompressionStream`. Bun
 * implements both `gzip` and `brotli` formats natively. The function
 * is async because the stream API is.
 */
async function compressBuffer(
    bytes: Uint8Array,
    format: "br" | "gzip",
): Promise<Uint8Array> {
    const cf = format === "br" ? "brotli" : "gzip";
    // CompressionStream is part of Web Streams; supported by Bun.
    const cs = new (
        globalThis as unknown as {
            CompressionStream: new (format: string) => TransformStream<
                Uint8Array,
                Uint8Array
            >;
        }
    ).CompressionStream(cf);
    const writer = cs.writable.getWriter();
    void writer.write(bytes);
    void writer.close();
    const reader = cs.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value !== undefined) {
            chunks.push(value);
            total += value.byteLength;
        }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

/**
 * Replaces `c.res` with a compressed copy when all skip rules pass.
 * Idempotent — checks `Content-Encoding` to avoid double-encoding when
 * a downstream handler already compressed.
 */
export function compression(
    options: CompressionOptions = {},
): MiddlewareHandler {
    const minBytes = options.minBytes ?? DEFAULT_MIN_BYTES;

    return async (c, next) => {
        await next();

        const res = c.res;
        if (!(res instanceof Response)) return undefined;
        if (res.status < 200 || res.status >= 300) return undefined;
        if (res.body === null) return undefined;
        if (res.headers.get("Content-Encoding") !== null) return undefined;

        // Skip when client doesn't ask for any supported encoding.
        const acceptEncoding = c.req.header("Accept-Encoding") ?? "";
        if (acceptEncoding === "") return undefined;
        const encoding = pickEncoding(acceptEncoding);
        if (encoding === null) return undefined;

        // Skip precompressed extensions (file ext from request path).
        const ext = pathExtension(c.req.path);
        if (PRECOMPRESSED_EXTS.has(ext)) return undefined;

        // Skip non-compressible content types.
        const contentType = res.headers.get("Content-Type") ?? "";
        if (!isCompressibleType(contentType)) return undefined;

        // Buffer the body so we can both size-check and re-emit.
        const bodyBuf = new Uint8Array(await res.arrayBuffer());
        if (bodyBuf.byteLength < minBytes) {
            // Restore original body since arrayBuffer() consumed it.
            // Build a fresh Response with identical headers.
            const headers = new Headers(res.headers);
            headers.set("Content-Length", String(bodyBuf.byteLength));
            c.res = new Response(bodyBuf, {
                status: res.status,
                statusText: res.statusText,
                headers,
            });
            return undefined;
        }

        const compressed = await compressBuffer(bodyBuf, encoding);
        const headers = new Headers(res.headers);
        headers.set("Content-Encoding", encoding);
        headers.set("Content-Length", String(compressed.byteLength));
        // Append (not replace) Vary; the secure-headers middleware does
        // not set Vary, but be defensive in case a future middleware does.
        const existingVary = headers.get("Vary");
        if (existingVary === null || existingVary === "") {
            headers.set("Vary", "Accept-Encoding");
        } else if (!/\baccept-encoding\b/i.test(existingVary)) {
            headers.set("Vary", `${existingVary}, Accept-Encoding`);
        }
        // Cast through ArrayBuffer view: TS DOM lib types Response body
        // as a strict BodyInit union that excludes Uint8Array generics
        // depending on the toolchain. ArrayBufferView is always valid.
        c.res = new Response(compressed as unknown as BodyInit, {
            status: res.status,
            statusText: res.statusText,
            headers,
        });
        return undefined;
    };
}
