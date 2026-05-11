# SPEC-037-7-04: Gate + timeline action wiring

## Metadata
- **Parent Plan**: PLAN-037-7
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Tasks Covered**: PLAN-037-7 §Scope items 7, 8, 9
- **Dependencies**: PLAN-037-2 (gate endpoints, `/api/requests/:id/action`);
  SPEC-037-7-03 (shared modal helper)
- **Estimated effort**: 0.5 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Verify that gate Approve / Request Changes / Reject buttons and the
RequestTimeline retry / skip / cancel buttons wire end-to-end to the
PLAN-037-2 endpoints, including the confirm-modal interstitial that
gate-actions.js mounts. Add the integration tests called for by
PLAN-037-7 §Scope item 9.

## Acceptance Criteria

1. `gate-detail.tsx` buttons (already `hx-post` to
   `/repo/:repo/request/:id/gate/{approve|request-changes|reject}`)
   are confirmed wired and reach the live route from PLAN-037-2. The
   integration test described below is the verification artifact.
2. `request-timeline.tsx` is extended so that completed/failed/skipped
   phases (where applicable) render `retry` and `skip` buttons in
   addition to the existing `Cancel` button for `in-progress` entries.
   Each button issues `hx-post` to `/api/requests/:id/action` with
   `hx-vals={"action":"<retry|skip|cancel>","phase":"<name>"}`. Irreversible
   actions (`skip`, `cancel`) carry `hx-confirm`. Reversible (`retry`)
   does not.
3. `static/gate-actions.js` continues to intercept gate buttons, open
   the shared confirm-modal (sourced from SPEC-037-7-03's modal helper)
   with action label + optional note textarea, and fire the HTMX
   request only on confirm. CSRF token attaches via `htmx:configRequest`.
4. The success response from a gate action OOB-swaps
   `#request-{id}-meta` and emits a toast (`.toast` element) confirming
   the action — matching kit `RequestDetail.jsx:14-18, 209`.
5. Failure response surfaces the existing degradation banner /
   field-error path; no silent failures.

## Implementation

**Files**
- `server/templates/fragments/gate-detail.tsx` — no markup change;
  validate against live endpoints.
- `server/templates/fragments/request-timeline.tsx` — add `retry` /
  `skip` action buttons next to `Cancel`. Use `hx-confirm` for
  destructive actions.
- `server/static/gate-actions.js` — confirm-modal flow uses
  `modal.js::openModal('confirm-gate')`; close on cancel; on confirm,
  set the textarea value as a header (`X-Gate-Note`) and dispatch
  `confirmed` to the originating button so HTMX fires.
- `server/templates/fragments/confirm-modal.tsx` — ensure the markup
  matches the new `.modal-bg`+`.modal` overlay (the confirm-modal
  fragment already exists; this SPEC consumes it).

## Tests

- `tests/integration/gate-action-flow.test.ts`: open Request Detail
  with `status === "gate"`, click Approve, confirm-modal opens, submit
  with note, POST `/repo/:repo/request/:id/gate/approve` is observed
  with `X-CSRF-Token` and `X-Gate-Note` headers, response OOB-swaps
  `#request-{id}-meta`, toast appears, modal closes. Repeat for
  Reject + Request Changes.
- `tests/integration/timeline-action-flow.test.ts`: failed phase
  shows `retry`; click → POST `/api/requests/{id}/action` with
  `{action:"retry", phase:"<name>"}`. Skip carries `hx-confirm`.
- `tests/fragments/request-timeline.test.ts`: retry button renders
  for `status === "failed"`; skip button renders for `status !==
  "in-progress" && status !== "complete"`; cancel renders only for
  `in-progress`.

## Verification

- `bun test tests/integration/gate-action-flow.test.ts tests/integration/timeline-action-flow.test.ts tests/fragments/request-timeline.test.ts` passes.
- Manual: gate Approve → modal → POST → OOB swap → toast end-to-end
  against the running portal with PLAN-037-2 endpoints mounted.
