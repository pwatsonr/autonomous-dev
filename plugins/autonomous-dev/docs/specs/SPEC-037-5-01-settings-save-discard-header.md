# SPEC-037-5-01: Settings Save / Discard Header

## Metadata
- **Parent Plan**: PLAN-037-5-settings-tab-layouts
- **Parent TDD**: TDD-037-portal-kit-parity
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Tasks Covered**: PLAN-037-5 Task 6 (Save/Discard header + dirty-tracking JS)
- **Estimated effort**: 0.5 day
- **Dependencies**: SPEC-036-4-01 (Settings route + tab shell), PLAN-037-2 (settings POST endpoint)
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Render a kit-style `page-head` for `/settings` with paired `Discard` and
`Save` buttons in `head-actions`. Introduce `settings-dirty.js`, a small
opt-in module that tracks dirty form fields, enables/disables the
buttons, and serialises the delta on Save.

## Acceptance Criteria

| ID    | Criterion |
|-------|-----------|
| AC-01 | `views/settings.tsx` renders `<div class="page-head"><h1>Settings</h1><div class="head-actions">…</div></div>` matching `Settings.jsx:15-21`. |
| AC-02 | `head-actions` contains `<button class="btn" data-action="discard">Discard</button>` and `<button class="btn primary" data-action="save" hx-post="/settings" hx-include="[data-dirty-tracking] :is(input,select,textarea)" hx-target="#settings-root" hx-swap="outerHTML">Save</button>`. |
| AC-03 | Both buttons render with `disabled` attribute on initial load (no dirty fields). |
| AC-04 | The settings form container carries `data-dirty-tracking` so the module scopes its DOM queries. |
| AC-05 | `settings-dirty.js` (new module under `server/static/js/`) listens for `input` and `change` on `[data-dirty-tracking]`, marks the originating field with `data-dirty="true"`, and toggles `disabled` on both `[data-action="discard"]` and `[data-action="save"]` based on whether any descendant is dirty. |
| AC-06 | Clicking Discard restores each `data-dirty="true"` field to its `defaultValue` / `defaultChecked` / `defaultSelected`, removes the `data-dirty` flag, and re-disables the buttons. |
| AC-07 | After a successful HTMX swap (`htmx:afterSwap` targeting `#settings-root`), the module re-initialises against the swapped fragment so dirty state is reset. |
| AC-08 | Module is opt-in: if no `[data-dirty-tracking]` container exists on the page, the script is a no-op (`querySelector` returns null, return early). |

## Implementation

- `views/settings.tsx` adds the page-head block above the existing
  `SettingsTabs` invocation and wraps the panel grid in
  `<div id="settings-root" data-dirty-tracking>…</div>`.
- New module: `plugins/autonomous-dev-portal/server/static/js/settings-dirty.js`.
  Exposes `window.SettingsDirty = { init(root), reset(root) }`. The
  module is loaded as a `<script>` tag from the Settings view template
  alongside `settings-tabs.js`.
- Discard uses each control's `defaultValue` (HTMLInputElement),
  `defaultChecked` (radio/checkbox), and `defaultSelected` on
  `<option>` elements — no roundtrip to the server.
- Save delegates to HTMX (`hx-post="/settings"`), so the existing
  POST route in PLAN-037-2 receives the form-encoded payload. The
  `hx-include` selector limits the body to fields inside the tracked
  container.
- Keep `settings-tabs.js` untouched — the modules are independent.

## Tests

- **Snapshot (`tests/snapshot/settings-page-head.test.ts`)**: render
  `SettingsView` and assert the `page-head` block, both button labels,
  and `disabled` on initial render.
- **Clientside (`tests/clientside/settings-dirty.test.ts`)**: jsdom
  harness — load the module, type into an input, assert
  `data-dirty="true"` on the field and that both buttons become
  enabled. Click Discard, assert the field reverts and buttons
  re-disable.
- **Integration (`tests/integration/settings-save.test.ts`)**: POST
  `/settings` with one changed field, expect 200 and the response
  fragment to omit `data-dirty` flags.

## Verification

- `bun test tests/snapshot/settings-page-head.test.ts tests/clientside/settings-dirty.test.ts tests/integration/settings-save.test.ts` passes.
- Manual smoke: change a field, observe both buttons enable; press
  Discard, observe revert; change a field and press Save, observe
  network POST and re-disabled state after swap.
