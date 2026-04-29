# SPEC-013-4-02: HTMX Library Vendoring and CSS Build Pipeline

## Metadata
- **Parent Plan**: PLAN-013-4
- **Tasks Covered**: TASK-001 (HTMX vendoring), TASK-002 (portal CSS framework), TASK-003 (SVG icon set), TASK-012 (asset build integration)
- **Estimated effort**: 9 hours

## Description
Vendor HTMX v1.9.x as a local static asset (no CDN dependency) with SHA256 verification and pinned version. Author the hand-rolled `portal.css` from four source files (`variables.css`, `layout.css`, `components.css`, `utilities.css`) using CSS custom properties, CSS Grid, and WCAG 2.2 AA-compliant tokens, compiled to a single ~3KB gzipped output. Build the SVG icon set (12 icons) with embedded `<title>`/`<desc>` accessibility metadata. Wire all three asset categories into a unified `build-assets.sh` that runs in development (watch mode) and production (with hashing and optimization).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `static/htmx.min.js` | Create (vendored) | HTMX v1.9.12 minified |
| `static/htmx.min.js.LICENSE` | Create | BSD-2-Clause text |
| `scripts/vendor-htmx.sh` | Create | Download + SHA256 verify + version pin |
| `src/styles/variables.css` | Create | Color/spacing/typography tokens |
| `src/styles/layout.css` | Create | Grid/container/responsive |
| `src/styles/components.css` | Create | Cards/banners/buttons/forms |
| `src/styles/utilities.css` | Create | Helper classes (text-*, mt-*, sr-only) |
| `static/portal.css` | Create (build artifact) | Concatenated + minified |
| `scripts/build-css.sh` | Create | Concat sources, minify, size-check |
| `static/icons/*.svg` | Create | 12 icons listed in TASK-003 |
| `scripts/optimize-svg.sh` | Create | svgo wrapper preserving title/desc |
| `src/icons/icon-manifest.ts` | Create | Type-safe icon name enum |
| `scripts/build-assets.sh` | Create | Orchestrates HTMX + CSS + SVG + hash steps |
| `scripts/watch-assets.sh` | Create | Dev mode with `bun --watch` |
| `package.json` | Modify | Add `build:assets`, `dev:assets`, `vendor:htmx` scripts |

## Implementation Details

### HTMX Vendoring (`scripts/vendor-htmx.sh`)

```
vendor-htmx.sh -> writes static/htmx.min.js + static/htmx.min.js.LICENSE
```

Behavior:
1. Define constants: `HTMX_VERSION="1.9.12"`, `HTMX_SHA256="<known-good-hash>"`, `URL="https://unpkg.com/htmx.org@${HTMX_VERSION}/dist/htmx.min.js"`.
2. Download to temp file: `curl -fsSL --max-time 30 "$URL" -o "$tmpfile"`.
3. Verify: `actual=$(shasum -a 256 "$tmpfile" | awk '{print $1}')`. Exit 1 with explicit error if mismatch.
4. On success: `mv "$tmpfile" static/htmx.min.js`.
5. Write `static/htmx.min.js.LICENSE` with BSD-2-Clause text including `Copyright (c) 2020, Big Sky Software`.
6. Idempotent: if `static/htmx.min.js` exists AND its SHA matches `HTMX_SHA256`, exit 0 without re-downloading. Supports offline operation.

### CSS Source Files (`src/styles/*.css`)

**`variables.css`** — `:root` block with CSS custom properties:
- Brand: `--primary-color`, `--primary-hover`, `--secondary-color`
- Status: `--success/warning/danger/info-color` and `*-light` variants
- Neutrals: `--bg-primary/secondary/tertiary`, `--text-primary/secondary/muted`, `--border-color/hover`
- Spacing: `--space-xs` (0.25rem) through `--space-2xl` (3rem)
- Typography: `--text-xs` through `--text-3xl`
- Radius: `--radius-sm` through `--radius-xl`
- Shadows: `--shadow-sm/md/lg`
- Z-index: `--z-dropdown`, `--z-banner`, `--z-modal`, `--z-tooltip`
- Dark-mode override block: `@media (prefers-color-scheme: dark) { :root { ... } }`
- High-contrast override: `@media (prefers-contrast: high) { ... }`
- Reduced-motion override: `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; ... } }`

**`layout.css`** — `.container`, `.main-layout` (CSS Grid with `grid-template-areas`), header/sidebar/main/footer placement, mobile breakpoint at 768px collapses sidebar.

**`components.css`** — `.repo-card`, `.repo-status-badge`, `.daemon-status-banner` (warning + error variants with `border-left` accent), `.error-page`, `.btn` (primary/secondary/danger), `.form-input`, `.chart-container`, `.loading` spinner.

**`utilities.css`** — `.sr-only`, `.text-{center,left,right}`, `.m{t,b}-{0,xs,sm,md,lg,xl}`, `.{hidden,block,inline,inline-block,flex,grid}`.

### CSS Build Script (`scripts/build-css.sh`)

```
build-css.sh -> writes static/portal.css
```

1. Concatenate sources in order: `variables.css → layout.css → components.css → utilities.css`.
2. Minify: collapse whitespace, strip comments (preserve `/*! ... */` license banners). Use `bun x lightningcss --minify` if available, else fallback to a regex-based minifier.
3. Validate: `gzip -c static/portal.css | wc -c` MUST be <3072 (3KB). Exit 1 with size report if exceeded.
4. Prepend banner: `/*! autonomous-dev portal.css | MIT | <date> */`.

### SVG Icons (`static/icons/*.svg`)

Each icon MUST follow this template:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
     role="img" aria-labelledby="title-<id> desc-<id>">
  <title id="title-<id>"><Short label, e.g. "Daemon running"></title>
  <desc id="desc-<id>"><Longer description for screen readers></desc>
  <path d="..." stroke="currentColor" stroke-width="1.5" fill="none"
        stroke-linejoin="round" stroke-linecap="round"/>
</svg>
```

Constraints:
- Single `viewBox="0 0 24 24"`. Provide 16/24/32 px sizing via consumer CSS, not duplicate files.
- Stroke: 1.5px, `currentColor` for theme compatibility.
- Corner radius: 2px on rounded elements.
- File size: each <1KB after svgo optimization.
- 12 icons required (see PLAN-013-4 TASK-003 for exact list).

**`scripts/optimize-svg.sh`**: invokes `bun x svgo --config=.svgorc.json static/icons/*.svg`. The svgo config MUST set `removeTitle: false`, `removeDesc: false`, `removeViewBox: false`.

**`src/icons/icon-manifest.ts`**:
```typescript
export const ICON_NAMES = [
  'daemon-running', 'daemon-stale', 'daemon-unreachable',
  'request-pending', 'request-approved', 'request-rejected',
  'request-executing', 'request-complete',
  'attention-needed', 'settings-gear', 'cost-chart', 'logs-viewer',
] as const;
export type IconName = typeof ICON_NAMES[number];
```

### Unified Build (`scripts/build-assets.sh`)

```
build-assets.sh [--production] -> exits 0 on success
```

Pipeline:
1. `./scripts/vendor-htmx.sh` (idempotent — skips if hash matches)
2. `./scripts/build-css.sh`
3. `./scripts/optimize-svg.sh`
4. If `--production`: `./scripts/hash-assets.sh` (from SPEC-013-4-01)
5. Print build summary: `htmx: <size>kB | portal.css: <size>kB gzipped | icons: 12 files / <total>kB | manifest: <count> entries`
6. Exit non-zero on any step failure with the failing step name.

**`scripts/watch-assets.sh`**: invokes `bun --watch src/styles/*.css static/icons/*.svg --exec "./scripts/build-assets.sh"`.

### `package.json` Scripts

```json
{
  "scripts": {
    "vendor:htmx": "./scripts/vendor-htmx.sh",
    "build:css":   "./scripts/build-css.sh",
    "build:svg":   "./scripts/optimize-svg.sh",
    "build:assets": "./scripts/build-assets.sh --production",
    "dev:assets":   "./scripts/watch-assets.sh"
  }
}
```

## Acceptance Criteria

- [ ] `bun run vendor:htmx` produces `static/htmx.min.js` whose SHA256 matches the pinned `HTMX_SHA256` constant
- [ ] Re-running `vendor:htmx` after success exits 0 without re-downloading (offline-capable)
- [ ] `static/htmx.min.js.LICENSE` contains the BSD-2-Clause text and HTMX copyright line
- [ ] `bun run build:css` produces `static/portal.css` whose gzipped size is <3072 bytes
- [ ] `static/portal.css` contains `:root { --primary-color:` (variables block present)
- [ ] `static/portal.css` contains `@media (prefers-reduced-motion: reduce)` block
- [ ] `static/portal.css` contains `@media (prefers-color-scheme: dark)` block
- [ ] All 12 SVG icons exist in `static/icons/` and contain `<title>` AND `<desc>` elements
- [ ] All 12 SVG icons set `role="img"` and `aria-labelledby` referencing both title and desc IDs
- [ ] No SVG icon exceeds 1024 bytes after svgo optimization
- [ ] `src/icons/icon-manifest.ts` exports `IconName` union with exactly 12 members
- [ ] `bun run build:assets` completes in <10 seconds and exits 0 with build summary printed
- [ ] `bun run build:assets --production` produces `static/asset-manifest.json` with hashed filenames
- [ ] Failing the SHA verification (manually corrupt download) causes `vendor:htmx` to exit 1 and NOT overwrite the existing `htmx.min.js`

## Dependencies

- **Upstream**: None internal; SPEC-013-4-01 consumes outputs (manifest, static dir layout)
- **External**: `curl`, `shasum` (macOS/Linux built-ins), `bun x svgo`, optional `bun x lightningcss`
- **Network**: required only on first `vendor:htmx` run; subsequent runs are offline
- **Consumed by**: SPEC-013-4-03 (error pages reference `portal.css` and icons), SPEC-013-4-04 (build verification tests)

## Notes

- HTMX version is pinned in the script as a constant. Upgrading requires editing `HTMX_VERSION` AND `HTMX_SHA256` together — this is intentional friction to prevent silent CDN drift.
- The 3KB CSS budget is HARD: progressive enhancement allows deferring decorative styles. If the budget is exceeded, decorative animations and shadows are the first to be moved out (not core layout or accessibility).
- SVG accessibility metadata is non-negotiable — the svgo config MUST preserve `<title>` and `<desc>`. Verify by running `grep -c '<title>' static/icons/*.svg` after optimization.
- Build scripts use bash, not Node, to keep them runnable without a populated `node_modules` (bootstrapping scenario).
- Watch mode does NOT run hashing — hashing only happens in production builds because hashed filenames break the manifest reload loop.
