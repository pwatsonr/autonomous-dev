# TDD-029: Jest Harness Migration, Failure Triage, and CI Gate Hardening

| Field          | Value                                                                |
|----------------|----------------------------------------------------------------------|
| **Title**      | Jest Harness Migration, Failure Triage, and CI Gate Hardening        |
| **TDD ID**     | TDD-029                                                              |
| **Version**    | 1.0                                                                  |
| **Date**       | 2026-05-02                                                           |
| **Status**     | Draft                                                                |
| **Author**     | Patrick Watson                                                       |
| **Parent PRD** | PRD-016: Test-Suite Stabilization & Jest Harness Migration           |
| **Plugin**     | autonomous-dev                                                       |
| **Sibling TDDs** | TDD-030 (closeout backfill), TDD-031 (SPEC reconciliation)         |

---

## 1. Summary

TDD-029 is the foundation TDD for PRD-016. It addresses the test runner shape itself: the 27
custom-harness files that abort jest workers via `process.exit(1)`, the triage matrix needed
to disposition the FAIL suites that become visible once jest can complete, and the CI gate
that must prevent regression of the harness anti-pattern.

The core of the design is a mechanical, reviewable migration recipe that converts each
top-level `runTests()` IIFE into idiomatic `describe`/`it`/`expect` blocks while preserving
the assertion set 1:1. Around that recipe sit two supporting deliverables: a triage matrix
schema (`docs/triage/PRD-016-test-failures.md`) that captures per-suite disposition, owner,
and rationale; and a CI/lint gate that fails any PR introducing `process.exit(` into a test
file.

This TDD is deliberately scoped to the **test runner contract**. It does not touch
production code, does not backfill new test suites, and does not edit SPECs — those are
TDD-030 and TDD-031 respectively. Its single deliverable is: `npx jest --runInBand` runs to
completion and reports a real summary.

---

## 2. Goals & Non-Goals

### Goals

- **G-2901** Convert all 27 custom-harness files in `plugins/autonomous-dev/tests/**` to
  idiomatic jest with a 1:1 assertion mapping that reviewers can diff mechanically.
- **G-2902** Eliminate every `process.exit(` call from test code so jest controls process
  lifecycle exclusively.
- **G-2903** Restore the canonical "tests pass" gate: `npx jest --runInBand` from
  `plugins/autonomous-dev/` runs to completion and prints a full pass/fail summary.
- **G-2904** Produce a triage matrix at `docs/triage/PRD-016-test-failures.md` that gives
  every post-migration FAIL suite a disposition (FIX / SKIP-WITH-NOTE / DELETE), an owner,
  and a follow-up link.
- **G-2905** Ship a CI/lint gate that fails any future PR introducing `process.exit(` into
  a test file or attempting to merge with non-skipped failing suites.
- **G-2906** Make the migration mechanically reviewable: every conversion commit body
  records the pre/post assertion count so a 1:1 mapping is verifiable without re-reading
  the test logic.

### Non-Goals

| ID      | Non-Goal                                                                  | Rationale                                                                            |
|---------|---------------------------------------------------------------------------|--------------------------------------------------------------------------------------|
| NG-2901 | New test cases beyond the migration                                       | Coverage widening is explicitly out of scope per PRD-016 NG-02                       |
| NG-2902 | Production code changes for FAIL suites that turn out to be regressions   | Per PRD-016 NG-01, regression fixes ship as separate small PRs that reference PRD-016 |
| NG-2903 | TDD-014 security test backfill                                             | Owned by TDD-030                                                                     |
| NG-2904 | Portal pipeline production code or its tests                              | Owned by TDD-030                                                                     |
| NG-2905 | Plugin-reload CLI surface or its integration test                         | Owned by TDD-030                                                                     |
| NG-2906 | SPEC path/Vitest/Bats reconciliation                                       | Owned by TDD-031                                                                     |
| NG-2907 | Vitest/Mocha/Tap migrations                                               | Standardizing on jest because that's what `jest.config.cjs` is configured for        |
| NG-2908 | Sharding the jest run for performance                                     | Out of scope; only required if first run exceeds the runner's job timeout            |

---

## 3. Background

### 3.1 Why the harness exists

The pattern arose during TDDs 002–009 when the project did not yet have `jest.config.cjs`.
Tests were invoked directly with `node --loader tsx/esm tests/foo.test.ts`. A self-contained
harness — `let passed=0, failed=0; ... if (failed > 0) process.exit(1);` — was the simplest
way to produce a runnable test artifact in that period.

When jest was adopted (`testMatch: ['**/?(*.)+(spec|test).ts']`), the harness files were
silently picked up because they ended in `.test.ts`. The top-level `runTests()` IIFE then
runs inside a jest worker, and any failure terminates the worker via `process.exit(1)`.
Jest treats a worker `exit(1)` as a worker crash — it surfaces the crash and aborts the run.

### 3.2 Concrete mechanism

Confirmed against the codebase as of `main@2937725`:

```
$ grep -rln "process\.exit" plugins/autonomous-dev/tests/ | wc -l
27

$ npx jest --runInBand
... runs early suites ...
FAIL tests/audit/log-archival.test.ts
  ● Test suite failed to run
    Worker terminated due to reaching timeout of 5000 ms
... abort, no summary ...
```

The 27 files that contain `process.exit` map exactly to the 27 files that contain
top-level `runTests()` invocations (a subset of 3 — `log-archival`, `hash-verifier`,
`decision-replay` — name the pattern `runTests()`; the rest use renamed variants but the
shape is identical).

### 3.3 Reference: the working pattern

`tests/chains/test-cycle-detection.test.ts` is the canonical example of the target shape:
top-of-file `import` lines, no top-level side effects, `describe(...)` blocks containing
`it(...)` cases that use `expect(...)`. No `process.exit`, no manual counters, no top-level
IIFE.

The migration's job is to take the 27 harness files and produce that shape, preserving
every assertion that the pre-migration `runTests` body actually executed.

---

## 4. Architecture

There is no runtime architecture diagram — this TDD does not introduce a system. It
introduces a deterministic *code transformation* plus two surrounding artifacts (triage
matrix, CI gate). The relevant architecture is the contract between jest, the test files,
and CI:

```
                    ┌────────────────────────────┐
                    │  plugins/autonomous-dev/   │
                    │      jest.config.cjs       │
                    │  testMatch: *.test.ts      │
                    └─────────────┬──────────────┘
                                  │
                    ┌─────────────▼──────────────┐
                    │     jest worker pool        │
                    │   (one worker / file w/    │
                    │       --runInBand)         │
                    └─────────────┬──────────────┘
              ┌───────────────────┼────────────────────┐
              │                   │                    │
   ┌──────────▼─────────┐ ┌───────▼──────┐ ┌──────────▼─────────┐
   │  IDIOMATIC SUITE   │ │ HARNESS SUITE│ │  IDIOMATIC SUITE   │
   │ describe/it/expect │ │ runTests()   │ │ describe/it/expect │
   │  ✓ summary         │ │ process.exit │ │  (never reached)   │
   └────────────────────┘ └──────┬───────┘ └────────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────────┐
                    │   WORKER CRASH → ABORT     │  ← problem
                    └────────────────────────────┘

Post-migration:

   ┌──────────▼─────────┐ ┌──────────▼─────────┐ ┌──────────▼─────────┐
   │  IDIOMATIC SUITE   │ │  IDIOMATIC SUITE   │ │  IDIOMATIC SUITE   │
   │  ✓/✗ summary       │ │  ✓/✗ summary       │ │  ✓/✗ summary       │
   └─────────┬──────────┘ └─────────┬──────────┘ └─────────┬──────────┘
             │                      │                      │
             └──────────┬───────────┴──────────────────────┘
                        ▼
             ┌─────────────────────┐         ┌─────────────────────┐
             │  Full jest summary  │ ─────▶  │ Triage matrix:       │
             │  N pass / M fail    │         │ FIX / SKIP / DELETE  │
             └─────────────────────┘         └─────────────────────┘
                        │
                        ▼
             ┌─────────────────────┐
             │  CI gate enforces:  │
             │  - lint: no exit()  │
             │  - run: no fails    │
             └─────────────────────┘
```

The migration converts each harness suite into the same shape the rest of the corpus
already uses; the triage matrix names what the now-visible failures mean; the CI gate
makes the new shape a one-way ratchet.

---

## 5. Migration Recipe (per file)

### 5.1 The transformation

Each harness file follows a recurring shape. Using `tests/audit/log-archival.test.ts` as
the canonical example, lines 612–647:

```ts
// PRE-MIGRATION (current harness)
const tests = [
  test_archive_old_events,
  test_no_events_to_archive,
  // ... 9 more
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

The post-migration equivalent:

```ts
// POST-MIGRATION (idiomatic jest)
describe('LogArchival (SPEC-009-5-3, Task 6)', () => {
  it('archives old events', async () => { await test_archive_old_events(); });
  it('handles no events to archive', async () => { await test_no_events_to_archive(); });
  // ... 9 more, one per former test_* function
});
```

The bodies of `test_archive_old_events` etc. are left intact in the first pass. The
function-internal `assert(...)` helper becomes a separate concern (§5.2).

### 5.2 The `assert()` helper question

Most harness files define a local helper:

```ts
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}
```

Two valid migrations:

| Strategy                            | Pros                                                     | Cons                                                  |
|-------------------------------------|----------------------------------------------------------|-------------------------------------------------------|
| **A. Keep `assert()` as-is**        | Mechanical 1:1 conversion; smallest diff per file        | Reviewer cannot distinguish a real `expect()` from the helper; standard jest reporters do not enrich the failure |
| **B. Rewrite `assert(x, m)` → `expect(x).toBe(true)`** with the message preserved as a comment | Idiomatic; jest reporters point at the failing line | Larger diff; risk of subtly changing which value is checked when the original `condition` was a complex expression |

**Decision:** Strategy A in pass one; Strategy B as a follow-up in TDD-029 phase 2. The
PRD's FR-1603 mandates a 1:1 assertion mapping, and Strategy A makes that mapping
trivially verifiable. Strategy B is recommended for files where the conversion is small
enough that the reviewer can verify both passes in one sitting.

### 5.3 The 27 files, categorised by complexity

The PRD enumerates ~20 files explicitly (FR-1604) and leaves the rest to the triage
matrix. Confirmed against the tree (`grep -rln "process\.exit" plugins/autonomous-dev/tests/`):

**Simple (linear `tests` array of independent functions) — 22 files, est. 30 min each:**

- `tests/audit/log-archival.test.ts`
- `tests/audit/hash-chain.test.ts`
- `tests/audit/hash-verifier.test.ts`
- `tests/audit/decision-replay.test.ts`
- `tests/agent-factory/{audit,discovery,parser,config,runtime,cli,agents,validator}.test.ts`
- `tests/agent-factory/improvement/{observation-trigger,rate-limiter,meta-reviewer,version-classifier,proposer,weakness-report-store}.test.ts`
- `tests/triage/notification.test.ts`
- `tests/governance/{cooldown,oscillation}.test.ts`

**Medium (shared setup/teardown that needs `beforeEach`/`afterEach`) — 4 files, est. 1 hr each:**

- `tests/pipeline/frontmatter/{validator,parser,id-generator}.test.ts` (shared fixture
  directory)
- `tests/intake/core/shutdown.test.ts` (uses module-side-effect `register()` calls)

**Complex (orchestration / cross-test state) — 1 file, est. 2 hr:**

- `tests/agent-factory/runtime.test.ts` (line 616 `process.exit`; the runtime test wires
  up a multi-step lifecycle that needs `beforeAll` for daemon spawn and `afterAll` for
  teardown).

Total budgeted effort: 27 × ~45 min average = ~20 engineer-hours of mechanical work.

### 5.4 Per-file commit discipline (FR-1603)

Each migration commit body MUST include:

```
preserved-assertions: <pre-migration count> → <post-migration count>
```

Where the count is the number of `assert(`, `if (...failed...)`, or `throw new Error(`
sites in the original `runTests` body, and the equivalent count of `it(`, `expect(`, or
`assert(` (per §5.2) sites in the migrated file. Mismatches block review.

This is the single most important guardrail in this TDD. Without it, a sloppy migration
silently drops assertions and the resulting "green" suite is a lie.

### 5.5 Implicit-side-effect imports (FR-1606)

A subset of files rely on import-time side effects — e.g., importing a module so that its
`registerHandler()` runs before tests execute. The harness pattern hid this because the
`runTests` IIFE ran before any test logic. Migrated files must hoist that registration
into an explicit `beforeAll`:

```ts
// BEFORE (implicit, brittle)
import './register-side-effect';

// AFTER (explicit)
import { register } from './register-side-effect';
beforeAll(() => { register(); });
```

The migration recipe flags every import that has no explicit usage in the rest of the
file as a candidate for this transformation; the reviewer confirms whether the import is
truly side-effect-only.

---

## 6. Triage Matrix Schema (FR-1610–FR-1615)

### 6.1 Location and format

`docs/triage/PRD-016-test-failures.md` (new file, repo-root `docs/triage/` directory
created if absent).

```markdown
# PRD-016 Test Failure Triage Matrix

| Row | Suite path                                                      | Category         | Disposition       | Owner       | Linked SPEC / Issue | Notes |
|-----|-----------------------------------------------------------------|------------------|-------------------|-------------|---------------------|-------|
| 1   | tests/parallel/test-parallel-coordinator.test.ts                | regression       | FIX (next-PR)     | @pwatson    | SPEC-006-3-02       | Race in coordinator; suspected timer mock leak |
| 2   | tests/agent-factory/improvement/proposer.test.ts                | harness-residue  | FIX (this-PR)     | @pwatson    | n/a                 | Migrated in TDD-029; failure was the harness pattern itself |
| 3   | tests/safety/security-audit.test.ts                             | flake            | SKIP-WITH-NOTE    | @pwatson    | issue #TBD          | 5/5 reruns failed → re-categorise to regression |
| ... |                                                                 |                  |                   |             |                     |       |
```

### 6.2 Column semantics

| Column            | Allowed values                                          | Purpose                                                                                  |
|-------------------|---------------------------------------------------------|------------------------------------------------------------------------------------------|
| Row               | Monotonic integer                                       | Used as the citation key in `// SKIP per PRD-016 triage row N: <reason>` annotations     |
| Suite path        | Relative path from `plugins/autonomous-dev/`            | Must be exactly the path jest emits in its summary                                       |
| Category          | `regression` \| `fixture` \| `flake` \| `harness-residue` | What kind of failure this is, not what we'll do about it                                |
| Disposition       | `FIX` \| `SKIP-WITH-NOTE` \| `DELETE`                   | What action ships in this PR                                                             |
| Owner             | `@github-handle`                                        | Single named human; not "team" or "TBD"                                                  |
| Linked SPEC/Issue | SPEC-NNN-N-NN id, GitHub issue URL, or `n/a`            | Where the follow-up lives                                                                |
| Notes             | Free text, ≤ 1 line                                     | One-sentence root-cause hypothesis                                                       |

### 6.3 Disposition rules

**FIX:** Includes an ETA bucket (`this-PR` / `next-PR` / `next-sprint`). FIX in `this-PR`
means a follow-up commit on this branch; FIX in `next-PR` means a separate PR referencing
PRD-016 (per NG-2902); FIX in `next-sprint` means a tracking issue.

**SKIP-WITH-NOTE:** Implemented as `describe.skip(...)` or `it.skip(...)` with an inline
comment of the form `// SKIP per PRD-016 triage row N: <reason>`. The annotation is
machine-checkable: `git grep -n "SKIP per PRD-016 triage row"` should return one hit per
SKIP-WITH-NOTE row. Mismatches block review.

**DELETE:** Requires three pieces of evidence in the matrix's Notes column:
1. Why the test is legacy (e.g., "covers `src/foo/bar.ts` removed in TDD-018").
2. Whether the production code it covered is still live.
3. A named approver (not the row's Owner — must be a second person).

Bulk deletes without all three fields are rejected at review.

### 6.4 Flake re-classification (FR-1615)

Suites tagged `flake` MUST be re-run in CI a minimum of 5 times before the label sticks.
A simple `.github/workflows/flake-check.yml` invocable via `workflow_dispatch` runs
`npx jest --runInBand --testPathPattern=<suite> --no-coverage` 5 times; consistent
failures auto-promote the row's category to `regression`. The matrix records the run id
of the flake-check job in the Notes column.

### 6.5 Pre-migration vs. post-migration FAIL coverage

The triage matrix MUST cover, at minimum, the 11 suites already named in PRD-016
FR-1614:

- `parallel/*`
- `agent-factory/improvement/*` (a subset of these are harness-residue and will be FIXED
  by the migration itself)
- `notifications/*`
- `escalation/response-handler.integration`
- `safety/security-audit`
- `intake/__tests__/core/reconciliation_repair`
- `intake/notifications/notification_engine`
- `tests/core/test_handoff_manager`
- `full-collection-run`
- `governance-lifecycle`
- `scrub-integration`

Plus any new FAIL suites surfaced once the run completes. The matrix is open-ended; a
larger-than-expected post-migration FAIL count does not invalidate the design, it just
expands the row count (and may trigger PRD-016 OQ-07: split into PRD-016A).

---

## 7. CI Gate Hardening (FR-1660–FR-1662)

### 7.1 Lint rule (FR-1660)

Two implementation options:

| Option                                              | Pros                                                                          | Cons                                                                                  |
|-----------------------------------------------------|-------------------------------------------------------------------------------|---------------------------------------------------------------------------------------|
| **A. ESLint `no-restricted-syntax`** rule           | Already in the toolchain; rich error messages; runs in the `lint` CI job      | Pattern matching is awkward (`CallExpression[callee.object.name='process']...`)       |
| **B. eslint-plugin-jest** (`jest/no-restricted-jest-methods` + custom) | Purpose-built for jest patterns                              | New dependency; covers slightly different surface than what we want                   |
| **C. Bash `grep` step in CI**                       | Trivial to write; impossible to misconfigure                                  | Bypassed by local pre-commit hooks; not reported in editor                            |

**Decision:** A + C. ESLint catches it locally before commit; the bash grep step in CI is
the belt-and-braces backstop. Both must be wired; either alone is insufficient.

ESLint config addition:

```js
// .eslintrc.js (additive change)
{
  files: ['**/*.test.ts', '**/*.spec.ts'],
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector: "CallExpression[callee.object.name='process'][callee.property.name='exit']",
        message: 'process.exit() is forbidden in test files. Use expect()/throw — jest controls process lifecycle. (PRD-016 FR-1660)',
      },
    ],
  },
}
```

CI grep step (extends `.github/workflows/ci.yml`):

```yaml
- name: Check for process.exit in test files
  run: |
    if grep -rn "process\.exit" plugins/autonomous-dev/tests/ plugins/autonomous-dev-portal/tests/ ; then
      echo "::error::process.exit() found in test files. See PRD-016 FR-1660."
      exit 1
    fi
```

### 7.2 Run-completion gate (FR-1661)

Replace the existing "3 known failures allowed" carve-out (currently at
`.github/workflows/ci.yml` `test` job) with a clean failure mode:

```yaml
- name: Run jest with hard-fail
  working-directory: plugins/autonomous-dev
  run: npx jest --runInBand --ci --reporters=default --reporters=jest-junit
  env:
    JEST_JUNIT_OUTPUT_DIR: ./reports
    JEST_JUNIT_OUTPUT_NAME: jest-junit.xml
```

The `--ci` flag forces `process.exitCode` non-zero on any non-skipped failure, with no
allowlist. SKIP-WITH-NOTE suites (per the triage matrix) are honored because jest treats
`describe.skip`/`it.skip` as pending, not failed.

### 7.3 JUnit XML reporting (FR-1662, P2)

`jest-junit` writes per-suite results to `reports/jest-junit.xml`; GitHub Actions
surfaces these via `actions/upload-artifact@v4` and the GitHub UI's test-results tab.
This is P2; ship if cheap, defer if not.

---

## 8. Cross-Cutting Concerns

### 8.1 Security

The migration touches **test code only**, with one indirect security implication: while
the harness migration is in flight, the auth surface from TDD-014 remains unprotected by
tests (this is what TDD-030 fixes). Within this TDD's scope, no production code paths
change, no secrets handling changes, and no new dependencies are added beyond
`jest-junit` (a widely-used reporter, MIT-licensed, no native bindings).

The CI lint rule is itself a security-relevant gate: it prevents future code from
bypassing test assertions via `process.exit(0)` (which would silently mark a failing test
as passing).

### 8.2 Privacy

No PII is introduced or removed. Test fixtures continue to use synthetic data
(`test-repo`, `test-agent`, `evt-${random}` patterns confirmed in
`tests/audit/log-archival.test.ts:32-45`). The triage matrix records GitHub handles, not
email addresses.

### 8.3 Scalability

Post-migration, the full jest run grows from "aborted partway" to "complete." The current
visible 41 suites runs in <5 min on a developer laptop; the full run is projected at
~10 min wall-clock with `--runInBand` (single worker) and ~3 min with default parallelism.
Both fit comfortably within the existing GitHub Actions 30-min job timeout.

If the post-migration run unexpectedly exceeds 25 min, sharding (`--shard=1/4` etc.)
becomes a fast-follow per PRD-016 §11. This TDD designs for the 10-min case and treats
sharding as a tracked-but-not-built optimisation.

### 8.4 Reliability

Two reliability concerns:

1. **Migration silently drops assertions.** Mitigated by FR-1603's pre/post count
   discipline (§5.4). A reviewer can verify a single number per commit; a mismatch is
   visible without re-reading the test logic.
2. **Flake re-classification mistakes a real regression for a flake.** Mitigated by
   FR-1615's 5-rerun rule (§6.4). The cost is one CI workflow + one row of the matrix;
   the value is that a "flake" label can no longer be applied without evidence.

### 8.5 Observability

The deliverable artifact *is* observability: a complete jest summary printed to stdout
plus the JUnit XML report. Pre-TDD, operators had no view of the suite's true state;
post-TDD, every failure has a row in the triage matrix and a clear disposition.

The CI workflow uploads `reports/jest-junit.xml` so the GitHub Actions UI can render
per-suite pass/fail without operators having to scroll the raw log.

### 8.6 Cost

Direct infrastructure cost: zero (no new runners, no new services). The lint rule adds
~50 ms to the existing ESLint run. The CI grep adds ~200 ms. The JUnit XML upload adds
~1 s + ~50 KB of artifact storage per run.

Indirect cost (engineer time): ~20 hours for the migration (§5.3) + ~4 hours for the
triage matrix authoring + ~2 hours for the CI gate wiring = ~26 engineer-hours total.
This is the up-front investment that makes every subsequent "tests pass" claim
verifiable.

---

## 9. Alternatives Considered

### 9.1 Codemod the harness migration (jscodeshift / ts-morph)

**Approach:** Write a jscodeshift transform that detects the `runTests` IIFE shape and
emits `describe`/`it` blocks. Apply across all 27 files in one commit.

**Advantages:**
- Single PR instead of 27 commits
- Mechanically guaranteed 1:1 assertion mapping (the codemod can count)
- Repeatable: if a future harness regression slips through, re-run the codemod

**Disadvantages:**
- The 27 files are not uniform. Three sub-shapes exist (§5.3); a codemod that handles
  all three is non-trivial to author and review. The medium and complex categories need
  manual `beforeAll`/`afterAll` placement that a generic transform cannot infer.
- A codemod commit is a single ~2,000-line diff — much harder to review than 27
  small commits. Reviewer fatigue trades off against author effort.
- The codemod itself is throwaway code that needs tests.

**Why rejected:** The migration is one-shot (the lint rule prevents recurrence). The
review-burden penalty of a single mega-diff outweighs the author-effort saving. 27 small
commits with the FR-1603 assertion-count discipline is simpler to verify.

### 9.2 Jest setup file that intercepts `process.exit`

**Approach:** Add `setupFilesAfterEach: ['./jest.setup.ts']` that monkey-patches
`process.exit` to throw, so the harness files fail individually instead of crashing the
worker.

**Advantages:**
- Zero file-level changes; the harness files keep working as-is
- One-line config change

**Disadvantages:**
- The harness files would still run as top-level IIFEs, which means jest reports them as
  one giant test each (no per-`test_*` granularity)
- The `passed`/`failed` counters remain manual; jest cannot enrich the failure reporter
- Does not satisfy FR-1601 (idiomatic jest) or FR-1604 (per-file enumeration)
- Hides the anti-pattern instead of removing it; new harness files could still be
  written

**Why rejected:** This treats the symptom, not the disease. PRD-016's whole point is to
make the test corpus idiomatic; this approach institutionalises the harness instead.

### 9.3 Delete the harness files and rebuild

**Approach:** Identify which production code each harness file covers; if covered by
another suite, delete the harness file; if not, write a fresh idiomatic suite from
scratch.

**Advantages:**
- Clean slate; no legacy harness shape persists
- Reveals coverage gaps directly

**Disadvantages:**
- High risk of dropping assertions (NG-2902: regressions surfaced by triage are
  out-of-scope for this PR; we can't simultaneously delete tests and fix bugs)
- The 27 files contain ~300 individual assertions; rewriting from scratch is much more
  work than mechanical conversion
- Loses the audit trail: a 1:1 conversion lets a reviewer compare pre/post; a rewrite
  doesn't

**Why rejected:** PRD-016 R-02 explicitly flags assertion-drop as a high-impact risk;
mechanical conversion with a count guardrail is the prescribed mitigation.

### 9.4 ESLint plugin alone (no CI grep)

**Approach:** Ship only the ESLint rule from §7.1 option A; trust devs to run `npm run
lint` before pushing.

**Advantages:**
- Single point of enforcement
- Cleaner CI

**Disadvantages:**
- Devs can disable ESLint locally, ship without lint, and the CI lint job covers a
  different file glob than the test glob. A test file authored without going through
  the lint config (e.g., a junior contributor copy-pasting an old harness file) might
  not be caught.
- A grep step is one line of yaml and runs in <1 s; it's pure upside.

**Why rejected:** The cost of the second check is negligible; the assurance value is
high. Defense in depth.

---

## 10. Operational Readiness

### 10.1 Rollout sequence

1. **Phase 1 (this TDD's commits 1–N).** Migrate the 22 simple files in alphabetical
   order, one commit per file. Each commit's body has the FR-1603 preserved-assertions
   note.
2. **Phase 2.** Migrate the 4 medium files (frontmatter + intake/core/shutdown). Each
   commit additionally records the `beforeEach`/`afterEach` reshaping done.
3. **Phase 3.** Migrate `tests/agent-factory/runtime.test.ts`. This is the highest-risk
   file; it gets its own commit and a hand-written reviewer note explaining the
   `beforeAll`/`afterAll` choices.
4. **Phase 4.** Run `npx jest --runInBand`, capture the full FAIL list, populate the
   triage matrix.
5. **Phase 5.** Add `describe.skip`/`it.skip` annotations for SKIP-WITH-NOTE rows.
   Verify `git grep "SKIP per PRD-016 triage row"` count matches the matrix row count.
6. **Phase 6.** Wire the ESLint rule, the CI grep step, and the `--ci` flag. Verify
   `npx jest --runInBand --ci` exits 0.

Phases 1–3 are the harness migration (Plan 029-A). Phase 4 is triage (Plan 029-B).
Phases 5–6 are the gate (Plan 029-C). See §12.

### 10.2 Rollback plan

The migration commits are individually revertable (one file per commit). If a migrated
suite turns out to drop coverage, `git revert` that commit and re-do the conversion. The
triage matrix is purely additive (a new file) and trivially revertable. The CI gate is
wired in a single PR-level commit; revert by toggling the `--ci` flag and removing the
grep step.

### 10.3 Feature flags

None. The migration is unconditional; jest cannot run two test runners in parallel.

### 10.4 Canary criteria

- Pre-merge: `npx jest --runInBand --ci` exits 0 in CI on the PR branch.
- Post-merge: One week of clean main-branch runs (no flake escalations from the matrix's
  flake-tagged rows). If a flake-tagged row produces a real regression in that window,
  re-categorise per FR-1615.

---

## 11. Test Strategy

### 11.1 The migration is its own test

By definition, every migrated suite is exercised by the post-migration `npx jest`
invocation. A green run means the migration preserved the suite's behavior; a red run
flags the regression for the triage matrix.

### 11.2 Lint-rule self-test

Add `tests/_meta/test-no-process-exit.test.ts` (a new idiomatic suite):

```ts
import { execSync } from 'child_process';
describe('PRD-016 FR-1660: no process.exit in test files', () => {
  it('grep finds no process.exit calls under tests/', () => {
    const result = execSync(
      'grep -rn "process\\.exit" plugins/autonomous-dev/tests/ || true',
      { encoding: 'utf-8' },
    );
    expect(result.trim()).toBe('');
  });
});
```

This guards against accidental reintroduction at the test layer in addition to the lint
and CI grep gates.

### 11.3 CI gate self-test

A throwaway PR (not merged) that introduces a single `process.exit(1)` into a test file
must:
1. Fail `npm run lint` locally.
2. Fail the `Check for process.exit in test files` step in CI.
3. Be impossible to merge with branch protection on the `lint` and the new check.

Documented in the PR description; verified before the gate is declared shipped.

### 11.4 No new product test scenarios

Per NG-2901, this TDD does not author new test cases. The migrated suites' coverage
equals the pre-migration coverage by construction (FR-1603).

---

## 12. Implementation Plan (high-level)

| Plan ID    | Title                                  | Scope                                                                          | Estimate | Depends on |
|------------|----------------------------------------|--------------------------------------------------------------------------------|----------|------------|
| Plan 029-A | Custom-harness migration               | Convert 27 files per §5; one commit per file with FR-1603 count notes          | L        | —          |
| Plan 029-B | Triage matrix authoring                | Author `docs/triage/PRD-016-test-failures.md` per §6; populate every FAIL row  | M        | 029-A      |
| Plan 029-C | CI/lint gate hardening                 | ESLint rule + CI grep + `--ci` flag + JUnit reporter (§7); meta-test (§11.2)   | S        | 029-A      |
| Plan 029-D | Flake re-classification workflow       | `.github/workflows/flake-check.yml` per §6.4; row-status update mechanic       | S        | 029-B      |

Plans 029-B and 029-C can run in parallel after 029-A merges. 029-D is a P1 fast-follow.

---

## 13. Open Questions

| ID    | Question                                                                                                              | Recommendation                                                                                                                              |
|-------|-----------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------|
| OQ-29-01 | Should the migration land as one PR with 27 commits, or as 27 stacked PRs?                                         | One PR. Stacked PRs add review-coordination cost without value; the per-commit assertion-count discipline gives the same review granularity. |
| OQ-29-02 | Do we apply Strategy B (`assert()` → `expect()`) in the same PR as Strategy A?                                       | No — Strategy B as a phase-2 follow-up. Conflating them dilutes the FR-1603 mapping; a separate PR is mechanically cleaner.                   |
| OQ-29-03 | If a migrated suite reveals a real regression mid-PR, do we ship the migration with `it.skip` + matrix row, or pause? | Ship with skip + matrix row. The migration's value is unblocking the runner; pausing on a regression keeps the runner broken.                |
| OQ-29-04 | Should the `--ci` flag's "no allowlist" land before or after the triage matrix is populated?                          | After. Until the matrix is populated, the run will fail; the carve-out exists precisely to bridge that gap.                                  |
| OQ-29-05 | Do we record the JUnit XML in source control, or only as a CI artifact?                                              | CI artifact only. Source-controlled XML drifts; CI artifacts are immutable per-run.                                                          |
| OQ-29-06 | If post-migration FAIL count > 50, do we split this TDD?                                                              | Yes — escalate to PRD-016 OQ-07 and split into PRD-016A (harness migration only) + PRD-016B (triage). This TDD's §6 is then re-scoped.        |

---

## 14. References

- **PRD-016:** Test-Suite Stabilization & Jest Harness Migration —
  `plugins/autonomous-dev/docs/prd/PRD-016-test-suite-stabilization.md`
- **TDD-030:** Closeout backfill (TDD-014/015/019) — sibling
- **TDD-031:** SPEC reconciliation — sibling
- **Reference harness file:**
  `plugins/autonomous-dev/tests/audit/log-archival.test.ts` (line 644:
  `if (failed > 0) process.exit(1);`)
- **Reference idiomatic file:**
  `plugins/autonomous-dev/tests/chains/test-cycle-detection.test.ts`
- **Jest config:** `plugins/autonomous-dev/jest.config.cjs`
- **Existing CI:** `.github/workflows/ci.yml` (the file `--ci` and the lint step land
  into)
- **TDD-016 (Baseline CI):** depended-upon for the `lint`/`test` job shape

---

**END TDD-029**
