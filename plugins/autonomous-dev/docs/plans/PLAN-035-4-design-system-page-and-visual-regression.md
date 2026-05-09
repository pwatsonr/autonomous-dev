# PLAN-035-4: /design-system Page and Visual Regression

## Metadata
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Estimated effort**: 3 days
- **Dependencies**: ["PLAN-035-2", "PLAN-035-3"]
- **Blocked by**: ["PLAN-035-2"] (renders Btn / Chip / Dot / Score / CostRing / Card), ["PLAN-035-3"] (renders KillSwitch in disengaged + engaged states)
- **Priority**: P1 (regression surface — non-blocking for end-user surfaces but the canonical CI gate for primitive drift)
- **Stage**: Phase 3 of TDD-035 §11 rollout (`/design-system` page + visual regression)

## Objective

Land the `/design-system` route that renders all 20 preview cards from the
design bundle as live Hono JSX components composed from the portal's own
primitives, then bootstrap the Playwright + Docker visual regression
pipeline that uses this page as the canonical CI gate against primitive
drift. Per TDD-035 §10.4 (M-03), the regression surface exercises the
actual component implementations — not raw HTML copies of the preview
files — so any future change to a primitive's rendered output is caught at
the pixel level on the next PR.

Concretely this plan delivers:

1. `server/routes/design-system.ts` — the route handler.
2. `server/templates/views/design-system.tsx` — the page view with all 20 preview-card sections.
3. Route registration in `server/routes/index.ts`; nav-item added to `RailNav` (the entry already exists in TDD-035 §6.2 NAV_ITEMS — confirm it's wired).
4. CSS for the design-system page in `portal.css`: `.ds-card`, `.ds-toc`, `.ds-swatch`, `.ds-swatch-grid` (TDD-035 §15).
5. `npm run gen:visual-goldens` script wrapping `UPDATE_GOLDEN=1 npx playwright test tests/visual/design-system.spec.ts --project=golden-gen`.
6. Playwright spec `tests/visual/design-system.spec.ts` with one full-page screenshot + 20 per-card screenshots (`design-system-card-{01..20}.png`).
7. Golden images committed at `tests/visual-regression/goldens/`; if the directory exceeds 500KB total, switch to `git lfs` per TDD-035 §10.4.
8. CI job spec using Docker image `mcr.microsoft.com/playwright:v1.40.0-jammy` (pinned), with the `GOLDEN_MISSING` failure mode that explicitly requires local regeneration rather than auto-creating goldens in CI.
9. Pixel-diff threshold `0.1%` per TDD-035 §10.4.
10. Integration test asserting `GET /design-system` returns 200 with all 20 `<section class="ds-card">` elements present.

## Scope

### In Scope
- The `/design-system` route, view, sticky-sidebar TOC, and 20 section components.
- Each section renders the **portal's own primitives** (Btn, Chip, Dot, Score, CostRing, Card, KillSwitch) and the `BrandWordmark` — not raw HTML from the design bundle's preview files (FR-S34: no `dangerouslySetInnerHTML`).
- Token-only sections (1: Type display, 2: Type body, 3: Colors neutrals, 4: Colors brand, 7: Spacing and radii) are pure HTML structures using `var(--*)` tokens — these exercise the token system, not a primitive.
- Playwright spec, golden generation script, Docker-pinned CI job.
- Golden image bootstrap via local `npm run gen:visual-goldens` and committed binaries.
- Pixel-diff threshold of 0.1% with explicit `GOLDEN_MISSING` failure mode.
- Integration test for route + content presence.

### Out of Scope
- Auth gate on `/design-system` — TDD-035 §12.1 OQ-035-01 RESOLVED as public; the page renders only static specimens, no operational data.
- Cross-OS visual regression — the canonical environment is the pinned Docker image; macOS-local generation produces identical output by construction (system fonts + fixed viewport per TDD-035 §10.4).
- New primitives or shell changes — those are PLAN-035-1 / PLAN-035-2 / PLAN-035-3.
- Vendoring or modifying `colors_and_type.css` — PLAN-034-1.
- Surface-by-surface adoption (Dashboard, Approvals, Costs, Ops, Settings, Request Detail) — TDD-018-C.
- M-04 before/after screenshots of the six surfaces — TDD-018-C scope.

## Tasks

1. **Implement `design-system.tsx` view skeleton.** `<ShellLayout activePath="/design-system" theme={theme}>` wrapper, `.page-head` with title "Design system", a sticky sidebar `<nav class="ds-toc">` linking to each section by `#preview-{n}` anchor, then 20 `<section id="preview-{n}" class="ds-card">` containers. Effort: 0.4 day.

2. **Implement sections 1–8 (foundational + tokens + elevation).**
   - 1: Type display — font specimens at 28/20/15/13/12/11px in both Inter and JetBrains Mono.
   - 2: Type body — body text + mono numerics + ID specimens.
   - 3: Colors neutrals — swatch grid `bg-0` through `fg-3`.
   - 4: Colors brand — brand amber + tint + line companions.
   - 5: Colors semantic — `Chip` ok/warn/err/info/muted swatches.
   - 6: Colors phases — eight `Chip variant="phase"` swatches in canonical order (prd, tdd, plan, spec, code, review, deploy, observe).
   - 7: Spacing and radii — visual scale of `--s-1` through `--s-6` and `--r-1` through `--r-3`.
   - 8: Elevation — hairline-only `Card` next to a `--shadow-pop` example to demonstrate R-15a.
   Effort: 0.5 day.

3. **Implement sections 9–14 (interactive primitives).**
   - 9: Buttons — `Btn` in all four kinds × two sizes (8 buttons total).
   - 10: Status chips — `Chip variant="status"` in all six tones.
   - 11: Phase chips — all 8 phases in a row.
   - 12: Dots — all 5 tones + `live`.
   - 13: Scores — `Score` at value=92 (ok), 70 (warn), 45 (err) with default threshold=85.
   - 14: Cost ring — `CostRing` at spent=18/cap=120 (TODAY) and spent=1843/cap=2500 (MONTH).
   Effort: 0.4 day.

4. **Implement sections 15–20 (composite + safety + brand).**
   - 15: Inputs — text input, select, error state, mono variant (CSS-only; no primitive).
   - 16: Repo card — `Card leftBar="code"` with chip + score + dot composition; plus an "attention" variant with `leftBar="review"`.
   - 17: Kill switch — `KillSwitch engaged={false}` and `KillSwitch engaged={true}` side-by-side. The armed state is a transient HTMX response and is not rendered as a static specimen here (verified by integration tests in PLAN-035-3 instead).
   - 18: Cost panel — `Card` containing `CostRing` + budget breakdown table.
   - 19: Timeline — phase progression with `Dot` and `Chip variant="phase"` for each step.
   - 20: Brand wordmark — `BrandWordmark showBrackets={true}` and a second instance demonstrating dark theme rendering (the page renders one theme per request; the second specimen is a `<div data-theme="dark">` overriding the cascade).
   Effort: 0.5 day.

5. **Add design-system page CSS to `portal.css`.** `.ds-card` (1px border, 3px radius, `var(--s-3)` padding, no shadow per R-15a), `.ds-toc` (sticky sidebar, list of anchor links), `.ds-swatch` (small inline swatch with hex label), `.ds-swatch-grid` (CSS grid for colors-neutrals + colors-brand sections). Effort: 0.2 day.

6. **Implement `design-system.ts` route handler.** Reads `portal-theme` cookie, renders `<DesignSystemPage theme={cookieValue}>`. Effort: 0.1 day.

7. **Register route + confirm nav item.** Add `app.get("/design-system", designSystemHandler)` in `server/routes/index.ts`. Confirm the `/design-system` entry in `RailNav` NAV_ITEMS (PLAN-035-1) routes correctly. Effort: 0.1 day.

8. **Author Playwright spec `tests/visual/design-system.spec.ts`.** Setup: launch portal server in test mode (`PORT=19281 NODE_ENV=test`), navigate to `http://127.0.0.1:19281/design-system`, set viewport `1440x900`, wait for `domcontentloaded` + a known live-dot element to be visible (so the pulse animation reaches a deterministic frame — use `animation: paused` injected via test stylesheet). Capture 1 full-page screenshot and 20 per-section screenshots scoped to `#preview-{n}`. Compare against goldens in `tests/visual-regression/goldens/` with pixel-diff tolerance `0.1%`. Effort: 0.4 day.

9. **Add `npm run gen:visual-goldens` script to `package.json`.** Wraps `UPDATE_GOLDEN=1 npx playwright test tests/visual/design-system.spec.ts --project=golden-gen`. Document in the script's adjacent README that this is the **only** way to update goldens — CI never auto-generates. Effort: 0.1 day.

10. **Bootstrap goldens.** Run `npm run gen:visual-goldens` locally on macOS; commit the 21 PNG files under `tests/visual-regression/goldens/`. Verify total directory size; if >500KB, configure `git lfs track "*.png"` for that path and re-add. Effort: 0.2 day.

11. **CI job spec.** Add a `visual-regression` job to the existing CI pipeline using image `mcr.microsoft.com/playwright:v1.40.0-jammy` (pinned). Steps: install deps, start portal in test mode, run `npx playwright test tests/visual/design-system.spec.ts`, on failure upload diff PNGs as job artifacts. Implement the `GOLDEN_MISSING` failure mode: if a golden file is absent, exit 1 with the message `GOLDEN_MISSING: No golden image found at tests/visual-regression/goldens/<name>.png. Run "npm run gen:visual-goldens" locally and commit the generated files.` (TDD-035 §10.4). Effort: 0.4 day.

12. **Integration test.** `tests/integration/design-system-route.test.ts` — `GET /design-system` → 200, response HTML contains 20 `<section ` substrings with `id="preview-1"` through `id="preview-20"` and class `ds-card`. Effort: 0.1 day.

## Verification

- `GET /design-system` returns 200 with all 20 `ds-card` sections present (integration test).
- The page loads with no console errors and no CSP violations (manual; CSP middleware unchanged).
- The Playwright spec passes locally on macOS against the committed goldens.
- The Playwright spec passes in CI under the pinned Docker image.
- `npm run gen:visual-goldens` regenerates all 21 PNG files; running it twice produces zero diffs (deterministic).
- `GOLDEN_MISSING` failure mode triggers on a missing golden: the CI run fails with the documented error message and the developer-action instruction.
- Pixel-diff tolerance is exactly `0.1%`; a 1px shift in any primitive triggers a CI failure.
- Removing a class from any primitive (e.g., `.btn.primary` → `.btn`) causes the corresponding section's golden comparison to fail — confirms the surface exercises the actual component code.
- The `KillSwitch` section renders disengaged + engaged states with the correct tint/border per `.ks-panel.armed` styling.
- The `BrandWordmark` section renders both light and dark theme treatments correctly.

## Test Plan

- **Integration**: `tests/integration/design-system-route.test.ts` — route returns 200, all 20 sections present.
- **Visual regression**: `tests/visual/design-system.spec.ts` — 21 screenshot comparisons (1 full-page + 20 per-card) against committed goldens, threshold 0.1%, runs in CI under the pinned Playwright Docker image.
- **Bootstrap test**: delete a single golden file and run the spec → assert it fails with the `GOLDEN_MISSING` message and the CI-suggested next-step text.
- **Determinism check**: run `npm run gen:visual-goldens` twice in clean working trees; the second run produces zero git diffs.
- **CSP smoke**: `curl -I /design-system` returns the standard portal CSP headers; the page does not introduce any inline scripts or styles that violate the existing policy.
- **Manual smoke**: navigate to `/design-system` in Chrome; eyeball each of the 20 sections against the design bundle's `preview/*.html` reference for visual fidelity.

## Rollback

The `/design-system` page is additive — no existing surface depends on it. Rollback is `git revert <commit-sha>` of the PR. The visual-regression CI job becomes a no-op (the spec file is removed). The `npm run gen:visual-goldens` script is also removed. The committed goldens are the only artifact requiring cleanup, but they are isolated under `tests/visual-regression/goldens/` and removing the directory has no downstream effect on the portal runtime. If the visual regression CI is too flaky to keep enabled mid-rollout, flip the CI job to `continue-on-error: true` as an interim — preserves observability without blocking PRs — and revisit after stabilizing the Docker image pin.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `.dot.live` pulse animation produces non-deterministic frames between golden generation and CI run | High | High | Inject a test-only stylesheet that sets `animation: paused` on `.dot.live` before the screenshot. Document in the spec file. |
| Golden directory exceeds 500KB without git-lfs configured, bloating the main repo | Medium | Medium | Pre-commit check: total size of `tests/visual-regression/goldens/`. If >500KB, run `git lfs track "*.png"` in that path and re-stage. TDD-035 §10.4 anticipates this. |
| Docker image `mcr.microsoft.com/playwright:v1.40.0-jammy` is updated upstream and renders differently | Low | Medium | Image is version-pinned to `v1.40.0-jammy` in the CI job spec. Renovate/dependabot will surface upgrades; goldens regenerate on the same PR as the upgrade. |
| `GOLDEN_MISSING` error message is generic and confuses developers who don't know about `npm run gen:visual-goldens` | Medium | Low | The error message itself includes the exact command to run. Onboarding docs (`docs/dev/visual-regression.md` — out of this plan's scope but recommended follow-up) should expand on this. |
| KillSwitch armed state isn't visualized in the design-system page (only disengaged + engaged) | Low | Low | Documented in task 4: the armed state is a transient HTMX response, exercised by PLAN-035-3 integration tests. Adding it as a static specimen would require either a fixture armed_at (always-stale, would expire mid-render) or a third surface state — neither pays for itself. |
| Token-only sections (1, 2, 3, 4, 7) drift from `colors_and_type.css` after a future token change without anyone catching it | Low | Low | The visual regression on these sections IS the catch — the goldens encode the current token values. Any token change requires golden regeneration, which forces the maintainer to acknowledge the visual change. |
| Sticky `.ds-toc` sidebar overlaps content on viewports narrower than the test viewport | Low | Low | PRD-018 NG-06 — desktop only. Test viewport is fixed `1440x900`. Mobile is explicitly out of scope. |
| Visual regression on the `BrandWordmark` section breaks if `PORTAL_WORDMARK_BRACKETS=0` is set in test mode | Low | Low | Test environment must run with `PORTAL_WORDMARK_BRACKETS=1` (the default). Document in the CI job env block. |

## Definition of Done

- [ ] `/design-system` route registered; `GET /design-system` returns 200 with all 20 `ds-card` sections.
- [ ] Each section renders the portal's own primitives (Btn / Chip / Dot / Score / CostRing / Card / KillSwitch / BrandWordmark), not raw HTML from preview files.
- [ ] Sticky `.ds-toc` sidebar links to each section anchor.
- [ ] Design-system CSS classes added to `portal.css`; no `box-shadow:` outside `--shadow-*`.
- [ ] `npm run gen:visual-goldens` script defined and documented; deterministic on second run.
- [ ] Playwright spec captures 1 full-page + 20 per-card screenshots with 0.1% threshold.
- [ ] Goldens committed under `tests/visual-regression/goldens/` (git-lfs if directory >500KB).
- [ ] CI job runs under pinned Docker image `mcr.microsoft.com/playwright:v1.40.0-jammy`.
- [ ] `GOLDEN_MISSING` failure mode emits the documented error with developer action.
- [ ] Pulse animation paused in test mode for deterministic frames.
- [ ] Integration test passes.
- [ ] OQ-035-01 documented as RESOLVED (page is public).
