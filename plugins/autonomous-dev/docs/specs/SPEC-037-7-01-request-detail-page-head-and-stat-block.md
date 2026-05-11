# SPEC-037-7-01: Request Detail page-head and `.rd-stat` block

## Metadata
- **Parent Plan**: PLAN-037-7
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Tasks Covered**: PLAN-037-7 §Scope items 1, 2, 3
- **Dependencies**: SPEC-035-2 (Btn primitive); kit `RequestDetail.jsx:22-53`
- **Estimated effort**: 0.5 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Bring `/repo/:repo/request/:id` to kit parity by adding the page-head row
(`← Back`, request id in `meta-mono`, `Pause` / `Kill` action buttons)
above the request header, plus the right-column `.rd-stat` block of three
mono numeric cells (cost / turns / score) inside the existing `.rd-head`
flex layout. Also render `started <timestamp>` as the final segment of
the `.rd-meta` row.

## Acceptance Criteria

1. A new fragment `server/templates/fragments/request-page-head.tsx`
   emits a `<div class="page-head">` containing:
   - `<div class="back-row">`: a `<button class="back">← Back</button>`
     that links to `/` (use plain anchor `<a>` styled as button for
     no-JS navigation; the `hx-get="/"` path is acceptable too) and
     `<span class="r-id meta-mono">{request.id}</span>`.
   - `<div class="head-actions">`: a `<Btn>Pause</Btn>` and
     `<Btn kind="danger">Kill</Btn>`. Buttons render with
     `data-request-action="pause" | "kill"` and `disabled` is omitted —
     POST handlers are deferred (PLAN-037-7 Out of Scope).
2. `request-header.tsx` is extended so `.rd-head` becomes a 2-column
   flex with `.rd-stat` on the right. `.rd-stat` contains three `<div>`
   cells; each cell has `<span class="rd-stat-num">…</span>` over
   `<span class="rd-stat-lbl">…</span>`. Values come from
   `request.cost` (formatted `$X.XX`), `request.turns`, `request.score`.
3. `.rd-meta` gains a final `<span class="meta-mono">started {started}</span>`
   segment preceded by a `dot-sep`. `request.startedAt` (ISO string) is
   formatted via the existing compact-timestamp helper; when undefined,
   the segment is omitted (no trailing dot-sep).
4. `RequestRecord` (`server/types/render.ts`) gains optional fields
   `cost: number`, `turns: number`, `score: number`, `startedAt: string`.
   All optional and default to `0` / `""` for backward compatibility.
5. Snapshot of the rendered view matches kit `RequestDetail.jsx:22-53`
   class-for-class.

## Implementation

**Files**
- `server/types/render.ts` — extend `RequestRecord`.
- `server/templates/fragments/request-page-head.tsx` — new fragment.
- `server/templates/fragments/request-header.tsx` — add `.rd-stat`
  right column to `.rd-head`; append `started` segment to `.rd-meta`.
- `server/templates/views/request-detail.tsx` — mount `RequestPageHead`
  above `RequestHeader`.
- `server/stubs/requests.ts` — populate `cost`, `turns`, `score`,
  `startedAt` for the fixture request(s).

**Formatting**
`formatCost(n)` returns `$${n.toFixed(2)}`. Render server-side; do not
emit `Intl.NumberFormat` calls from JSX.

## Tests

- `tests/fragments/request-page-head.test.ts`: emits `.page-head` with
  `.back-row` + `.head-actions`; back button has correct href; Pause +
  Kill buttons present.
- `tests/fragments/request-header.test.ts`: snapshot covers new
  `.rd-stat` block; values rendered when present; `started` segment
  appears iff `startedAt` is set; backward-compatible without new
  fields.

## Verification

- `bun test tests/fragments/request-page-head.test.ts tests/fragments/request-header.test.ts` passes.
- Manual visual: page-head matches kit; right-column stat cells align.
