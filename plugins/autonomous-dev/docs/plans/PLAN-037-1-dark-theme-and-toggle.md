# PLAN-037-1: Dark-default theme + theme-toggle pill

## Metadata
- **Parent**: PLAN-037-portal-kit-parity
- **Effort**: 1 day
- **Dependencies**: []
- **Priority**: P0 (unblocks visual review against kit screenshots)

## Objective

Flip the portal's default theme from light to dark to match the kit (`<html data-theme="dark">` per `Shell.jsx`), and surface a working theme-toggle pill inside the rail-ops bar. CSS for `.theme-toggle` already exists in `static/app.css:111-160` but no DOM control is rendered.

## Scope

### In Scope
1. **Flip FOUC IIFE default** at `server/components/shell.tsx:55` so missing-cookie/missing-localStorage falls back to `dark`, not `light`.
2. **Flip ShellLayout `theme` prop default** at `shell.tsx:98` from `'light'` to `'dark'`.
3. **Flip `getThemeFromCookie` fallback** at `server/lib/theme.ts` to return `'dark'` when cookie missing.
4. **Render the `.theme-toggle` pill** inside `<div class="rail-ops">` (after the kill-switch button) using the kit's markup: `<div class="theme-toggle"><div class="tt-track"><span class="tt-knob"/></div><div class="tt-l">LIGHT</div><div class="tt-l">DARK</div></div>`.
5. **Wire the toggle to `theme-toggle.js`** — add `data-action="toggle-theme"` attribute and ensure the existing module's click handler picks it up. Confirm cookie key alignment (`portal-theme` vs kit's `autodev-theme`; pick one and stick with it — recommend `portal-theme`).
6. **Tests**: update `tests/unit/base-layout-load-order.test.ts` and `tests/unit/shell-layout.test.tsx` to assert the new default. Add `tests/unit/theme-toggle.test.tsx` for the rendered pill.

### Out of Scope
- A user-controllable theme PRD revision (PRD-018 R-03 said `'light'` default; this is a TDD-level reversal documented in the PR body).

## Verification
- `curl -s http://127.0.0.1:19280/ | grep -oE 'data-theme="[a-z]+"'` returns `data-theme="dark"` on a cookie-less request.
- Page rendered in browser shows the kit's dark palette.
- Clicking the theme-toggle pill changes theme without page reload AND writes the `portal-theme` cookie so SSR honors the choice on next request.

## Tests
- Unit: shell-layout default theme; theme-toggle pill markup; cookie-roundtrip.
- Manual: visual diff against `/tmp/portal-design-v2/autonomous-dev-design-system/project/screenshots/dashboard.png`.

## Risks
| Risk | Mitigation |
|---|---|
| Reverses PRD-018 R-03 (light default) | Document in PR body; if rejected, add a `default_theme` config flag instead |
| Existing tests assume `data-theme="light"` | Update them in the same PR |
