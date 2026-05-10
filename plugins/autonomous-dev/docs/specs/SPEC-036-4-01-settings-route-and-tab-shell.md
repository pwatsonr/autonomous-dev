# SPEC-036-4-01: Settings Route + Tab Shell

## Metadata
- **Parent Plan**: PLAN-036-4
- **Parent TDD**: TDD-036-portal-redesign-surfaces (v1.1, §6.5)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-20)
- **Tasks Covered**: PLAN-036-4 Tasks 1, 3, 4, 13 (route handler + tab shell composition)
- **Estimated effort**: 1.0 day
- **Dependencies**: SPEC-035-2 (`Btn`, `Chip`, `Card` primitives), SPEC-035-3 (`ConfirmModal`)
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Implement `GET /settings?tab=<id>` route handler and the tab nav shell that
composes the five tab panels per TDD-036 §6.5. The server is solely
responsible for resolving the active tab from the query string and
emitting the `data-active-tab` attribute that the client-side JS
(SPEC-036-4-02) reads on `DOMContentLoaded`. All five panels render
server-side; non-active panels carry the `hidden` attribute so a JS-off
browser still shows the deep-linked tab.

## Acceptance Criteria

| ID    | Criterion |
|-------|-----------|
| AC-01 | A new route handler at `server/routes/settings.ts` reads `req.query.tab`, validates it against the constant `TAB_IDS = ['general', 'variants', 'standards', 'backends', 'agents'] as const`, and passes the resolved value as `activeTab` into the render props. Absent or invalid values resolve to `'general'`. |
| AC-02 | `types/render.ts` gains `SettingsData.activeTab: typeof TAB_IDS[number]` and the four new types `DeployBackend`, `AgentRecord`, `AgentRunRef`, `StandardRule` re-exports per TDD-036 §5.3. `bun tsc --noEmit` passes. |
| AC-03 | `fragments/settings-tabs.tsx` renders a `<nav class="seg seg-tabs" data-active-tab="<activeTab>">` containing five `<button class="seg-btn" data-tab="<id>">` elements; the button matching `activeTab` carries the `on` class. |
| AC-04 | `views/settings.tsx` composes page-head + the tab nav fragment + five sibling `<section data-tab-panel="<id>">` elements. The panel matching `activeTab` renders without `hidden`; the other four render with the `hidden` attribute. |
| AC-05 | All `<dialog>` modal elements (Edit Standard, Inspect Agent) are hoisted to top-level `<main>` siblings of the panel sections — never nested inside a `[hidden]` panel — to avoid `display:none` ancestors blocking `showModal()` (per PLAN-036-4 risk row 4). |
| AC-06 | Server-side validation: a request to `GET /settings?tab=../etc/passwd` returns HTML rendered with `activeTab='general'`; the `data-active-tab` attribute value is `general` and never echoes the raw query value. |
| AC-07 | Three `<script type="module" src="/static/js/...">` tags load `settings-tabs.js`, `form-validation.js`, and `settings-modals.js` at the bottom of the view. |

## Implementation

- Define `TAB_IDS` once in `server/types/render.ts` and import it in route handler, view, and tab-nav fragment so a typo cannot create drift (per PLAN-036-4 risk row 7).
- Route handler: `const tab = TAB_IDS.includes(raw) ? raw : 'general'`. No exceptions, no logging on invalid — the default is benign.
- Tab nav fragment is a pure function of `activeTab` — no side effects, no client-state coupling. Server emits the truth.
- View signature: `SettingsView({ activeTab, variants, standards, backends, agents, settings })` — `activeTab` is required and typed.

## Tests

- **Unit (`tests/unit/settings-route.test.ts`)**: `resolveActiveTab('standards') === 'standards'`; `resolveActiveTab('') === 'general'`; `resolveActiveTab('../foo') === 'general'`; `resolveActiveTab(undefined) === 'general'`. All five valid IDs round-trip.
- **Snapshot (`tests/snapshot/settings-tabs.test.ts`)**: render the tab-nav fragment for each of the five `activeTab` values; assert exactly one button has `class="seg-btn on"` and `data-active-tab` matches.
- **Integration (`tests/integration/settings.test.ts`)**: `GET /settings?tab=standards` returns HTML where the `[data-tab-panel="standards"]` element lacks the `hidden` attribute and the other four carry it. `GET /settings?tab=invalid` defaults to `general`. `GET /settings` (no query) defaults to `general`.

## Verification

- `bun tsc --noEmit` passes.
- `bun test plugins/autonomous-dev-portal/tests/unit/settings-route.test.ts` passes (5 cases).
- `bun test plugins/autonomous-dev-portal/tests/integration/settings.test.ts` passes the deep-link parity assertions for all five valid tab IDs plus invalid + missing.
- Manual smoke: `curl /settings?tab=variants | grep 'data-active-tab="variants"'` returns one match.
