# PLAN-034-1: Token Vendoring, Self-Hosted Fonts/Icons, and Theme Switcher

## Metadata
- **Parent TDD**: TDD-034-portal-redesign-foundations
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Estimated effort**: 4 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0 (foundational; gates PLAN-034-2 and PLAN-034-3)
- **Stage**: TDD-034 §8 Phase 1 (token vendoring + font/icon self-hosting), Phase 2 (CSS migration), Phase 3 (theme switcher)

## Objective

Establish the visual substrate for the portal redesign: vendor the design system's
`colors_and_type.css` as the single source of design tokens, self-host Inter +
JetBrains Mono fonts and 24 Lucide icons under the existing strict CSP, migrate
the legacy portal CSS to reference the new token names exclusively, and ship the
operator-selectable light/dark theme switcher with a server-side cookie shadow
for FOUC-free SSR. After this plan lands, all subsequent portal work (PLAN-034-2
lints, PLAN-034-3 contrast, TDD-035 shell, TDD-036 surfaces) can assume tokens
and themes exist.

## Scope

### In Scope
- `plugins/autonomous-dev-portal/server/static/design-tokens.css` -- vendored verbatim from `project/colors_and_type.css` with the `@import url('https://fonts.googleapis.com/...')` line replaced by 8 local `@font-face` declarations and a "DO NOT EDIT" header comment (TDD-034 §5.1).
- `plugins/autonomous-dev-portal/server/static/fonts/*.woff2` -- 8 self-hosted WOFF2 files (Inter 400/500/600/700, JetBrains Mono 400/500/600/700) per TDD-034 §5.4.
- `plugins/autonomous-dev-portal/server/static/icons/*.svg` -- 24 Lucide SVGs vendored from `lucide-static` per TDD-034 §5.7 inventory list.
- `plugins/autonomous-dev-portal/server/lib/icons.tsx` -- inline-SVG helper with filesystem-cache + size override per TDD-034 §5.7.
- `plugins/autonomous-dev-portal/server/static/theme-toggle.js` -- IIFE that reads `localStorage.portal.theme`, sets `data-theme` on `<html>` synchronously before paint, and registers the toggle click handler on `DOMContentLoaded` (TDD-034 §5.3.2).
- `plugins/autonomous-dev-portal/server/templates/layout/base.tsx` -- accept `theme` prop, emit `data-theme={theme}`, load `design-tokens.css` first then `portal.css`, load `theme-toggle.js` blocking in `<head>` (TDD-034 §5.3.1).
- Route handlers under `plugins/autonomous-dev-portal/server/routes/` -- read `portal-theme` cookie via `getCookie` and pass `theme` prop to `BaseLayout`.
- `plugins/autonomous-dev-portal/src/styles/{layout,components,utilities}.css` -- rewrite to reference new token names per TDD-034 §5.2 mapping table; delete `src/styles/variables.css`; remove the `@media (prefers-color-scheme: dark)` block.
- `plugins/autonomous-dev-portal/scripts/build-css.sh` -- exclude the deleted `variables.css` from the concatenation.

### Out of Scope
- CI lint scripts (`lint-css-tokens.sh`, `lint-no-emoji.sh`, `lint-box-shadow.sh`) -- PLAN-034-2.
- Phase contrast script and theme-parity verification -- PLAN-034-3.
- Voice/copy sweep across `.tsx` templates -- PLAN-034-2.
- Left-rail shell, brand wordmark, primitives -- TDD-035.
- Surface re-skins (Dashboard, Ops, Costs, etc.) -- TDD-036.
- Visual-regression infra (M-03) -- TDD-035.

## Work Breakdown

1. **Vendor `design-tokens.css`** (TDD-034 §5.1) -- copy `project/colors_and_type.css` verbatim to `server/static/design-tokens.css`; replace the `@import url('https://fonts.googleapis.com/...')` line with the 8 `@font-face` declarations from §5.4; prepend the `/* DO NOT EDIT -- regenerate from the design bundle */` header. Acceptance: byte-identical to source except the `@import`/header diff.
2. **Add self-hosted font files** (TDD-034 §5.4, OQ-06) -- download Inter and JetBrains Mono WOFF2 (400/500/600/700 each) via google-webfonts-helper into `server/static/fonts/`. Acceptance: 8 files committed, total ~400 KB; `font-display: swap` declarations resolve under CSP `font-src 'self'`.
3. **Vendor 24 Lucide SVGs** (TDD-034 §5.7, OQ-03) -- copy the named icons from `lucide-static` into `server/static/icons/`. Inventory: `activity`, `shield-alert`, `circle-slash`, `git-branch`, `git-pull-request`, `play`, `pause`, `square`, `chevron-right`, `chevron-down`, `check`, `x`, `alert-triangle`, `info`, `terminal`, `cpu`, `database`, `dollar-sign`, `trending-up`, `trending-down`, `users`, `bot`, `bell`, `bell-off`. Acceptance: 24 files committed.
4. **Implement `server/lib/icons.tsx`** (TDD-034 §5.7) -- read SVG, cache, expose `icon(name, size=16)` that rewrites width/height attrs and inherits `currentColor`. Acceptance: helper used by at least one template smoke-test; cache populated on first call.
5. **Update `base.tsx` for token + theme load order** (TDD-034 §5.3.1) -- add `theme` prop (default `"light"`), emit `<html lang="en" data-theme={theme}>`, load `design-tokens.css` first then `portal.css`, add `<script src="/static/theme-toggle.js" nonce={cspNonce}>` blocking in `<head>` (no `defer`/`async`). Acceptance: SSR output for both themes contains correct `data-theme`; load order matches §4.2 component diagram.
6. **Wire route handlers to read the theme cookie** (TDD-034 §5.3.1) -- in every route invoking `BaseLayout`, read `getCookie(c, "portal-theme")`, validate to `"dark"`/`"light"` (anything else falls back to `"light"` per §10.2), pass to `BaseLayout`. Acceptance: incognito request renders `light`; request with `Cookie: portal-theme=dark` renders `dark`.
7. **Author `theme-toggle.js`** (TDD-034 §5.3.2) -- IIFE that reads `localStorage.getItem('portal.theme')`, sets `document.documentElement.dataset.theme` synchronously, registers `#theme-toggle` click handler under `DOMContentLoaded`, writes both `localStorage` and `portal-theme` cookie (`SameSite=Lax; Path=/; Max-Age=31536000`). Acceptance: minified file ≤800 bytes; manual test shows no FOUC on full reload.
8. **Migrate portal CSS to new token names** (TDD-034 §5.2) -- delete `src/styles/variables.css`; rewrite `layout.css`, `components.css`, `utilities.css` per the §5.2 mapping table (`--primary-color` → `--brand`, `--bg-primary` → `--bg-1`, `--radius-md` → `--r-2`, etc.); remove all hex literals and hardcoded `font-family`/`px` values outside structural dimensions; remove the `@media (prefers-color-scheme: dark)` block. Acceptance: portal renders all surfaces; `grep -E '#[0-9][0-9a-fA-F]{2,7}\b' src/styles/*.css` returns empty.
9. **Update `scripts/build-css.sh`** -- drop `variables.css` from the concatenation list. Acceptance: `bun run build:css` produces a valid `static/portal.css` that loads after `design-tokens.css` and references only token vars.

## Verification

- **Token vendoring (R-01)**: `diff` of `design-tokens.css` vs `project/colors_and_type.css` shows only the `@import` → `@font-face` swap and the header comment.
- **CSS migration (R-02)**: `grep -RnE '#[0-9][0-9a-fA-F]{2,7}\b' plugins/autonomous-dev-portal/src/styles plugins/autonomous-dev-portal/server/static/portal.css` returns zero matches; `grep -Rn 'font-family' plugins/autonomous-dev-portal/src/styles | grep -v 'var(--font-'` returns zero matches.
- **Theme load order**: SSR snapshot test on `BaseLayout` shows `<link href="/static/design-tokens.css">` precedes `<link href="/static/portal.css">` and `<script src="/static/theme-toggle.js">` lacks `defer`/`async`.
- **Theme switch (R-03)**: Manual test -- toggle in browser, confirm CSS variables cascade without reload, `localStorage.getItem('portal.theme')` and `document.cookie` both reflect the new value, full reload preserves it, new incognito window defaults to `light`.
- **Self-hosted fonts (R-04, OQ-06)**: DevTools Network tab shows fonts loaded from `/static/fonts/` (not `fonts.googleapis.com`); browser console reports zero CSP violations.
- **Self-hosted icons (OQ-03)**: Smoke template renders an inline SVG via `icon("activity")`; no `unpkg.com` references in any template.

## Test Plan

- **Unit**: `BaseLayout` renders with `theme="dark"` → output contains `data-theme="dark"`; renders with no theme → defaults to `light`.
- **Unit**: `icon("activity")` returns SVG markup with `width="16"` and `height="16"`; `icon("activity", 24)` rewrites both attrs.
- **Manual**: theme-toggle FOUC test (full reload in dark mode shows dark from first paint), incognito default test, cookie persistence test.
- **CI**: existing portal test suite must pass unchanged (this plan introduces no behavior changes beyond visual tokens).

## Rollback

Each work item is a separate commit on the feature branch. To revert:
- Revert the merge commit; `design-tokens.css`, `fonts/`, `icons/`, `theme-toggle.js`, the `base.tsx` diff, the route-handler diffs, and the CSS migration all roll back atomically.
- Old `variables.css` is restored from git history; old token names re-resolve.
- The portal returns to the pre-redesign CSS without any partial state (no DB migrations, no config keys touched).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| WOFF2 files committed without correct license attribution | Low | Medium -- repo legal hygiene | Inter (OFL) and JetBrains Mono (OFL) license texts ship in `server/static/fonts/LICENSE.txt`; reviewer checks presence. |
| `theme-toggle.js` blocking script measurably slows first paint | Low | Low | Script is ≤800 bytes minified; perf budget for first-paint blocking unchanged. Manual Lighthouse comparison if reviewer flags. |
| CSS migration mapping table missed a variable, breaking a surface | Medium | Medium -- visual regression on a surface | Grep for every old token name post-migration (`--primary-color`, `--bg-primary`, etc.) returns zero hits. Manual smoke of all 6 portal surfaces before merge. |
| `portal-theme` cookie value tampered to inject CSS via `data-theme` | Low | Low | Route handler whitelist: only `"dark"` accepted; anything else falls back to `"light"` (TDD-034 §10.2). Reviewer asserts the validation line. |
| SSR theme cookie read latency on cold path | Low | Low | `getCookie` is a synchronous header parse; cost is negligible vs. existing JSX render. |
| `@font-face` `format('woff2')` unsupported in some target browser | Low | Low | Target browsers (modern Chrome/Firefox/Safari/Edge) all support WOFF2 per §5.4 rationale. Fallback to system stack via the `--font-sans`/`--font-mono` token chain. |
