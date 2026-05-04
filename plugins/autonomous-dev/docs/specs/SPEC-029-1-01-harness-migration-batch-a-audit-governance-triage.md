# SPEC-029-1-01: Harness Migration Batch A — audit + governance + triage (7 files)

## Metadata
- **Parent Plan**: PLAN-029-1 (Custom-Harness Migration to Idiomatic Jest)
- **Parent TDD**: TDD-029 (Jest Harness Migration, Failure Triage, and CI Gate Hardening)
- **Parent PRD**: PRD-016 (Test-Suite Stabilization & Jest Harness Migration)
- **Tasks Covered**: PLAN-029-1 Task 1 (Batch A — 7 files in `tests/audit/`, `tests/governance/`, `tests/triage/`)
- **Estimated effort**: 1.5 days (~7 × 30 min mechanical conversion + ~30 min review/verify per file)
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-029-1-01-harness-migration-batch-a-audit-governance-triage.md`
- **Depends on**: none (foundation batch; no other SPEC-029 work blocks it)

## Description
Convert the seven simplest custom-harness `.test.ts` files in `plugins/autonomous-dev/tests/audit/`, `tests/governance/`, and `tests/triage/` from a top-level `runTests()` IIFE pattern into idiomatic jest `describe` / `it` / `expect` blocks. Each conversion preserves the file's assertion set 1:1 per PRD-016 FR-1603, leaves each `test_*` function body untouched (Strategy A from TDD-029 §5.2), and removes the trailing `process.exit(1)` so jest's worker pool no longer crashes mid-run.

This spec is **mechanical**: the only logic change per file is replacing the `tests = [...]` array and `runTests()` IIFE with a single `describe(...)` block whose `it(...)` cases delegate to the existing `test_*` functions. It does NOT rewrite `assert(...)` to `expect(...)` (that is a TDD-029 phase-2 follow-up per OQ-29-02), does NOT widen coverage (PRD-016 NG-02), and does NOT touch production code. The seven files in this batch all share the simplest harness shape — no shared fixture state, no daemon orchestration — so they are the lowest-risk lead-in for the broader migration.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/audit/decision-replay.test.ts` | Modify | Replace `runTests()` IIFE with `describe`/`it` block |
| `plugins/autonomous-dev/tests/audit/hash-chain.test.ts` | Modify | Same |
| `plugins/autonomous-dev/tests/audit/hash-verifier.test.ts` | Modify | Same |
| `plugins/autonomous-dev/tests/audit/log-archival.test.ts` | Modify | Canonical example from TDD-029 §5.1; line ~644 `if (failed > 0) process.exit(1)` is the smoking gun |
| `plugins/autonomous-dev/tests/governance/cooldown.test.ts` | Modify | Same |
| `plugins/autonomous-dev/tests/governance/oscillation.test.ts` | Modify | Same |
| `plugins/autonomous-dev/tests/triage/notification.test.ts` | Modify | Same |

Seven file modifications, one commit per file (no squash).

## Implementation Details

### Per-file procedure

For each of the seven files, in alphabetical order by path:

1. **Read the file end-to-end.** Identify:
   - The `tests` array (typically near the bottom of the file).
   - The `runTests()` (or renamed equivalent) IIFE.
   - The trailing `if (failed > 0) process.exit(1);` and the bare `runTests();` invocation.
   - Any local `function assert(condition: boolean, message: string): void { ... }` helper. Leave it intact.
   - Any imports with no in-file reference (candidate side-effect imports per FR-1606; flag for step 4).

2. **Compute `pre` count.** In the original `runTests` body and the test functions it iterates, count:
   - Each `assert(...)` call site.
   - Each `if (...failed...)` early-return-style check.
   - Each `throw new Error(...)` site reached during a test path.

   Concretely, `grep -cE "assert\(|throw new Error\(" <file>` gives a usable upper bound; the manual recount disambiguates `assert` vs unrelated identifiers. Record as `pre`.

3. **Rewrite the bottom-of-file harness.** Replace this shape:

   ```ts
   const tests = [
     test_archive_old_events,
     test_no_events_to_archive,
     // ...
   ];

   async function runTests(): Promise<void> {
     let passed = 0;
     let failed = 0;
     for (const test of tests) {
       try { await test(); passed++; }
       catch (err) { console.log(`FAIL: ${test.name} -- ${err}`); failed++; }
     }
     console.log(`\nResults: ${passed}/${tests.length} passed, ${failed} failed`);
     if (failed > 0) process.exit(1);
   }
   runTests();
   ```

   With this:

   ```ts
   describe('LogArchival (SPEC-009-5-3, Task 6)', () => {
     it('archives old events', async () => { await test_archive_old_events(); });
     it('handles no events to archive', async () => { await test_no_events_to_archive(); });
     // ... one it() per former tests-array entry, in the same order
   });
   ```

   Conversion rules:
   - **Suite name** = the file's existing top-of-file comment header (e.g., `LogArchival (SPEC-009-5-3, Task 6)`). If absent, use `<PascalCaseFromFilename> (<spec-id>)` and grep the SPEC reference from existing comments.
   - **`it()` description** = the `test_*` function name minus the `test_` prefix, snake_case → space-separated (`test_archive_old_events` → `archives old events`). If a `// ` comment precedes the function declaration with a higher-quality phrasing, prefer that.
   - **`it()` body** = `async () => { await test_*(); }` (or non-async if the original is sync). Do NOT inline the function body.
   - **Order** = same as the original `tests` array (sequential within `describe` is jest's default).
   - **Remove** the `tests` array, the `runTests()` declaration, the `runTests();` invocation, and the trailing `process.exit`.

4. **Side-effect import audit (FR-1606).** Scan the file's top-level `import` lines. For each import where the imported binding is never referenced elsewhere in the file:
   - If the import is a relative path (`'./register-side-effect'`) AND the imported module has a side-effect register call, hoist it:
     ```ts
     // BEFORE
     import './register-side-effect';
     // AFTER
     import { register } from './register-side-effect';
     beforeAll(() => { register(); });
     ```
   - If the imported module exposes no callable side-effect entry point, leave the import untouched and add a one-line comment: `// side-effect-only import: <reason>`.
   - Record any hoisting decisions for the commit body.

5. **Per-file isolation check.** Run:
   ```
   $ npx jest plugins/autonomous-dev/tests/<path>/<file>.test.ts --runInBand
   ```
   Expected outcome: jest prints a pass/fail summary. The suite MAY have failing `it()` cases — those are dispositioned by PLAN-029-2 (SPEC-029-2-*). The suite MUST NOT crash the worker. If jest reports `Worker terminated due to reaching timeout` or `Test suite failed to run`, the conversion is broken and step 3 must be revisited before commit.

6. **Compute `post` count.** In the migrated file:
   - Count each `it(` call.
   - Count each `expect(` call inside `it` bodies.
   - Count each surviving `assert(` call inside the unchanged `test_*` function bodies.
   - Sum to `post`.

7. **Verify `pre === post`.** A mismatch means an assertion was lost (FR-1603 violation). The most common mismatch source: a `for (const x of arr) assert(...)` loop that originally yielded N runtime assertions; structurally that still counts as 1 `assert(` site, so the count is preserved as long as the loop stays inside `test_*`. Loops moved out of `test_*` cause silent assertion drop — do not move them.

8. **Commit.** One commit per file. Commit message format:

   ```
   refactor(test-harness): convert tests/audit/log-archival.test.ts to idiomatic jest

   Replace top-level runTests() IIFE with describe/it blocks. Each former
   tests-array entry becomes an it() that delegates to its test_* function.
   Removes process.exit(1) so the suite no longer crashes the jest worker.

   preserved-assertions: 11 -> 11
   side-effect-imports: none

   Refs PRD-016 FR-1601, FR-1602, FR-1603; TDD-029 §5; PLAN-029-1 Task 1.
   ```

   The `preserved-assertions:` line is mandatory (FR-1603). The `side-effect-imports:` line lists hoisted imports or `none`.

### File-by-file specifics

| File | Existing suite name (from header comment) | Notes |
|------|-------------------------------------------|-------|
| `tests/audit/decision-replay.test.ts` | `DecisionReplay` (per SPEC reference at top) | No known side-effect imports |
| `tests/audit/hash-chain.test.ts` | `HashChain` | No known side-effect imports |
| `tests/audit/hash-verifier.test.ts` | `HashVerifier` | No known side-effect imports |
| `tests/audit/log-archival.test.ts` | `LogArchival (SPEC-009-5-3, Task 6)` | Canonical reference example; 11 test functions per the visible bottom-of-file array |
| `tests/governance/cooldown.test.ts` | `CooldownGovernance` | Inspect for any policy-registry imports |
| `tests/governance/oscillation.test.ts` | `OscillationGovernance` | Inspect for any policy-registry imports |
| `tests/triage/notification.test.ts` | `TriageNotification` | Inspect for any notification-channel side-effects |

If a header comment is missing or unclear, the implementer chooses a plain PascalCase suite name and notes the choice in the commit body.

### What NOT to do

- Do NOT rewrite `assert(condition, message)` calls to `expect(condition).toBe(true)`. That is OQ-29-02 phase 2 and is out of scope for this spec.
- Do NOT inline the bodies of `test_*` functions into `it()` blocks. The 1:1 mapping is by structure; inlining changes the count.
- Do NOT delete or rename the file-local `function assert(...)` helper.
- Do NOT add new test cases, new fixtures, or new helpers.
- Do NOT squash the seven commits into one. Per-file granularity is the review unit.
- Do NOT reorder `it()` blocks relative to the original `tests` array order.

## Acceptance Criteria

- [ ] All seven files have their `runTests()` IIFE replaced by a single `describe(...)` block per the §Implementation Details rewrite shape.
- [ ] `git grep -n "process\.exit" plugins/autonomous-dev/tests/audit plugins/autonomous-dev/tests/governance plugins/autonomous-dev/tests/triage` returns zero hits.
- [ ] `git grep -n "runTests()" plugins/autonomous-dev/tests/audit plugins/autonomous-dev/tests/governance plugins/autonomous-dev/tests/triage` returns zero hits.
- [ ] `git grep -n "const tests = \[" plugins/autonomous-dev/tests/audit plugins/autonomous-dev/tests/governance plugins/autonomous-dev/tests/triage` returns zero hits (the `tests` array is removed).
- [ ] Seven commits exist on the branch, one per file, in alphabetical-by-path order.
- [ ] Each commit body contains a line matching `^preserved-assertions: \d+ -> \d+$` and the two numbers are equal.
- [ ] Each commit body contains a `side-effect-imports:` line listing hoisted imports or `none`.
- [ ] Each commit body contains the reference suffix `Refs PRD-016 FR-1601, FR-1602, FR-1603; TDD-029 §5; PLAN-029-1 Task 1.`
- [ ] `npx jest plugins/autonomous-dev/tests/audit/decision-replay.test.ts --runInBand` produces a jest pass/fail summary (no worker crash).
- [ ] Same for `hash-chain.test.ts`, `hash-verifier.test.ts`, `log-archival.test.ts`, `cooldown.test.ts`, `oscillation.test.ts`, `notification.test.ts`.
- [ ] `npx jest plugins/autonomous-dev/tests/audit plugins/autonomous-dev/tests/governance plugins/autonomous-dev/tests/triage --runInBand` runs to a summary (PASS or FAIL of individual `it` cases is acceptable; worker crash is not).
- [ ] No `test_*` function body is modified by any commit in this batch (verified by `git diff --stat` showing the change region is bounded to the bottom-of-file harness).
- [ ] No new test files are added; no test files are deleted.
- [ ] No production-code files (`src/**`) are modified by any commit in this batch.

## Dependencies

- **Blocked by**: none. Foundation batch.
- **Blocks**: SPEC-029-1-02 (Batch B agent-factory base), SPEC-029-1-03 (Batch B improvement), SPEC-029-1-04 (Batch C medium), SPEC-029-1-05 (Batch D complex + verification). All four downstream specs assume the audit/governance/triage subset is already idiomatic so cumulative jest runs against `tests/<dir>` are usable as smoke tests.
- **Blocks**: SPEC-029-2-* (triage matrix) — needs the subset's failure list folded into the post-migration log captured in PLAN-029-1 Task 6.
- **Blocks**: SPEC-029-3-* (CI gate) — the gate requires `process.exit` already absent from this subset.

## Notes

- The seven files in this batch were chosen because each one's `runTests()` block iterates a flat `tests` array of `() => Promise<void>` functions with no setup/teardown around the iteration. That shape converts mechanically; medium and complex shapes (frontmatter pipeline, runtime.test.ts) get their own specs (SPEC-029-1-04, SPEC-029-1-05) because they need explicit `beforeEach`/`afterEach` placement.
- The `function assert(...)` helper survives this pass intentionally. TDD-029 §5.2 Strategy A keeps the diff minimal and the FR-1603 1:1 mapping trivially verifiable. Strategy B (`assert` → `expect`) is queued as a post-merge follow-up where reviewers can audit both passes side-by-side.
- A failing `it()` case in any of the seven migrated files is expected and acceptable for THIS spec's acceptance. The triage pass (SPEC-029-2-*) handles disposition. Until then, the batch's success criterion is "the worker no longer crashes," not "every test passes."
- If `log-archival.test.ts` or any other file shows assertion counts that do not match between pre and post, the implementer must revert the local change, recount, and re-apply. Do NOT commit a `pre != post` migration with a hand-waved explanation.
- The `Suite name` choices (e.g., `LogArchival (SPEC-009-5-3, Task 6)`) are author-chosen but reviewer-checked. They appear in jest's summary output as the top-level group; downstream tooling (jest-junit XML in SPEC-029-3-03) keys per-suite results by this string.
- Any `import './foo'` line that the file's body never references is a side-effect import candidate. Review docs in TDD-029 §5.5 and the FR-1606 description before deciding to hoist; some imports register middleware that MUST run before any test body executes, in which case `beforeAll(() => register())` is required.
- Commit ordering is alphabetical-by-path within the batch, not by complexity. This makes review predictable and lets a reviewer skim seven adjacent commits with the same diff shape.
