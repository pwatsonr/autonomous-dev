// SPEC-015-1-01 — Pattern resolution helper for FileWatcher.
//
// PORTAL has no `glob` npm dep (and adding one breaks the lean dep policy
// from PLAN-013-2). This resolver handles the small set of glob shapes
// that the portal actually uses:
//   - exact paths            : "/abs/.autonomous-dev/heartbeat.json"
//   - single-segment wildcard : "/abs/.autonomous-dev/requests/*"
//   - single-segment + suffix : "/abs/.autonomous-dev/requests/*/state.json"
//
// More complex globs (recursive `**`, character classes) are out of scope
// for SPEC-015-1-01 — the daemon file layout is fully covered by the
// shapes above. Unsupported patterns are passed through fs.realpath as
// literal paths; if they don't exist they're dropped.

import { promises as fs } from "node:fs";
import { dirname, join, sep } from "node:path";

/**
 * Resolve a list of (possibly globbed) absolute path patterns to a list
 * of canonical absolute paths to existing files. Errors per-pattern are
 * skipped (logged via the provided logger) so one unreadable pattern does
 * not abort the whole resolution.
 */
export async function resolvePatterns(
    patterns: readonly string[],
    logger: { warn: (msg: string, ...args: unknown[]) => void } = console,
): Promise<string[]> {
    const seen = new Set<string>();
    for (const pattern of patterns) {
        try {
            const matches = await expandPattern(pattern);
            for (const match of matches) {
                try {
                    const real = await fs.realpath(match);
                    seen.add(real);
                } catch {
                    // File disappeared between expansion and realpath, or
                    // realpath failed — drop silently. The watcher polls
                    // / re-resolves on subsequent start() calls.
                }
            }
        } catch (err) {
            logger.warn(
                `glob-resolver: failed to expand pattern "${pattern}": ${(err as Error).message}`,
            );
        }
    }
    return Array.from(seen).sort();
}

async function expandPattern(pattern: string): Promise<string[]> {
    if (!pattern.includes("*")) {
        // Literal path. Only return it if it points to a file.
        try {
            const stat = await fs.stat(pattern);
            if (stat.isFile()) return [pattern];
            return [];
        } catch {
            return [];
        }
    }

    // Find the first wildcard segment.
    const segments = pattern.split(sep);
    let prefixEnd = 0;
    while (prefixEnd < segments.length && !segments[prefixEnd]?.includes("*")) {
        prefixEnd++;
    }
    if (prefixEnd === segments.length) return [];

    const prefixDir = segments.slice(0, prefixEnd).join(sep) || sep;
    const wildcardSeg = segments[prefixEnd];
    const remainder = segments.slice(prefixEnd + 1);

    // Only `*` (single-segment wildcard) is supported. Anything more
    // exotic (`**`, character classes) is rejected as unsupported and
    // returns no matches.
    if (wildcardSeg !== "*") {
        // Allow patterns like `prefix*` or `*.json` — convert to a
        // simple regex over a single directory level.
        const re = compileSegmentGlob(wildcardSeg ?? "");
        let entries: string[];
        try {
            entries = await fs.readdir(prefixDir);
        } catch {
            return [];
        }
        const out: string[] = [];
        for (const entry of entries) {
            if (!re.test(entry)) continue;
            const next = join(prefixDir, entry, ...remainder);
            if (remainder.length === 0) {
                out.push(next);
            } else {
                const sub = await expandPattern(next);
                out.push(...sub);
            }
        }
        return out;
    }

    let entries: string[];
    try {
        entries = await fs.readdir(prefixDir);
    } catch {
        return [];
    }

    const expanded: string[] = [];
    for (const entry of entries) {
        const next = join(prefixDir, entry, ...remainder);
        if (remainder.length === 0) {
            try {
                const stat = await fs.stat(next);
                if (stat.isFile()) expanded.push(next);
            } catch {
                // skip
            }
        } else {
            const sub = await expandPattern(next);
            expanded.push(...sub);
        }
    }
    return expanded;
}

function compileSegmentGlob(seg: string): RegExp {
    // Escape regex metacharacters except `*`, which becomes `.*`.
    const escaped = seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`);
}

/** Return the directory containing `filePath`. Exposed for FileWatcher. */
export function parentDir(filePath: string): string {
    return dirname(filePath);
}
