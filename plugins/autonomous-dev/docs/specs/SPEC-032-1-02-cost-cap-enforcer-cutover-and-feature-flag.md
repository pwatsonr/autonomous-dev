# SPEC-032-1-02: Orchestrator Cost-Cap Cutover, Ledger Record-on-Completion, and Legacy Feature Flag

## Metadata
- **Parent Plan**: PLAN-032-1 (Cost-Cap Dual-Path Migration)
- **Parent TDD**: TDD-032 §5.1 (WS-1)
- **Parent PRD**: PRD-017 (FR-1701, FR-1702, FR-1703)
- **Tasks Covered**: PLAN-032-1 Task 4 (`enforcer.check()` cutover), Task 5 (ledger record-on-completion), Task 6 (feature flag wiring)
- **Estimated effort**: 1 day
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-032-1-02-cost-cap-enforcer-cutover-and-feature-flag.md`
- **Depends on**: SPEC-032-1-01 (helper + `actor` field exist)

## Summary
Cut the orchestrator's runtime cost-cap path from the legacy
`checkCostCap` / `recordCost` pair onto `CostCapEnforcer.check()` plus
`CostLedger.recordCompleted()`. Wrap the cutover in an env-var feature
flag (`AUTONOMOUS_DEV_COST_CAP_LEGACY=1`) so operators can flip back to
the legacy path without redeploy during the deprecation window.

This is the only runtime-behavior-changing spec in PLAN-032-1. It
preserves the existing `cost-cap-exceeded` telemetry contract and the
`CostCapExceededError` re-throw shape, but the `reason` string now
carries the enforcer's error class name plus message
(e.g. `"DailyCostCapExceededError: projected USD 73.20 >= cap 50.00"`).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/intake/deploy/orchestrator.ts` | Modify | Replace `checkCostCap` + `recordCost` calls; wire feature flag |
| `plugins/autonomous-dev/intake/deploy/errors.ts` | Modify (if needed) | Confirm `CostCapExceededError` exported with `(reason: string)` constructor; add if absent |

No new files. The shim itself (the legacy code path target when the
flag is set) ships in SPEC-032-1-03.

## Functional Requirements

| ID | Requirement | Task |
|----|-------------|------|
| FR-1 | When `process.env.AUTONOMOUS_DEV_COST_CAP_LEGACY` is unset or any value other than `'1'`, `runDeploy()` MUST route through `getOrCreateCostCapEnforcer(args.requestDir).check({...})`. | T6 |
| FR-2 | When `process.env.AUTONOMOUS_DEV_COST_CAP_LEGACY === '1'`, `runDeploy()` MUST route through the legacy `checkCostCap` / `recordCost` path (target shim ships in SPEC-032-1-03). | T6 |
| FR-3 | The `enforcer.check()` call MUST pass `{ actor: args.actor, estimated_cost_usd: estimatedCost, deployId: args.deployId, env: resolved.envName, backend: selection.backendName }` (field names taken from existing orchestrator locals; adjust during impl if names differ). | T4 |
| FR-4 | On `DailyCostCapExceededError` OR `AdminOverrideRequiredError` from `enforcer.check()`, the orchestrator MUST emit `deploy.completion` telemetry with `outcome: 'cost-cap-exceeded'` and `reason: ${err.constructor.name}: ${err.message}`, then re-throw `new CostCapExceededError(reason)`. | T4 |
| FR-5 | On any other thrown error from `enforcer.check()`, the orchestrator MUST re-throw verbatim (no wrapping, no telemetry mapping). | T4 |
| FR-6 | After `invokeBackend` resolves successfully, the orchestrator MUST call `getLedger(args.requestDir).recordCompleted(args.deployId, estimatedCost)` instead of `recordCost(...)`. | T5 |
| FR-7 | The legacy `if (!capCheck.allowed) throw new CostCapExceededError(capCheck.reason)` block MUST be removed from the new path. | T4 |
| FR-8 | `runDeploy()` JSDoc MUST document `AUTONOMOUS_DEV_COST_CAP_LEGACY=1` as the operator-facing flag for routing back to the legacy path. | T6 |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| Telemetry preservation | `outcome: 'cost-cap-exceeded'` field unchanged from main; `reason` string contains the new error class name | Unit assertion against the emitted event payload |
| Type safety | `tsc --noEmit` exit code 0 | `cd plugins/autonomous-dev && npx tsc --noEmit` |
| Backward compatibility | Existing orchestrator tests for the cap-exceeded path pass without modification (other than `actor` field added in SPEC-032-1-01) | `npx jest tests/deploy/test-orchestrator-*.test.ts` |
| Test count | Strictly non-decreasing | `npm test` baseline diff (TG-06) |
| Idempotency | Two `runDeploy()` calls with the same `deployId` produce exactly one ledger entry | `CostLedger.aggregate` count post-test |

## Technical Approach

### Cutover shape

```ts
async function runDeploy(args: RunDeployArgs): Promise<RunDeployResult> {
  // ... existing setup (resolve env, select backend, estimate cost) ...

  if (process.env.AUTONOMOUS_DEV_COST_CAP_LEGACY === '1') {
    // Route to legacy shim. Implementation lives in SPEC-032-1-03.
    return runDeployLegacy(args, /* resolved, selection, estimatedCost */);
  }

  const enforcer = getOrCreateCostCapEnforcer(args.requestDir);
  try {
    await enforcer.check({
      actor: args.actor,
      estimated_cost_usd: estimatedCost,
      deployId: args.deployId,
      env: resolved.envName,
      backend: selection.backendName,
    });
  } catch (err) {
    if (
      err instanceof DailyCostCapExceededError ||
      err instanceof AdminOverrideRequiredError
    ) {
      const reason = `${err.constructor.name}: ${err.message}`;
      emitDeployCompletion({
        /* existing fields */,
        outcome: 'cost-cap-exceeded',
        reason,
      });
      throw new CostCapExceededError(reason);
    }
    throw err;
  }

  const result = await invokeBackend(/* ... */);
  await getLedger(args.requestDir).recordCompleted(args.deployId, estimatedCost);
  return result;
}
```

`runDeployLegacy` is a thin wrapper that calls the original
`checkCostCap` + `recordCost` flow against the shim module. The shim
itself is authored in SPEC-032-1-03; this spec MAY ship a stub that
throws `'legacy path not yet wired — see SPEC-032-1-03'` to keep
the type-checker happy and test the flag branching.

### Telemetry contract

The existing `emitDeployCompletion` (or equivalent) already accepts
`outcome` and `reason`. Confirm during implementation. The `reason`
string MUST be exactly `${err.constructor.name}: ${err.message}` —
this is the contract for the integration test in SPEC-032-1-04.

### `CostCapExceededError`

If the existing `errors.ts` already exports `CostCapExceededError`,
reuse it. If not, define:

```ts
export class CostCapExceededError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CostCapExceededError';
  }
}
```

This is the orchestrator-level error type that downstream consumers
have always seen; preserving it is FR-1701 contract continuity.

## Interfaces and Dependencies

**Consumes:**
- `getOrCreateCostCapEnforcer` (from SPEC-032-1-01).
- `CostCapEnforcer.check(req)` — existing API on
  `intake/deploy/cost-cap-enforcer.ts`.
- `DailyCostCapExceededError`, `AdminOverrideRequiredError` from
  `intake/deploy/errors.ts`.
- `CostLedger.recordCompleted(deployId, usd)` — existing API on
  `intake/deploy/cost-ledger.ts`.

**Produces:**
- Updated `runDeploy()` runtime semantics (still satisfies the
  `RunDeployResult` contract).
- Operator-facing env var `AUTONOMOUS_DEV_COST_CAP_LEGACY`.

**Telemetry contract:**
- Event: `deploy.completion`
- Outcome: `'cost-cap-exceeded'` (unchanged)
- Reason: `${ErrorClassName}: ${message}` (CHANGED — richer than legacy)

## Acceptance Criteria

```
Given AUTONOMOUS_DEV_COST_CAP_LEGACY is unset
And cap is 50 USD and estimated cost is 30 USD
When runDeploy() is invoked
Then enforcer.check() is called exactly once
And no DailyCostCapExceededError is thrown
And invokeBackend resolves
And ledger.recordCompleted(deployId, 30) is called exactly once

Given AUTONOMOUS_DEV_COST_CAP_LEGACY is unset
And cap is 50 USD and estimated cost is 75 USD
When runDeploy() is invoked
Then enforcer.check() throws DailyCostCapExceededError
And a deploy.completion telemetry event is emitted with outcome 'cost-cap-exceeded'
And the event's reason field starts with 'DailyCostCapExceededError: '
And runDeploy() rejects with CostCapExceededError whose message equals the reason

Given AUTONOMOUS_DEV_COST_CAP_LEGACY is unset
And enforcer.check() throws AdminOverrideRequiredError
When runDeploy() handles the throw
Then telemetry outcome is 'cost-cap-exceeded'
And reason starts with 'AdminOverrideRequiredError: '
And runDeploy rejects with CostCapExceededError

Given AUTONOMOUS_DEV_COST_CAP_LEGACY is unset
And enforcer.check() throws an unrelated TypeError
When runDeploy() handles the throw
Then no deploy.completion event with cost-cap-exceeded is emitted for that error
And the TypeError is re-thrown verbatim

Given AUTONOMOUS_DEV_COST_CAP_LEGACY === '1'
When runDeploy() is invoked
Then enforcer.check() is NOT called
And the legacy code path (runDeployLegacy or equivalent) is invoked
And the shim's documented behavior is exercised (see SPEC-032-1-03)

Given a successful runDeploy() with deployId='X'
When a second runDeploy() is invoked with the same deployId='X'
Then ledger.recordCompleted is called twice but only one entry is appended (idempotent on deployId)

Given the runDeploy() JSDoc block at HEAD on this branch
When inspected
Then it documents AUTONOMOUS_DEV_COST_CAP_LEGACY as the legacy-path env var
And it cross-references the deprecation shim

Given the test suite
When `npm test` runs
Then pass count is greater than or equal to baseline (TG-06)
```

## Test Requirements

- **Unit (cutover branching).** Add cases to
  `tests/deploy/test-orchestrator-cost-cap.test.ts`:
  - happy path with flag unset → enforcer.check() invoked, ledger
    recorded.
  - cap-exceeded with flag unset → telemetry + CostCapExceededError.
  - admin-override-required with flag unset → telemetry + error.
  - unrelated throw → re-thrown, no telemetry.
  - flag === '1' → legacy path invoked, enforcer.check() NOT invoked.
- **Integration (idempotency).** Two sequential `runDeploy()` calls
  with the same `deployId` produce exactly one ledger entry. Use a
  temp-dir ledger (no real `~/.autonomous-dev` writes).
- **Env var hygiene.** `beforeEach`/`afterEach` save and restore
  `process.env.AUTONOMOUS_DEV_COST_CAP_LEGACY`.
- **No mocking of `CostLedger.aggregate`.** Use the real
  `CostLedger` against a temp dir so HMAC-chain integrity is
  exercised end-to-end.

The full integration test matrix (Cases A-D from PLAN-032-1 Task 10)
ships in SPEC-032-1-04. This spec only ensures the cutover compiles
and branches correctly.

## Implementation Notes

- The `runDeployLegacy` helper is intentionally a thin shim. SPEC-032-1-03
  fills in the body via `cost-cap-shim.ts`. To keep this spec
  type-safe in isolation, the implementer MAY ship a placeholder that
  imports from the new `cost-cap-shim.ts` module and trusts SPEC-032-1-03
  to land before this spec's tests run end-to-end. Document the
  expectation in a `// TODO: SPEC-032-1-03` comment.
- The `reason` string format `${err.constructor.name}: ${err.message}`
  is observable contract — downstream telemetry consumers may parse
  it. Do not paraphrase.
- `CostLedger.recordCompleted` is assumed idempotent on `deployId`
  per PLAN-032-1 §Risks. If the assumption proves wrong, this spec
  blocks on a `cost-ledger.ts` patch (escalate).
- `getLedger(args.requestDir)` MUST return the same instance the
  enforcer holds via `getOrCreateCostCapEnforcer` — both call sites
  share one ledger per `requestDir` so dedup works. Verify the helper
  in SPEC-032-1-01 wires this correctly.

## Rollout Considerations

- **Feature flag.** Default OFF (new path active). Operators flip
  ON during canary if they observe regressions. Removal of the flag
  is a follow-up PRD (TDD-032 §11 OQ-01); not owned by this PR.
- **Telemetry consumers.** The richer `reason` string is additive
  information; consumers parsing for `cost-cap-exceeded` outcome are
  unaffected.
- **Rollback.** Reverting this commit restores the orchestrator to
  the legacy path. The enforcer + helper from SPEC-032-1-01 remain
  in tree but inert.

## Effort Estimate

- Coding: 0.5 day (cutover, error mapping, flag wiring)
- Testing: 0.25 day (cutover-branching cases)
- Documentation: 0.25 day (JSDoc + telemetry contract)
- Total: 1 day
