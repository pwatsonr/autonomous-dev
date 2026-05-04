# SPEC-032-1-04: Delete `cost-cap.ts`, Re-Point Imports, and Author Orchestrator Integration Test

## Metadata
- **Parent Plan**: PLAN-032-1 (Cost-Cap Dual-Path Migration)
- **Parent TDD**: TDD-032 §5.1, §10.1 (test posture)
- **Parent PRD**: PRD-017 (FR-1701, FR-1705)
- **Tasks Covered**: PLAN-032-1 Task 8 (delete + re-point), Task 10 (integration test), Task 11 (smoke + baseline check)
- **Estimated effort**: 0.75 day
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-032-1-04-cost-cap-deletion-and-orchestrator-integration-test.md`
- **Depends on**: SPEC-032-1-01, SPEC-032-1-02, SPEC-032-1-03 (all upstream code in place)

## Summary
Close PLAN-032-1 by deleting the dead predecessor file
`intake/deploy/cost-cap.ts`, re-pointing every import discovered in
SPEC-032-1-01's audit CSV onto either `cost-cap-shim.ts` (legacy
shape) or `cost-cap-enforcer.ts` (new path), and authoring the
orchestrator-level integration test that closes FR-1705. Also runs
the test-baseline diff and the manual deploy-phase smoke per
TDD-032 §10.3.

This is the only spec in PLAN-032-1 that physically removes the
legacy file. Sequencing matters: the shim (SPEC-032-1-03) must be
in tree first or the deletion orphans imports.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/intake/deploy/cost-cap.ts` | Delete | Legacy file removed |
| `plugins/autonomous-dev/intake/deploy/orchestrator.ts` | Modify | Re-point any remaining `from './cost-cap'` import to `./cost-cap-shim` (legacy branch) or `./cost-cap-enforcer` (new branch) |
| `plugins/autonomous-dev/tests/deploy/test-orchestrator-cost-cap.test.ts` | Create or extend | Four-case integration matrix per TDD §10.1 |
| Any other file flagged by SPEC-032-1-01's audit CSV | Modify | Re-point legacy imports |

The audit CSV (from SPEC-032-1-01) is the canonical work-list. If
the inventory turned up zero non-test production callers besides the
orchestrator, the file modification list is exactly two files.

## Functional Requirements

| ID | Requirement | Task |
|----|-------------|------|
| FR-1 | `plugins/autonomous-dev/intake/deploy/cost-cap.ts` MUST be deleted from the working tree and from the git index. | T8 |
| FR-2 | `git grep "from './cost-cap'" -- 'plugins/autonomous-dev/**'` MUST return zero matches. | T8 |
| FR-3 | `git grep 'from "../cost-cap"' -- 'plugins/autonomous-dev/**'` MUST return zero matches. | T8 |
| FR-4 | Every file in SPEC-032-1-01's audit CSV that imported from `cost-cap` MUST now import from either `cost-cap-shim` (legacy) or `cost-cap-enforcer` (new). | T8 |
| FR-5 | `plugins/autonomous-dev/tests/deploy/test-orchestrator-cost-cap.test.ts` MUST contain four cases: A (success + HMAC entry), B (cap exceeded + telemetry), C (idempotency), D (legacy flag warns once). | T10 |
| FR-6 | The test MUST isolate `process.env.AUTONOMOUS_DEV_COST_CAP_LEGACY` via `beforeEach`/`afterEach` so the value does not leak. | T10 |
| FR-7 | The test MUST use a temp-dir ledger override (or `stateDir` injection on the enforcer) so it does not touch the user's real `~/.autonomous-dev`. | T10 |
| FR-8 | The implementer MUST run `npm test` against `main` and against this branch and confirm the pass count is strictly non-decreasing. The diff is captured in the PR description. | T11 |
| FR-9 | The implementer MUST run a manual deploy-phase smoke (TDD §10.3) against a no-op backend with `costCapUsd > 0` and verify ledger writes + telemetry events fire. The smoke command and observed output are captured in the PR description. | T11 |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| Build cleanliness | `tsc --noEmit` exit 0 | `cd plugins/autonomous-dev && npx tsc --noEmit` |
| Grep cleanliness | Zero matches for legacy import paths | `git grep` commands in FR-2 / FR-3 |
| Test pass count | Strictly non-decreasing | Diff `/tmp/before.log` vs `/tmp/after.log` per TDD §10.2 |
| Suite count | Non-decreasing | Same diff |
| HMAC entry presence | Case A's ledger entry has a non-empty 64-char hex `chain` (or equivalent) field | Read the ledger file post-test; assert |
| Telemetry contract | Case B's `deploy.completion` event has `outcome: 'cost-cap-exceeded'` and `reason` containing `'DailyCostCapExceededError'` | Spy on telemetry emitter |
| Idempotency | Case C's ledger has exactly 1 entry for the deployId | `aggregate({today})` count |
| Once-per-process warn | Case D's `console.warn` spy has `callCount === 1` | Spy assertion |

## Technical Approach

### Deletion + re-pointing

```bash
# 1. Verify shim is in place (sanity, do NOT proceed otherwise)
ls plugins/autonomous-dev/intake/deploy/cost-cap-shim.ts

# 2. Delete the legacy file
git rm plugins/autonomous-dev/intake/deploy/cost-cap.ts

# 3. Re-point any remaining imports
#    Open each file from the audit CSV; change:
#       from './cost-cap'  →  from './cost-cap-shim'  (or '-enforcer' if new path)
#       from '../cost-cap' →  from '../cost-cap-shim' (or '-enforcer')

# 4. Confirm no stragglers
git grep -nE "from ['\"]\.{1,2}/cost-cap['\"]" -- 'plugins/autonomous-dev/**'
# expected: zero output

# 5. Build + test
cd plugins/autonomous-dev && npx tsc --noEmit && npm test
```

### Integration test shape

`tests/deploy/test-orchestrator-cost-cap.test.ts`:

```ts
describe('orchestrator cost-cap integration (FR-1705)', () => {
  let tempDir: string;
  let originalLegacyFlag: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-032-1-04-'));
    originalLegacyFlag = process.env.AUTONOMOUS_DEV_COST_CAP_LEGACY;
    delete process.env.AUTONOMOUS_DEV_COST_CAP_LEGACY;
  });

  afterEach(() => {
    if (originalLegacyFlag === undefined) {
      delete process.env.AUTONOMOUS_DEV_COST_CAP_LEGACY;
    } else {
      process.env.AUTONOMOUS_DEV_COST_CAP_LEGACY = originalLegacyFlag;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('Case A: successful deploy writes an HMAC-chained ledger entry', async () => {
    // capUsd=10, estimatedCost=5, no-op backend returns status 'deployed'
    const result = await runDeploy({ requestDir: tempDir, /* ... */, actor: 'tester' });
    expect(result.status).toBe('deployed');
    const ledger = await readLedger(tempDir);
    const entries = ledger.entries.filter(e => e.deployId === 'deploy-A');
    expect(entries).toHaveLength(1);
    expect(entries[0].chain).toMatch(/^[0-9a-f]{64}$/);
  });

  it('Case B: over-cap deploy emits cost-cap-exceeded telemetry', async () => {
    const telemetry = jest.fn();
    // capUsd=5, estimatedCost=50
    await expect(runDeploy({ /* ... */, telemetry })).rejects.toThrow(CostCapExceededError);
    const completionEvent = telemetry.mock.calls.find(c => c[0]?.type === 'deploy.completion');
    expect(completionEvent[0].outcome).toBe('cost-cap-exceeded');
    expect(completionEvent[0].reason).toMatch(/^DailyCostCapExceededError: /);
  });

  it('Case C: same deployId twice produces one ledger entry', async () => {
    await runDeploy({ /* ..., deployId: 'D-C' */ });
    await runDeploy({ /* ..., deployId: 'D-C' */ });
    const ledger = await readLedger(tempDir);
    expect(ledger.entries.filter(e => e.deployId === 'D-C')).toHaveLength(1);
  });

  it('Case D: legacy flag routes to shim and warns once', async () => {
    process.env.AUTONOMOUS_DEV_COST_CAP_LEGACY = '1';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await jest.isolateModulesAsync(async () => {
      const { runDeploy } = await import('@intake/deploy/orchestrator');
      await runDeploy({ /* ... */ });
      await runDeploy({ /* ... */ });
    });
    const shimWarnings = warnSpy.mock.calls
      .map(c => String(c[0]))
      .filter(s => s.includes('cost-cap.ts shim'));
    expect(shimWarnings).toHaveLength(1);
    warnSpy.mockRestore();
  });
});
```

Field names (`requestDir`, `costCapUsd`, etc.) and the no-op backend
fixture must match as-built code; align during implementation.

### Smoke procedure

```bash
# Local
npm test 2>&1 | tee /tmp/before.log     # on main BEFORE checkout
git checkout docs/specs-from-tdd-032
npm test 2>&1 | tee /tmp/after.log
diff <(grep -E 'Tests:|Suites:' /tmp/before.log) \
     <(grep -E 'Tests:|Suites:' /tmp/after.log)

# Then a real runDeploy invocation per TDD §10.3 against a no-op backend
# with costCapUsd=10 and estimatedCost=2. Expected:
#   - one HMAC-chained ledger entry written
#   - deploy.init + deploy.completion telemetry events emitted
#   - completion event's reason field uses the new richer shape
```

The smoke output (or a sanitized excerpt) is pasted into the closeout
PR description.

## Interfaces and Dependencies

**Consumes:**
- All upstream code from SPEC-032-1-01 / -02 / -03 (helper, cutover,
  shim).
- `runDeploy` public surface (now requires `actor`).
- `CostLedger` (for `aggregate` / read-after-write verification).
- `console.warn` spy (Case D).

**Produces:**
- Removal of `cost-cap.ts` from tree.
- `test-orchestrator-cost-cap.test.ts` integration test file (FR-1705).

**No new npm dependencies.**

## Acceptance Criteria

```
Given the file tree at HEAD on this branch
When `git ls-files plugins/autonomous-dev/intake/deploy/cost-cap.ts` runs
Then no output is returned (file deleted)

Given the file tree at HEAD
When `git grep -nE "from ['\"]\.{1,2}/cost-cap['\"]"` runs scoped to plugins/autonomous-dev
Then zero matches are returned

Given the file tree at HEAD
When `cd plugins/autonomous-dev && npx tsc --noEmit` runs
Then exit code is 0

Given Case A is run with capUsd=10, estimatedCost=5, no-op backend
When the test asserts on the ledger
Then exactly one entry exists for the test deployId
And that entry has a non-empty 64-char lowercase hex chain field

Given Case B is run with capUsd=5, estimatedCost=50
When runDeploy() is awaited
Then it rejects with CostCapExceededError
And exactly one deploy.completion telemetry event was emitted with outcome 'cost-cap-exceeded'
And that event's reason field starts with 'DailyCostCapExceededError: '

Given Case C runs runDeploy() twice with deployId='D-C'
When the test inspects the ledger
Then exactly one entry exists for 'D-C'

Given Case D sets AUTONOMOUS_DEV_COST_CAP_LEGACY='1'
And the orchestrator module is freshly imported via jest.isolateModulesAsync
When runDeploy() is invoked twice in the same isolated module load
Then console.warn is called exactly once with text matching /cost-cap\.ts shim/

Given the test runs
When the AUTONOMOUS_DEV_COST_CAP_LEGACY env var is inspected after each test case
Then it is restored to its pre-test value (or unset if originally unset)

Given baseline npm test output captured on main
And npm test output on this branch
When the diff is computed per TDD §10.2
Then the branch's pass count is greater than or equal to baseline
And the suite count is greater than or equal to baseline
And no test was skipped or xit'd that was not already skipped on main

Given the manual smoke command from TDD §10.3 has been executed
When the closeout PR description is reviewed
Then it includes the smoke command and a sanitized excerpt of the output
And the excerpt shows a non-empty HMAC chain field on the ledger entry
And the excerpt shows deploy.init and deploy.completion events
```

## Test Requirements

- **Integration matrix.** Cases A, B, C, D above. Each in its own
  `it` block.
- **Env hygiene.** `beforeEach`/`afterEach` MUST save and restore
  `AUTONOMOUS_DEV_COST_CAP_LEGACY` to prevent leak between cases.
- **Ledger isolation.** Use `fs.mkdtempSync` per test; `rmSync` in
  `afterEach`. No reliance on `~/.autonomous-dev`.
- **Module isolation for Case D.** Use `jest.isolateModulesAsync`
  (or equivalent) so the shim's module-level warning `Set` is fresh
  for that case.
- **Regression.** Baseline diff per TDD §10.2 is the gate.

## Implementation Notes

- The `cost-cap.ts` deletion is irreversible within this commit.
  Verify SPEC-032-1-03's shim is functional first by running the
  enforcer + shim test suites. If anything fails, fix forward in
  SPEC-032-1-03 — do not skip the deletion.
- If SPEC-032-1-01's audit found additional production callers
  beyond the orchestrator, this spec inherits the burden of
  re-pointing them. Document each in the PR description.
- The integration test imports `runDeploy` from the orchestrator
  module path used by the supervisor — likely an aliased
  `@intake/deploy/orchestrator` import. Use whatever path the
  existing orchestrator tests use for consistency.
- For Case D, `jest.isolateModulesAsync` was introduced in Jest 28.
  Project uses Jest 29 (`package.json` line 41). If the API is
  unavailable, fall back to `jest.isolateModules` with a sync entry
  point.
- The smoke step (FR-9) is manual; it does not block CI. It is a
  pre-merge confidence check.

## Rollout Considerations

- This commit is the highest-impact in PLAN-032-1. Stage it last in
  the closeout PR's commit order so reviewers can check earlier
  commits in isolation.
- Rollback plan: revert this commit. The deletion is undone; the
  helper / cutover / shim from earlier specs remain in tree but
  inert against the legacy code path because the orchestrator's
  legacy branch in SPEC-032-1-02 still routes through the
  (now-restored) shim.
- Per TDD §11 OQ-01, removal of the shim and the feature flag is a
  follow-up PRD; not owned by this spec.

## Effort Estimate

- Coding: 0.25 day (deletion + import re-pointing)
- Testing: 0.5 day (four-case integration matrix, env hygiene)
- Smoke + baseline: handled in PR description; ~0 incremental day
- Total: 0.75 day
