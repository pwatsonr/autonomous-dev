# SPEC-029-1-03: Harness Migration Batch B continued — agent-factory/improvement (6 files)

## Metadata
- **Parent Plan**: PLAN-029-1
- **Parent TDD**: TDD-029
- **Parent PRD**: PRD-016
- **Tasks Covered**: PLAN-029-1 Task 3 (Batch B sub-batch — 6 files in `tests/agent-factory/improvement/`)
- **Estimated effort**: 1 day (~6 × 30 min mechanical conversion + ~30 min review/verify per file)
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-029-1-03-harness-migration-batch-b-improvement.md`
- **Depends on**: SPEC-029-1-01 (pattern), SPEC-029-1-02 (sibling agent-factory base; can run in parallel)

## Description
Convert the six `tests/agent-factory/improvement/*.test.ts` files from custom-harness `runTests()` IIFE to idiomatic jest `describe`/`it`/`expect`. Same Strategy-A mechanical recipe as SPEC-029-1-01 and SPEC-029-1-02. The directory is split out as its own spec because: (a) the six files form a self-contained sub-module with its own review-able boundary, (b) several of these suites are explicitly named in PRD-016 FR-1614 as expected post-migration triage targets, and (c) `proposer.test.ts` and `meta-reviewer.test.ts` interact with shared rate-limit and cooldown state that may surface side-effect imports.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/agent-factory/improvement/meta-reviewer.test.ts` | Modify | Replace `runTests()` IIFE; inspect for cooldown-clock side-effects |
| `plugins/autonomous-dev/tests/agent-factory/improvement/observation-trigger.test.ts` | Modify | Same |
| `plugins/autonomous-dev/tests/agent-factory/improvement/proposer.test.ts` | Modify | Same; named in PRD-016 FR-1614 expected-FAIL list |
| `plugins/autonomous-dev/tests/agent-factory/improvement/rate-limiter.test.ts` | Modify | Same; uses real or mocked timers — note in commit body |
| `plugins/autonomous-dev/tests/agent-factory/improvement/version-classifier.test.ts` | Modify | Same; pure-function shape expected |
| `plugins/autonomous-dev/tests/agent-factory/improvement/weakness-report-store.test.ts` | Modify | Same; uses tmp dir fixtures — note cleanup in commit body |

Six file modifications, one commit per file (no squash).

## Implementation Details

### Per-file procedure

Identical to SPEC-029-1-01 §Implementation Details `Per-file procedure` steps 1–8 (read, count `pre`, rewrite, side-effect audit, isolation check, count `post`, verify equal, commit). The full text of each step is not repeated here; refer to SPEC-029-1-01.

Commit message format:

```
refactor(test-harness): convert tests/agent-factory/improvement/<file>.test.ts to idiomatic jest

Replace top-level runTests() IIFE with describe/it blocks. Each former
tests-array entry becomes an it() that delegates to its test_* function.
Removes process.exit(1) so the suite no longer crashes the jest worker.

preserved-assertions: <pre> -> <post>
side-effect-imports: <list-or-none>
[setup-reshape: <description>]   <-- only if a beforeEach/afterEach guard was added

Refs PRD-016 FR-1601, FR-1602, FR-1603; TDD-029 §5; PLAN-029-1 Task 3.
```

### File-by-file specifics

| File | Suite name | Notes |
|------|------------|-------|
| `meta-reviewer.test.ts` | `MetaReviewer` | Inspect for cooldown-clock or `Date.now` mocks. If the original `runTests` set `jest.useFakeTimers()` (unlikely under harness pattern) or installed a `Date.now` shim, hoist that into a `beforeAll`/`afterAll` and document via `setup-reshape:`. |
| `observation-trigger.test.ts` | `ObservationTrigger` | Likely a flat-functions suite. |
| `proposer.test.ts` | `ImprovementProposer` | **PRD-016 FR-1614 names this suite as a known FAIL.** A failing `it()` after migration is expected; do NOT fix the underlying defect (out of scope per NG-2902). The triage matrix (SPEC-029-2-02) will categorise it as `regression` or `harness-residue`. |
| `rate-limiter.test.ts` | `RateLimiter` | If the suite uses real timers (`setTimeout` / `setInterval`), check whether jest's default fake-timer behavior interacts. If the original was wall-clock-dependent and now flakes under jest, add `jest.setTimeout(<ms>)` per-`it` or `jest.useRealTimers()` in a `beforeAll`. Document via `setup-reshape:`. |
| `version-classifier.test.ts` | `VersionClassifier` | Pure-function suite expected. Lowest-risk file. |
| `weakness-report-store.test.ts` | `WeaknessReportStore` | Uses tmpdir fixtures. If the original `runTests` had top-level `mkdtempSync` and per-test cleanup inside each `test_*`, leave the structure intact (per-test cleanup keeps working under `it`). If the cleanup was at the bottom of `runTests`, hoist into `afterAll`. Document via `setup-reshape:`. |

### Timer / clock guards (rate-limiter.test.ts)

If `rate-limiter.test.ts` uses `jest.useFakeTimers()` inside any `test_*` function, leave that call in place — jest's fake timers are scoped to the worker, not the test. If the suite ran reliably under harness with real timers but flakes under jest, the fix is:

```ts
describe('RateLimiter', () => {
  beforeAll(() => {
    jest.useRealTimers();
  });

  // ...
});
```

Apply this guard ONLY if a flake is observed during the per-file isolation check (§Per-file procedure step 5). If the suite passes consistently, do NOT add the guard. Premature timer manipulation is a TDD-029 §5.2 Strategy-A violation.

### Tmpdir cleanup (weakness-report-store.test.ts)

If the original `runTests` did per-iteration `mkdtempSync`/`rmSync` cleanup at the *outer* loop level (i.e., the `runTests` body, not each `test_*`), the cleanup is lost when the `runTests` body is replaced by jest. Mitigation:

```ts
describe('WeaknessReportStore', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weakness-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('...', async () => { await test_*(/* pass tmpDir somehow */); });
  // ...
});
```

If the `test_*` functions take a `tmpDir` parameter, thread it through. If they don't (likely — they create their own tmpdirs), leave the structure as-is and rely on jest's process-scoped cleanup at worker exit. Document the choice in `setup-reshape:`.

### What NOT to do

- Do NOT fix any failing `it()` cases. Failing tests in `proposer.test.ts` (or any other named-in-FR-1614 file) are tracked by SPEC-029-2-02, not this spec.
- Do NOT rewrite `assert(...)` to `expect(...)`.
- Do NOT inline `test_*` function bodies.
- Do NOT add new test cases.
- Do NOT preemptively add timer guards or tmpdir guards. Add only if a per-file isolation run actually shows the failure mode the guard addresses.

## Acceptance Criteria

- [ ] All six files have their `runTests()` IIFE replaced by a single `describe(...)` block.
- [ ] `git grep -n "process\.exit" plugins/autonomous-dev/tests/agent-factory/improvement/` returns zero hits.
- [ ] `git grep -n "runTests()" plugins/autonomous-dev/tests/agent-factory/improvement/` returns zero hits.
- [ ] Six commits exist on the branch, one per file, in alphabetical-by-path order.
- [ ] Each commit body contains `preserved-assertions: <pre> -> <post>` with equal numbers.
- [ ] Each commit body contains a `side-effect-imports:` line.
- [ ] Where a `setup-reshape` (timer guard, tmpdir guard, env restore) was applied, the commit body contains a `setup-reshape:` line describing the change with one or two sentences.
- [ ] Each commit body contains the reference suffix `Refs PRD-016 FR-1601, FR-1602, FR-1603; TDD-029 §5; PLAN-029-1 Task 3.`
- [ ] `npx jest plugins/autonomous-dev/tests/agent-factory/improvement/<file>.test.ts --runInBand` produces a jest pass/fail summary for each of the six files individually (worker crash is a fail; failing `it` cases are acceptable).
- [ ] `npx jest plugins/autonomous-dev/tests/agent-factory/improvement --runInBand` runs to a cumulative pass/fail summary.
- [ ] `proposer.test.ts` may have failing `it` cases (expected per PRD-016 FR-1614); the spec's acceptance is the worker-no-crash, not the all-green outcome.
- [ ] No `test_*` function body is modified.
- [ ] No new test files; no deleted test files.
- [ ] No production-code files modified.

## Dependencies

- **Blocked by**: none structurally; conceptually depends on SPEC-029-1-01 establishing the conversion pattern.
- **Parallel-safe with**: SPEC-029-1-02 (different directory; same review pattern).
- **Blocks**: SPEC-029-2-* (triage matrix) — `proposer.test.ts` failures need to land in the matrix; SPEC-029-3-* (CI gate) — needs `process.exit` absent here.

## Notes

- The six `improvement/` suites cover the agent-factory's self-improvement loop: meta-review, observation triggers, rate-limiting, classification, proposing, and weakness reporting. They share helpers and registry state with the base agent-factory suite (SPEC-029-1-02), but each `*.test.ts` runs in its own jest worker, so cross-file state leakage is not a concern at this layer.
- `proposer.test.ts` and `meta-reviewer.test.ts` are the highest-information files in this batch — both interact with cooldown windows and rate-limit windows that have wall-clock semantics. If a per-file isolation run reveals a hang or timeout, the most likely root cause is a `setTimeout(..., realDuration)` that the harness pattern absorbed silently. Document and add the `jest.useRealTimers()` or `jest.setTimeout(<ms>)` guard, but do not change the assertion logic.
- `weakness-report-store.test.ts`'s tmpdir handling is the most likely place to need a `beforeEach`/`afterEach` reshape. Inspect carefully; mis-applied cleanup can cause cross-test interference even though jest's worker isolation usually masks it.
- After this spec lands, the only `process.exit` calls remaining under `tests/agent-factory/` are in `runtime.test.ts` (handled by SPEC-029-1-05). After SPEC-029-1-05 lands, the entire `tests/agent-factory/` tree is harness-free.
- Commit ordering: alphabetical-by-path within the directory: `meta-reviewer`, `observation-trigger`, `proposer`, `rate-limiter`, `version-classifier`, `weakness-report-store`.
