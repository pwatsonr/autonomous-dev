# SPEC-035-1-04: BrandWordmark Component (with OQ-02 brackets fallback)

## Metadata
- **Parent Plan**: PLAN-035-1-layout-shell-and-brand
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives (SS 6.4)
- **Parent PRD**: PRD-018-portal-visual-redesign (G-03)
- **Tasks Covered**: PLAN-035-1 Task 4 + Task 6 (vendor brand SVGs) + Task 10 (env-var docs)
- **Estimated effort**: 0.5 day (0.25d component + 0.15d SVG vendoring + 0.1d env-var docs)
- **Dependencies**: SPEC-035-1-01 (consumed by ShellLayout); PLAN-034-1 (`--brand` token)
- **Priority**: P0 (blocks ShellLayout render)
- **Status**: Draft
- **Date**: 2026-05-09
- **Open question dependency**: OQ-02 (wordmark IP). The `PORTAL_WORDMARK_BRACKETS` env var is the runtime fallback if OQ-02 resolves REPLACE — set `PORTAL_WORDMARK_BRACKETS=0` and the component drops the brackets without a redeploy.

## Objective

Implement `BrandWordmark` at `server/components/brand-wordmark.tsx` as a theme-aware inline-text wordmark (no `<img>`). The component renders `[ autonomous-dev ]` with the brackets in `var(--brand)` so CSS custom properties handle theme switching automatically. The `showBrackets` prop defaults from the `PORTAL_WORDMARK_BRACKETS` env var (default `"1"`). Vendor the three brand SVGs (`wordmark.svg`, `wordmark-dark.svg`, `mark.svg`) to `server/static/brand/` for external consumers (docs, screenshots). Document `PORTAL_WORDMARK_BRACKETS` in the portal env-var reference.

## Acceptance Criteria

- **AC-01**: `server/components/brand-wordmark.tsx` exports `BrandWordmark: FC<{ showBrackets?: boolean }>` matching TDD-035 SS 6.4 verbatim, with the default `showBrackets = (process.env["PORTAL_WORDMARK_BRACKETS"] ?? "1") === "1"`.
- **AC-02**: With `showBrackets=true` (or env unset), output is `<div class="wm"><span class="br">[</span> autonomous-dev <span class="br">]</span></div>` (whitespace exactly as in TDD-035 SS 6.4).
- **AC-03**: With `showBrackets=false` (or `PORTAL_WORDMARK_BRACKETS=0`), output is `<div class="wm"> autonomous-dev </div>` with no `<span class="br">` children.
- **AC-04**: Component does not depend on theme prop — bracket color comes from CSS `.rail-brand .wm .br { color: var(--brand) }` declaration in `portal.css` (added by SPEC-035-1-01's CSS work or here, whichever lands first; this spec adds the rules if absent).
- **AC-05**: Three brand SVG files present at `plugins/autonomous-dev-portal/server/static/brand/wordmark.svg`, `wordmark-dark.svg`, `mark.svg`. If OQ-02 has not resolved by ship time, files MAY be empty placeholders (1-byte zero-width SVG documents) — operators rely on `PORTAL_WORDMARK_BRACKETS` for the rendered wordmark and the SVGs are consumed only by external tooling.
- **AC-06**: Static-asset middleware serves `/static/brand/wordmark.svg` as `Content-Type: image/svg+xml` with HTTP 200 (verified via integration test in SPEC-035-1-01 or direct curl).
- **AC-07**: `PORTAL_WORDMARK_BRACKETS` is documented in the portal env-var reference (`plugins/autonomous-dev-portal/docs/env-vars.md` or the deployment config doc identified by TDD-035 SS 13) with: name, default `"1"`, accepted values `"0"|"1"`, description "Renders the `[` `]` bracket motif around the wordmark; set to `0` if OQ-02 (wordmark IP) resolves REPLACE."

## Implementation

**Files created/modified:**

1. `plugins/autonomous-dev-portal/server/components/brand-wordmark.tsx` (NEW)
2. `plugins/autonomous-dev-portal/server/static/brand/wordmark.svg` (NEW — vendored or placeholder)
3. `plugins/autonomous-dev-portal/server/static/brand/wordmark-dark.svg` (NEW — vendored or placeholder)
4. `plugins/autonomous-dev-portal/server/static/brand/mark.svg` (NEW — vendored or placeholder)
5. `plugins/autonomous-dev-portal/docs/env-vars.md` (NEW or MODIFIED) — env-var reference entry
6. `plugins/autonomous-dev-portal/server/static/portal.css` (MODIFIED if not already done by SPEC-035-1-01) — `.rail-brand .wm` and `.rail-brand .wm .br` rules

**Steps:**

1. Create the FC verbatim from TDD-035 SS 6.4.
2. Copy the three SVGs from the design bundle (or commit empty placeholders pending OQ-02).
3. Add the env-var reference entry.
4. Confirm `.rail-brand .wm .br { color: var(--brand) }` exists in `portal.css`.

## Tests

`tests/unit/components/brand-wordmark.test.tsx`:

| ID | Assertion |
|----|-----------|
| W-01 | Default render contains two `<span class="br">` elements with text `[` and `]` |
| W-02 | `showBrackets={false}` render contains zero `<span class="br">` elements |
| W-03 | With `process.env.PORTAL_WORDMARK_BRACKETS = "0"` and prop omitted, no `.br` spans render |
| W-04 | With `process.env.PORTAL_WORDMARK_BRACKETS = "1"` and prop omitted, two `.br` spans render |
| W-05 | Output always wraps content in `<div class="wm">` |

`tests/integration/static-assets.test.ts` (added or extended):

| ID | Assertion |
|----|-----------|
| W-I1 | `GET /static/brand/wordmark.svg` returns 200 with `Content-Type: image/svg+xml` |
| W-I2 | `GET /static/brand/wordmark-dark.svg` returns 200 with `Content-Type: image/svg+xml` |
| W-I3 | `GET /static/brand/mark.svg` returns 200 with `Content-Type: image/svg+xml` |

## Verification

```bash
cd plugins/autonomous-dev-portal
npm test -- tests/unit/components/brand-wordmark.test.tsx
PORTAL_WORDMARK_BRACKETS=0 npm test -- tests/unit/components/brand-wordmark.test.tsx
ls -la server/static/brand/   # wordmark.svg, wordmark-dark.svg, mark.svg present
grep -n "PORTAL_WORDMARK_BRACKETS" docs/env-vars.md
```
