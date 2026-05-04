# SPEC-029-1-04: Harness Migration Batch C — frontmatter pipeline (3 medium files)

## Metadata
- **Parent Plan**: PLAN-029-1
- **Parent TDD**: TDD-029
- **Parent PRD**: PRD-016
- **Tasks Covered**: PLAN-029-1 Task 4 (Batch C — 3 medium files in `tests/pipeline/frontmatter/`)
- **Estimated effort**: 0.5 day (~1 hr per file mechanical conversion + setup-reshape verification)
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-029-1-04-harness-migration-batch-c-frontmatter-pipeline.md`
- **Depends on**: SPEC-029-1-01 (pattern); parallel-safe with SPEC-029-1-02 and SPEC-029-1-03

## Description
Convert the three frontmatter-pipeline `.test.ts` files (`id-generator.test.ts`, `parser.test.ts`, `validator.test.ts` under `tests/pipeline/frontmatter/`) from custom-harness `runTests()` IIFE to idiomatic jest. These files are categorised as **medium** complexity in TDD-029 §5.3 because they share fixture-directory init/teardown that the original `runTests` body performed at outer-scope; under jest, that init/teardown must be hoisted into explicit `beforeEach`/`afterEach` (or `beforeAll`/`afterAll`) hooks so each `it()` case sees the same fixture state the original `tests` array entries did.

Strategy A from TDD-029 §5.2 still applies: leave each `test_*` function body intact; the only structural change beyond replacing the `runTests` scaffold is the lifted setup/teardown. Each commit additionally records the `setup-reshape` decision in its body so reviewers can verify the lift is faithful.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/pipeline/frontmatter/id-generator.test.ts` | Modify | Replace `runTests()` IIFE; lift fixture init/teardown into `beforeEach`/`afterEach` (or `beforeAll`/`afterAll` per shape) |
| `plugins/autonomous-dev/tests/pipeline/frontmatter/parser.test.ts` | Modify | Same |
| `plugins/autonomous-dev/tests/pipeline/frontmatter/validator.test.ts` | Modify | Same |

Three file modifications, one commit per file.

## Implementation Details

### Per-file procedure (deviates from SPEC-029-1-01)

For each of the three files, in alphabetical order by path:

1. **Read the file end-to-end.** In addition to the SPEC-029-1-01 step-1 checklist, identify:
   - Module-level fixture creation (`const fixturesDir = ...`, `mkdirSync(...)`, etc.).
   - Init code in or above the `runTests` body: `await initFixtures()`, `seedDb()`, `writeFile(...)`.
   - Teardown code in or below the `runTests` body: `rmSync(..., { recursive: true })`, `await closeDb()`.
   - Whether init/teardown happens once-per-suite (constant fixtures) or once-per-test (mutable fixtures). The shape is observable by inspecting whether `test_*` functions assume a clean state on entry.

2. **Compute `pre` count.** Same definition as SPEC-029-1-01 step 2.

3. **Decide the lift target:**
   - If init runs once and the fixture is read-only across `test_*`: lift to `beforeAll` and teardown to `afterAll`.
   - If init runs once but each `test_*` mutates the fixture: lift to `beforeEach` and teardown to `afterEach`.
   - If unsure, default to `beforeEach`/`afterEach` (safer for cross-test isolation; jest pays the cost gladly).

4. **Rewrite the bottom-of-file harness.** Replace this shape:

   ```ts
   const fixturesDir = '/tmp/frontmatter-test';

   async function setup(): Promise<void> { mkdirSync(fixturesDir, { recursive: true }); /* seed files */ }
   async function teardown(): Promise<void> { rmSync(fixturesDir, { recursive: true, force: true }); }

   const tests = [test_a, test_b, test_c];

   async function runTests(): Promise<void> {
     await setup();
     let passed = 0, failed = 0;
     for (const test of tests) {
       try { await test(); passed++; } catch (err) { console.log(`FAIL: ${test.name} -- ${err}`); failed++; }
     }
     await teardown();
     console.log(`\nResults: ${passed}/${tests.length} passed, ${failed} failed`);
     if (failed > 0) process.exit(1);
   }
   runTests();
   ```

   With this:

   ```ts
   describe('FrontmatterIdGenerator', () => {
     beforeAll(async () => { await setup(); });
     afterAll(async () => { await teardown(); });

     it('generates ids for fresh frontmatter', async () => { await test_a(); });
     it('preserves existing ids', async () => { await test_b(); });
     it('rejects duplicate ids', async () => { await test_c(); });
   });
   ```

   (Use `beforeEach`/`afterEach` instead of `beforeAll`/`afterAll` if the lift target decision in step 3 was per-test.)

   Conversion rules (incremental over SPEC-029-1-01):
   - The `setup()` and `teardown()` functions stay declared. The hooks call them. Do NOT inline the bodies into the hooks.
   - If the original code interleaved init across the `runTests` body (e.g., `await setup(); for (...) { ... }; await teardown();`), the lift extracts the `await setup()` and `await teardown()` calls only. The loop body is gone (replaced by `it()` blocks).
   - Fixture-path constants stay at module scope.

5. **Side-effect import audit (FR-1606).** Same as SPEC-029-1-01 step 4.

6. **Per-file isolation check.** Run `npx jest <path> --runInBand` per file. Plus an explicit re-run check: run the file twice in a row (`npx jest <path> --runInBand && npx jest <path> --runInBand`). The second run must produce the same summary as the first (no leftover fixture state breaks the second run). This guards against teardown gaps.

7. **Compute `post` count.** Same as SPEC-029-1-01 step 6. The `setup()`/`teardown()` function calls in the hooks do NOT count toward `post` (they were not assertions in the original).

8. **Verify `pre === post`.** Same as SPEC-029-1-01 step 7.

9. **Commit.** Format:

   ```
   refactor(test-harness): convert tests/pipeline/frontmatter/<file>.test.ts to idiomatic jest

   Replace top-level runTests() IIFE with describe/it blocks. Lift fixture
   setup/teardown from outer-scope runTests body into beforeAll/afterAll
   (or beforeEach/afterEach) hooks. test_* function bodies unchanged.
   Removes process.exit(1) so the suite no longer crashes the jest worker.

   preserved-assertions: <pre> -> <post>
   side-effect-imports: <list-or-none>
   setup-reshape: lifted setup() into beforeAll, teardown() into afterAll [or specifics]

   Refs PRD-016 FR-1601, FR-1602, FR-1603, FR-1606; TDD-029 §5; PLAN-029-1 Task 4.
   ```

### File-by-file specifics

| File | Suite name | Expected lift |
|------|------------|---------------|
| `id-generator.test.ts` | `FrontmatterIdGenerator` | Probably `beforeAll`/`afterAll` (id-gen tests typically read fixtures, don't mutate). Verify by inspecting whether any `test_*` writes to fixturesDir. |
| `parser.test.ts` | `FrontmatterParser` | `beforeAll`/`afterAll`; pure parser, fixtures are read-only. |
| `validator.test.ts` | `FrontmatterValidator` | Likely `beforeEach`/`afterEach` if any `test_*` writes a candidate fixture and validates, then expects a clean slate next round. Inspect carefully. |

If inspection shows the lift target was wrong (e.g., `beforeAll` chosen but `test_*_b` corrupts the fixture so `test_*_c` fails), revert the local change and re-apply with `beforeEach`/`afterEach`. Document the change-of-mind in the commit body.

### Fixture-leak deliberate-failure check

Acceptance criterion (below) requires verifying that a deliberate test failure does not leave the fixture directory behind. Procedure:

1. Apply the migration locally on `id-generator.test.ts`.
2. Insert a temporary `throw new Error('deliberate')` into the first `it()`.
3. Run `npx jest <path> --runInBand`. Confirm the first `it` reports failure.
4. Inspect the fixture directory location (e.g., `/tmp/frontmatter-test`). It MUST be cleaned (the `afterAll` hook still runs even after a failure unless the failure was inside `beforeAll` itself).
5. Remove the temporary throw, recommit nothing of the deliberate change.

If step 4 shows leftover state, the lift target was wrong: use `afterEach` instead of `afterAll` so cleanup runs after every test regardless of failure. Document the change in `setup-reshape:`.

### What NOT to do

- Do NOT inline `setup()` or `teardown()` function bodies into hooks. Keep the function declarations; hooks just call them.
- Do NOT change the original `setup()`/`teardown()` semantics (no parameter additions, no early-return guards).
- Do NOT widen test coverage. The migration preserves the existing assertion set.
- Do NOT rewrite `assert(...)` to `expect(...)`.
- Do NOT migrate `tests/intake/core/shutdown.test.ts` here. (PLAN-029-1 originally mentioned it as Batch B-medium; this spec scopes Batch C to frontmatter pipeline only because shutdown.test.ts uses module-side-effect `register()` calls that need separate inspection. If shutdown.test.ts is genuinely medium-complexity it can be folded into a follow-up; this spec is intentionally narrow.)
- Do NOT squash the three commits.

## Acceptance Criteria

- [ ] All three files have their `runTests()` IIFE replaced by a single `describe(...)` block with appropriate `beforeAll`/`afterAll` (or `beforeEach`/`afterEach`) hooks.
- [ ] `git grep -n "process\.exit" plugins/autonomous-dev/tests/pipeline/frontmatter/` returns zero hits.
- [ ] `git grep -n "runTests()" plugins/autonomous-dev/tests/pipeline/frontmatter/` returns zero hits.
- [ ] Three commits exist on the branch, one per file.
- [ ] Each commit body contains `preserved-assertions: <pre> -> <post>` with equal numbers.
- [ ] Each commit body contains a `side-effect-imports:` line.
- [ ] Each commit body contains a `setup-reshape:` line describing which init/teardown was lifted into which jest lifecycle hook.
- [ ] Each commit body references `Refs PRD-016 FR-1601, FR-1602, FR-1603, FR-1606; TDD-029 §5; PLAN-029-1 Task 4.`
- [ ] `npx jest plugins/autonomous-dev/tests/pipeline/frontmatter/<file>.test.ts --runInBand` produces a jest pass/fail summary for each file (worker crash is a fail; failing `it` cases are acceptable).
- [ ] Running the same file twice in a row (`npx jest <path> --runInBand && npx jest <path> --runInBand`) produces consistent summaries (no fixture-leak across runs).
- [ ] Fixture-leak deliberate-failure check (per §Implementation Details): a deliberate `throw` inside an `it()` does not leave fixture directories behind on disk.
- [ ] `npx jest plugins/autonomous-dev/tests/pipeline/frontmatter --runInBand` runs to a cumulative summary.
- [ ] No `test_*` function body is modified.
- [ ] No new test files; no deleted test files.
- [ ] No production-code files modified.

## Dependencies

- **Blocked by**: none structurally; conceptually follows SPEC-029-1-01 conversion pattern.
- **Parallel-safe with**: SPEC-029-1-02 and SPEC-029-1-03.
- **Blocks**: SPEC-029-1-05 (Batch D complex + verification) — needs the medium category cleared so the only remaining harness file is `runtime.test.ts`.
- **Blocks**: SPEC-029-2-*, SPEC-029-3-*.

## Notes

- The frontmatter pipeline tests are paired with the production code in `src/pipeline/frontmatter/`. None of that production code is touched by this spec.
- The lift target choice (`beforeAll` vs `beforeEach`) is the single most consequential decision per file. Defaulting to `beforeEach` is the safe choice; promote to `beforeAll` only if the fixtures are demonstrably read-only across all `test_*` in the file. The cost of a wrong-direction choice is cross-test interference which surfaces as flake.
- The fixture-leak deliberate-failure check is the spec's most important runtime gate. Without it, a `beforeAll`/`afterAll` lift can pass clean runs but leak on a real failure, producing a confusing second-run failure later.
- `tests/intake/core/shutdown.test.ts` is NOT in scope here. If subsequent inspection determines it needs the same medium-complexity treatment, a follow-up SPEC-029-1-04b or fold-in to SPEC-029-1-05 can address it. The spec is intentionally narrow to keep the "medium" category to a single review-able directory.
- Commit ordering is alphabetical-by-path: `id-generator`, `parser`, `validator`.
