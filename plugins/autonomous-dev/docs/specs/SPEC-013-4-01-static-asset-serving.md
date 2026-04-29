# SPEC-013-4-01: Static Asset Serving with Cache Headers, ETag, and Content-Type Detection

## Metadata
- **Parent Plan**: PLAN-013-4
- **Tasks Covered**: TASK-004 (static file serving middleware), TASK-005 (compression middleware), TASK-010 (asset hash generation)
- **Estimated effort**: 6 hours

## Description
Implement the Hono static asset middleware that serves files from the portal's `static/` directory with correct MIME-type detection, ETag generation, cache-control policies (immutable for hashed assets, 24-hour TTL for unhashed), gzip/brotli compression, range-request support, and directory-traversal protection. Wire in the asset hashing build script and manifest-driven URL resolver so templates reference `assetUrl('portal.css')` and receive `/static/portal-a1b2c3.css`. Apply NFR-aligned size threshold (≥1KB) before compressing to avoid overhead on small assets.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `server/middleware/static-assets.ts` | Create | Path normalization, ETag, cache-control, range requests |
| `server/middleware/compression.ts` | Create | Brotli-preferred negotiation with gzip fallback |
| `server/lib/mime-types.ts` | Create | Extension → MIME map (.js, .css, .svg, .ico, .png, .woff2) |
| `server/lib/asset-manifest.ts` | Create | Read manifest JSON, atomic refresh on file change |
| `server/helpers/asset-url.ts` | Create | `assetUrl(name)` template helper |
| `scripts/hash-assets.sh` | Create | SHA256 build-time hashing + manifest writer |
| `server/server.ts` | Modify | Mount middleware in correct order (compression → static) |
| `static/asset-manifest.json` | Create (build artifact) | Logical → hashed name map |

## Implementation Details

### MIME Type Map (`server/lib/mime-types.ts`)

```typescript
export const MIME_TYPES: Readonly<Record<string, string>> = {
  '.js':    'application/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.svg':   'image/svg+xml; charset=utf-8',
  '.ico':   'image/x-icon',
  '.png':   'image/png',
  '.woff2': 'font/woff2',
  '.json':  'application/json; charset=utf-8',
  '.html':  'text/html; charset=utf-8',
};

export function mimeFor(ext: string): string {
  return MIME_TYPES[ext.toLowerCase()] ?? 'application/octet-stream';
}
```

### Static Asset Middleware (`server/middleware/static-assets.ts`)

```typescript
staticAssets(opts: { rootDir: string; urlPrefix: string }) -> MiddlewareHandler
```

Behavior:
1. Resolve `requestedPath = c.req.path` after `urlPrefix`. Reject if it contains `..`, NUL bytes, or absolute paths (`/`, `\\`).
2. Compute `absolutePath = path.resolve(rootDir, requestedPath)`. Reject if `!absolutePath.startsWith(rootDir + path.sep)`.
3. `stat()` the file. On `ENOENT`/`EACCES`/missing → return 404 (do not leak fs errors).
4. Compute ETag: `"${size}-${mtimeMs.toString(36)}"` (weak ETag style, no body hashing on every request).
5. Honor `If-None-Match`: return 304 with no body when ETag matches.
6. Set headers:
   - `Content-Type` from `mimeFor(extname(absolutePath))`
   - `X-Content-Type-Options: nosniff`
   - `ETag: <computed>`
   - `Cache-Control`: if filename matches `^[A-Za-z0-9_.-]+-[a-f0-9]{8,}\.[a-z]+$` (hashed) → `public, max-age=31536000, immutable`, else `public, max-age=86400`
   - `Accept-Ranges: bytes`
7. If `Range: bytes=N-M` header present and parseable, stream `[N..M]` with `206 Partial Content` and `Content-Range`. Otherwise stream full body.

### Compression Middleware (`server/middleware/compression.ts`)

```typescript
compression(opts: { minBytes: number /* default 1024 */, level: number /* default 6 */ }) -> MiddlewareHandler
```

Behavior:
1. Run `await next()` first to collect downstream response.
2. Skip if response status is not 2xx, body is null, or `Content-Encoding` is already set.
3. Skip if `Content-Length < minBytes` or content-type is not in compressible allowlist: `text/*`, `application/javascript`, `application/json`, `image/svg+xml`.
4. Parse `Accept-Encoding` request header. Prefer `br` if listed; fall back to `gzip`. If neither present → no-op.
5. Replace response body with a streamed `Bun.gzipSync` / brotli-equivalent buffer at `level=6`. Set:
   - `Content-Encoding: br` or `gzip`
   - `Vary: Accept-Encoding`
   - Updated `Content-Length`
6. Never compress files with `.gz`, `.br`, `.png`, `.woff2`, `.ico` extensions (already compressed).

### Asset Manifest (`server/lib/asset-manifest.ts`)

```typescript
class AssetManifest {
  constructor(manifestPath: string)
  resolve(logicalName: string): string  // throws if not found in production mode
  refresh(): Promise<void>               // atomic re-read from disk
}
```

- In `NODE_ENV=production`: throw `MissingAssetError` if logical name not in manifest.
- In development: fall back to logical name (`portal.css` → `/static/portal.css`).
- Manifest format: `{ "portal.css": "portal-a1b2c3d4.css", "htmx.min.js": "htmx.min-e5f6.js" }`
- Atomic refresh: read into temp object, swap on success only. Never serve a half-loaded manifest.

### Asset URL Helper (`server/helpers/asset-url.ts`)

```typescript
assetUrl(logicalName: string): string  // returns "/static/<resolved>"
```

Singleton `AssetManifest` instance, lazily initialized on first call.

### Hash Build Script (`scripts/hash-assets.sh`)

```bash
hash-assets.sh -> writes static/asset-manifest.json
```

- Iterate over `static/*.{js,css,svg,woff2}` (excluding already-hashed `*-[hex].*`).
- For each file: compute `sha256sum`, take first 8 hex chars, copy to `<basename>-<hash>.<ext>`.
- Write manifest atomically: write to `asset-manifest.json.tmp`, `mv` to final path.
- Cleanup: remove orphaned `*-<hex>.<ext>` files whose source no longer exists.
- Exit non-zero on any failure (CI integration).

### Server Wiring (`server/server.ts`)

Middleware mount order (top-to-bottom):
```
1. compression (wraps everything below)
2. staticAssets({ rootDir: 'static', urlPrefix: '/static' })
3. existing route handlers
```

## Acceptance Criteria

- [ ] `GET /static/portal.css` returns 200 with `Content-Type: text/css; charset=utf-8` and `Cache-Control` containing `max-age=86400`
- [ ] `GET /static/portal-a1b2c3d4.css` (hashed) returns `Cache-Control: public, max-age=31536000, immutable`
- [ ] `GET /static/portal.css` with `Accept-Encoding: gzip, br` returns 200 with `Content-Encoding: br` (preferred) or `gzip`
- [ ] `GET /static/portal.css` with `If-None-Match: <prev-etag>` returns 304 with empty body
- [ ] `GET /static/portal.css` with `Range: bytes=0-99` returns 206 with `Content-Range: bytes 0-99/<size>`
- [ ] `GET /static/../package.json` returns 404 (path traversal blocked)
- [ ] `GET /static/missing.css` returns 404
- [ ] `GET /static/icon.png` returns 200 with NO `Content-Encoding` header (image not compressed)
- [ ] Files <1024 bytes returned uncompressed even when `Accept-Encoding: gzip` present
- [ ] All static responses include `X-Content-Type-Options: nosniff`
- [ ] `bun run scripts/hash-assets.sh` produces `static/asset-manifest.json` with valid JSON
- [ ] `assetUrl('portal.css')` returns `/static/portal-<hash>.css` after build, `/static/portal.css` in dev mode
- [ ] Missing logical name in production mode throws `MissingAssetError`

## Dependencies

- **Upstream**: PLAN-013-2 (Hono server scaffolding), PLAN-013-3 (template helpers consume `assetUrl`)
- **Bun runtime**: `Bun.file()`, `Bun.gzipSync()`, native brotli support via Web Streams
- **No new npm dependencies** — uses Bun built-ins exclusively
- **Consumed by**: SPEC-013-4-02 (HTMX/CSS placement), SPEC-013-4-03 (error pages reference `assetUrl`), SPEC-013-4-04 (header verification tests)

## Notes

- ETag uses `mtimeMs + size` (weak) to avoid body hashing on every request; combined with manifest hashing this gives correct cache invalidation without per-request cost.
- Range request support is for future large-asset use cases (fonts, images). Implementation must handle malformed ranges gracefully (fall back to full response).
- Compression order matters: it must wrap static assets so gzipped responses include the static body. Reversing the order produces uncompressed output.
- Path traversal validation runs BEFORE filesystem `stat()` to avoid leaking existence of files outside `rootDir`.
- The manifest is read-only at runtime; only `hash-assets.sh` writes it. No mutation API.
