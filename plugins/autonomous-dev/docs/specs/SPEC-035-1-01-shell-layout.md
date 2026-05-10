# SPEC-035-1-01: ShellLayout Component

## Metadata
- **Parent Plan**: PLAN-035-1-layout-shell-and-brand
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives (SS 6.1)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-05, R-06, R-07)
- **Tasks Covered**: PLAN-035-1 Task 1 + Task 7 (shell CSS subset for `.app`/`.main`/`.page-head`/`.head-actions`)
- **Estimated effort**: 1.0 day (0.5d component + 0.5d shell CSS)
- **Dependencies**: PLAN-034-1 (design tokens shipped); SPEC-035-1-02 (RailNav), SPEC-035-1-03 (RailOpsBar), SPEC-035-1-04 (BrandWordmark) for child imports
- **Priority**: P0 (gates every other 035-1 spec and all TDD-018-C surface adoption)
- **Status**: Draft
- **Date**: 2026-05-09

## Objective

Implement `ShellLayout` at `server/components/shell.tsx` as the portal's two-column shell (220px left rail | content column) replacing `BaseLayout`. Render the full `<html>` document including `data-theme` attribute, design-tokens CSS link first, portal CSS link second, the HTMX script, the theme-toggle module script (both nonce-protected), the rail (brand + nav + ops bar), `<main class="main">{children}</main>`, and the `<div id="modal-slot">` HTMX target slot. Add the shell CSS classes (`.app`, `.main`, `.main.wide`, `.page-head`, `.page-head h1`, `.head-actions`) to `portal.css`.

## Acceptance Criteria

- **AC-01**: `server/components/shell.tsx` exports `ShellLayout: FC<ShellProps>` with the seven props from TDD-035 SS 6.1: `activePath: string`, `cspNonce?: string`, `theme?: "light"|"dark"` (default `"light"`), `daemonStatus?: "running"|"stale"|"dead"|"unknown"` (default `"unknown"`), `killSwitchEngaged?: boolean` (default `false`), `breakerTripped?: boolean` (default `false`), `mtdSpend?: number`, `gateCount?: number`, `children?: unknown`.
- **AC-02**: Rendered output starts with `<html lang="en" data-theme="${theme}">` — `data-theme="dark"` when prop is `"dark"`, `"light"` otherwise.
- **AC-03**: `<head>` contains, in this order: `<meta charset="utf-8">`, `<meta name="viewport">`, `<title>autonomous-dev portal</title>`, `<link rel="stylesheet" href="/static/design-tokens.css">`, `<link rel="stylesheet" href="/static/portal.css">`, `<script src="/static/htmx.min.js" defer nonce={cspNonce ?? ""}></script>`, `<script src="/static/js/theme-toggle.js" type="module" nonce={cspNonce ?? ""}></script>`.
- **AC-04**: `<body>` contains `<div class="app">` with two children — `<aside class="rail">` (rendering `<div class="rail-brand">` containing `<BrandWordmark />` + `<div class="meta-mono">CONTROL PLANE</div>`, `<RailNav activePath={activePath} gateCount={gateCount} />`, `<RailOpsBar daemonStatus killSwitchEngaged breakerTripped mtdSpend />`) and `<main class="main">{children}</main>` — followed by sibling `<div id="modal-slot">`.
- **AC-05**: `portal.css` gains shell classes per TDD-035 SS 6.1 / SS 15: `.app` (`display: grid; grid-template-columns: 220px 1fr; min-height: 100vh`), `.main` (`padding: 28px 36px; max-width: 1280px`), `.main.wide` (`max-width: none`), `.page-head` (flex baseline space-between, 24px bottom margin), `.page-head h1` (`font-size: 28px; font-weight: 700; margin: 0`), `.head-actions` (flex, `gap: var(--s-2)`, `align-items: center`). No `box-shadow:` declarations outside `--shadow-*` tokens (R-15a).
- **AC-06**: Default-prop test: rendering `<ShellLayout activePath="/">{...}</ShellLayout>` with no other props produces `data-theme="light"`, ops bar with daemon status `"unknown"`, no kill-switch engaged, no breaker tripped.

## Implementation

**Files created/modified:**

1. `plugins/autonomous-dev-portal/server/components/shell.tsx` (NEW) — copy structure from TDD-035 SS 6.1; imports `RailNav`, `RailOpsBar`, `BrandWordmark`.
2. `plugins/autonomous-dev-portal/server/static/portal.css` (MODIFIED) — append shell-section comment block with `.app`, `.main`, `.main.wide`, `.page-head`, `.page-head h1`, `.head-actions`.

**Steps:**

1. Create `server/components/shell.tsx` with the `ShellProps` interface and `ShellLayout` FC verbatim from TDD-035 SS 6.1.
2. Validate that `cspNonce ?? ""` does not produce a literal `nonce=""` in dev mode (acceptable per TDD-035 SS 7 CSP guidance — empty nonce is equivalent to absent).
3. Append shell CSS block to `portal.css` under a `/* === ShellLayout (TDD-035 SS 6.1) === */` banner.
4. Verify no `box-shadow:` literal appears in the new CSS block (`grep -n "box-shadow:" portal.css` should only show `--shadow-*` token usages).

## Tests

`tests/unit/components/shell.test.tsx` (Hono JSX renderer):

| ID | Assertion |
|----|-----------|
| S-01 | Renders `.app` grid with `.rail` + `.main` children |
| S-02 | `<html data-theme="light">` when `theme` prop omitted |
| S-03 | `<html data-theme="dark">` when `theme="dark"` |
| S-04 | `<link rel="stylesheet" href="/static/design-tokens.css">` precedes `portal.css` link |
| S-05 | Theme-toggle script tag present with `nonce` matching `cspNonce` prop |
| S-06 | `<div id="modal-slot">` is a sibling of `<div class="app">`, inside `<body>` |
| S-07 | Children render inside `<main class="main">` |

## Verification

```bash
cd plugins/autonomous-dev-portal
npm test -- tests/unit/components/shell.test.tsx
grep -n "box-shadow:" server/static/portal.css | grep -v "var(--shadow"  # must return no lines
grep -n "data-theme" server/components/shell.tsx                          # must show prop wiring
```
