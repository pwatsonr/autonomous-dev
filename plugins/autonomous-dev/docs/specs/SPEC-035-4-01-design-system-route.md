# SPEC-035-4-01: `/design-system` Route + View Skeleton

## Metadata
- **Parent Plan**: PLAN-035-4
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives (§6.8)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-21)
- **Tasks Covered**: PLAN-035-4 Tasks 1, 5, 6, 7, 12
- **Estimated effort**: 0.8 day
- **Status**: Draft
- **Date**: 2026-05-09

## Objective

Land the `GET /design-system` Hono JSX route plus its view skeleton: a 220px-shell-wrapped page with a sticky `.ds-toc` sidebar and twenty `<section id="preview-{n}" class="ds-card">` containers ready for content (SPEC-035-4-02). The route is public (OQ-035-01 RESOLVED), reads `portal-theme` cookie for SSR theme parity, and registers cleanly in the existing route table without disturbing other surfaces.

## Acceptance Criteria

- AC-1 `server/routes/design-system.ts` exports `designSystemHandler(c: Context): Response` returning `c.html(<DesignSystemPage theme={cookieValue} />)`.
- AC-2 `server/templates/views/design-system.tsx` exports `DesignSystemPage({ theme }: { theme: 'light'|'dark' })` wrapping content in `<ShellLayout activePath="/design-system" theme={theme}>` (PLAN-035-1 primitive).
- AC-3 The view emits a `.page-head` with `<h1>` text "Design system" and a sticky `<nav class="ds-toc">` whose links point to `#preview-1` through `#preview-20` in registry order.
- AC-4 The view emits exactly 20 `<section>` elements with `id="preview-{n}"` (1-indexed) and class `ds-card`. Each section is initially a stub rendered by a per-section component imported from `server/templates/views/design-system/sections/section-{NN}.tsx` (one component per section; SPEC-035-4-02 provides the bodies).
- AC-5 Route is registered in `server/routes/index.ts` as `app.get("/design-system", designSystemHandler)`. The `/design-system` entry already present in `RailNav` NAV_ITEMS (TDD-035 §6.2) routes correctly.
- AC-6 No `dangerouslySetInnerHTML` usage anywhere in the view tree (FR-S34).
- AC-7 New CSS classes `.ds-card`, `.ds-toc`, `.ds-swatch`, `.ds-swatch-grid` added to `server/static/portal.css` per TDD-035 §15. `.ds-card` = 1px border, 3px radius, `var(--s-3)` padding, no `box-shadow`.
- AC-8 No `box-shadow:` declarations outside `var(--shadow-*)` references (R-15a CI lint).
- AC-9 Integration test `tests/integration/design-system-route.test.ts` asserts `GET /design-system` returns 200, body contains 20 substrings `id="preview-{n}"` for n in 1..20 each on a `<section ` element with class `ds-card`.
- AC-10 Manual smoke: `curl -I /design-system` returns the existing portal CSP headers unchanged; no inline scripts or styles introduced.

## Implementation

**`server/routes/design-system.ts`**:

```typescript
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { DesignSystemPage } from "../templates/views/design-system";

export function designSystemHandler(c: Context): Response {
  const theme = (getCookie(c, "portal-theme") === "dark" ? "dark" : "light");
  return c.html(<DesignSystemPage theme={theme} />);
}
```

**`server/templates/views/design-system.tsx`**: imports 20 section components and emits the layout per AC-3/AC-4. Section component file naming: `sections/section-01.tsx` through `sections/section-20.tsx` so SPEC-035-4-02 can fill bodies independently.

**`server/routes/index.ts`**: add `import { designSystemHandler } from "./design-system";` and `app.get("/design-system", designSystemHandler);` adjacent to other GET-only static page routes.

**`server/static/portal.css`** (additions only):
- `.ds-card { border: 1px solid var(--line-1); border-radius: 3px; padding: var(--s-3); }`
- `.ds-toc { position: sticky; top: var(--s-3); }` plus list-reset for nested anchors.
- `.ds-swatch`, `.ds-swatch-grid` — see SPEC-035-4-02.

## Tests

- **Integration** (`tests/integration/design-system-route.test.ts`): asserts AC-9 + asserts response Content-Type begins `text/html`.
- **Unit** (`tests/unit/design-system-page.test.ts`): renders `<DesignSystemPage theme="light" />` via Hono JSX in isolation; asserts presence of `.ds-toc` with 20 anchor children and 20 `.ds-card` sections.
- **Theme cookie**: integration test sets `portal-theme=dark` cookie on request; asserts response HTML includes `data-theme="dark"` on `<html>`.
- **CSP**: integration test asserts `Content-Security-Policy` header on the response equals the value from a known-existing route (no policy widening).

## Verification

- `bun test tests/integration/design-system-route.test.ts` passes.
- `bun test tests/unit/design-system-page.test.ts` passes.
- Manual: navigate to `http://127.0.0.1:8080/design-system`; observe 20 stub sections + sticky TOC; no console errors; no CSP violations.
- `grep -RE "box-shadow:" server/static/portal.css | grep -v "var(--shadow-"` returns zero hits.
- `grep -R "dangerouslySetInnerHTML" server/templates/views/design-system*` returns zero hits.
