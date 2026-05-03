# PLAN-032-1: Cost-Cap Dual-Path Migration (Path-A)

## Metadata
- **Parent TDD**: TDD-032-cleanup-and-operational-closeout (§5.1, WS-1)
- **Parent PRD**: PRD-017 (FR-1701..FR-1705)
- **Estimated effort**: 3 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0
- **Closes FRs**: FR-1701, FR-1702, FR-1703, FR-1705

## Objective
Resolve the `cost-cap.ts` / `cost-cap-enforcer.ts` dual-path by migrating
`intake/deploy/orchestrator.ts` from the legacy `checkCostCap` /
`recordCost` pair onto the HMAC-chained, ledger-backed
`CostCapEnforcer`, then delete `intake/deploy/cost-cap.ts` while
preserving its public surface for one minor release through a
deprecated re-export shim and an opt-in legacy feature flag. This is
the only workstream in the PRD-017 closeout that has runtime impact;
every other workstream is doc-only or build-tooling.

## Scope

### In Scope
- Migrate the orchestrator's cost-check and post-deploy record code
  paths from `checkCostCap` + `recordCost` to a single
  `CostCapEnforcer.check()` call backed by the shared `CostLedger`.
- Add an `actor` field to `RunDeployArgs` (already supplied upstream
  by the approval state — no new plumbing required) so the enforcer
  can perform the per-actor sticky-warning logic.
- Map enforcer exceptions (`DailyCostCapExceededError`,
  `AdminOverrideRequiredError`) to the orchestrator's existing
  `cost-cap-exceeded` telemetry outcome with a richer `reason` string
  carrying the error class name plus message.
- Introduce env-var feature flag `AUTONOMOUS_DEV_COST_CAP_LEGACY=1`
  that routes the orchestrator back to the legacy `checkCostCap` /
  `recordCost` codepath. Default is unset (new path active).
- Delete `plugins/autonomous-dev/intake/deploy/cost-cap.ts` after
  re-exporting `checkCostCap`, `recordCost`, `readTodayLedger`,
  `__setCostCapDayForTest`, and types as deprecated thin shims from
  `cost-cap-enforcer.ts` (or a co-located `cost-cap-shim.ts`). The
  shim emits exactly one `console.warn(...)` per process via a `Set`
  guard; warning text is `cost-cap.ts shim — switch to CostCapEnforcer; will be removed in vNEXT`.
- Port every test in `tests/deploy/test-cost-cap.test.ts` onto the
  enforcer + ledger surface. Translate `result.allowed === false` →
  `expect(...).rejects.toThrow(DailyCostCapExceededError)`. Move
  idempotency assertions to `CostLedger.recordCompleted` /
  `aggregate`.
- Add an orchestrator-level integration test (closes FR-1705) that
  asserts: (a) successful deploy writes an HMAC-chained ledger entry
  via the enforcer for a non-zero `costCapUsd`, (b) over-cap deploy
  rejects with `DailyCostCapExceededError` and emits
  `cost-cap-exceeded` telemetry, (c) two `runDeploy()` calls with the
  same `deployId` produce one ledger entry, (d) feature-flag flip
  routes through the deprecated shim (asserted via spy on the
  `console.warn` guard).

### Out of Scope
- Schema or API changes to `CostCapEnforcer` itself (NTG-01: the
  enforcer is a strict superset of the legacy module already; no
  expansion required).
- Removal of the feature flag or the deprecated shim — both ship as
  one-minor-version deprecation surface and are removed in a
  follow-up PRD (TDD-032 §11 OQ-01).
- Dependabot, runbook automation, or any other tooling outside the
  cost-governance surface.
- Test-side path drift on `tests/deploy/test-cost-cap*.test.ts` —
  PRD-016 owns test-file path conventions; this plan only relocates
  test assertions, not test file paths.
- Any change to the on-disk format of the cost ledger
  (`cost-ledger-<env>.json` ↔ HMAC-chained `CostLedger`). The
  enforcer already writes the new format via the injected
  `CostLedger`; this plan does not migrate any historical data.

## Tasks

1. **Inventory call sites and confirm Path-A scope.** Grep for
   `checkCostCap`, `recordCost`, `readTodayLedger`,
   `__setCostCapDayForTest`, `from './cost-cap'`, and
   `from '../cost-cap'` across `plugins/autonomous-dev/**` plus the
   four cloud deploy plugins. Build a CSV of every import site
   (file, line, symbol). Confirm the only production caller is
   `intake/deploy/orchestrator.ts`; record any third-party plugin
   call site for the shim contract.
   - Files to create: `tmp/plan-032-1-call-sites.csv` (audit aid;
     deleted before commit — not shipped).
   - Acceptance criteria: CSV exists with one row per call site;
     orchestrator is the only production caller; all test files
     listed; no surprises in deploy plugins.
   - Estimated effort: 0.5 day

2. **Add `actor` to `RunDeployArgs` and thread to the enforcer.**
   Extend `RunDeployArgs` with a required `actor: string` field.
   Update the supervisor caller (the only one) to pass the
   approval-state actor through. Document the field in the JSDoc
   block above `RunDeployArgs`.
   - Files to modify: `plugins/autonomous-dev/intake/deploy/orchestrator.ts`
   - Acceptance criteria: `tsc --noEmit` clean. Existing orchestrator
     tests updated to pass `actor`. JSDoc names `actor` as the
     per-request principal used by `CostCapEnforcer.maybeStickyWarn`.
   - Estimated effort: 0.25 day

3. **Build the orchestrator's enforcer factory.** Author a small
   helper `getOrCreateCostCapEnforcer(requestDir)` that lazily
   constructs a `CostCapEnforcer` with `ledger: getLedger(requestDir)`,
   `config: () => loadCostCapConfig(requestDir)`, and an
   `escalate` sink that delegates to the existing orchestrator
   `escalationSink`. Memoize per-`requestDir` so a second deploy in
   the same process reuses the enforcer instance.
   - Files to modify: `plugins/autonomous-dev/intake/deploy/orchestrator.ts`
   - Acceptance criteria: Helper exists, is unexported (private
     module-level closure), and returns the same enforcer instance
     for a given `requestDir`. Unit test in
     `tests/deploy/test-orchestrator-cost-cap.test.ts` exercises the
     memoization.
   - Estimated effort: 0.5 day

4. **Replace `checkCostCap` call with `enforcer.check()`.** Wrap the
   call in `try`/`catch` per TDD §5.1.2:
   - On `DailyCostCapExceededError` or `AdminOverrideRequiredError`,
     emit `deploy.completion` with `outcome: 'cost-cap-exceeded'`,
     `reason: '${err.constructor.name}: ${err.message}'`, then
     re-throw `CostCapExceededError(reason)` to preserve the
     existing orchestrator contract.
   - On any other throw, re-throw verbatim.
   - Files to modify: `plugins/autonomous-dev/intake/deploy/orchestrator.ts`
   - Acceptance criteria: The legacy `if (!capCheck.allowed)` block
     is removed. The new error mapping preserves
     `outcome: 'cost-cap-exceeded'`. Existing orchestrator tests for
     the cap-exceeded path pass without change.
   - Estimated effort: 0.5 day

5. **Replace `recordCost(...)` with ledger record-on-completion.**
   After `invokeBackend` succeeds, call
   `getLedger(args.requestDir).recordCompleted(args.deployId, estimatedCost)`
   (the existing `CostLedger` API used by the enforcer) instead of
   `recordCost(...)`. Idempotency on `deployId` is preserved by the
   ledger's existing dedup logic.
   - Files to modify: `plugins/autonomous-dev/intake/deploy/orchestrator.ts`
   - Acceptance criteria: A second `runDeploy()` with the same
     `deployId` does not add a second entry to the ledger
     (verified by ledger-level test + orchestrator-level
     integration test in task 10).
   - Estimated effort: 0.25 day

6. **Wire the feature flag.** At the top of `runDeploy()`, check
   `process.env.AUTONOMOUS_DEV_COST_CAP_LEGACY === '1'`. When set,
   route to the legacy code path (preserved behind the deprecated
   shim from task 7). When unset, route through the enforcer.
   Document the flag in the JSDoc block above `runDeploy`.
   - Files to modify: `plugins/autonomous-dev/intake/deploy/orchestrator.ts`
   - Acceptance criteria: Both code paths compile and type-check.
     Flag default (unset) routes new path. `AUTONOMOUS_DEV_COST_CAP_LEGACY=1`
     routes legacy path and triggers the shim's `console.warn`
     exactly once per process (asserted in task 10).
   - Estimated effort: 0.25 day

7. **Author the deprecation shim.** Create
   `plugins/autonomous-dev/intake/deploy/cost-cap-shim.ts` that
   re-exports `checkCostCap`, `recordCost`, `readTodayLedger`,
   `__setCostCapDayForTest`, `CostLedgerEntry`, `CostLedger`,
   `CheckCostCapArgs`, `CheckCostCapResult`, `RecordCostArgs`. The
   re-exports route through the new enforcer + `CostLedger` so the
   shim emits the new HMAC-chained ledger entries (Tenet:
   "deprecation must not silently downgrade security"). On first
   call, `console.warn('cost-cap.ts shim — switch to CostCapEnforcer; will be removed in vNEXT')`
   is emitted, gated by a module-level `Set<string>` keyed by the
   warning text so it fires exactly once per process.
   - Files to create: `plugins/autonomous-dev/intake/deploy/cost-cap-shim.ts`
   - Acceptance criteria: Shim re-exports the full legacy API.
     `tsc --noEmit` clean. Shim's `checkCostCap` returns
     `{allowed: false, reason}` shape on cap-exceeded
     (translates `DailyCostCapExceededError` back to legacy shape).
     Warning fires once per process, asserted by task 10 test.
   - Estimated effort: 0.5 day

8. **Delete `cost-cap.ts` and re-point its imports.** Delete
   `plugins/autonomous-dev/intake/deploy/cost-cap.ts`. Update the
   one or more import sites discovered in task 1 to import from
   `cost-cap-shim.ts` (legacy path) or `cost-cap-enforcer.ts` (new
   path). Confirm `git grep "from './cost-cap'"` and
   `git grep 'from \"../cost-cap\"'` return no matches.
   - Files to delete: `plugins/autonomous-dev/intake/deploy/cost-cap.ts`
   - Files to modify: any import site discovered in task 1 (expected:
     orchestrator.ts only, plus tests).
   - Acceptance criteria: File deleted. Grep returns zero hits.
     Build passes; full test suite passes.
   - Estimated effort: 0.25 day

9. **Port `tests/deploy/test-cost-cap.test.ts`.** Move every test
   from `test-cost-cap.test.ts` into either
   `test-cost-cap-enforcer.test.ts` (for tests of the enforcer's
   contract) or `test-cost-cap-shim.test.ts` (for tests asserting
   the shim still exposes the legacy shape). Translate
   `result.allowed === false && result.reason === '...'` to
   `await expect(...).rejects.toThrow(DailyCostCapExceededError)`.
   The legacy-shape tests stay against the shim until the shim is
   removed in a follow-up PRD.
   - Files to create: `plugins/autonomous-dev/tests/deploy/test-cost-cap-shim.test.ts`
   - Files to modify: `plugins/autonomous-dev/tests/deploy/test-cost-cap-enforcer.test.ts`
   - Files to delete: `plugins/autonomous-dev/tests/deploy/test-cost-cap.test.ts`
   - Acceptance criteria: Total test count for the cost-cap surface
     is non-decreasing (TG-06). Pass count strictly non-decreasing.
     Every previously asserted invariant (UTC rollover, idempotency,
     daily cap, single-deploy-exceeds-cap) has a corresponding
     enforcer-side or shim-side test.
   - Estimated effort: 0.5 day

10. **Author the orchestrator integration test (FR-1705).** Add
    `tests/deploy/test-orchestrator-cost-cap.test.ts` with four
    cases:
    - **Case A (success).** `costCapUsd > 0`, estimate within cap,
      mock backend returns `status: 'deployed'`. Assert ledger
      contains exactly one entry for the deployId, entry has a
      non-empty HMAC chain field.
    - **Case B (cap exceeded).** Estimate > cap. Assert
      `runDeploy()` resolves to status `failed` (or rethrows per
      orchestrator contract — match existing behavior), telemetry
      `deploy.completion` has `outcome: 'cost-cap-exceeded'` and
      `reason` contains `'DailyCostCapExceededError'`.
    - **Case C (idempotency).** Two `runDeploy()` calls with same
      `deployId`. Assert ledger has one entry.
    - **Case D (legacy flag).** Set
      `process.env.AUTONOMOUS_DEV_COST_CAP_LEGACY = '1'`. Spy on
      `console.warn`. Run `runDeploy()` once. Assert spy was called
      exactly once with the documented shim message; subsequent
      calls in the same process do not re-warn.
    - Files to create: `plugins/autonomous-dev/tests/deploy/test-orchestrator-cost-cap.test.ts`
    - Acceptance criteria: All four cases pass. Test isolates
      `process.env.AUTONOMOUS_DEV_COST_CAP_LEGACY` via
      `beforeEach`/`afterEach` so it does not leak. Test does not
      touch the user's real `~/.autonomous-dev` (uses `stateDir`
      override on the enforcer or a temp dir).
    - Estimated effort: 0.5 day

11. **Smoke + jest-baseline check.** Locally:
    ```
    npm test 2>&1 | tee /tmp/before.log    # on main
    git checkout docs/plans-from-tdd-032-final
    npm test 2>&1 | tee /tmp/after.log
    diff <(grep -E 'Tests:|Suites:' /tmp/before.log) \
         <(grep -E 'Tests:|Suites:' /tmp/after.log)
    ```
    Confirm pass count strictly non-decreasing. Run the manual
    deploy-phase smoke per TDD §10.3.
    - Files to modify: None.
    - Acceptance criteria: Diff shows Tests: N+ passed (N or higher).
      No suite regression. Smoke against a no-op backend with
      `costCapUsd=10` writes a ledger entry and emits `deploy.init`
      + `deploy.completion` with the new `reason` field shape.
    - Estimated effort: 0.25 day

## Dependencies & Integration Points

**Exposes to other plans:**
- The `cost-cap-shim.ts` deprecation contract (one-minor warning,
  legacy shape preserved). Removal is logged as TDD-032 §11 OQ-01
  for a follow-up PRD; no PLAN-032-N owns it.
- The `actor` field on `RunDeployArgs` becomes required. Callers
  outside this plan (the supervisor) must supply it; PRD-017
  confirms the field is already plumbed through the approval state.

**Consumes from other plans:**
- None. The TDD-023-3 spec→code session already shipped
  `cost-cap-enforcer.ts`, `cost-ledger.ts`, `errors.ts`,
  `monitor-types.ts`, `cost-ledger-types.ts`. This plan only wires
  them into the orchestrator and removes the dead predecessor.

## Testing Strategy

- **Unit (enforcer + ledger):** Existing
  `test-cost-cap-enforcer.test.ts` plus migrated assertions from the
  old `test-cost-cap.test.ts`.
- **Unit (shim):** New `test-cost-cap-shim.test.ts` asserts the
  shim emits the documented warning exactly once per process and
  preserves the legacy `{allowed, reason}` shape.
- **Integration (orchestrator):** New
  `test-orchestrator-cost-cap.test.ts` covers the four cases listed
  in task 10 — closes FR-1705.
- **Regression posture (TG-06):** `npm test` pass count strictly
  non-decreasing between `main` and the closeout branch. The branch
  must not introduce any skipped or `xit` tests.
- **Manual smoke (TDD §10.3):** One real `runDeploy()` against a
  no-op backend with a small cap, verifying ledger writes + telemetry
  events fire on both success and cap-exceeded paths.
- **No mocking of `CostLedger.aggregate`:** Tests use a temp-dir
  ledger so HMAC-chain integrity is exercised end-to-end.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Undiscovered orchestrator caller of `cost-cap.ts` (PRD-017 R1) breaks after deletion. | Medium | Medium | Task 1's inventory grep is exhaustive across all five plugin dirs. Task 7's shim preserves the import surface for one minor; task 6's feature flag lets operators flip back without redeploy. Task 11's smoke confirms the deploy phase still works. |
| Enforcer's `console.warn` shim guard leaks `Set` state across jest workers, causing flaky once-per-process assertion. | Medium | Low | Task 7's `Set` is module-scoped; jest's `--runInBand` is documented in the test file's setup block. Task 10's case D uses a fresh module via `jest.isolateModules`. |
| `recordCompleted` on `CostLedger` is not idempotent on `deployId` (assumption from TDD §5.1.4). | Low | High | Task 5 ships with a ledger-level test that calls `recordCompleted` twice with the same id and asserts one entry. If the assumption is wrong, this plan blocks on a `cost-ledger.ts` patch (out of scope; escalate to TDD-023-3 owner). |
| Mapping `DailyCostCapExceededError` → `CostCapExceededError` loses information needed by downstream consumers. | Low | Medium | Task 4's mapping preserves both class name and message in the `reason` string. Task 11's smoke verifies the telemetry `reason` field carries the new richer string. |
| Feature-flag default (off) silently routes through the new path on production deploys before the canary window. | Medium | Medium | TDD §8.1 sets the flag default to off; canary procedure in TDD §8.3 says operators canary by leaving the flag off in staging and flipping on in production after one full deploy cycle. Document the canary in the closeout PR description. |

## Definition of Done

- [ ] `plugins/autonomous-dev/intake/deploy/cost-cap.ts` deleted; `git grep` returns zero hits.
- [ ] `plugins/autonomous-dev/intake/deploy/cost-cap-shim.ts` exists; emits warning exactly once per process; preserves legacy `{allowed, reason}` shape.
- [ ] Orchestrator routes through `CostCapEnforcer.check()` by default; `AUTONOMOUS_DEV_COST_CAP_LEGACY=1` routes through the shim.
- [ ] `RunDeployArgs.actor` is required; supervisor caller updated; `tsc --noEmit` clean.
- [ ] All four cases in `test-orchestrator-cost-cap.test.ts` pass (FR-1705).
- [ ] Migrated tests in `test-cost-cap-enforcer.test.ts` and `test-cost-cap-shim.test.ts` pass; total pass count strictly non-decreasing (TG-06).
- [ ] Manual smoke against a no-op backend with `costCapUsd > 0` writes an HMAC-chained ledger entry and emits `deploy.init` + `deploy.completion`.
- [ ] PR description enumerates `closes FR-1701, FR-1702, FR-1703, FR-1705` and links to TDD-032 §5.1.
- [ ] Commit message: `feat(deploy): migrate orchestrator to CostCapEnforcer; deprecate cost-cap.ts (PLAN-032-1)`.
