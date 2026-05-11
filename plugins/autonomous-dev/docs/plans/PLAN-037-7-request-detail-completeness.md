# PLAN-037-7: Request Detail completeness

## Metadata
- **Parent**: PLAN-037-portal-kit-parity
- **Effort**: 2 days
- **Dependencies**: [PLAN-037-2] (gate action endpoints)
- **Priority**: P2 (less-trafficked surface; lower visual delta than Approvals/Settings)

## Objective

`/repo/:repo/request/:id` is missing the page-head, the right-column `.rd-stat` block (cost / turns / score cells), the standards-applied section (`.std-list`), and several kit details. Gate action buttons (Approve / Request Changes / Reject) `hx-post` to endpoints that 404. The phase-artifact modal uses `<dialog>` instead of the kit's `.modal-bg`+`.modal` overlay.

## Scope

### In Scope

1. **Add page-head** with `← Back` (link to `/`) + request id + Pause/Kill buttons. Match kit `RequestDetail.jsx:22-31`.
2. **Add `.rd-stat` right column** — 3 stat cells showing total cost, turns, latest score with the kit's mono numeric treatment.
3. **Render `started <timestamp>`** in the meta row.
4. **Render Standards-applied section** as `.std-list` of `.std-row.sev-{blocking|warn|advisory}` cards when `request.flags.hasStandards`. Match kit `RequestDetail.jsx:149-167`.
5. **Refactor phase-artifact modal** — replace `<dialog>` with `.modal-bg` overlay so kit CSS classes resolve. Provide shared modal helper (overlap with PLAN-037-5 Settings modals; coordinate so both use the same helper).
6. **Trim non-kit details** (or document them as intentional v1.1 extensions):
   - `<ul class="rev-dims">` per-dimension score sub-rows — leave but mark `<!-- v1.1 extension -->`
   - `<ol class="request-timeline">` and `<section class="run-history">` — leave but add inline CSS in `app.css` for `.timeline-entry / .status-icon` to avoid unstyled appearance.
7. **Wire gate actions** — buttons already `hx-post` to `/repo/:repo/request/:id/gate/{approve,request-changes,reject}`. The endpoints exist in PLAN-037-2 — verify integration here.
8. **Wire request-timeline retry/skip actions** to `/api/requests/:id/action` (PLAN-037-2 endpoint).
9. **Tests**: snapshot test for the new page-head + .rd-stat; integration test for gate-action confirm-modal flow end-to-end.

### Out of Scope
- Real artifact-content fetching (PRD/TDD/diff text) — current stub data is acceptable; live wiring is a separate plan.
- Pause / Kill action implementation — buttons render but POST handlers are deferred.

## Verification
- Visual match to `/tmp/portal-design-v2/autonomous-dev-design-system/project/ui_kits/portal/RequestDetail.jsx`.
- Gate Approve / Reject buttons complete end-to-end (with PLAN-037-2 endpoints merged).
- Standards-applied section renders when request has standards hits; hidden when not.

## Tests
- Unit: page-head shape, rd-stat shape, std-list shape.
- Integration: gate-action confirm-modal → POST → success fragment.

## Risks
| Risk | Mitigation |
|---|---|
| Modal helper API conflicts between Settings and RequestDetail | Land helper first via PLAN-037-5; this plan consumes it |
| Standards data shape doesn't match kit | Extend `StandardsHit` type with severity + applied-by fields if needed |
