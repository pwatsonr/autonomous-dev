# SPEC-034-1-06: base.tsx integration — load design-tokens.css first, then portal.css

## Metadata
- **Parent Plan**: PLAN-034-1-tokens-and-theme
- **Parent TDD**: TDD-034-portal-redesign-foundations
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Estimated effort**: 1 hour
- **Dependencies**: [SPEC-034-1-01]
- **Priority**: P0

## Objective

Modify `plugins/autonomous-dev-portal/server/templates/layout/base.tsx` so that every page-level HTML response loads `/static/design-tokens.css` as the FIRST `<link rel="stylesheet">` and `/static/portal.css` SECOND, per TDD-034 §5.1 and §4.2. This guarantees CSS variables are defined before any consumer references them and is a precondition for SPEC-034-1-04 (CSS migration) and SPEC-034-1-05 (theme switcher). This spec also asserts the load order via a SSR snapshot test.

## Acceptance Criteria

- [ ] AC-01: `plugins/autonomous-dev-portal/server/templates/layout/base.tsx` contains `<link rel="stylesheet" href="/static/design-tokens.css" />` in `<head>`.
- [ ] AC-02: The `design-tokens.css` `<link>` tag appears BEFORE the `portal.css` `<link>` tag in the rendered HTML source. Verify by SSR snapshot: in the head, the substring `/static/design-tokens.css` appears at a lower index than `/static/portal.css`.
- [ ] AC-03: No other stylesheet `<link>` tag precedes `design-tokens.css` in `<head>`.
- [ ] AC-04: The `<script>` tag for `/static/theme-toggle.js` (added in SPEC-034-1-05) appears AFTER both stylesheet `<link>` tags but BEFORE `</head>`. Order is: `design-tokens.css` → `portal.css` → `theme-toggle.js`.
- [ ] AC-05: Existing route-render tests continue to pass with no behavior change other than the new `<link>` tag.
- [ ] AC-06: A new unit test in `plugins/autonomous-dev-portal/tests/unit/base-layout-load-order.test.ts` asserts the substring-order invariant of AC-02 and AC-04.

## Implementation

### Files to create / modify
- `plugins/autonomous-dev-portal/server/templates/layout/base.tsx` — MODIFY. Add `design-tokens.css` link as the first stylesheet.
- `plugins/autonomous-dev-portal/tests/unit/base-layout-load-order.test.ts` — NEW. Asserts SSR substring ordering.

### Step-by-step

1. Open `plugins/autonomous-dev-portal/server/templates/layout/base.tsx`. Locate the `<head>` block.
2. Insert `<link rel="stylesheet" href="/static/design-tokens.css" />` as the FIRST stylesheet `<link>`. The existing `<link rel="stylesheet" href="/static/portal.css" />` must remain and stay BELOW it.
3. Confirm the final ordering inside `<head>` (ignoring `<meta>`/`<title>`):
   1. `<link rel="stylesheet" href="/static/design-tokens.css" />`
   2. `<link rel="stylesheet" href="/static/portal.css" />`
   3. `<script src="/static/theme-toggle.js" nonce={cspNonce ?? ""}></script>` (added in SPEC-034-1-05; if SPEC-034-1-05 ships in the same PR, ensure load-order is preserved)
   4. Any other scripts (e.g., `htmx.min.js`) follow.
4. Author `tests/unit/base-layout-load-order.test.ts`:
   - Render `<BaseLayout>` to a string via `renderToString` (or the project's existing render helper).
   - Assert: `html.indexOf("/static/design-tokens.css") < html.indexOf("/static/portal.css")`.
   - Assert: `html.indexOf("/static/portal.css") < html.indexOf("/static/theme-toggle.js")` (skip this assertion if SPEC-034-1-05 has not landed yet).
   - Assert: there is NO stylesheet `<link>` between `<head>` and the `design-tokens.css` link.
5. Run `npx jest plugins/autonomous-dev-portal/tests/unit/base-layout-load-order.test.ts`; all assertions pass.
6. Run the full portal test suite to confirm no regression: `npx jest plugins/autonomous-dev-portal/tests/`.

## Tests

- Unit: `plugins/autonomous-dev-portal/tests/unit/base-layout-load-order.test.ts` (new).
- Regression: existing `plugins/autonomous-dev-portal/tests/` suite must still pass.

## Verification

- `grep -n 'design-tokens.css' plugins/autonomous-dev-portal/server/templates/layout/base.tsx` returns at least one match.
- `npx jest plugins/autonomous-dev-portal/tests/unit/base-layout-load-order.test.ts` exits `0`.
- `npx jest plugins/autonomous-dev-portal/tests/` exits `0`.
- Manual SSR check: `curl http://localhost:<port>/ | grep -E '/static/(design-tokens|portal)\.css'` shows `design-tokens.css` first, then `portal.css`.
