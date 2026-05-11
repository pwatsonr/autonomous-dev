# SPEC-037-5-05: Standards Severity Chips + Edit Modal

## Metadata
- **Parent Plan**: PLAN-037-5-settings-tab-layouts
- **Parent TDD**: TDD-037-portal-kit-parity
- **Parent PRD**: PRD-018-portal-visual-redesign (PRD-013 — engineering standards)
- **Tasks Covered**: PLAN-037-5 Task 3 (Standards tab rebuild)
- **Estimated effort**: 0.5 day
- **Dependencies**: SPEC-037-5-06 (shared Modal helper), PLAN-037-2 (`PUT /api/standards/:id`)
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Update the Standards tab table to render severity-coloured chips
(`chip sev-blocking`, `chip sev-warn`, `chip sev-advisory`) in place of
the current `chip muted`, and add a per-row Edit button that opens a
shared Modal containing the rule's description / severity / applies
predicate (`Settings.jsx:114-141, 239-266`).

## Acceptance Criteria

| ID    | Criterion |
|-------|-----------|
| AC-01 | The Standards table swaps every `<span class="chip muted sm">` rendering a severity to `<span class={"chip sev-" + s.severity + " sm"}>{s.severity}</span>` (CSS classes already defined in `app.css:413-415`). |
| AC-02 | An additional `<th></th>` is appended and each row gains `<td><button class="btn sm" hx-get={"/api/standards/" + s.id + "/edit"} hx-target="#modal-slot">Edit</button></td>`. |
| AC-03 | The sec-head gains `<div class="head-actions"><span class="meta-mono dim">PRD-013</span><button class="btn sm primary" hx-get="/api/standards/new" hx-target="#modal-slot">+ Rule</button></div>`. |
| AC-04 | Server route `GET /api/standards/:id/edit` returns a Modal fragment with title `Standard / {id}` and a `<div class="form-grid">` containing three labelled fields: `Description` (input), `Severity` (select of `blocking|warn|advisory`), `Applies (predicate)` (input with `meta-mono`). |
| AC-05 | If `s.immutable === true`, every field in the modal renders `disabled`, the modal footer shows only `Cancel`, and a `<div class="dim small mt8">🔒 This rule is org-immutable; only org admins can edit.</div>` appears above the footer. |
| AC-06 | Mutable Edit modal footer renders `<div class="modal-foot"><button class="btn sm">Cancel</button><button class="btn sm primary" hx-put={"/api/standards/" + s.id} hx-include="closest .modal">Save</button></div>`. |
| AC-07 | The modal markup uses the shared `<Modal>` helper from SPEC-037-5-06 (`.modal-bg` + `.modal modal-wide`). |
| AC-08 | Row severity classes also propagate to `<tr class={"std-row sev-" + s.severity}>` to use the left-border accents from `app.css:532-534`. |

## Implementation

- Edit the existing Standards fragment (or inline block in
  `views/settings.tsx`) to:
  1. Append the Edit column.
  2. Swap the severity chip class.
  3. Add the `+ Rule` button to the sec-head.
  4. Apply `std-row sev-{severity}` to each `<tr>`.
- New server route file (or extension of an existing standards route):
  `GET /api/standards/:id/edit` → returns a `Modal` fragment.
- New server route: `PUT /api/standards/:id` accepting form-encoded
  `description`, `severity`, `applies`; 403 if `immutable`; 200 with
  the re-rendered Standards table fragment otherwise.
- The hoisted `#modal-slot` element is added to `views/settings.tsx`
  by SPEC-037-5-06 — this spec only emits HTMX targets at it.
- Concrete severity chip example:

  ```tsx
  <span class={`chip sev-${s.severity} sm`}>{s.severity}</span>
  ```

## Tests

- **Snapshot (`tests/snapshot/settings-standards-chips.test.ts`)**:
  render three rules covering all three severities. Assert each chip's
  class is exactly `chip sev-{severity} sm` and the row carries the
  matching `std-row sev-{severity}` class.
- **Integration (`tests/integration/standards-edit-modal.test.ts`)**:
  `GET /api/standards/:id/edit` returns a 200 fragment containing
  `.modal-bg` and a `<select>` with the rule's current severity
  pre-selected. For an immutable rule, every field is `disabled` and
  the Save button is absent.
- **Integration (`tests/integration/standards-put.test.ts`)**: `PUT`
  to a mutable rule with `severity=warn` returns 200; PUT to an
  immutable rule returns 403.

## Verification

- `bun test tests/snapshot/settings-standards-chips.test.ts tests/integration/standards-edit-modal.test.ts tests/integration/standards-put.test.ts` passes.
- Manual smoke: open `/settings?tab=standards`; observe severity
  chips render red/amber/blue; click Edit on a mutable rule, observe
  modal with editable fields; click Edit on `🔒` rule, observe
  read-only modal.
