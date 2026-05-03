# PLAN-029-1: Custom-Harness Migration to Idiomatic Jest

| Field                | Value                                                              |
|----------------------|--------------------------------------------------------------------|
| **Parent TDD**       | TDD-029: Jest Harness Migration, Failure Triage, and CI Gate       |
| **Parent PRD**       | PRD-016: Test-Suite Stabilization & Jest Harness Migration         |
| **Plan ID**          | PLAN-029-1                                                         |
| **Version**          | 1.0                                                                |
| **Date**             | 2026-05-02                                                         |
| **Status**           | Draft                                                              |
| **Priority**         | P0                                                                 |
| **Estimated effort** | 5 days (~24 engineer-hours of mechanical conversion + review)      |
| **Sibling plans**    | PLAN-029-2 (triage matrix), PLAN-029-3 (CI gate)                   |

## Objective

Convert all 24 custom-harness `.test.ts` files in `plugins/autonomous-dev/tests/**` to idiomatic
jest (`describe` / `it` / `expect`), eliminating every `process.exit()` call from test code so
that `npx jest --runInBand` from `plugins/autonomous-dev/` runs to completion and prints a full
pass/fail summary. Each conversion preserves the original assertion set 1:1 (FR-1603) and is
landed as a single, mechanically reviewable commit whose body records the pre/post assertion
count. This plan delivers the foundation that PLAN-029-2 (triage) and PLAN-029-3 (CI gate)
build on; until it merges, the jest baseline remains broken and no other test work is safely
verifiable.

## Scope

### In Scope

- 24 harness `.test.ts` files split into three batches by complexity per TDD-029 §5.3
- Per-file commit discipline per FR-1603: each commit body records
  `preserved-assertions: <pre> -> <post>` (the count of `assert(`, `if (...failed...)`, and
  `throw new Error(` sites in the original `runTests` body vs. the count of `it(` /
  `expect(` / `assert(` sites in the migrated file). Mismatches block review.
- Strategy A from TDD-029 §5.2: keep the file-local `assert()` helper as-is; convert the
  outer `runTests()` IIFE to `describe`/`it`/`async () => { await test_*(); }` blocks. No
  rewriting of `assert(...)` -> `expect(...)` in this PR (that is TDD-029 phase 2 follow-up,
  per OQ-29-02).
- Implicit-side-effect imports flagged per FR-1606: any `import './x'` with no other
  reference in the file becomes an explicit `beforeAll(() => { register(); })` call.
- Per-file isolation: after each commit, `npx jest <path-to-file>` runs to a jest summary
  (FR-1605). Suite may PASS or FAIL but it must not crash the worker.
- After all 24 files migrate, `git grep -n "process\.exit" plugins/autonomous-dev/tests`
  returns zero hits.
- After all 24 files migrate, `git grep -n "runTests()" plugins/autonomous-dev/tests`
  returns zero hits (acceptance for PRD-016 FR-1601).

### Out of Scope

- Authoring `docs/triage/PRD-016-test-failures.md` and dispositioning the now-visible
  FAIL suites — delivered by **PLAN-029-2**.
- ESLint `no-restricted-syntax` rule, CI grep step, `--ci` flag wiring, JUnit XML
  reporter, `tests/_meta/test-no-process-exit.test.ts` — delivered by **PLAN-029-3**.
- Strategy B (`assert(x, m)` -> `expect(x).toBe(true)`) rewrite — explicitly deferred to
  TDD-029 phase 2 per §5.2.
- Production code changes for any FAIL suite that turns out to be a real regression
  (PRD-016 NG-01: regression fixes ship as separate small PRs referencing PRD-016).
- TDD-014 security test backfill, TDD-015 portal pipeline closeout, TDD-019 plugin-reload
  CLI closeout — owned by TDD-030.
- SPEC reconciliation (path-drift, Vitest, Bats) — owned by TDD-031.
- Sharding the jest run for performance — only required if the post-migration run
  exceeds the GitHub Actions job timeout (TDD-029 §8.3).

## Tasks

The 24 files are grouped into three batches that map to TDD-029 §5.3's complexity tiers
(simple / medium / complex). Each batch is a sequential block of small commits; the
batches themselves can be reviewed independently.

### Task 1 — Batch A: Simple harness files, audit + governance + triage (7 files)

Convert the seven files where the harness is a linear `tests` array of independent
functions and there is no shared setup/teardown. Order by alphabetical path so reviewers
can diff sequentially.

Files:

- `tests/audit/decision-replay.test.ts`
- `tests/audit/hash-chain.test.ts`
- `tests/audit/hash-verifier.test.ts`
- `tests/audit/log-archival.test.ts` (the canonical example from TDD-029 §5.1; line 644
  `if (failed > 0) process.exit(1);` is the smoking gun)
- `tests/governance/cooldown.test.ts`
- `tests/governance/oscillation.test.ts`
- `tests/triage/notification.test.ts`

Per-file procedure:

1. Read the file. Count `assert(`, `if (...failed...)`, `throw new Error(` sites in the
   original `runTests` body. Record as `pre`.
2. Replace the `tests = [test_a, test_b, ...]` array and `runTests()` IIFE with a single
   `describe('<SuiteName>', () => { it('<case-from-fn-name>', async () => { await
   test_a(); }); ... });` block. Leave each `test_*` function body intact.
3. Remove the `runTests()` invocation and the trailing `if (failed > 0) process.exit(1);`.
4. If the file's only top-level imports are obviously side-effect-only (no other use of
   the imported binding), hoist them into a `beforeAll(() => register())` per FR-1606.
   Otherwise leave imports untouched.
5. Run `npx jest <path-to-file>`; the suite must produce a jest pass/fail summary (it
   need not pass — failing suites are dispositioned by PLAN-029-2).
6. Count `it(` and `expect(` (and surviving `assert(` calls inside `test_*` bodies) in
   the migrated file. Record as `post`.
7. Commit one file per commit. Body: `preserved-assertions: <pre> -> <post>` plus a
   one-line note about any `beforeAll` hoisting done. Body MUST also reference the
   parent: `Refs PRD-016 FR-1601, FR-1602, FR-1603, TDD-029 §5`.

Acceptance:

- 7 commits, one per file, each with the FR-1603 count note.
- `git grep -n "process\.exit" plugins/autonomous-dev/tests/audit
  plugins/autonomous-dev/tests/governance plugins/autonomous-dev/tests/triage` returns
  zero hits after the batch.
- `npx jest plugins/autonomous-dev/tests/audit plugins/autonomous-dev/tests/governance
  plugins/autonomous-dev/tests/triage` runs to a summary (PASS or FAIL but not abort).

Estimated effort: 1.5 days (7 × ~30 min mechanical + ~30 min per file for review &
verification).

### Task 2 — Batch B: Simple harness files, agent-factory base (8 files)

Convert the agent-factory base suite, same procedure as Task 1.

Files:

- `tests/agent-factory/agents.test.ts`
- `tests/agent-factory/audit.test.ts`
- `tests/agent-factory/cli.test.ts`
- `tests/agent-factory/config.test.ts`
- `tests/agent-factory/discovery.test.ts`
- `tests/agent-factory/parser.test.ts`
- `tests/agent-factory/validator.test.ts`
- (`tests/agent-factory/runtime.test.ts` is the **complex** file — handled separately in
  Task 4. Do not include it in this batch.)

Per-file procedure: identical to Task 1.

Acceptance:

- 7 commits (8 files minus `runtime.test.ts`), one per file, each with FR-1603 count note.
- `git grep -n "process\.exit" plugins/autonomous-dev/tests/agent-factory/*.test.ts`
  returns zero hits in the seven base files (runtime.test.ts will still match until
  Task 4).
- Each migrated file runs in isolation to a jest summary.

Estimated effort: 1.5 days.

### Task 3 — Batch B (cont.): Simple harness files, agent-factory/improvement (6 files)

Same procedure, separated as a sub-batch because the directory boundary makes review
easier and commits group cleanly.

Files:

- `tests/agent-factory/improvement/meta-reviewer.test.ts`
- `tests/agent-factory/improvement/observation-trigger.test.ts`
- `tests/agent-factory/improvement/proposer.test.ts`
- `tests/agent-factory/improvement/rate-limiter.test.ts`
- `tests/agent-factory/improvement/version-classifier.test.ts`
- `tests/agent-factory/improvement/weakness-report-store.test.ts`

Per-file procedure: identical to Task 1.

Acceptance:

- 6 commits, one per file, each with FR-1603 count note.
- `git grep -n "process\.exit" plugins/autonomous-dev/tests/agent-factory/improvement/`
  returns zero hits.

Estimated effort: 1 day.

### Task 4 — Batch C: Medium files with shared setup/teardown (3 files)

These three files share fixture directories (frontmatter pipeline) and require explicit
`beforeEach` / `afterEach` placement. Each file gets its own commit with a hand-written
note explaining the setup/teardown reshape.

Files:

- `tests/pipeline/frontmatter/id-generator.test.ts`
- `tests/pipeline/frontmatter/parser.test.ts`
- `tests/pipeline/frontmatter/validator.test.ts`

Per-file procedure (deviates from Task 1):

1. Identify the shared fixture directory init / teardown done at the top of `runTests`
   or in module-level code.
2. Hoist init into `beforeEach(async () => { ... })` (or `beforeAll` if the fixture is
   immutable across tests).
3. Hoist teardown into `afterEach` / `afterAll` mirroring the init choice.
4. Convert the `tests = [...]` array to `describe`/`it` blocks per Task 1 step 2.
5. Run `npx jest <path>` and verify pass/fail summary.
6. Commit body MUST include both the FR-1603 count note AND a `setup-reshape:` line
   describing where init/teardown moved.

Acceptance:

- 3 commits, one per file, each with FR-1603 count note + setup-reshape note.
- Each suite is runnable in isolation.
- Fixture cleanup verified: a deliberate test failure in one of the three suites does
  not leave behind fixture directories that break the next suite.

Estimated effort: 0.5 day.

### Task 5 — Batch D: Complex orchestration file (1 file)

`tests/agent-factory/runtime.test.ts` is the highest-risk migration (TDD-029 §5.3 calls
it out specifically). It wires up a multi-step daemon lifecycle, contains the `process.exit`
on line 616, and needs `beforeAll` / `afterAll` rather than per-test setup.

Per-file procedure:

1. Map every `test_*` function to an `it(...)` and identify which steps depend on a
   live daemon vs. which are pure-function.
2. Hoist daemon spawn into `beforeAll(async () => { ... })` and teardown into
   `afterAll(async () => { ... })`.
3. Use `describe.serial` semantics implicitly by grouping order-dependent `it`s under a
   single `describe` (jest does not have `.serial`; ordering within a `describe` is
   sequential by default).
4. Convert; run; verify summary.
5. Commit body: FR-1603 count note + a hand-written reviewer note (~5–10 lines) walking
   through the `beforeAll`/`afterAll` choices and explaining any `it`s that were
   reordered.

Acceptance:

- 1 commit with FR-1603 count + lifecycle reviewer note.
- `npx jest tests/agent-factory/runtime.test.ts` runs to a summary.
- No remaining `process.exit` in `plugins/autonomous-dev/tests/`.

Estimated effort: 0.5 day (file-specific complexity warrants the whole half-day even
though the LOC count is small).

### Task 6 — End-of-plan verification

After all 24 files migrate:

1. Run `git grep -n "process\.exit" plugins/autonomous-dev/tests/`. Expect zero hits.
2. Run `git grep -n "runTests()" plugins/autonomous-dev/tests/`. Expect zero hits.
3. Run `npx jest --runInBand` from `plugins/autonomous-dev/`. Capture full output.
   Expect: jest exits with a summary (zero-or-more PASS, zero-or-more FAIL), not a
   worker crash.
4. Save the captured output as input for PLAN-029-2 (the triage matrix populates from
   this exact run's FAIL list).
5. Verify each per-file `preserved-assertions` count by re-greping the migrated file
   for the post count and the original file (via `git show <pre-commit>:<path>`) for
   the pre count. Document any discrepancies in a follow-up commit (FR-1603 mandates
   this be reviewed).

Acceptance:

- All three greps pass.
- Captured `npx jest --runInBand` log saved to the PR description (or attached as a
  workflow artifact) for downstream consumption.

Estimated effort: 2h.

## Acceptance Criteria

- All 24 enumerated `.test.ts` files contain `describe`/`it`/`expect`; none contain a
  top-level `runTests()` IIFE (PRD-016 FR-1601, AC reference).
- `git grep -n "process.exit" plugins/autonomous-dev/tests` returns zero results
  (PRD-016 FR-1602).
- Each migration commit body contains a `preserved-assertions: <pre> -> <post>` line and
  the two numbers match (PRD-016 FR-1603).
- Each migrated file passes individually under `npx jest <path>` and prints a jest
  summary (PRD-016 FR-1605).
- `npx jest --runInBand` from `plugins/autonomous-dev/` runs to completion (no worker
  crash) and prints a full pass/fail summary (PRD-016 G-02).
- Implicit-side-effect imports identified during conversion are replaced with explicit
  `beforeAll` setup or left with a reviewer note explaining why the import was retained
  as-is (PRD-016 FR-1606).
- Total commit count: 24 file-conversion commits, ordered alphabetically within each
  batch. No squash; per-file granularity is the review unit.

## Testing

- **Per-file isolation:** after each commit, `npx jest <path>` runs to a jest summary.
- **Cumulative:** after each batch (Tasks 1–5), `npx jest --runInBand
  plugins/autonomous-dev/tests/<scope>` runs to a summary; no worker crashes.
- **Final:** Task 6 captures a full `npx jest --runInBand` log as input for PLAN-029-2.
- **No new test cases authored.** Per PRD-016 NG-02 and TDD-029 NG-2901, this plan
  preserves the existing assertion set; coverage widening is out of scope.

## Risks

| ID    | Risk                                                                                                                                          | Probability | Impact | Mitigation                                                                                                                                                                                                |
|-------|-----------------------------------------------------------------------------------------------------------------------------------------------|-------------|--------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| R-291 | Conversion silently drops assertions (e.g., a `for (const x of arr) assert(...)` loop becomes one `it()` instead of N).                       | Medium      | High   | FR-1603 per-commit count discipline. Reviewer compares two numbers; mismatches block review. Loops that yield N assertions stay inside the `test_*` function body so the count is preserved by structure. |
| R-292 | Hidden flaky tests previously masked by harness abort surface as new "FAIL" rows.                                                              | High        | Medium | Expected and intentional — those rows go to PLAN-029-2's triage matrix with category `flake`. PRD-016 FR-1615 mandates 5 reruns before flake classification sticks; a real regression auto-promotes.       |
| R-293 | Implicit side-effect imports (FR-1606) are missed during conversion; a migrated suite passes locally but fails in CI due to missing `register()`. | Medium      | Medium | Step 4 of the per-file procedure explicitly flags every import without an in-file reference. Reviewer confirms in the commit. CI matrix run (PLAN-029-3) catches any survivors before merge.                |
| R-294 | `runtime.test.ts` daemon spawn/teardown leaks processes between `beforeAll` and `afterAll`, causing flake on CI's parallel runners.            | Medium      | High   | Task 5 uses `--runInBand` semantics during local verification. The `afterAll` teardown explicitly awaits process death (no fire-and-forget). PR description records the manual leak-check protocol used.   |
| R-295 | Post-migration FAIL count exceeds 50 suites, triggering PRD-016 OQ-07 (split into PRD-016A + PRD-016B).                                       | Medium      | Medium | Task 6 captures the exact FAIL list. If count > 50, escalate to PRD-016 OQ-07 via comment on the PR; PLAN-029-2 may need to re-scope but PLAN-029-1 still merges as the foundation.                          |
| R-296 | A migration commit slips through without the `preserved-assertions` line and is missed at review.                                              | Low         | High   | PLAN-029-3 ships a CI grep that fails any migration commit on this branch whose body lacks `preserved-assertions:`. Until that ships, a commit-msg hook is added as a local guard (out of scope for this plan but referenced). |

## Definition of Done

- [ ] All 24 files migrated, one commit per file.
- [ ] Each commit body has `preserved-assertions: <pre> -> <post>` and the numbers match.
- [ ] `git grep -n "process\.exit" plugins/autonomous-dev/tests` returns zero hits.
- [ ] `git grep -n "runTests()" plugins/autonomous-dev/tests` returns zero hits.
- [ ] `npx jest --runInBand` from `plugins/autonomous-dev/` runs to a full summary.
- [ ] Per-file isolation verified: `npx jest <path>` runs to a summary for each file.
- [ ] Implicit-side-effect imports converted to explicit `beforeAll` (or retained with
      reviewer note).
- [ ] Captured `npx jest --runInBand` log handed off to PLAN-029-2 as the FAIL-list source.

## Dependencies

### Parent TDD

- **TDD-029** §5 (Migration Recipe), §10.1 (Rollout sequence phases 1–3), §11.1 (the
  migration is its own test).

### Parent PRD

- **PRD-016** §7.1 (FR-1601 through FR-1606), §9 (acceptance criteria), §10 R-02
  (assertion-drop risk), §13 (out-of-scope carve-outs).

### Blocked By

- None. This is the foundation plan for TDD-029.

### Blocks Downstream Plans

- **PLAN-029-2** (triage matrix) — needs the post-migration FAIL list captured in
  Task 6 to populate `docs/triage/PRD-016-test-failures.md`.
- **PLAN-029-3** (CI gate) — needs `process.exit` to be already absent from the tree
  so that the lint rule and CI grep step land green on day one.

### Integration Points

- After this plan merges, `npx jest --runInBand` is the canonical "tests pass" command
  (PRD-016 G-02). PLAN-029-3 wires that command into CI with `--ci`.
- PLAN-029-2 will add `describe.skip` annotations to FAIL suites; those skips depend on
  the suites already being in idiomatic jest shape (no `runTests` wrapper).
