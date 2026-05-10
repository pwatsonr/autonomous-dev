# SPEC-035-2-01: `primitives.tsx` Skeleton — Shared Imports, Type Exports, JSDoc Convention

## Metadata
- **Parent Plan**: PLAN-035-2 (Primitive Components)
- **Parent TDD**: TDD-035 (Portal Redesign — Shell + Primitives), §6.5.0 ("API Authority")
- **Parent PRD**: PRD-018 (Portal Visual Redesign), R-08
- **Tasks Covered**: PLAN-035-2 Task 1 (file scaffolding), Task 10 (API authority documentation)
- **Estimated effort**: 0.2 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Create the empty-but-typed scaffold for `plugins/autonomous-dev-portal/server/components/primitives.tsx`: shared `hono/jsx` imports, the shared `StatusTone` and `PhaseName` type aliases consumed by multiple primitives, the file-level JSDoc block that pins the R-08 / TDD §6.5.0 prop API as the authoritative consumer contract, and named-export ordering. This skeleton is the file that SPEC-035-2-02 through -06 fill in; it must build (`tsc --noEmit` passes) immediately after this spec lands even though no primitives are implemented yet.

## Acceptance Criteria

1. `server/components/primitives.tsx` exists with `import type { FC } from "hono/jsx";` as the only runtime import.
2. The file's first non-import block is a JSDoc comment that:
   - References TDD-035 §6.5.0 ("API Authority") by name.
   - Lists the kit-prop → R-08-prop renames as a table: `kind` → `variant` (Chip), `n` → `value` (Score).
   - States: "Surface authors must use these prop names. The kit's original prop names are not supported."
3. Two shared type aliases are exported and used by later specs:
   - `export type StatusTone = "ok" | "warn" | "err" | "info" | "muted" | "brand";`
   - `export type PhaseName = "prd" | "tdd" | "plan" | "spec" | "code" | "review" | "deploy" | "observe";`
4. Named-export ordering is fixed (Btn, Chip, Dot, Score, CostRing, Card) so reviewer diffs stay deterministic across the six follow-up specs.
5. No default export. No re-exports from other modules. No hooks. No `useState`, `useEffect`, `useMemo`, `useRef`, or any client-only React API.
6. `tsc --noEmit` passes against the file with the two type exports present (consumed downstream).

## Implementation

**File**: `plugins/autonomous-dev-portal/server/components/primitives.tsx`

```tsx
/**
 * Primitive components — TDD-035 §6.5 / PRD-018 R-08.
 *
 * API AUTHORITY (TDD-035 §6.5.0): the prop signatures in this file are the
 * authoritative consumer contract for TDD-018-C surface adoption and all
 * future portal surface work. They supersede the design kit's prop names.
 *
 * Kit → R-08 renames:
 *   - Chip:  `kind` (kit) → `variant` (R-08)
 *   - Score: `n`    (kit) → `value`   (R-08)
 *
 * Surface authors must use these prop names. The kit's original prop names
 * are not supported and will not be accepted in code review.
 *
 * All components are pure Hono JSX function components: no hooks, no state,
 * no side effects (TDD §6.5 invariant).
 */

import type { FC } from "hono/jsx";

export type StatusTone = "ok" | "warn" | "err" | "info" | "muted" | "brand";
export type PhaseName =
    | "prd" | "tdd" | "plan" | "spec"
    | "code" | "review" | "deploy" | "observe";

// Btn — see SPEC-035-2-02
// Chip, Dot — see SPEC-035-2-03
// Score, CostRing — see SPEC-035-2-04
// Card — see SPEC-035-2-05
```

The placeholder comments preserve the export ordering pin from AC-4 until the follow-up specs replace them with real exports.

## Tests

- **Build gate**: `bunx tsc --noEmit` passes with the file present.
- **Lint gate**: file passes the existing `tsc`/`eslint` chain run by the portal's CI step.
- **Static asserts** (added by SPEC-035-2-02..-06 as primitives land — none required in this spec).

## Verification

- `grep -n "TDD-035 §6.5.0" server/components/primitives.tsx` returns exactly one match (the JSDoc anchor).
- `grep -nE "^export (type|const) " server/components/primitives.tsx` returns `StatusTone` and `PhaseName` in this spec; later specs append `Btn`, `Chip`, `Dot`, `Score`, `CostRing`, `Card` in that order.
- No `import { ... } from "react"` anywhere in the file (PRD-018 §4.5 — no React runtime).
- No `useState`, `useEffect`, or `use*` identifiers anywhere in the file (TDD §12.1 pre-flight assertion).
