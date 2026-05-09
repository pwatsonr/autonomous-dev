# PLAN-035-1: Layout Shell and Brand Wordmark

## Metadata
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Estimated effort**: 4 days
- **Dependencies**: ["PLAN-034-1"]
- **Blocked by**: ["PLAN-034-1"] (design tokens must ship first; shell CSS references `--bg-1`, `--line-1`, `--brand`, `--phase-*`)
- **Priority**: P0 (gates all surface re-skinning in TDD-018-C)
- **Stage**: Phase 2 of TDD-035 §11 rollout (Shell layout + brand assets)

## Objective

Replace the portal's current top-bar `<header><nav>` `BaseLayout` with the kit's
220px persistent left-rail `ShellLayout`, vendor the brand wordmark (with the
OQ-02 bracket-fallback env var), and migrate every existing view to render
inside the new shell. This is the structural change that every other PRD-018
deliverable (primitives, KillSwitch, design-system page, surface adoption)
composes inside.

Concretely this plan delivers:

1. `server/components/shell.tsx` — `ShellLayout` FC with `theme`, `daemonStatus`, `killSwitchEngaged`, `breakerTripped`, `mtdSpend`, `gateCount`, `activePath` props per TDD-035 §6.1.
2. `server/components/rail-nav.tsx` — `RailNav` with the seven `NAV_ITEMS` (Dashboard, Approvals, Costs, Operations, Settings, Audit, Design system) split into Operate / System groups, with `gateCount` badge on Approvals (TDD-035 §6.2).
3. `server/components/rail-ops-bar.tsx` — `RailOpsBar` rendering daemon-status line, breaker line, MTD-spend line, kill-switch button (uses HTMX swap into `#modal-slot`), and theme-toggle button (TDD-035 §6.3).
4. `server/components/brand-wordmark.tsx` — `BrandWordmark` FC with `showBrackets` prop defaulting from `process.env["PORTAL_WORDMARK_BRACKETS"] ?? "1"` (TDD-035 §6.4, OQ-02 fallback).
5. `server/static/js/theme-toggle.js` — vanilla JS module that reads `localStorage["portal.theme"]`, writes the `portal-theme` cookie shadow, toggles `data-theme` on `<html>`, and updates the toggle visual (TDD-035 §6.7).
6. Vendored brand assets at `server/static/brand/{wordmark,wordmark-dark,mark}.svg` (TDD-035 §6.4).
7. Shell + rail CSS in `portal.css`: `.app`, `.rail`, `.rail-brand`, `.rail-nav`, `.rail-ops`, `.main`, `.main.wide`, `.page-head`, `.head-actions`, `.theme-toggle`, `.tt-*` (TDD-035 §6.1, §15).
8. Theme-prop wiring in every existing route handler: `getCookie(c, "portal-theme")` → `theme={cookieValue}` passed to `ShellLayout`.
9. Atomic migration of all 10 existing views (Dashboard, Approvals, Request Detail, Settings, Costs, Ops, Audit, etc.) from `BaseLayout` → `ShellLayout` in a single commit.
10. Deprecation of `BaseLayout`, `Navigation`, and `DaemonStatusPill` (TDD-035 §12.1 OQ-035-02 resolution): retained for one release cycle, marked `@deprecated`, removed in TDD-018-C.

## Scope

### In Scope
- All shell-level components, the brand wordmark (with `PORTAL_WORDMARK_BRACKETS` env-var fallback per TDD-035 §6.4), the theme-toggle JS module, vendored brand SVGs, the new shell CSS section in `portal.css`, theme-prop wiring across every route handler, and the atomic `BaseLayout` → `ShellLayout` migration of all 10 existing views.
- Documentation of `PORTAL_WORDMARK_BRACKETS` in the portal deployment config / env-var reference (TDD-035 §13).
- Unit tests asserting `data-theme="light"` / `data-theme="dark"` rendering, wordmark bracket toggling, and active-nav-item detection (TDD-035 §10.2).
- Integration tests verifying every migrated page returns 200 and renders the rail (TDD-035 §10.5).
- Deprecation comments on `BaseLayout`, `Navigation`, and `DaemonStatusPill`.

### Out of Scope
- The seven primitive components (`Btn`, `Chip`, `Dot`, `Score`, `CostRing`, `Card`, `KillSwitch`) — PLAN-035-2 / PLAN-035-3.
- The `/design-system` route — PLAN-035-4.
- Re-skinning the existing surfaces beyond swapping the layout wrapper (the views render inside `ShellLayout` but their internal markup is unchanged) — TDD-018-C scope.
- Removing the deprecated `BaseLayout` / `Navigation` / `DaemonStatusPill` — happens in TDD-018-C after a release cycle.
- Vendoring `colors_and_type.css`, font self-hosting, CI lints — TDD-034 / PLAN-034-1 scope.

## Tasks

1. **Implement `ShellLayout` (`server/components/shell.tsx`).** All seven props per TDD-035 §6.1 with the documented defaults; renders the full `<html><body>` shell including `<link rel="stylesheet" href="/static/design-tokens.css">` first, `<link rel="stylesheet" href="/static/portal.css">` second, the HTMX script, the theme-toggle module script (both with `nonce={cspNonce}`), and a `<div id="modal-slot">` slot for HTMX modal targets. Effort: 0.5 day.

2. **Implement `RailNav` (`server/components/rail-nav.tsx`).** The seven NAV_ITEMS in TDD-035 §6.2 split into Operate/System groups; active item via `activePath === item.href`; `gateCount` badge on the Approvals item when non-zero; `aria-current="page"` on the active link. Effort: 0.5 day.

3. **Implement `RailOpsBar` (`server/components/rail-ops-bar.tsx`).** The four-line ops bar per TDD-035 §6.3: daemon line (`.dot.live` running, `.dot.warn` stale, `.dot.err` dead, `.dot.muted` unknown), breaker line (`.dot.ok` / `.dot.err`), MTD-spend line (`.dot.warn` above 80% of cap, else `.dot.ok`), kill-switch `.kbtn` with HTMX `hx-get="/ops/kill-switch-modal?step=arm"` `hx-target="#modal-slot"`, and the theme-toggle button. Effort: 0.5 day.

4. **Implement `BrandWordmark` (`server/components/brand-wordmark.tsx`).** Inline-text wordmark (no `<img>`) per TDD-035 §6.4; `showBrackets` prop defaults from `(process.env["PORTAL_WORDMARK_BRACKETS"] ?? "1") === "1"`. Brackets render as `<span class="br">[</span>` / `<span class="br">]</span>` so CSS controls `var(--brand)` color. Effort: 0.25 day.

5. **Implement theme-toggle vanilla JS module (`server/static/js/theme-toggle.js`).** IIFE on load reads `localStorage["portal.theme"]` and sets `data-theme` to prevent flash; writes `portal-theme=<value>;path=/;max-age=31536000;SameSite=Strict` cookie shadow; on click swaps `data-theme`, updates `localStorage`, refreshes the cookie, and toggles `.tt-track.light` / `.tt-track.dark`. Loaded as `<script type="module" nonce>` from `ShellLayout`. Effort: 0.5 day.

6. **Vendor brand assets to `server/static/brand/`.** Copy `wordmark.svg`, `wordmark-dark.svg`, `mark.svg` from the design bundle. Verify served with `Content-Type: image/svg+xml` by the existing `staticAssets` middleware. Note: shipping SVGs is gated on OQ-02 ACCEPT; if OQ-02 resolves REPLACE, ship empty placeholders and rely on `PORTAL_WORDMARK_BRACKETS=0` for the rendered wordmark. Effort: 0.25 day.

7. **Add shell + rail CSS to `portal.css`.** All classes from TDD-035 §15 "Shell" inventory: `.app` (grid 220px / 1fr), `.rail` (sticky, 100vh, `var(--bg-1)`, 1px right border), `.rail-brand`, `.rail-brand .wm`, `.rail-brand .wm .br` (`color: var(--brand)`), `.rail-nav`, `.rail-nav a.active` (inset 2px brand left bar), `.rail-ops`, `.kbtn` (1px err border, err color), `.theme-toggle`, `.tt-track`, `.tt-knob`, `.main` (max-width 1280px, padding 28px 36px), `.main.wide`, `.page-head` (flex baseline space-between), `.page-head h1` (28px 700), `.head-actions` (flex `var(--s-2)` gap). Hairline-only — no `box-shadow:` declarations outside `--shadow-*` tokens (R-15a). Effort: 0.75 day.

8. **Wire theme prop in every route handler.** For each route handler that currently calls `c.html(<BaseLayout>...)`: import `getCookie` from `hono/cookie`, read `portal-theme`, pass `theme={cookieValue === "dark" ? "dark" : "light"}` to `ShellLayout`. Affects every page route (Dashboard, Approvals, Request Detail, Settings, Costs, Ops, Audit, healthz/error pages excluded). Effort: 0.5 day.

9. **Atomic migration: all 10 views from `BaseLayout` → `ShellLayout`.** Single commit per TDD-035 §11 Phase 2. Rename layout import in each view file; pass `activePath` matching the route; pass through `daemonStatus` / `killSwitchEngaged` / `breakerTripped` / `mtdSpend` / `gateCount` from existing readers (`StateReader`, `HeartbeatReader`, `CostReader`). Mark `BaseLayout`, `Navigation`, `DaemonStatusPill` as `@deprecated` (do not delete). Effort: 0.5 day.

10. **Document `PORTAL_WORDMARK_BRACKETS` env var.** Add to portal deployment config docs / env-var reference table per TDD-035 §13. Default `"1"`; set to `"0"` if OQ-02 resolves REPLACE. Effort: 0.1 day.

11. **Shell unit + integration tests.** Per TDD-035 §10.2 + §10.5: `data-theme` attribute correctness for both themes, `<link>` tags present, theme-toggle script `nonce` correct, ops-bar dot classes match daemon/breaker/MTD inputs, `aria-current="page"` on active nav, and a smoke integration test asserting all 10 migrated routes return 200 with `<aside class="rail">` in the body. Effort: 0.4 day.

## Verification

- `ShellLayout` unit tests cover all 8 assertions in TDD-035 §10.2 (grid, wordmark spans, active-nav, design-tokens link, theme-toggle script with nonce, ops-bar daemon dot, `data-theme="dark"`, `data-theme="light"`).
- `BrandWordmark` unit tests cover both `showBrackets=true` (`.br` spans present) and `showBrackets=false` (no `.br` spans), including env-var default behaviour.
- Theme-toggle JS module manual smoke: load portal in light theme → click toggle → `data-theme="dark"` on `<html>`, `localStorage.portal.theme === "dark"`, `document.cookie` contains `portal-theme=dark`. Reload → still dark. Toggle back → light persisted.
- Theme cookie SSR round-trip: with `Cookie: portal-theme=dark`, every route returns HTML with `<html data-theme="dark">` — no flash of wrong theme on first paint.
- Integration test: `GET /static/brand/wordmark.svg` → 200 `image/svg+xml`; `GET /static/js/theme-toggle.js` → 200 `application/javascript` (or `text/javascript`).
- Migration completeness: `grep -rn "BaseLayout" server/templates/views/` returns zero matches in non-deprecated files.
- `PORTAL_WORDMARK_BRACKETS=0 npm run dev` renders "autonomous-dev" without brackets.

## Test Plan

- **Unit (Hono JSX renderer)**: `tests/unit/components/shell.test.tsx`, `tests/unit/components/rail-nav.test.tsx`, `tests/unit/components/rail-ops-bar.test.tsx`, `tests/unit/components/brand-wordmark.test.tsx`. Cover the assertion matrix from TDD-035 §10.2 plus wordmark bracket toggling.
- **Integration**: `tests/integration/shell-migration.test.ts` — start portal in test mode, GET each of the 10 migrated routes, assert 200 + `<aside class="rail">` + `<main class="main">` + `data-theme` attribute.
- **Theme cookie**: `tests/integration/theme-cookie.test.ts` — assert SSR honors `portal-theme` cookie for both `light` and `dark`.
- **Static assets**: `tests/integration/static-assets.test.ts` — assert brand SVGs and `theme-toggle.js` serve with correct content-type.
- **Manual smoke**: theme toggle round-trip in Chrome + Firefox + Safari (PRD-018 NG-06 — desktop only, but cross-browser since the JS module uses standard `localStorage` + `cookie`).

## Rollback

The shell migration is a single atomic commit (TDD-035 §11 Phase 2). Rollback is `git revert <commit-sha>` of that commit. `BaseLayout`, `Navigation`, and `DaemonStatusPill` remain in the codebase as deprecated for one release cycle, so reverting only the view-import switch restores the previous behavior with zero downstream code changes. Brand assets, theme-toggle JS, and `portal.css` shell additions are additive and may stay in place after rollback (no impact on the reverted views).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| OQ-02 (wordmark IP) blocks brand SVG vendoring | Medium | Low | `PORTAL_WORDMARK_BRACKETS` env var (default `"1"`, set `"0"` for REPLACE) means no code change is required if OQ-02 resolves REPLACE. SVG files can ship as empty placeholders. |
| Atomic migration of 10 views half-lands and leaves split-layout state | Medium | High | Single PR with single commit touching all 10 view files. CI gate: integration test asserts every route renders `.rail`. Reviewer enforces: no partial migrations. |
| Theme cookie SSR mismatch causes flash-of-wrong-theme | Low | Low | Theme-toggle JS IIFE runs before DOMContentLoaded, sets `data-theme` from `localStorage` first; cookie is the SSR fallback only on first ever visit. Both paths converge after first render. |
| `kbtn` HTMX target `#modal-slot` collides with existing modal patterns | Low | Medium | The existing `confirm-modal.tsx` uses the same pattern; reuse the slot. Verify with the integration test that hits `GET /ops/kill-switch-modal?step=arm`. (Full kill-switch route logic lives in PLAN-035-3.) |
| Shell CSS introduces a `box-shadow:` declaration that violates R-15a | Low | Low | TDD-034's CI lint will reject any `box-shadow:` outside `--shadow-*` tokens. Local `grep` is the dev-time check. |
| Route handlers miss the theme-cookie wiring on a less-trafficked surface | Medium | Low | Shell defaults `theme="light"`, so a missed wiring degrades to "light theme regardless of preference" — visible bug, not a crash. CI grep: every route handler that renders `ShellLayout` must reference `getCookie(c, "portal-theme")`. |

## Definition of Done

- [ ] `ShellLayout` renders the documented HTML shape including `data-theme`, design-tokens link first, both nonce-protected scripts, and `<div id="modal-slot">`.
- [ ] `RailNav`, `RailOpsBar`, `BrandWordmark` each ship with the prop signatures from TDD-035 §6.2 / §6.3 / §6.4.
- [ ] `theme-toggle.js` module persists `localStorage["portal.theme"]` and the `portal-theme` cookie shadow; flash-of-wrong-theme is not observable in a manual smoke.
- [ ] Brand SVGs vendored at `server/static/brand/{wordmark,wordmark-dark,mark}.svg`, served with correct content-type.
- [ ] All shell CSS classes from TDD-035 §15 added to `portal.css`; no `box-shadow:` outside `--shadow-*` tokens.
- [ ] All 10 existing views migrated to `ShellLayout` in a single commit; integration test confirms every route renders `.rail`.
- [ ] Every route handler reads `portal-theme` cookie and passes `theme` prop to `ShellLayout`.
- [ ] `BaseLayout`, `Navigation`, `DaemonStatusPill` marked `@deprecated` with TDD-018-C cleanup pointer.
- [ ] `PORTAL_WORDMARK_BRACKETS` documented in env-var reference; default `"1"`.
- [ ] Unit tests in TDD-035 §10.2 all pass; integration suite green.
