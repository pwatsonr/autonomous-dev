// SPEC-034-1-03 §Tests — server/lib/icons.tsx.
//
// Covers: default size, size override, cache hit on second call (no
// re-read from disk), and loud failure on missing icon.

import { afterEach, describe, expect, test } from "bun:test";
import { renameSync } from "node:fs";
import { join } from "node:path";

import { __resetIconCacheForTests, icon } from "../../server/lib/icons";

const ICON_DIR = join(__dirname, "../../server/static/icons");

afterEach(() => {
    __resetIconCacheForTests();
});

describe("icon()", () => {
    test("default size 16 — markup contains width=\"16\" and height=\"16\"", () => {
        const svg = icon("activity");
        expect(svg).toContain('width="16"');
        expect(svg).toContain('height="16"');
        // Lucide default stroke must survive untouched (design system contract).
        expect(svg).toContain('stroke="currentColor"');
    });

    test("explicit size override — icon('activity', 24) yields width/height 24", () => {
        const svg = icon("activity", 24);
        expect(svg).toContain('width="24"');
        expect(svg).toContain('height="24"');
    });

    test("cache hit on second call — file removed after warm-up still resolves", () => {
        // The cache contract (AC-07) is: after the first call, subsequent
        // calls do NOT touch the disk. We verify this by warming the cache,
        // temporarily moving the source file out of the way, and confirming
        // a second call still succeeds with identical output.
        const target = "circle-slash";
        const path = join(ICON_DIR, `${target}.svg`);
        const backup = `${path}.bak-cache-test`;

        const first = icon(target);
        expect(first).toContain('width="16"');

        renameSync(path, backup);
        try {
            // Disk read here would ENOENT; success proves the cache served it.
            const second = icon(target);
            expect(second).toBe(first);

            // Different size on the cached entry must also work without disk.
            const third = icon(target, 32);
            expect(third).toContain('width="32"');
            expect(third).toContain('height="32"');
        } finally {
            renameSync(backup, path);
        }
    });

    test("missing icon — throws so SSR fails loudly instead of rendering blank", () => {
        expect(() => icon("definitely-not-a-real-icon")).toThrow();
    });

    test("size override does not corrupt the cached source for subsequent default calls", () => {
        // Warm cache via override.
        const big = icon("activity", 48);
        expect(big).toContain('width="48"');

        // Default call must still produce 16, not 48 — proving the cache
        // stores the unmodified source string.
        const small = icon("activity");
        expect(small).toContain('width="16"');
        expect(small).toContain('height="16"');
        expect(small).not.toContain('width="48"');
    });
});
