# SPEC-034-1-03: Self-host 24 Lucide SVGs and ship inline-SVG helper

## Metadata
- **Parent Plan**: PLAN-034-1-tokens-and-theme
- **Parent TDD**: TDD-034-portal-redesign-foundations
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Estimated effort**: 2 hours
- **Dependencies**: []
- **Priority**: P0

## Objective

Vendor 24 Lucide icon SVGs (from the `lucide-static` package) into `plugins/autonomous-dev-portal/server/static/icons/` and implement a server-side helper at `plugins/autonomous-dev-portal/server/lib/icons.tsx` that reads, caches, and emits inline SVG markup with a configurable size override (default `16`). Inline SVGs inherit `currentColor` for stroke, matching the design system spec. This resolves PRD-018 OQ-03 (TDD-034 §5.7) and removes any runtime dependency on `unpkg.com`.

## Acceptance Criteria

- [ ] AC-01: Directory `plugins/autonomous-dev-portal/server/static/icons/` contains exactly 24 SVG files. Verify: `ls plugins/autonomous-dev-portal/server/static/icons/*.svg | wc -l` returns `24`.
- [ ] AC-02: The 24 filenames are exactly: `activity.svg`, `shield-alert.svg`, `circle-slash.svg`, `git-branch.svg`, `git-pull-request.svg`, `play.svg`, `pause.svg`, `square.svg`, `chevron-right.svg`, `chevron-down.svg`, `check.svg`, `x.svg`, `alert-triangle.svg`, `info.svg`, `terminal.svg`, `cpu.svg`, `database.svg`, `dollar-sign.svg`, `trending-up.svg`, `trending-down.svg`, `users.svg`, `bot.svg`, `bell.svg`, `bell-off.svg`.
- [ ] AC-03: Each SVG references `stroke="currentColor"` (Lucide default). Verify: `grep -L 'currentColor' plugins/autonomous-dev-portal/server/static/icons/*.svg` returns empty.
- [ ] AC-04: File `plugins/autonomous-dev-portal/server/lib/icons.tsx` exists and exports a function with signature `export function icon(name: string, size?: number): string` (default size `16`).
- [ ] AC-05: `icon("activity")` returns SVG markup containing `width="16"` and `height="16"`.
- [ ] AC-06: `icon("activity", 24)` returns SVG markup containing `width="24"` and `height="24"`.
- [ ] AC-07: A second call to `icon("activity")` does NOT re-read the file from disk (verified via cache: an internal `Map<string,string>` is populated on the first call and reused on subsequent calls).
- [ ] AC-08: Calling `icon("nonexistent")` throws (so missing icons fail loudly at SSR time, not silently render blank).
- [ ] AC-09: No portal template references `unpkg.com` or any external CDN for icons. Verify: `grep -RIn 'unpkg' plugins/autonomous-dev-portal/server/templates plugins/autonomous-dev-portal/server/lib` returns zero hits.

## Implementation

### Files to create / modify
- `plugins/autonomous-dev-portal/server/static/icons/<name>.svg` — NEW (24 files).
- `plugins/autonomous-dev-portal/server/lib/icons.tsx` — NEW. Inline-SVG helper.
- `plugins/autonomous-dev-portal/tests/unit/icons.test.ts` — NEW. Helper unit tests.

### Step-by-step

1. From the `lucide-static` package (`npm view lucide-static dist.tarball` → extract → `icons/`), copy the 24 named SVGs in AC-02 into `plugins/autonomous-dev-portal/server/static/icons/`.
2. Create `plugins/autonomous-dev-portal/server/lib/icons.tsx` per TDD-034 §5.7:
   ```ts
   import { readFileSync } from "fs";
   import { join } from "path";

   const ICON_DIR = join(import.meta.dir, "../static/icons");
   const cache = new Map<string, string>();

   export function icon(name: string, size: number = 16): string {
     if (!cache.has(name)) {
       const path = join(ICON_DIR, `${name}.svg`);
       cache.set(name, readFileSync(path, "utf-8"));
     }
     return cache.get(name)!
       .replace(/width="[^"]*"/, `width="${size}"`)
       .replace(/height="[^"]*"/, `height="${size}"`);
   }
   ```
3. Create unit tests in `plugins/autonomous-dev-portal/tests/unit/icons.test.ts` covering: default size 16; size override 24; cache hit on second call; throws on missing icon.
4. Run `npx jest plugins/autonomous-dev-portal/tests/unit/icons.test.ts`; all assertions pass.

## Tests

- Unit: `plugins/autonomous-dev-portal/tests/unit/icons.test.ts`.
  - `icon("activity")` markup contains `width="16"` and `height="16"`.
  - `icon("activity", 24)` markup contains `width="24"` and `height="24"`.
  - Two calls to `icon("activity")` return identical strings; second call does not re-read disk (mock or fs-spy).
  - `icon("does-not-exist")` throws.
- Integration: smoke template renders `icon("activity")` and the SSR HTML contains `<svg ... width="16" height="16" ... stroke="currentColor"`.

## Verification

- `ls plugins/autonomous-dev-portal/server/static/icons/*.svg | wc -l` returns `24`.
- `grep -RIn 'unpkg' plugins/autonomous-dev-portal/server/` returns no matches.
- `npx jest plugins/autonomous-dev-portal/tests/unit/icons.test.ts` exits `0`.
