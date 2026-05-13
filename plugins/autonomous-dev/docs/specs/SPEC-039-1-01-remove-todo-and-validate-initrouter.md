# SPEC-039-1-01: Remove TODO and validate initRouter

## Metadata
- **Parent Plan**: PLAN-039
- **Parent TDD**: TDD-038
- **Parent PRD**: PRD-019
- **Tasks Covered**: PLAN-039 TASK-001, TASK-005
- **Dependencies**: none
- **Estimated effort**: 2.5 hours
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-11

## Objective

Remove the `TODO(PLAN-011-1)` comment in `cli_adapter.ts` and verify that `initRouter()` correctly constructs an `IntakeRouter` when `claudeClient`, `duplicateDetector`, and `injectionRules` are undefined. The TDD review (TDD-038 §6.2) confirmed that `initRouter()` already passes `undefined` for the three optional dependencies, so this is purely a comment removal plus regression-grade unit tests for graceful degradation.

## Acceptance Criteria

1. (AC-038-01) `initRouter()` resolves without throwing when all three optional deps are undefined.
2. (AC-038-02) Submit handler uses the raw description as the title when `claudeClient` is undefined (no NLP).
3. (AC-038-03) Submit handler accepts duplicate descriptions when `duplicateDetector` is undefined (skip dedup).
4. `TODO(PLAN-011-1)` comment removed from `intake/adapters/cli_adapter.ts` (lines 843-844 and 879 per current source).
5. `bun run build:cli` succeeds after changes.
6. `git grep "TODO.*PLAN-011-1"` returns no matches across the plugin.

## Implementation

**Files modified**
- `plugins/autonomous-dev/intake/adapters/cli_adapter.ts` — remove the two `TODO(PLAN-011-1)` blocks; do NOT change `initRouter()`'s functional body. Per TDD §6.2 the existing `undefined` values for the three optional deps are correct.

**Contract preservation**
- Public signature unchanged: `export async function initRouter(): Promise<IntakeRouterLike>`.
- Behavioral contract unchanged: returned router instance accepts the same verbs as before.

## Tests

**Files created**
- `plugins/autonomous-dev/intake/__tests__/unit/cli_adapter_initrouter.test.ts`

**Test cases**
1. `initRouter_with_undefined_deps` — router resolves; instance is non-null; no exception (AC-038-01).
2. `submit_skips_nlp` — description text equals title when `claudeClient` is undefined (AC-038-02).
3. `submit_skips_dedup` — two identical descriptions both succeed when `duplicateDetector` is undefined (AC-038-03).
4. `submit_skips_injection_rules` — submission with bracket characters proceeds when `injectionRules` is undefined.

## Verification

- `bun run typecheck`
- `bun run build:cli`
- `bun test intake/__tests__/unit/cli_adapter_initrouter.test.ts`
- `git grep "TODO.*PLAN-011-1"` returns nothing.
