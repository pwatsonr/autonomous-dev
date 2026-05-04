# SPEC-032-1-01: Cost-Cap Call-Site Inventory and `RunDeployArgs.actor` Plumbing

## Metadata
- **Parent Plan**: PLAN-032-1 (Cost-Cap Dual-Path Migration)
- **Parent TDD**: TDD-032 §5.1 (WS-1)
- **Parent PRD**: PRD-017 (FR-1701, FR-1702)
- **Tasks Covered**: PLAN-032-1 Task 1 (call-site inventory), Task 2 (`actor` field), Task 3 (enforcer factory)
- **Estimated effort**: 1.25 days
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-032-1-01-cost-cap-call-site-inventory-and-runtime-args.md`

## Summary
Establish the migration prerequisites for the orchestrator-side cost-cap
dual-path resolution (TDD-032 §5.1). Three artifacts ship: (1) a one-shot
audit CSV documenting every legacy `cost-cap.ts` call-site so the
deletion in SPEC-032-1-04 cannot orphan a caller, (2) a required
`actor: string` field on `RunDeployArgs` so the new
`CostCapEnforcer.maybeStickyWarn` can attribute soft warnings to the
correct principal, and (3) a memoized `getOrCreateCostCapEnforcer(requestDir)`
helper inside the orchestrator that lazily constructs an enforcer
backed by the shared `CostLedger`.

This spec ships zero behavior change at runtime. The enforcer is wired
up but not yet *invoked* — SPEC-032-1-02 performs the actual
`enforcer.check()` cutover. Sequencing this way keeps each PR
atomically revertable.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/intake/deploy/orchestrator.ts` | Modify | Add `actor` to `RunDeployArgs`; add `getOrCreateCostCapEnforcer` helper |
| `plugins/autonomous-dev/tests/deploy/test-orchestrator-cost-cap.test.ts` | Create | Memoization test for the new helper |
| `tmp/plan-032-1-call-sites.csv` | Create (audit aid; NOT committed) | One row per legacy call site; deleted before commit |

The CSV is generated locally and used to inform SPEC-032-1-04's
deletion step. It is explicitly NOT shipped in tree (PRD-017 NG-02).

## Functional Requirements

| ID | Requirement | Task |
|----|-------------|------|
| FR-1 | Implementer MUST `git grep` for `checkCostCap`, `recordCost`, `readTodayLedger`, `__setCostCapDayForTest`, `from './cost-cap'`, `from "../cost-cap"` across `plugins/autonomous-dev/**` and the four cloud deploy plugins. | T1 |
| FR-2 | The CSV produced from FR-1 MUST contain one row per match with columns `file,line,symbol,is_production`. | T1 |
| FR-3 | `RunDeployArgs` MUST gain a required `actor: string` field with JSDoc identifying it as the principal used by `CostCapEnforcer.maybeStickyWarn`. | T2 |
| FR-4 | The supervisor caller of `runDeploy(...)` MUST be updated to pass the approval-state actor through. `tsc --noEmit` MUST be clean. | T2 |
| FR-5 | A private module-level helper `getOrCreateCostCapEnforcer(requestDir: string): CostCapEnforcer` MUST exist in `orchestrator.ts`, memoized per `requestDir`. | T3 |
| FR-6 | The helper MUST construct the enforcer with `ledger: getLedger(requestDir)`, `config: () => loadCostCapConfig(requestDir)`, and an `escalate` sink delegating to the existing orchestrator escalation sink. | T3 |
| FR-7 | The helper MUST be unexported (private to the orchestrator module). | T3 |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| Type safety | `tsc --noEmit` exit code 0 | `cd plugins/autonomous-dev && npx tsc --noEmit` |
| Memoization correctness | Same `CostCapEnforcer` instance returned for identical `requestDir` within one process | Unit test asserts `===` instance equality across two helper calls |
| Public API surface delta | Zero (helper is module-private) | Verified by `grep -n 'export' orchestrator.ts` diff |
| Test count regression | Pass count strictly non-decreasing | `npm test` baseline diff (TG-06) |

## Technical Approach

### `RunDeployArgs.actor`

Locate the existing `RunDeployArgs` interface in
`plugins/autonomous-dev/intake/deploy/orchestrator.ts`. Add:

```ts
export interface RunDeployArgs {
  // ... existing fields ...
  /**
   * Principal initiating the deploy (per-request).
   * Used by `CostCapEnforcer.maybeStickyWarn` to attribute the
   * 80% sticky soft-warning per actor/day. Sourced from approval state.
   */
  actor: string;
}
```

Update the supervisor caller (single known caller; confirm via FR-1
inventory) to pass `actor: approvalState.actor` (or the equivalent
field name discovered during exploration). Existing orchestrator tests
that construct a `RunDeployArgs` literal MUST be updated to include
`actor: 'test-actor'` (or similar) to keep the suite compiling.

### `getOrCreateCostCapEnforcer`

A module-level `Map<string, CostCapEnforcer>` keyed on `requestDir`:

```ts
const enforcerCache = new Map<string, CostCapEnforcer>();

function getOrCreateCostCapEnforcer(requestDir: string): CostCapEnforcer {
  const cached = enforcerCache.get(requestDir);
  if (cached) return cached;
  const enforcer = new CostCapEnforcer({
    ledger: getLedger(requestDir),
    config: () => loadCostCapConfig(requestDir),
    escalate: orchestratorEscalationSink,
  });
  enforcerCache.set(requestDir, enforcer);
  return enforcer;
}
```

`getLedger`, `loadCostCapConfig`, and `orchestratorEscalationSink` are
existing symbols (or near-equivalents) — discover their actual names
during implementation. If the names differ, document them in
`Implementation Notes`.

### Audit CSV

Generated locally by the implementer:

```bash
( for sym in checkCostCap recordCost readTodayLedger __setCostCapDayForTest "from './cost-cap'" "from \"../cost-cap\""; do
    git grep -nF "$sym" -- 'plugins/autonomous-dev*' \
      | awk -v s="$sym" -F: '{printf "%s,%s,%s,%s\n",$1,$2,s,($1 ~ /tests?\//?"false":"true")}'
  done ) > tmp/plan-032-1-call-sites.csv
```

The CSV is used as the work-list for SPEC-032-1-04. It MUST be deleted
from the worktree before the spec's commit lands.

## Interfaces and Dependencies

**Consumes:**
- `CostCapEnforcer` (existing, `intake/deploy/cost-cap-enforcer.ts`).
- `CostLedger` and `getLedger(requestDir)` (existing).
- `loadCostCapConfig(requestDir)` (existing).
- `orchestratorEscalationSink` (existing).

**Produces:**
- `RunDeployArgs.actor: string` — new required field on the public
  `runDeploy()` signature. Downstream callers (supervisor) MUST pass it.
- `getOrCreateCostCapEnforcer` (private; not exported; consumed only
  by SPEC-032-1-02).

**No new npm dependencies.**

## Acceptance Criteria

```
Given a clean checkout on this branch
When the implementer runs the FR-1 grep into tmp/plan-032-1-call-sites.csv
Then the CSV contains at least one row per legacy symbol
And the CSV has columns file, line, symbol, is_production
And the only row with is_production=true and file containing "intake/deploy/orchestrator.ts" is the orchestrator caller of cost-cap

Given the CSV from FR-1
When inspected before commit
Then it lists every test file under tests/deploy that touches cost-cap
And no production callers exist outside intake/deploy/orchestrator.ts (or, if any do, they are documented in Implementation Notes)

Given the modified orchestrator.ts
When `npx tsc --noEmit` runs from plugins/autonomous-dev/
Then exit code is 0
And `RunDeployArgs.actor` is required (not optional, not undefined-allowed)
And the JSDoc above `RunDeployArgs` names `actor` and references CostCapEnforcer.maybeStickyWarn

Given the supervisor caller of runDeploy
When the migrated branch is checked out
Then the call site passes a string `actor` field
And no test in the suite throws TypeError for missing `actor`

Given a fresh process running getOrCreateCostCapEnforcer('/tmp/req-A')
When called twice with the same requestDir
Then both calls return the same instance (=== equality)

Given getOrCreateCostCapEnforcer('/tmp/req-A')
When called once with '/tmp/req-A' and once with '/tmp/req-B'
Then the two returned instances are NOT === equal

Given the helper getOrCreateCostCapEnforcer
When `grep -n '^export' orchestrator.ts | grep -i enforcer` is run
Then the helper does not appear (it is module-private)

Given tmp/plan-032-1-call-sites.csv exists at HEAD
When the spec's commit is opened
Then the CSV is NOT present (audit aid only; not shipped)

Given the test suite at HEAD on this branch
When `npm test` runs
Then total pass count is greater than or equal to baseline on main (TG-06)
```

## Test Requirements

- **Unit (memoization).** `tests/deploy/test-orchestrator-cost-cap.test.ts`
  ships one `describe('getOrCreateCostCapEnforcer', ...)` block:
  - Test A: same `requestDir` returns the same instance (via two
    invocations and `expect(a).toBe(b)`).
  - Test B: different `requestDir` returns different instances.
  - Test C: cache survives across multiple synchronous calls in the
    same `it` block (sanity).
  - The test imports the helper via a thin export-for-test escape
    hatch, OR exercises it indirectly through a public surface that
    routes through the helper. Implementer picks; document the choice.
- **Type-only test (optional but recommended).** A `// @ts-expect-error`
  asserting `RunDeployArgs` cannot be instantiated without `actor`.
- **Regression.** Every existing orchestrator test that constructs a
  `RunDeployArgs` literal is updated (mechanical edit) to include
  `actor: 'test-actor'`. Pass count MUST be non-decreasing.

## Implementation Notes

- The CSV is your work-list for the deletion in SPEC-032-1-04. Do
  NOT commit it. Add it to `.gitignore` or just `rm` it.
- If the supervisor caller already resolves `approvalState.actor` (or
  similar) but does not pass it down, this is the correct moment to
  thread it. Per PRD-017 the field exists upstream; no new approval
  plumbing required.
- The `enforcerCache` MUST be module-scoped so jest's worker isolation
  gives each worker a fresh map. Do NOT use `globalThis`.
- If `loadCostCapConfig` does not exist as named, locate the existing
  function that returns the cost-cap config object (may be inlined in
  `cost-cap.ts` today) and either re-export it from
  `cost-cap-enforcer.ts` or define a small local equivalent. Document
  the choice.
- Resist the temptation to also delete `cost-cap.ts` here — that lives
  in SPEC-032-1-04 and depends on SPEC-032-1-02 (cutover) and
  SPEC-032-1-03 (shim) shipping first.

## Rollout Considerations

- This spec ships behind no feature flag because it adds infrastructure
  (a field, a helper) without changing behavior. The enforcer is
  constructed but never `check()`-ed until SPEC-032-1-02.
- Revertable independently: undoing this commit only loses the
  helper + the field, both of which are inert.

## Effort Estimate

- Coding: 0.75 day (`actor` plumbing, helper, supervisor update)
- Testing: 0.25 day (memoization tests, regression updates)
- Documentation: 0.25 day (JSDoc, Implementation Notes refinement)
- Total: 1.25 days
