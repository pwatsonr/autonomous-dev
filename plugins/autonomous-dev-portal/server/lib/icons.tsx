// SPEC-034-1-03 §Inline-SVG icon helper.
//
// Server-side helper that loads vendored Lucide SVGs from
// `static/icons/*.svg` (the canonical served root since PLAN-038 TASK-002),
// caches their raw markup in-process, and emits inline SVG strings with a
// configurable size override.
//
// Why inline (not <img> / sprite):
//   - Templates can apply `currentColor` for stroke, so icons inherit
//     the surrounding text color without extra CSS plumbing.
//   - No extra HTTP round-trip per icon, no FOUC during SSR.
//   - Resolves PRD-018 OQ-03: removes any runtime dependency on
//     external CDNs (TDD-034 §5.7).
//
// Cache contract:
//   - Keyed by icon name. Populated lazily on the first call via
//     `readFileSync`. Subsequent calls reuse the cached string and
//     therefore do NOT touch the disk again (AC-07).
//   - Cache holds the raw on-disk SVG (with its native width/height of
//     "24"). Each call applies the requested size via regex replace so
//     two callers with different sizes share one cache entry.
//
// Failure mode:
//   - `icon("nonexistent")` lets `readFileSync` throw (ENOENT). This is
//     intentional (AC-08): missing icons should fail loudly at SSR time
//     rather than silently render blank squares in production.

import { readFileSync } from "node:fs";
import { join } from "node:path";

// `import.meta.dir` is provided by Bun (the portal's runtime, see
// package.json `engines.bun`). It resolves to the directory of this
// source file (`server/lib/`), which keeps icon resolution stable
// regardless of the process's cwd. The canonical icon root is
// `<package>/static/icons` (PLAN-038 TASK-002 deleted the legacy
// `server/static/` tree).
const ICON_DIR = join(import.meta.dir, "../../static/icons");

const cache = new Map<string, string>();

/**
 * Returns inline SVG markup for a vendored Lucide icon.
 *
 * @param name - Icon basename (e.g. `"activity"` for `activity.svg`).
 * @param size - Pixel width/height applied to the root <svg>. Default `16`.
 * @returns Raw SVG string suitable for embedding via Hono JSX
 *          `dangerouslySetInnerHTML` or template raw-HTML helpers.
 * @throws  If the underlying SVG file does not exist.
 */
export function icon(name: string, size: number = 16): string {
    if (!cache.has(name)) {
        const path = join(ICON_DIR, `${name}.svg`);
        // readFileSync throws ENOENT for unknown icons — see AC-08.
        cache.set(name, readFileSync(path, "utf-8"));
    }
    // Lucide SVGs ship with width="24" and height="24"; replace both with
    // the caller-requested size. The cache stores the unmodified source
    // so different call sites can request different sizes.
    return cache
        .get(name)!
        .replace(/width="[^"]*"/, `width="${size}"`)
        .replace(/height="[^"]*"/, `height="${size}"`);
}

/**
 * Test-only hook: clears the in-process icon cache. Exposed so unit
 * tests can assert disk-read behavior across calls without leaking
 * state from prior suites. Not intended for production use.
 */
export function __resetIconCacheForTests(): void {
    cache.clear();
}
