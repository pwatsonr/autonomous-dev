# SPEC-036-3-04: Reviewer Chain Detail + Per-Dimension Scores

## Metadata
- **Parent Plan**: PLAN-036-3
- **Parent TDD**: TDD-036-portal-redesign-surfaces (§6.2 "Reviewer
  chain")
- **Parent PRD**: PRD-018-portal-visual-redesign (R-17)
- **Tasks Covered**: PLAN-036-3 Task 7 (reviewer-chain),
  PLAN-036-3 Task 7 (deploy-pipeline)
- **Dependencies**: SPEC-035-2 (primitives — `Chip`, `Score`)
- **Estimated effort**: 0.75 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Implement the expanded **reviewer chain** region (rendered when
`phase ∈ {review, code}`) and the sibling **deploy pipeline** region
(rendered when `phase === 'deploy'`). The reviewer chain shows per-
reviewer cards with rubric-level dimensions visualized via the `Score`
primitive from SPEC-035-2. The deploy pipeline mirrors the top-level
pipeline-vis pattern but for the deploy stages.

## Acceptance Criteria

1. `fragments/reviewer-chain.tsx` renders only when `request.phase ∈
   {review, code}`. The container is a CSS grid of reviewer cards.
2. Each reviewer card shows: reviewer name, agent version (`meta-mono`),
   blocking/passing state via `Chip variant="status"`, and a list of
   rubric dimensions each rendered with the `Score` primitive
   (numerator/denominator/tone per the score's pass/block state).
3. Each rubric dimension links to the corresponding reviewer agent run
   via `<a href="/agents/${reviewerName}/runs/${runId}">` so an operator
   can drill into the specific reviewer execution.
4. `fragments/deploy-pipeline.tsx` renders only when `phase === 'deploy'`.
   It emits a horizontal flex strip of `deploy-step` elements with the
   same three visual states (`done` / `now` / `pending`) as pipeline-vis,
   keyed off the request's deploy stage.
5. Empty / missing reviewer data: when the reviewer set is empty (no
   reviewers configured for the phase), the region renders an
   `EmptyState noun="reviewers"` row inside the section card so the
   region remains visually anchored.
6. Reviewer card layout mirrors `RequestDetail.jsx` from the kit
   pixel-faithfully (per TDD-036 §5.2 mapping); both light and dark
   themes pass visual regression.

## Implementation

**Files**
- `server/templates/fragments/reviewer-chain.tsx` — grid of reviewer
  cards, each card composes `Chip` + `Score` primitives and the agent-
  run link.
- `server/templates/fragments/deploy-pipeline.tsx` — horizontal stage
  strip; reuses the `pipe-step` styling token namespace from SPEC-036-3-
  03.

**Score wiring**
Reviewer rubric dimensions are sourced from
`request.reviewers[].dimensions` (existing data shape). Each entry maps
to a `<Score num={n} den={d} tone={...} />` invocation. Tone is
determined server-side by comparing num/den against the rubric pass
threshold.

## Tests

- `tests/fragments/reviewer-chain.test.ts`: renders only for `phase ∈
  {review, code}`; Score primitives present per dimension; agent-run
  links well-formed; empty reviewer set yields `EmptyState`.
- `tests/fragments/deploy-pipeline.test.ts`: renders only for `phase ===
  'deploy'`; stage state classes correctly applied per current stage.

## Verification

- `bun test tests/fragments/reviewer-chain.test.ts tests/fragments/deploy-pipeline.test.ts` passes.
- Visual snapshots covered transitively by SPEC-036-3-01's `review` and
  `deploy` phase variants.
