# SPEC-036-3-05: Run History (v1.1) — Past Daemon Iterations Table

## Metadata
- **Parent Plan**: PLAN-036-3
- **Parent TDD**: TDD-036-portal-redesign-surfaces (§6.2 "Run history")
- **Parent PRD**: PRD-018-portal-visual-redesign (R-17)
- **Tasks Covered**: PLAN-036-3 Tasks 1, 2, 6
- **Dependencies**: SPEC-035-2 (primitives — `Chip`, `EmptyState`)
- **Estimated effort**: 0.5 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Implement the v1.1 **run history** region: an always-rendered (may be
empty) table of past daemon iterations that touched this request. The
region answers the operator question "what has the daemon done with this
request before now?" without leaving the surface. This SPEC owns the new
`RequestRunRef` type and the table fragment.

## Acceptance Criteria

1. `RequestRunRef` is added to `server/types/render.ts` with fields:
   `runId: string`, `timestamp: string` (ISO-8601 UTC), `phase: string`,
   `outcome: "pass" | "fail" | "block"`, `cost: number`.
   `RequestDetail.runs?: RequestRunRef[]` is added (optional,
   backward-compatible).
2. The fragment renders a `<section class="sec run-history">` with a
   section head: `<h2>Run history</h2>` and a `meta-mono dim` count
   (`${runs.length} runs`).
3. When `runs.length > 0`, render `<table class="tbl tight">` with
   columns in this exact order: `Run`, `Time`, `Phase`, `Outcome`,
   `Cost`. Cell renderers:
   - `Run`: `<td class="meta-mono">${runId}</td>` (monospace).
   - `Time`: `<td class="meta-mono dim">${timestamp}</td>` (ISO).
   - `Phase`: `<td><Chip variant="phase" tone={phase} /></td>`.
   - `Outcome`: `<td><Chip variant="status" tone={outcomeTone(outcome)}>{outcome}</Chip></td>`.
   - `Cost`: `<td class="meta-mono">$${cost.toFixed(2)}</td>`.
4. `outcomeTone()` maps `pass → "ok"`, `fail → "err"`, `block → "warn"`
   (TDD-036 §6.2 mapping).
5. Rows are sorted by `timestamp` descending (most recent first) before
   rendering.
6. When `runs` is empty or undefined, the table is replaced by
   `<EmptyState noun="prior runs" />` from SPEC-035-2.
7. Server-side cap: `runs` is sliced to the last 50 entries before
   render (per PLAN-036-3 risk mitigation row).
8. Stub fixture `stubs/requests.ts` carries 5–8 runs spanning multiple
   past phases with mixed outcomes so the table renders out of the box.

## Implementation

**Files**
- `server/types/render.ts` — extend with `RequestRunRef` and optional
  `RequestDetail.runs`.
- `server/templates/fragments/run-history.tsx` — table fragment per
  TDD-036 §6.2 markup verbatim.
- `server/stubs/requests.ts` — populate `runs` per stub.
- Daemon loader (real-data path): sourced from the daemon's iteration
  history per TDD-036 §6.2. Stub loader supplies representative data
  per NG-3606; wiring to real daemon storage is an explicit follow-up.

**Outcome tone helper** lives next to the fragment as a small pure
function for unit-testability:
```ts
const outcomeTone = (o: "pass" | "fail" | "block"): "ok" | "err" | "warn" =>
    o === "pass" ? "ok" : o === "fail" ? "err" : "warn";
```

## Tests

- `tests/fragments/run-history.test.ts`: renders 5+ rows when populated;
  empty array yields `EmptyState`; outcome tone mapping correct;
  rows sorted desc by timestamp; 50-row cap applied at boundary.

## Verification

- `bun test tests/fragments/run-history.test.ts` passes.
- Empty case asserted in SPEC-036-3-01's integration suite (`runs=[]`).
