# SPEC-036-4-03: Settings Trust Tab

## Metadata
- **Parent Plan**: PLAN-036-4
- **Parent TDD**: TDD-036-portal-redesign-surfaces (v1.1, §6.5 General tab — trust level)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-20: trust levels)
- **Tasks Covered**: Trust-level subset of PLAN-036-4 Task 5 (General tab)
- **Estimated effort**: 0.5 day
- **Dependencies**: SPEC-035-2 (`Btn`, `Chip`, `Card`), SPEC-035-3 (`ConfirmModal` for confirmation prompts), SPEC-036-4-01 (route + tab shell)
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Render the Trust tab content within the Settings General panel: a
4-radio control (`L0`, `L1`, `L2`, `L3`) for the global trust level
plus a per-repo overrides table whose rows let the operator select a
distinct trust level for any repo in the allowlist. Validation is
**bidirectional**: the server validates POSTs to `/api/settings/trust`
(authoritative), and the client validates `change` events on the radios
(UX-only — disables Save until inputs are consistent).

## Acceptance Criteria

| ID    | Criterion |
|-------|-----------|
| AC-01 | The General panel includes a `Card` titled "Trust level" containing four `<input type="radio" name="trust-level" value="L0|L1|L2|L3">` controls with labels and helper text per kit. The radio whose value matches `settings.trustLevel` carries `checked`. |
| AC-02 | A second `Card` titled "Per-repo overrides" renders a `<table class="tbl">` with columns: Repo, Override (`<select>` of L0–L3 + "inherit"), Source (mono), Action (`Btn kind="ghost" size="sm"` with `data-confirm` for reset). Empty state ("No overrides set") renders when `settings.trustOverrides.length === 0`. |
| AC-03 | **Server-side validation** (`POST /api/settings/trust`): trust level must be exactly one of `L0|L1|L2|L3`; per-repo overrides must reference a repo in `settings.allowlist` (else 400 with field error); response re-renders the General panel with `field-error` spans on invalid fields. |
| AC-04 | **Client-side validation** (`form-validation.js` extension): on radio `change`, set the form's data-state attribute; on per-repo `<select>` change, validate against the allowlist (already in DOM as a `<datalist>`) and insert a `<span class="field-error">` if the override targets a removed repo. The Save button is disabled while any field-error is present. |
| AC-05 | Reset-override action triggers a `ConfirmModal` ("Reset trust override for <repo>?") before POSTing; ESC and backdrop click dismiss without action. |
| AC-06 | Lowering the global trust level from L3 to L0–L1 triggers a `ConfirmModal` ("Lowering trust will require manual approval for more actions. Continue?") before submission. |
| AC-07 | All form fields have stable `id`s (`#trust-level-l0`, `#trust-override-<repo-slug>`) so `form-validation.js` can hook them without brittle selectors. |

## Implementation

- Trust level radios live inside the General tab panel; markup is co-located in `views/settings.tsx` (no dedicated fragment — small enough to inline per PLAN-036-4 Task 5).
- The override table is a `fragments/trust-overrides-table.tsx` for snapshot testability.
- Server validation reuses the existing `SettingsEditor` POST route (per PLAN-036-4 scope: re-skin only) but extends the validator to cover the per-repo overrides shape.
- Client validation predicates live in `form-validation.js` (SPEC-036-4-04 ships the module shell; this spec adds the trust-specific predicate).

## Tests

- **Snapshot (`tests/snapshot/trust-overrides-table.test.ts`)**: 0, 1, and 5 overrides; immutable repo (e.g. system repo) shows reset button disabled.
- **Server validation (`tests/integration/settings-trust.test.ts`)**: POST with `trustLevel='L9'` → 400; POST with override targeting unknown repo → 400 with `field-error` for that row; valid POST → 200 + re-render.
- **Client validation (`tests/clientside/form-validation-trust.test.ts`)**: radio change to L0 disables Save until ConfirmModal accepted; selecting an override for a deleted repo inserts a `field-error` span.

## Verification

- `bun test` for the three test files above passes.
- Manual smoke: change global trust L3→L0, observe ConfirmModal, accept, observe Save success; reset an override, observe ConfirmModal; submit invalid override via DevTools, observe 400 + inline error.
