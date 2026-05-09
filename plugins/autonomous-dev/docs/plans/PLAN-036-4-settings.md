# PLAN-036-4: Settings Surface Re-skin

## Metadata
- **Parent TDD**: TDD-036-portal-redesign-surfaces (v1.1)
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Estimated effort**: 5 days
- **Dependencies**: ["PLAN-035-2", "PLAN-035-3"]
- **Blocked by**: PLAN-035-2 (primitives — `Btn`, `Chip`), PLAN-035-3 (`ConfirmModal` per TDD-035 §6.5.7)
- **Priority**: P1
- **Stage**: Surface rollout order #5 (last) per TDD-036 §9 — most complex surface, ships last to benefit from lessons learned across the prior four

## Objective

Re-skin the Settings surface (`GET /settings`) to match `Settings.jsx` from
the design system kit, consuming the primitives delivered by TDD-035.
This plan covers PRD-018 R-20 in full, including five tabs (General /
Pipeline variants / Engineering standards / Deploy backends / Agent
factory), live form validation, two modal types (Edit Standard, Inspect
Agent), and the v1.1 deep-link mechanism (`?tab=` URL parameter).

Settings is the most complex surface in the redesign — five tabs with
distinct content, the most client-side JS in the entire portal (tab
switching with `history.pushState`, live form validation, modal open/close),
and the most form fields. Per TDD-036 §9, it ships last so the engineer
benefits from primitive-integration patterns established by Dashboard,
Costs, Ops, and the modal-handling pattern established by Request Detail.

The deep-link mechanism (v1.1) is the SSR port of the kit's React `useState
+ useEffect` synchronization. Per TDD-036 §6.5, the server reads `?tab=`,
sets `data-active-tab` on the tab nav, marks the active tab button with
`on` class, and renders all other tab panels with `hidden`. Vanilla JS
handles click → `history.pushState` and `popstate` → tab switch. Browser
reload preserves the active tab.

## Scope

### In Scope
- Rewrite `templates/views/settings.tsx` to compose the page-head + tab nav + 5 tab panels per TDD-036 §6.5 template structure.
- Replace the existing `<dl>` for auth/port/log-level + `SettingsEditor` form with the new tabbed interface. Existing form-submit HTMX flow remains the source of truth for persistence; the re-skin only changes the markup.

**Tab nav** (`fragments/settings-tabs.tsx`):
- `.seg.seg-tabs` segmented control with 5 buttons.
- `data-active-tab="<id>"` attribute on the nav container (set server-side).
- Active button has `on` class server-side.
- Each button has `data-tab="<id>"` for client click handler.

**Tab: General** (in `views/settings.tsx`):
- 2-col grid of setting cards.
- Trust level (`<select>` L0-L3).
- Daily cost cap (`$` prefix `<input type="number">` with live validation).
- Default pipeline variant (`<select>` populated from `variants[]`).
- Default deploy backend (`<select>` populated from `backends[]`).

**Tab: Pipeline variants** (`fragments/variant-grid.tsx`):
- Card grid, each card per variant with: name, default badge, description, phase pipeline visualization (compact), reviewer map, Edit + Set default `Btn`.

**Tab: Engineering standards** (`fragments/standards-table.tsx` + edit modal):
- Full-width table: ID, Severity (`Chip`), Description, Applies, Source, Hits, Edit `Btn`.
- Edit modal: form with description, severity select, applies predicate input. Uses `ConfirmModal` from TDD-035.
- Immutable rules show locked indicator, Edit button disabled.

**Tab: Deploy backends** (`fragments/backend-grid.tsx`):
- Responsive card grid, each card per backend with: name, kind badge (`Chip`), cost, capability chips, Configure + Set default `Btn` (or Install plugin `Btn` when `status === 'not-installed'`).

**Tab: Agent factory** (`fragments/agent-table.tsx` + inspect modal):
- Full-width table: Name, Role (`Chip`), State (`Chip`), Approval (mono), Precision (mono), Recall (mono), Version (mono), Inspect `Btn`.
- Inspect modal: stats grid + recent runs mini-table (populated from `agent.recentRuns`) + Promote/Shadow/Freeze `Btn`. Uses `ConfirmModal`.

**Vanilla JS modules**:
- Update `static/js/settings-tabs.js` per TDD-036 §6.5 deep-link logic verbatim:
  - On `DOMContentLoaded`, read `data-active-tab` from `.seg.seg-tabs`, call `showTab(initialTab)`.
  - Bind tab button clicks → `showTab(tabId)` + `history.pushState({}, '', '?tab=' + tabId)`.
  - Bind `popstate` → re-read `?tab=` param + `showTab()`.
- New `static/js/form-validation.js`: live validation on cost-cap input (negative / non-numeric / exceeds-cap warnings rendered as `<span class="field-error">` inserted/removed via vanilla JS). Server-side validation via existing HTMX `hx-post` flow remains authoritative.
- New `static/js/settings-modals.js`: open/close `<dialog>` for Edit Standard and Inspect Agent modals.

**Server-side route handler** (`server/routes/settings.ts`):
- Read `?tab=` query param, validate against allowed IDs (`general`, `variants`, `standards`, `backends`, `agents`), default to `general` on absent/invalid.
- Pass `activeTab` into the render props.

**Type extensions** (`types/render.ts`):
- `SettingsData` extension: `activeTab: 'general' | 'variants' | 'standards' | 'backends' | 'agents'`.
- Add `DeployBackend` per TDD-036 §5.3.
- Add `AgentRecord` and `AgentRunRef` per TDD-036 §5.3.
- Confirm `StandardRule`, `PipelineVariant` (already added in PLAN-036-1).

**Stub loader** (`stubs/settings.ts`):
- Populate `variants` (3-5 entries, one with `default: true`).
- Populate `standards` (8-12 rules with mixed severity, some immutable).
- Populate `backends` (4 entries, mix of bundled + plugin, mix of available + not-installed).
- Populate `agents` (6-10 records with `recentRuns` populated for the inspect modal).

**Tests**:
- Visual regression: `tests/visual/settings.visual.test.ts` — 5 tabs × 2 themes = 10 baseline images.
- Integration: `tests/integration/settings.test.ts` — assert deep-link parity (`?tab=standards` renders standards panel visible, others hidden), assert tab nav contains all 5 buttons, assert table/grid CSS classes present.
- Client-side JS unit tests per TDD-036 §8.6:
  - `tests/clientside/settings-tabs.test.ts` — `data-active-tab` initialization, click + `pushState`, `popstate` handling, default tab fallback.
  - `tests/clientside/form-validation.test.ts` — boundary inputs (negative, non-numeric, exceeds-cap) trigger field-error span; valid input clears it.
  - `tests/clientside/settings-modals.test.ts` — modal open/close.
- M-04 before/after screenshots for all 5 tabs (light + dark, 20 PNGs).

### Out of Scope
- Primitives — TDD-035 / PLAN-035-2.
- `ConfirmModal` helper — TDD-035 / PLAN-035-3 §6.5.7.
- Other surfaces — sister plans.
- New settings persistence backends / migration of existing config schema — re-skin only touches the template layer; existing HTMX `hx-post` route handlers remain authoritative.
- Server-side form validation — existing flow stays; client-side validation is UX-only and never authoritative.
- Agent state transition workflow (Promote/Shadow/Freeze) — buttons are wired to existing routes; logic unchanged.

## Tasks

1. **Extend `types/render.ts`** with `SettingsData.activeTab`, `DeployBackend`, `AgentRecord`, `AgentRunRef`. Reuse `StandardRule`, `PipelineVariant` from PLAN-036-1.
   - Files: `plugins/autonomous-dev-portal/server/types/render.ts`.
   - Acceptance: `bun tsc --noEmit` passes.
   - Effort: 0.25 day.

2. **Populate `stubs/settings.ts`** with variants (3-5), standards (8-12 with severity mix, 2 immutable), backends (4 with status mix), agents (6-10 with `recentRuns` populated).
   - Files: `plugins/autonomous-dev-portal/server/stubs/settings.ts`.
   - Acceptance: All 5 tabs render the kit's full visual without empty fallbacks.
   - Effort: 0.5 day.

3. **Update `server/routes/settings.ts`** to read `?tab=` query param, validate, default to `general`. Pass `activeTab` into render props.
   - Files: `plugins/autonomous-dev-portal/server/routes/settings.ts`.
   - Acceptance: Unit test for the validation function: valid IDs pass through, invalid/empty return `general`.
   - Effort: 0.25 day.

4. **Implement `fragments/settings-tabs.tsx`.** Renders `.seg.seg-tabs` with 5 buttons. Sets `data-active-tab` on container, `on` class on active button server-side, `data-tab` on every button.
   - Files: `plugins/autonomous-dev-portal/server/templates/fragments/settings-tabs.tsx`.
   - Acceptance: Snapshot test for each of the 5 active-tab values; assert `on` class only on the matching button.
   - Effort: 0.25 day.

5. **Implement General tab content** (inline in `views/settings.tsx`). 2-col grid of setting cards, 4 fields (trust select, cost cap input, variant select, backend select). Each input has `id` for client-side validation hooking.
   - Acceptance: Rendered fields match kit; cost cap input has `type="number"` with `min="0"` and `step="0.01"`.
   - Effort: 0.25 day.

6. **Implement `fragments/variant-grid.tsx`.** Per kit (Settings.jsx variant tab). Card per variant. Default badge when `variant.default === true`. Compact phase pipeline strip per card.
   - Files: `plugins/autonomous-dev-portal/server/templates/fragments/variant-grid.tsx`.
   - Acceptance: Snapshot test for 3 variants (one default).
   - Effort: 0.5 day.

7. **Implement `fragments/standards-table.tsx`** + Edit Standard modal. Table cols: ID, Severity (`Chip`), Description, Applies, Source, Hits, Edit. Severity tone mapping (`blocking`→err, `warn`→warn, `advisory`→info). Edit button disabled when `immutable === true`. Modal is hidden `<dialog id="edit-standard-modal">` populated server-side per row (form state) — opened via `static/js/settings-modals.js`.
   - Files: `plugins/autonomous-dev-portal/server/templates/fragments/standards-table.tsx`.
   - Acceptance: Renders 8+ rows; immutable rows show locked indicator; modal opens on Edit click in integration test.
   - Effort: 0.5 day.

8. **Implement `fragments/backend-grid.tsx`.** Responsive card grid. Per-card content per kit (Settings.jsx backends tab). Available backends show Configure + Set default; not-installed show Install plugin. Capability chips render as `Chip variant="status" tone="muted"`.
   - Files: `plugins/autonomous-dev-portal/server/templates/fragments/backend-grid.tsx`.
   - Acceptance: Snapshot test for 4 backends mixed status; install button replaces configure when `status === 'not-installed'`.
   - Effort: 0.5 day.

9. **Implement `fragments/agent-table.tsx`** + Inspect Agent modal. Table cols: Name, Role chip, State chip, Approval, Precision, Recall, Version, Inspect. Modal is hidden `<dialog id="inspect-agent-modal-{name}">` per agent, populated with stats grid + recent runs mini-table + Promote/Shadow/Freeze `Btn`.
   - Files: `plugins/autonomous-dev-portal/server/templates/fragments/agent-table.tsx`.
   - Acceptance: Renders 6+ rows; clicking Inspect opens correct dialog (integration test asserts `data-modal-target` resolves correctly); recent runs mini-table renders 3 most recent rows from `agent.recentRuns`.
   - Effort: 0.5 day.

10. **Update `static/js/settings-tabs.js`** with deep-link mechanism per TDD-036 §6.5 (verbatim from the code block in §6.5):
    - `DOMContentLoaded`: read `data-active-tab`, call `showTab(initialTab)`.
    - Bind tab button clicks: `showTab(tabId)` + `history.pushState({}, '', '?tab=' + tabId)`.
    - Bind `popstate`: re-read `?tab=` param, call `showTab()`.
    - `showTab(tabId)`: toggle `on` class on buttons, toggle `hidden` on panels.
    - Files: `plugins/autonomous-dev-portal/server/static/js/settings-tabs.js`.
    - Acceptance: jsdom unit test: `data-active-tab="standards"` → standards panel visible, others hidden; click `general` → `pushState` called with `?tab=general`; `popstate` from `?tab=variants` → variants panel visible.
    - Effort: 0.5 day.

11. **Implement `static/js/form-validation.js`.** Bind `input` event on `#cost-cap-input`; insert/remove `<span class="field-error">` based on validation rules (negative / non-numeric / > monthly-cap warning).
    - Files: `plugins/autonomous-dev-portal/server/static/js/form-validation.js`.
    - Acceptance: jsdom test: `-5` → "must be ≥ 0" error; `abc` → "must be a number"; `99999` → exceeds-cap warning; valid `42.50` → no error span.
    - Effort: 0.25 day.

12. **Implement `static/js/settings-modals.js`.** Generic modal open/close handler. On `click` of `[data-modal-open="<id>"]`, call `document.getElementById(<id>).showModal()`. ESC + backdrop dismiss handled by native `<dialog>`. Close button calls `dialog.close()`.
    - Files: `plugins/autonomous-dev-portal/server/static/js/settings-modals.js`.
    - Acceptance: jsdom test: click element with `data-modal-open="edit-standard-modal-r-001"` → `showModal()` called on that dialog.
    - Effort: 0.25 day.

13. **Rewrite `templates/views/settings.tsx`** to compose page-head + tab nav + 5 tab panels. All 5 panels render server-side; non-active panels have `hidden` attribute. Wire all 3 vanilla JS modules via `<script type="module" src="...">` tags.
    - Files: `plugins/autonomous-dev-portal/server/templates/views/settings.tsx`.
    - Acceptance: Visual snapshot for each of 5 tabs in light + dark.
    - Effort: 0.5 day.

14. **Capture M-04 before/after screenshots** for all 5 tabs in both themes (20 PNGs). Required by R-21 / M-04.
    - Files: `plugins/autonomous-dev-portal/docs/screenshots/redesign/settings-{tab-id}-{before,after}-{light,dark}.png`.
    - Acceptance: 20 PNGs committed; reviewer can eyeball-compare per tab.
    - Effort: 0.5 day.

## Verification

- `bun test plugins/autonomous-dev-portal/tests/integration/settings.test.ts` passes — deep-link `?tab=<id>` for each of the 5 IDs renders correct panel visible, others hidden; tab nav contains 5 buttons; table/grid CSS classes present.
- `bun playwright test plugins/autonomous-dev-portal/tests/visual/settings.visual.test.ts` passes for 5 tabs × 2 themes = 10 snapshots.
- `bun test plugins/autonomous-dev-portal/tests/clientside/settings-tabs.test.ts` passes — initial tab from `data-active-tab`, click + `pushState`, `popstate` re-sync.
- `bun test plugins/autonomous-dev-portal/tests/clientside/form-validation.test.ts` passes — boundary inputs.
- `bun test plugins/autonomous-dev-portal/tests/clientside/settings-modals.test.ts` passes — modal open/close.
- Browser smoke (manual): visit `/settings`, click through all 5 tabs, confirm URL updates with `?tab=<id>`, reload page → same tab restored, click browser back → previous tab restored, open Edit Standard modal → form fields populated, ESC closes modal.
- M-04 deliverable: 20 screenshots committed.

## Test Plan

- **Visual regression** per TDD-036 §8.1 — 5 tabs × 2 themes.
- **Component integration** per TDD-036 §8.3 — assert new CSS classes present (`.seg.seg-tabs`, `.variant-grid`, `.backend-grid`, `.tbl`); assert old `<dl>` / `SettingsEditor` markup absent.
- **Empty state** per TDD-036 §8.4 — feed empty `variants`, `standards`, `backends`, `agents` arrays, assert `EmptyState` text per TDD-036 §6.5.
- **Data shape compatibility** per TDD-036 §8.2.
- **Client-side JS unit tests** per TDD-036 §8.6:
  - Tab switching toggles `hidden` correctly.
  - Deep-link: `data-active-tab` is read and applied.
  - `history.pushState` called with correct `?tab=` on tab click.
  - `popstate` triggers correct tab switch.
  - Form validation shows/hides field-error for boundary inputs.
  - Modal open/close toggles `<dialog>` visibility.
- **Deep-link integration test**: HTTP `GET /settings?tab=standards` returns HTML where the standards panel is rendered without `hidden` and others with `hidden`.

## Rollback

Per TDD-036 §9, revert `views/settings.tsx` plus the 5 new fragments + 3 vanilla JS modules + route-handler `?tab=` parsing in a single commit. The `RenderProps` extensions are backward-compatible. Reverting restores the prior `<dl>` + `SettingsEditor` form. Existing HTMX `hx-post` persistence routes are untouched, so config writes continue to work whether the new or old view renders.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Deep-link `?tab=` URL doesn't match the kit's React initialState behavior — operator bookmarks break across browser restart | Low | Medium | Server-side validation defaults to `general` for invalid/missing param. Integration test covers all 5 valid IDs + 1 invalid case + missing case. |
| `history.pushState` in `settings-tabs.js` conflicts with HTMX's own URL management for `hx-push-url` form submissions | Medium | Medium | `pushState` is only fired on tab click, not form submission. HTMX `hx-push-url` is opt-in per-form; verify Settings forms do not set it (they shouldn't — the form posts to `/api/settings`, not `/settings`). Integration test asserts URL after form submit is unchanged. |
| Five tabs × 2 themes × multiple form states = visual snapshot matrix explodes | Medium | Low | Snapshot only the static "default state" of each tab in both themes (10 PNGs). Form-state edge cases are covered by client-side JS unit tests, not visuals. |
| `<dialog>` element nested inside `[hidden]` tab panel might not call `showModal()` correctly because the dialog is in an `display:none` ancestor | Medium | Medium | Hoist all `<dialog>` elements to the top of `<main>` (siblings of the tab panels), not nested inside panels. Document this in `views/settings.tsx`. Integration test opens a modal from an inactive tab to confirm. |
| `ConfirmModal` primitive (TDD-035 §6.5.7) signature mismatch with what Edit Standard / Inspect Agent expects | Medium | Medium | Pin to PLAN-035-3 merge commit; require ConfirmModal PR landed before this PR opens. R-08 prop surface is binding. If the primitive's prop surface diverges, file a TDD-035 amendment, do not extend the primitive locally. |
| Live form validation in vanilla JS races against HTMX `hx-post` resulting in double error display | Low | Low | Vanilla JS validation only inserts a `field-error` span; HTMX response replaces the form region wholesale on submit. No race because validation is event-driven on `input`, not `submit`. |
| Stub agents `recentRuns` arrays overgrow and bloat HTML payload | Low | Low | Cap stub to 5 recentRuns per agent; modal renders only first 3. Document the cap in stub header. |
| Hidden `<dialog>` modals balloon initial HTML size when many agents/standards exist | Medium | Low | Acceptable trade-off vs. lazy-loading per TDD-036 §7 trade-off #5. Cap each table to 50 rows server-side; "view all" link is a follow-up. |
| Tab content and tab nav fall out of sync if a tab ID is renamed in only one place | Medium | Medium | Define tab IDs as a single `const TAB_IDS = ['general', 'variants', 'standards', 'backends', 'agents'] as const` and import everywhere (route validator, view, fragment). TypeScript catches drift. |
