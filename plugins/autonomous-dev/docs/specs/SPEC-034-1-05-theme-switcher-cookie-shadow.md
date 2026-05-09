# SPEC-034-1-05: Theme switcher — cookie-shadow SSR + FOUC-prevention IIFE

## Metadata
- **Parent Plan**: PLAN-034-1-tokens-and-theme
- **Parent TDD**: TDD-034-portal-redesign-foundations
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Estimated effort**: 3 hours
- **Dependencies**: [SPEC-034-1-01, SPEC-034-1-06]
- **Priority**: P0

## Objective

Implement an operator-selectable light/dark theme switcher with FOUC-free SSR, per TDD-034 §5.3 (PRD-018 R-03). Ship `plugins/autonomous-dev-portal/server/static/theme-toggle.js` as a synchronous IIFE that reads `localStorage.portal.theme`, sets `document.documentElement.dataset.theme` before first paint, and registers a click handler on `#theme-toggle` (which writes both `localStorage` and the `portal-theme` cookie). Wire every Hono route handler that invokes `BaseLayout` to read the `portal-theme` cookie and pass a validated `theme` prop. The cookie is the server-side shadow of the client's choice; the synchronous IIFE eliminates flash-of-unstyled-content on full-page reloads.

## Acceptance Criteria

- [ ] AC-01: File `plugins/autonomous-dev-portal/server/static/theme-toggle.js` exists, is an IIFE (not an ES module), and is ≤ 800 bytes minified.
- [ ] AC-02: The IIFE reads `localStorage.getItem("portal.theme")` (defaulting to `"light"` on missing key or thrown exception) and synchronously sets `document.documentElement.setAttribute("data-theme", theme)` BEFORE `DOMContentLoaded` fires.
- [ ] AC-03: A `DOMContentLoaded` handler registers a click listener on `document.getElementById("theme-toggle")` that flips `data-theme`, writes `localStorage.setItem("portal.theme", next)`, and writes a cookie `portal-theme=<value>;path=/;max-age=31536000;SameSite=Lax`.
- [ ] AC-04: Every Hono route handler that renders `BaseLayout` reads `getCookie(c, "portal-theme")` and passes a validated `theme` prop. Validation: only the literal `"dark"` is accepted; ANY other value (including `"light"`, missing, or tampered) falls back to `"light"` per TDD-034 §10.2.
- [ ] AC-05: SSR output for an incognito request (no `portal-theme` cookie) contains `<html ... data-theme="light"`.
- [ ] AC-06: SSR output for a request with header `Cookie: portal-theme=dark` contains `<html ... data-theme="dark"`.
- [ ] AC-07: SSR output for a request with header `Cookie: portal-theme=<script>` contains `<html ... data-theme="light"` (validation rejects tampered values).
- [ ] AC-08: The `<script src="/static/theme-toggle.js" nonce={cspNonce}>` tag in `base.tsx` has NEITHER `defer` NOR `async` attribute (must be blocking to run before paint).
- [ ] AC-09: A unit test asserts `BaseLayout` rendered with `theme="dark"` produces output containing `data-theme="dark"`; rendered with no `theme` prop defaults to `data-theme="light"`.
- [ ] AC-10: Manual FOUC test: full reload in dark mode shows dark from first paint (no flash of light); full reload in light mode shows light; new incognito window defaults to light.

## Implementation

### Files to create / modify
- `plugins/autonomous-dev-portal/server/static/theme-toggle.js` — NEW. Synchronous IIFE.
- `plugins/autonomous-dev-portal/server/templates/layout/base.tsx` — MODIFY. Add `theme` prop, `data-theme` attr, blocking `<script>` tag (load order coordinated with SPEC-034-1-06).
- `plugins/autonomous-dev-portal/server/routes/*.tsx` — MODIFY. Each route invoking `BaseLayout` reads cookie and passes validated `theme`.
- `plugins/autonomous-dev-portal/tests/unit/base-layout-theme.test.ts` — NEW. Theme prop SSR test.
- `plugins/autonomous-dev-portal/tests/integration/theme-cookie.test.ts` — NEW. Route-handler cookie validation test.

### Step-by-step

1. Author `theme-toggle.js` per TDD-034 §5.3.2 (synchronous IIFE, no module syntax). Use `try/catch` around `localStorage` access to handle Safari private-mode and disabled-storage cases. The cookie writer must use `SameSite=Lax`, `Path=/`, `Max-Age=31536000`. Minify and verify size ≤ 800 bytes.
2. Modify `base.tsx`:
   - Add `theme?: "light" | "dark"` to the `Props` interface, default `"light"`.
   - Render `<html lang="en" data-theme={theme}>`.
   - In `<head>`, add `<script src="/static/theme-toggle.js" nonce={cspNonce ?? ""}></script>` with NO `defer`/`async` attributes. Place AFTER the stylesheet links so CSS variables are defined when the attribute is set, but before any other scripts.
3. For every route handler in `plugins/autonomous-dev-portal/server/routes/` that calls `BaseLayout`:
   - Import `getCookie` from `hono/cookie` if not already.
   - Read: `const themeCookie = getCookie(c, "portal-theme");`
   - Validate: `const theme: "light" | "dark" = themeCookie === "dark" ? "dark" : "light";`
   - Pass `theme` prop into `<BaseLayout>`.
4. Add a UI affordance `id="theme-toggle"` (a sun/moon icon button) in the navigation/chrome partial so the click handler registered by `theme-toggle.js` has a target. (Visual treatment is intentionally minimal here; styling is the design system's responsibility.)
5. Author `tests/unit/base-layout-theme.test.ts`:
   - Renders `<BaseLayout theme="dark">` → asserts output contains `data-theme="dark"`.
   - Renders `<BaseLayout>` (no theme prop) → asserts output contains `data-theme="light"`.
   - Asserts the `<script>` tag for `/static/theme-toggle.js` has neither `defer` nor `async`.
6. Author `tests/integration/theme-cookie.test.ts`:
   - GET `/` with no cookie → response HTML contains `data-theme="light"`.
   - GET `/` with `Cookie: portal-theme=dark` → response contains `data-theme="dark"`.
   - GET `/` with `Cookie: portal-theme=<script>alert(1)</script>` → response contains `data-theme="light"` (validation rejects).
7. Run `npx jest plugins/autonomous-dev-portal/tests/unit/base-layout-theme.test.ts plugins/autonomous-dev-portal/tests/integration/theme-cookie.test.ts`; all assertions pass.
8. Manual FOUC verification per AC-10.

## Tests

- Unit: `plugins/autonomous-dev-portal/tests/unit/base-layout-theme.test.ts`.
- Integration: `plugins/autonomous-dev-portal/tests/integration/theme-cookie.test.ts`.
- Manual: full-reload FOUC test in both themes; cookie persistence across reload; incognito default.

## Verification

- `test -f plugins/autonomous-dev-portal/server/static/theme-toggle.js && echo OK` returns `OK`.
- `wc -c plugins/autonomous-dev-portal/server/static/theme-toggle.js` reports ≤ 1500 bytes raw (≤ 800 bytes minified).
- `grep -E 'defer|async' plugins/autonomous-dev-portal/server/templates/layout/base.tsx | grep theme-toggle` returns no matches.
- `npx jest plugins/autonomous-dev-portal/tests/unit/base-layout-theme.test.ts plugins/autonomous-dev-portal/tests/integration/theme-cookie.test.ts` exits `0`.
- `grep -RIn 'getCookie(c, "portal-theme")' plugins/autonomous-dev-portal/server/routes/ | wc -l` is at least the number of routes calling `BaseLayout`.
