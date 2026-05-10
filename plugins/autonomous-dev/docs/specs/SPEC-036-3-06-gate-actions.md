# SPEC-036-3-06: Gate Actions — Approve / Request Changes / Reject

## Metadata
- **Parent Plan**: PLAN-036-3
- **Parent TDD**: TDD-036-portal-redesign-surfaces (§6.2 "Gate detail
  card", OI-004)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-17)
- **Tasks Covered**: PLAN-036-3 Task 7 (gate-detail action wiring)
- **Dependencies**: SPEC-035-2 (primitives — `Btn`), SPEC-035-3
  (`ConfirmModal` helper from KillSwitch SPEC), SPEC-036-3-03 (gate-
  detail surface)
- **Estimated effort**: 0.5 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Wire the three gate action buttons on the gate detail card —
**Approve**, **Request Changes**, **Reject** — to the existing approval
HTTP handlers via HTMX with CSRF protection. Each action passes through
the shared `ConfirmModal` helper from SPEC-035-3 (originally specced for
KillSwitch). Out of scope: the approval workflow logic itself; only the
re-skinned button surface and confirm flow.

## Acceptance Criteria

1. The gate detail card from SPEC-036-3-03 renders three action buttons:
   - **Approve**: `<Btn kind="primary" size="sm">`.
   - **Request Changes**: `<Btn kind="secondary" size="sm">`.
   - **Reject**: `<Btn kind="destructive" size="sm">`.
2. Each button is HTMX-driven:
   - `hx-post="/repo/${repo}/request/${id}/gate/${action}"`
   - `hx-target="#request-${id}-meta"` (OOB swap on the meta region).
   - `hx-headers='{"X-CSRF-Token": "${csrfToken}"}'`.
   - `hx-confirm` is NOT used — confirmation is via `ConfirmModal`.
3. Click handler (vanilla JS module
   `static/js/gate-actions.js`) intercepts the click, opens the shared
   `ConfirmModal` populated with action-specific copy:
   - Approve → title "Approve gate?", body summarizing the gate type,
     confirm label "Approve", `confirmKind="primary"`.
   - Request Changes → title "Request changes?", body prompting for a
     short reason (textarea inside the modal), confirm label "Send",
     `confirmKind="secondary"`.
   - Reject → title "Reject request?", body warning about
     irreversibility, confirm label "Reject", `confirmKind="destructive"`.
4. On modal confirm, the original HTMX request is fired with the
   payload (for Request Changes, the textarea value is included as
   `reason` form field).
5. CSRF token is read from the `<meta name="csrf-token">` rendered by
   the layout shell (SPEC-035-1). All three actions include it.
6. Server handlers exist already; this SPEC asserts only that the routes
   `POST /repo/:repo/request/:id/gate/{approve,request-changes,reject}`
   continue to accept the existing payload shape (no breaking change).
7. Modal Escape and backdrop dismiss cancel the action (no HTMX request
   fired).

## Implementation

**Files**
- `server/templates/fragments/gate-detail.tsx` — extended (from
  SPEC-036-3-03) to emit the three buttons with the HTMX attributes
  above.
- `server/static/js/gate-actions.js` — new module: binds click on
  `[data-gate-action]` buttons, opens `ConfirmModal` with action-keyed
  copy, on confirm dispatches the deferred HTMX request.
- Reuses `ConfirmModal` from SPEC-035-3 — no new modal markup here.

**CSRF**
The layout shell already emits `<meta name="csrf-token" content="…">`
(SPEC-035-1). The JS module reads it once on `DOMContentLoaded` and
attaches it to every HTMX request via `htmx:configRequest` listener.

## Tests

- `tests/clientside/gate-actions.test.ts`: jsdom click on Approve opens
  modal; confirm fires HTMX request with CSRF header; Escape cancels.
- `tests/integration/gate-actions.test.ts`: each button renders correct
  variant; Request Changes modal includes textarea; CSRF meta present.
- `tests/security/gate-actions-csrf.test.ts`: requests without CSRF
  token are rejected by the existing handler (regression-style assert).

## Verification

- `bun test tests/clientside/gate-actions.test.ts tests/integration/gate-actions.test.ts tests/security/gate-actions-csrf.test.ts` passes.
- Manual: trigger gate state, click each action, confirm modal copy
  matches, observe HTMX OOB swap on `#request-${id}-meta`.
