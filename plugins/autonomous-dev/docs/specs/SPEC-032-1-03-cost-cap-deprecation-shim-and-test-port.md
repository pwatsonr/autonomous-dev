# SPEC-032-1-03: `cost-cap-shim.ts` Deprecation Shim and Legacy-Test Port

## Metadata
- **Parent Plan**: PLAN-032-1 (Cost-Cap Dual-Path Migration)
- **Parent TDD**: TDD-032 §5.1.3 (deprecation window), §5.1.4 (test migration)
- **Parent PRD**: PRD-017 (FR-1701, FR-1704)
- **Tasks Covered**: PLAN-032-1 Task 7 (shim), Task 9 (test port)
- **Estimated effort**: 1 day
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-032-1-03-cost-cap-deprecation-shim-and-test-port.md`
- **Depends on**: SPEC-032-1-01 (helper), SPEC-032-1-02 (cutover branch is the shim's caller)

## Summary
Author the deprecation shim `cost-cap-shim.ts` that preserves the
legacy `checkCostCap` / `recordCost` / `readTodayLedger` /
`__setCostCapDayForTest` public API for one minor release while
routing every call through the new `CostCapEnforcer` + `CostLedger`
combination. Port every test from the existing
`tests/deploy/test-cost-cap.test.ts` into either
`test-cost-cap-enforcer.test.ts` (enforcer-contract assertions) or a
new `test-cost-cap-shim.test.ts` (legacy-shape assertions).

The shim must NOT silently downgrade security: re-exports route
through the HMAC-chained `CostLedger`, so even legacy callers get
tamper-evident ledger entries. A once-per-process `console.warn`
nudges operators to migrate.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/intake/deploy/cost-cap-shim.ts` | Create | Re-exports legacy API; warns once per process |
| `plugins/autonomous-dev/tests/deploy/test-cost-cap-shim.test.ts` | Create | Legacy-shape assertions + warning-once test |
| `plugins/autonomous-dev/tests/deploy/test-cost-cap-enforcer.test.ts` | Modify | Receive migrated invariants from old test-cost-cap.test.ts |
| `plugins/autonomous-dev/tests/deploy/test-cost-cap.test.ts` | Delete | All assertions moved (idempotency, UTC rollover, cap, single-deploy-exceeds) |

## Functional Requirements

| ID | Requirement | Task |
|----|-------------|------|
| FR-1 | `cost-cap-shim.ts` MUST re-export `checkCostCap`, `recordCost`, `readTodayLedger`, `__setCostCapDayForTest`, plus the types `CostLedgerEntry`, `CostLedger`, `CheckCostCapArgs`, `CheckCostCapResult`, `RecordCostArgs`. | T7 |
| FR-2 | `checkCostCap(args)` exposed by the shim MUST internally call `CostCapEnforcer.check(...)` against a `CostLedger` instance constructed against `args.requestDir`. | T7 |
| FR-3 | When the underlying enforcer throws `DailyCostCapExceededError` or `AdminOverrideRequiredError`, the shim's `checkCostCap` MUST translate the throw to the legacy shape: `{ allowed: false, reason: ${err.constructor.name}: ${err.message} }`. | T7 |
| FR-4 | When the underlying enforcer resolves without throwing, the shim's `checkCostCap` MUST resolve to `{ allowed: true }`. | T7 |
| FR-5 | `recordCost(args)` exposed by the shim MUST internally call `CostLedger.recordCompleted(args.deployId, args.usd)` against the same ledger instance. | T7 |
| FR-6 | The shim MUST emit `console.warn('cost-cap.ts shim — switch to CostCapEnforcer; will be removed in vNEXT')` exactly once per process, gated by a module-level `Set<string>` keyed on the warning text. | T7 |
| FR-7 | The warning MUST fire on the FIRST call to ANY shim function (not lazily on `checkCostCap` only). | T7 |
| FR-8 | Every assertion in `tests/deploy/test-cost-cap.test.ts` (UTC rollover, idempotency, daily cap, single-deploy-exceeds-cap) MUST have a corresponding assertion either in the enforcer test (new path) or the shim test (legacy shape). | T9 |
| FR-9 | The original `tests/deploy/test-cost-cap.test.ts` file MUST be deleted in this commit. | T9 |
| FR-10 | Total `npm test` pass count MUST be strictly non-decreasing relative to baseline (TG-06). | T9 |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| Warning fires once per process | Exactly 1 invocation regardless of how many shim functions are called | Spy on `console.warn`; assert `callCount === 1` after 5+ shim calls |
| Type compatibility | `tsc --noEmit` exit 0; downstream callers compiling against the legacy types continue to compile | Type smoke: a sample import that uses `CheckCostCapResult.allowed` and `.reason` compiles |
| Security parity | Shim writes to the HMAC-chained `CostLedger` (not legacy unsigned JSON) | Inspect the ledger file written by a shim test; assert HMAC field is non-empty |
| Test count | Pass count strictly non-decreasing | `npm test` baseline diff |

## Technical Approach

### Shim module shape

```ts
// plugins/autonomous-dev/intake/deploy/cost-cap-shim.ts
import {
  CostCapEnforcer,
  DailyCostCapExceededError,
  AdminOverrideRequiredError,
} from './cost-cap-enforcer';
import { CostLedger } from './cost-ledger';
// types re-exported as-is (canonical home moves to enforcer/ledger files)
export type {
  CostLedgerEntry,
  CostLedger as CostLedgerType,
} from './cost-ledger';
export type {
  CheckCostCapArgs,
  CheckCostCapResult,
  RecordCostArgs,
} from './cost-cap-enforcer'; // OR define here if the enforcer doesn't yet export these legacy shapes

const WARNING_TEXT =
  'cost-cap.ts shim — switch to CostCapEnforcer; will be removed in vNEXT';
const warned = new Set<string>();

function maybeWarn(): void {
  if (warned.has(WARNING_TEXT)) return;
  warned.add(WARNING_TEXT);
  console.warn(WARNING_TEXT);
}

// Legacy shape contract: { allowed, reason } where reason is set iff !allowed.
export async function checkCostCap(args: CheckCostCapArgs): Promise<CheckCostCapResult> {
  maybeWarn();
  const enforcer = new CostCapEnforcer({
    ledger: new CostLedger({ requestDir: args.requestDir, env: args.envName }),
    config: () => ({ capUsd: args.capUsd /* ... */ }),
    escalate: () => {},
  });
  try {
    await enforcer.check({
      actor: 'cost-cap-shim',
      estimated_cost_usd: args.estimatedUsd,
      deployId: args.deployId ?? 'shim-no-deploy-id',
      env: args.envName,
      backend: 'shim',
    });
    return { allowed: true };
  } catch (err) {
    if (
      err instanceof DailyCostCapExceededError ||
      err instanceof AdminOverrideRequiredError
    ) {
      return {
        allowed: false,
        reason: `${err.constructor.name}: ${(err as Error).message}`,
      };
    }
    throw err;
  }
}

export async function recordCost(args: RecordCostArgs): Promise<void> {
  maybeWarn();
  const ledger = new CostLedger({ requestDir: args.requestDir, env: args.envName });
  await ledger.recordCompleted(args.deployId, args.usd);
}

export async function readTodayLedger(args: { requestDir: string; envName: string }) {
  maybeWarn();
  const ledger = new CostLedger({ requestDir: args.requestDir, env: args.envName });
  return ledger.aggregate({ window: 'today' });
}

// Test-only helper preserved for backwards-compat:
export function __setCostCapDayForTest(_isoDate: string): void {
  maybeWarn();
  // Delegate to the same hook the enforcer exposes (or a shim equivalent).
  // Implementer: locate the existing test hook on CostLedger / enforcer;
  // if absent, restore a minimal in-memory clock override here so legacy
  // tests continue to pass.
}
```

The `CostLedger` constructor signature, the enforcer's `check()`
request shape, and the legacy types listed above MUST be confirmed
against the as-built code. If a name differs, document the actual
name and adjust.

### Test port

For each test in `tests/deploy/test-cost-cap.test.ts`:

1. If the assertion is about the enforcer's *contract*
   (cap-exceeded throws, idempotency, ledger-aggregate, UTC
   rollover): MOVE to `test-cost-cap-enforcer.test.ts`. Translate
   `expect(result.allowed).toBe(false)` to
   `await expect(...).rejects.toThrow(DailyCostCapExceededError)`.
2. If the assertion is about the legacy *shape*
   (`{allowed, reason}`, `recordCost` signature): MOVE to
   `test-cost-cap-shim.test.ts`. Keep the shape; only the import
   path changes.
3. The shim test file ALSO ships the once-per-process warning test
   (FR-6, FR-7).

After porting, delete the old file.

## Interfaces and Dependencies

**Consumes:**
- `CostCapEnforcer` (existing).
- `CostLedger` (existing).
- `DailyCostCapExceededError`, `AdminOverrideRequiredError`
  (existing in `errors.ts`).

**Produces:**
- `cost-cap-shim.ts` module (new). The shim is the import target for
  the legacy code path branch in SPEC-032-1-02. The shim is also
  the import target for any external operator-extensible plugin that
  was importing `cost-cap.ts` directly.

**No new npm dependencies.**

## Acceptance Criteria

```
Given a fresh process
And cost-cap-shim.ts is imported
When checkCostCap({...}) is called for the first time
Then console.warn is called exactly once with the documented text

Given a fresh process where checkCostCap was already called once
When recordCost({...}) is then called
Then console.warn is NOT called again (warned Set prevents re-fire)

Given a fresh process where readTodayLedger is called first
Then console.warn fires exactly once with the documented text
And subsequent shim calls in the same process do not re-warn

Given args { requestDir, envName, capUsd: 50, estimatedUsd: 30 }
When the shim's checkCostCap is invoked
Then the result is { allowed: true }
And no error is thrown

Given args { requestDir, envName, capUsd: 50, estimatedUsd: 75 }
When the shim's checkCostCap is invoked
Then the result is { allowed: false }
And result.reason starts with 'DailyCostCapExceededError: '

Given args { requestDir, envName, deployId: 'X', usd: 5 }
When the shim's recordCost is called
Then the underlying CostLedger contains exactly one entry for deployId 'X'
And the entry has a non-empty HMAC chain field

Given the same args called twice with the same deployId
When recordCost is called twice
Then the ledger has exactly one entry (idempotent)

Given the file tree at HEAD on this branch
When `git ls-files plugins/autonomous-dev/tests/deploy/test-cost-cap.test.ts` runs
Then no output is returned (file deleted)

Given the test suite runs
When npm test completes
Then total pass count is strictly non-decreasing relative to baseline
And every previously asserted invariant from test-cost-cap.test.ts has a corresponding test elsewhere

Given test-cost-cap-shim.test.ts uses jest.isolateModules per case
When two cases sequentially exercise the shim
Then each case observes exactly one console.warn fire (Set is fresh per isolated module load)
```

## Test Requirements

- **Shim contract tests** (new file `test-cost-cap-shim.test.ts`):
  - Once-per-process warning. Use `jest.spyOn(console, 'warn')` and
    `jest.isolateModules` per case so the module-level `Set` is
    fresh.
  - Legacy shape: `{ allowed: true }` on within-cap.
  - Legacy shape: `{ allowed: false, reason }` on cap-exceeded.
  - `recordCost` writes one HMAC-chained entry.
  - `recordCost` is idempotent on `deployId`.
  - `readTodayLedger` returns the day's entries.
  - `__setCostCapDayForTest` (if present) round-trips.
- **Enforcer-contract tests** (extended
  `test-cost-cap-enforcer.test.ts`):
  - Migrated UTC-rollover assertion.
  - Migrated single-deploy-exceeds-cap assertion.
  - Migrated cap-exceeded throws assertion.
  - Migrated idempotency assertion.
- **Total count.** `git diff --stat` shows
  `test-cost-cap.test.ts` deleted; new + extended tests cover at
  least the same number of assertions.

## Implementation Notes

- Read `CostLedger`'s constructor and `recordCompleted` /
  `aggregate` signatures before authoring the shim. The illustrative
  shapes above are best-effort; align with as-built code.
- The shim's `checkCostCap` constructs a fresh `CostCapEnforcer`
  per call. This is intentional: legacy callers do not memoize.
  Performance impact is negligible (one allocation per cap check).
  If the enforcer's constructor has side effects (it should not),
  flag for review.
- `jest.isolateModules` is the supported way to defeat the
  once-per-process `Set` between test cases. Run `jest --runInBand`
  in CI if the worker pool causes flakes (PLAN-032-1 §Risks).
- The deprecation message text is observable contract — runbooks
  may grep for it. Do not paraphrase.
- If `CheckCostCapArgs` / `CheckCostCapResult` / `RecordCostArgs`
  types currently live ONLY in the doomed `cost-cap.ts`, COPY them
  into the shim before deletion in SPEC-032-1-04 so the shim's
  re-export surface stays intact.

## Rollout Considerations

- Shim ships in the same release as the cutover (SPEC-032-1-02).
- Shim removal is a follow-up PRD (TDD-032 §11 OQ-01); not owned
  here.
- Operators who set `AUTONOMOUS_DEV_COST_CAP_LEGACY=1` see the
  warning once per process and continue to function.
- External plugin authors importing `cost-cap.ts` directly will see
  a build break in SPEC-032-1-04 (file deleted) — they must
  re-import from `cost-cap-shim.ts`. Document this in the closeout
  PR description.

## Effort Estimate

- Coding: 0.5 day (shim + warn-once Set)
- Testing: 0.5 day (shim contract tests + enforcer test migration)
- Total: 1 day
