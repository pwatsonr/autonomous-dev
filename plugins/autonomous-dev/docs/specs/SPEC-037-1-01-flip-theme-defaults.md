# SPEC-037-1-01: Flip Theme Defaults Light → Dark

## Metadata
- **Parent Plan**: PLAN-037-1-dark-theme-and-toggle
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives (SS 6.1 theme prop wiring)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-03 theme persistence; PLAN-037-1 inverts the default — documented in PR body)
- **Tasks Covered**: PLAN-037-1 in-scope items 1, 2, 3 (FOUC IIFE default, ShellLayout prop default, `getThemeFromCookie` fallback)
- **Estimated effort**: 0.25 day
- **Dependencies**: SPEC-034-1-05 (cookie module exists), SPEC-035-1-01 (ShellLayout exists)
- **Priority**: P0 (visual baseline for all subsequent kit-parity work)
- **Status**: Draft
- **Date**: 2026-05-09

## Objective

Flip the portal's default theme from `"light"` to `"dark"` in all three places the default leaks through to a cookie-less / `localStorage`-less first request, so cold loads render against the kit's dark palette and pass visual review against the `dashboard.png` screenshot.

## Acceptance Criteria

- **AC-01**: The FOUC-prevention IIFE inlined in `ShellLayout` evaluates a missing or non-`"light"`/non-`"dark"` `localStorage["portal-theme"]` value as `"dark"`. Verifiable by grepping the rendered HTML for the literal IIFE substring `t==='light'?'light':'dark'` (or equivalent expression whose negative branch is `'dark'`).
- **AC-02**: `ShellLayout`'s `theme` parameter destructure default is `"dark"`. `theme` omitted from props results in `<html data-theme="dark">`.
- **AC-03**: `getThemeFromCookie(c)` returns `"dark"` when the `portal-theme` cookie is absent, empty, or any value other than the literal string `"light"`. Only the literal `"light"` produces `"light"` (defensive inverse of the previous behavior).
- **AC-04**: `curl -s http://127.0.0.1:<port>/` (no `Cookie` header) returns HTML containing `data-theme="dark"`.
- **AC-05**: `curl -s -H "Cookie: portal-theme=light" http://127.0.0.1:<port>/` returns `data-theme="light"`.
- **AC-06**: Existing tests that asserted the light default (`tests/unit/base-layout-load-order.test.ts`, `tests/unit/shell-layout.test.tsx`) are updated in this commit to assert `"dark"`; no test in the suite is left asserting the old default.

## Implementation

**Files modified:**

1. `plugins/autonomous-dev-portal/server/components/shell.tsx`
   - Line ~54-56 (`FOUC_PREVENTION_IIFE`): invert the conditional so the fallback branch is `'dark'`. Final form: `"...document.documentElement.dataset.theme=t==='light'?'light':'dark';})();"`.
   - Line ~98 (`ShellLayout` destructure): change `theme = "light"` to `theme = "dark"`.
   - Line ~109 (`resolvedTheme` ternary): change `theme === "dark" ? "dark" : "light"` to `theme === "light" ? "light" : "dark"` so any non-`"light"` value (including `undefined`) resolves to `"dark"`.

2. `plugins/autonomous-dev-portal/server/lib/theme.ts`
   - Line ~21: change `return raw === "dark" ? "dark" : "light";` to `return raw === "light" ? "light" : "dark";`.
   - Update the file header docstring to state the new defensive default is `"dark"`.

3. `plugins/autonomous-dev-portal/tests/unit/base-layout-load-order.test.ts`
   - Flip every assertion that read `data-theme="light"` in the cookie-less path to expect `"dark"`. Retain one assertion that an explicit `portal-theme=light` cookie still yields `"light"`.

4. `plugins/autonomous-dev-portal/tests/unit/shell-layout.test.tsx`
   - Flip the "default theme" assertion to expect `"dark"` and add a test that `theme="light"` still renders `data-theme="light"`.

**Steps:**

1. Edit `shell.tsx` IIFE string + destructure default + `resolvedTheme` ternary in one pass.
2. Edit `theme.ts` and its docstring.
3. Update both existing unit tests; run them red-then-green.
4. Run the full unit suite to catch any other test that pinned the old default.

## Tests

`tests/unit/shell-layout.test.tsx`:

| ID | Assertion |
|----|-----------|
| D-01 | `<ShellLayout activePath="/" />` (no `theme` prop) renders `<html ... data-theme="dark">` |
| D-02 | `<ShellLayout activePath="/" theme="light" />` renders `data-theme="light"` |
| D-03 | `<ShellLayout activePath="/" theme={undefined as any} />` renders `data-theme="dark"` |
| D-04 | The rendered FOUC IIFE string contains the substring `'light'?'light':'dark'` |

`tests/unit/theme-cookie.test.ts` (new or extend existing):

| ID | Assertion |
|----|-----------|
| C-01 | `getThemeFromCookie` with no cookie returns `"dark"` |
| C-02 | `getThemeFromCookie` with `portal-theme=light` returns `"light"` |
| C-03 | `getThemeFromCookie` with `portal-theme=dark` returns `"dark"` |
| C-04 | `getThemeFromCookie` with `portal-theme=garbage` returns `"dark"` (defensive new default) |

## Verification

```
cd plugins/autonomous-dev-portal
npm test -- tests/unit/shell-layout.test.tsx tests/unit/base-layout-load-order.test.ts
npm test -- tests/unit/theme-cookie.test.ts
grep -nE "theme = \"light\"|=== \"dark\" \\? \"dark\" : \"light\"" server/components/shell.tsx server/lib/theme.ts && echo "FAIL: old defaults still present" || echo "OK"
curl -s "http://127.0.0.1:${PORT:-19281}/" | grep -o 'data-theme="dark"' >/dev/null && echo "OK cold=dark" || echo "FAIL cold!=dark"
curl -s -H "Cookie: portal-theme=light" "http://127.0.0.1:${PORT:-19281}/" | grep -o 'data-theme="light"' >/dev/null && echo "OK light cookie honored" || echo "FAIL light cookie ignored"
```
