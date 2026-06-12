// plugin-version.ts — single source for the portal's own version, read
// once at module load from .claude-plugin/plugin.json (same logic the
// brand wordmark used privately; extracted for reuse).
//
// asset(href) appends ?v=<version> to static asset URLs. Browsers cache
// /static/* indefinitely (no cache headers, no hashes), so CSS/JS-only
// changes were invisible until a manual hard-refresh — operators saw
// stale styling on every deploy (PORTAL-REDESIGN-HANDOFF cause #2,
// finally observed live on crawl p6: the breaker-grid CSS shipped but
// the operator's browser kept the old ops.css). The version changes on
// every release, so every deploy busts caches exactly once.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PLUGIN_VERSION: string = (() => {
    const fallback = "0.0.0";
    try {
        const path = join(
            import.meta.dir,
            "..",
            "..",
            ".claude-plugin",
            "plugin.json",
        );
        const raw = readFileSync(path, "utf-8");
        const parsed = JSON.parse(raw) as unknown;
        if (
            parsed !== null &&
            typeof parsed === "object" &&
            typeof (parsed as { version?: unknown }).version === "string"
        ) {
            return (parsed as { version: string }).version;
        }
        return fallback;
    } catch {
        return fallback;
    }
})();

/** Versioned URL for a static asset: `/static/x.css` → `/static/x.css?v=0.3.15`. */
export function asset(href: string): string {
    return `${href}?v=${encodeURIComponent(PLUGIN_VERSION)}`;
}
