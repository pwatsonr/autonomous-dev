# SPEC-036-3-01: Request Detail Route + Column Layout

## Metadata
- **Parent Plan**: PLAN-036-3
- **Parent TDD**: TDD-036-portal-redesign-surfaces (§6.2)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-17)
- **Tasks Covered**: PLAN-036-3 Task 9 (route + view rewrite)
- **Dependencies**: SPEC-035-2 (primitives), SPEC-035-3 (ConfirmModal/KillSwitch)
- **Estimated effort**: 0.5 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Stand up the `GET /repo/:repo/request/:id` route handler at
`server/routes/request-detail.tsx` and rewrite the matching view template
`templates/views/request-detail.tsx` as the column-layout composition root
that hosts all 11 conditionally-rendered regions defined in TDD-036 §6.2.
This SPEC owns the route plumbing, region ordering, and SSE channel
attribute wiring; sister SPECs (036-3-02..06) own the individual region
fragments.

## Acceptance Criteria

1. `GET /repo/:repo/request/:id` resolves a `RequestDetail` from the
   stub/daemon loader, sets cache-control `no-store`, and renders the
   layout shell from SPEC-035-1 with the request-detail view as `main`.
2. The view emits regions in this exact DOM order: back row + page head,
   request header, pipeline visualization, **artifact pane**, reviewer
   chain, deploy pipeline, gate detail, standards applied, **run
   history**, confirm modal, phase artifact modal.
3. Each conditional region renders only under its trigger predicate per
   TDD-036 §6.2 table. Unconditional regions (header, pipeline, artifact
   pane, run history) always render; the artifact pane and run history
   self-handle their empty cases (delegated to SPEC-036-3-02 / -05).
4. SSE channel attributes are present on the matching region root nodes
   exactly: `id="request-${id}-meta"`, `request-${id}-phase`,
   `request-${id}-artifact`, `request-${id}-deploy`. OOB swap target IDs
   are stable.
5. 404 is returned when the request ID is unknown; the response body uses
   the layout shell's standard 404 partial.
6. Visual regression snapshots pass for 4 phase variants (`prd`,
   `review`, `deploy`, `code-with-gate`) × 2 themes = 8 images.

## Implementation

**File: `plugins/autonomous-dev-portal/server/routes/request-detail.tsx`**
- Hono route handler. Reads `:repo` and `:id` from params, calls
  `loadRequestDetail({ repo, id })`, branches to 404 view on miss.
- Composes `<Layout>` (SPEC-035-1) wrapping `<RequestDetailView />`.

**File: `plugins/autonomous-dev-portal/server/templates/views/request-detail.tsx`**
- Pure composition: imports each fragment from `fragments/*` and emits
  regions in order. Conditional rendering uses straight ternary on
  `request.phase`, `request.status`, and `request.flags` — no logic
  duplicated from fragments.
- The 11-region order is fixed; reviewers diff against this SPEC's table.

**Wiring**
- The fragments themselves import their own primitives. This view does
  no styling beyond a single wrapper `<main class="request-detail">`.

## Tests

- `tests/integration/request-detail.test.ts`: route resolution (200 +
  shell), 404 path, region-ordering DOM assertion.
- `tests/visual/request-detail.visual.test.ts`: 4 phase variants × 2
  themes (Playwright).

## Verification

- `bun test tests/integration/request-detail.test.ts` passes.
- `bun playwright test tests/visual/request-detail.visual.test.ts` passes.
- Manual: `bun run dev`, visit `/repo/example-repo/request/req-001`,
  confirm shell + all unconditional regions render.
