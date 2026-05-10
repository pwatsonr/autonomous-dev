# SPEC-036-4-04: Settings Costs Tab

## Metadata
- **Parent Plan**: PLAN-036-4
- **Parent TDD**: TDD-036-portal-redesign-surfaces (v1.1, §6.5 General tab — cost cap)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-20: cost caps with live form validation)
- **Tasks Covered**: Cost-cap subset of PLAN-036-4 Task 5 (General tab) + PLAN-036-4 Task 11 (`form-validation.js`)
- **Estimated effort**: 0.5 day
- **Dependencies**: SPEC-035-2 (`Btn`, `Card`), SPEC-036-4-01 (route + tab shell)
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Render the Costs tab content within the Settings General panel: three
`type="number"` inputs for per-request cap, daily cap, and monthly cap
with `$` prefix decoration. Live validation runs on every `input` event
(client) and on POST (server). Validation is **bidirectional** — the
server-side `/api/settings/costs` POST is authoritative; the client
prevents most invalid submissions and renders inline `field-error`
spans matching the server's error contract.

## Acceptance Criteria

| ID    | Criterion |
|-------|-----------|
| AC-01 | The General panel includes a `Card` titled "Cost caps" with three labelled `<input type="number" min="0" step="0.01">` fields: `#cost-cap-per-request`, `#cost-cap-daily`, `#cost-cap-monthly`. Each input has a `$` prefix span and is initialized from `settings.costCaps`. |
| AC-02 | **Client-side validation** (`form-validation.js`): on `input` event for each cap field, run validators in order: (a) non-numeric → "must be a number"; (b) negative → "must be ≥ 0"; (c) per-request > daily or daily > monthly → "must be less than <next-cap-name>". Insert/update/remove a sibling `<span class="field-error">` accordingly. The Save button is disabled while any field-error is present. |
| AC-03 | **Server-side validation** (`POST /api/settings/costs`): same predicates as the client; on failure return 400 with a JSON body `{ errors: { fieldId: message }[] }`; HTMX re-renders the General panel with `field-error` spans matching the error contract. The server is authoritative — client validation is a pre-flight UX gate, not a security boundary. |
| AC-04 | A "Reset to defaults" `Btn kind="ghost"` resets all three inputs to compile-time defaults (per-request: 1.00, daily: 25.00, monthly: 500.00). Reset clears any field-errors. |
| AC-05 | The cap fields are wired into the existing HTMX `hx-post` flow used by the prior `SettingsEditor` (per PLAN-036-4 scope — re-skin only, persistence unchanged). The form's `hx-target` swaps the General panel only, never the tab nav. |
| AC-06 | A read-only "Current spend (today / this month)" row renders below the inputs as informational context; values come from `settings.currentSpend` and never participate in validation. |
| AC-07 | `form-validation.js` exports `validateCostCap(input)` as a named export so other tabs (and unit tests) can reuse the predicate without duplicating the boundary logic. |

## Implementation

- Markup inline in `views/settings.tsx` (the General-tab card). The three inputs share a `data-cost-cap-group` attribute that `form-validation.js` queries to discover them.
- Validators are pure functions in `static/js/form-validation.js`: `(value: string, context: { perRequest, daily, monthly }) => string | null` returning the error message or `null`.
- Server validator lives in `server/routes/settings.ts` next to the existing `SettingsEditor` POST handler.

## Tests

- **Client (`tests/clientside/form-validation.test.ts`)**: per the plan, fixture inputs `-5` → "must be ≥ 0"; `abc` → "must be a number"; `99999` (when monthly is `100`) → "exceeds monthly"; valid `42.50` → no error span. Cross-field: per-request `5` with daily `2` → "must be less than daily cap".
- **Server (`tests/integration/settings-costs.test.ts`)**: POST with `daily=-1` → 400; POST with `perRequest > daily` → 400; valid POST → 200 + re-render with no `field-error`.
- **Snapshot (`tests/snapshot/cost-caps-card.test.ts`)**: card with default values; card with all three fields in error.

## Verification

- `bun test` for the three test files passes.
- Manual smoke: enter `-1` in daily-cap, observe inline error and Save disabled; enter valid value, error clears, Save enabled; submit, observe HTMX swap with success indicator. Force a server-only failure by editing the request via DevTools (e.g. send `daily="abc"` bypassing client) — observe 400 + inline error rendered from the server response.
