# PLAN-029-3: CI Gate — ESLint Rule, CI Grep, `--ci` Flag, JUnit Reporter

| Field                | Value                                                              |
|----------------------|--------------------------------------------------------------------|
| **Parent TDD**       | TDD-029: Jest Harness Migration, Failure Triage, and CI Gate       |
| **Parent PRD**       | PRD-016: Test-Suite Stabilization & Jest Harness Migration         |
| **Plan ID**          | PLAN-029-3                                                         |
| **Version**          | 1.0                                                                |
| **Date**             | 2026-05-02                                                         |
| **Status**           | Draft                                                              |
| **Priority**         | P1                                                                 |
| **Estimated effort** | 2 days                                                             |
| **Sibling plans**    | PLAN-029-1 (harness migration), PLAN-029-2 (triage matrix)         |

## Objective

Make the harness migration a one-way ratchet by landing the CI/lint gate that fails any
PR introducing `process.exit(` into a test file, replacing the legacy "3 known failures
allowed" carve-out with a clean `--ci` flag, publishing JUnit XML for per-suite
visibility in the GitHub Actions UI, and shipping a meta-test that asserts the test tree
remains free of `process.exit`. After this plan merges, regressing to the harness
pattern is impossible without first disabling three independent gates (ESLint, CI grep,
meta-test).

## Scope

### In Scope

- ESLint `no-restricted-syntax` rule per TDD-029 §7.1 option A: scoped to `**/*.test.ts`
  and `**/*.spec.ts`, severity `error`, message references PRD-016 FR-1660. Lives in
  `plugins/autonomous-dev/.eslintrc.js` (or the existing eslint config root, whichever
  is canonical).
- CI grep step in `.github/workflows/ci.yml` per TDD-029 §7.1 option C: searches
  `plugins/autonomous-dev/tests/` and `plugins/autonomous-dev-portal/tests/` for
  `process\.exit`; non-zero matches fail the workflow with an annotation referencing
  FR-1660. Belt-and-braces backstop for the ESLint rule.
- Replace the existing "3 known failures allowed" carve-out in `.github/workflows/ci.yml`
  with `npx jest --runInBand --ci --reporters=default --reporters=jest-junit`. The
  `--ci` flag forces non-zero exit on any non-skipped failure (FR-1661).
- Add `jest-junit` as a dev dependency. Configure it via `jest.config.cjs` reporters
  array (or via env vars `JEST_JUNIT_OUTPUT_DIR=./reports`,
  `JEST_JUNIT_OUTPUT_NAME=jest-junit.xml`). Upload `reports/jest-junit.xml` as a CI
  artifact via `actions/upload-artifact@v4` (FR-1662, P2 but cheap so ship together).
- Author `tests/_meta/test-no-process-exit.test.ts` per TDD-029 §11.2: an idiomatic
  jest suite that greps the tree and asserts zero hits. Functions as the third gate
  (lint + CI step + test-time assertion) and ensures even a malformed CI pipeline still
  catches the regression.
- Self-test of the gate per TDD-029 §11.3 (documented protocol, not a merged commit):
  open a throwaway local PR introducing a single `process.exit(1)` into a test file;
  verify (a) `npm run lint` fails locally, (b) the CI grep step fails on the workflow,
  (c) the meta-test fails. Document the protocol in the PR description; do not merge
  the throwaway PR.

### Out of Scope

- The harness migration itself (delivered by **PLAN-029-1**). PLAN-029-3 assumes
  `git grep -n "process\.exit" plugins/autonomous-dev/tests` already returns zero on
  this branch.
- The triage matrix (delivered by **PLAN-029-2**). PLAN-029-3 assumes every FAIL has
  been dispositioned via PLAN-029-2 so that `--ci` lands green. Per TDD-029 OQ-29-04,
  PLAN-029-3 ships *after* PLAN-029-2 (the `--ci` flag's no-allowlist would otherwise
  break the build).
- The `flake-check.yml` 5-rerun workflow (PLAN-029-4 fast-follow per TDD-029 §12).
- Production code changes, security test backfill, SPEC reconciliation — all out of
  scope per parent PRD non-goals.

## Tasks

### Task 1 — Add the ESLint `no-restricted-syntax` rule

Locate the canonical ESLint config at `plugins/autonomous-dev/.eslintrc.js` (created by
PLAN-016-1 task 6). Add an `overrides` entry for test files:

```js
overrides: [
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
  },
],
```

Files to modify:

- `plugins/autonomous-dev/.eslintrc.js`

Acceptance:

- `npx eslint plugins/autonomous-dev/tests/**/*.test.ts` runs cleanly on the
  post-PLAN-029-1 tree (zero `no-restricted-syntax` errors).
- A scratch file containing `process.exit(0)` inside a `.test.ts` produces an ESLint
  error pointing at the call site with the FR-1660 message.

Estimated effort: 2h.

### Task 2 — Add the CI grep step

Edit `.github/workflows/ci.yml`. Add a new step in the `lint` job (or a dedicated
`harness-guard` job — single-runner, ubuntu-latest, sub-second). Step:

```yaml
- name: Check for process.exit in test files (PRD-016 FR-1660)
  run: |
    if grep -rn "process\.exit" plugins/autonomous-dev/tests/ plugins/autonomous-dev-portal/tests/ ; then
      echo "::error::process.exit() found in test files. See PRD-016 FR-1660."
      exit 1
    fi
```

Note: the grep step is intentionally not gated by a `paths-filter` — it runs on every
PR so a contributor cannot bypass it by routing changes through a non-test path.

Files to modify:

- `.github/workflows/ci.yml`

Acceptance:

- Step passes on the post-PLAN-029-1 tree.
- A throwaway commit introducing `process.exit(1)` into any test file fails the step
  with the documented `::error::` annotation.

Estimated effort: 1h.

### Task 3 — Replace the "3 known failures allowed" carve-out with `--ci`

Locate the existing `test` job in `.github/workflows/ci.yml`. Find the carve-out
(typically a `continue-on-error: true`, an exit-code allowlist, or an inline `||
true` chain) and replace the `npm test` invocation with:

```yaml
- name: Run jest (PRD-016 FR-1661)
  working-directory: plugins/autonomous-dev
  run: npx jest --runInBand --ci --reporters=default --reporters=jest-junit
  env:
    JEST_JUNIT_OUTPUT_DIR: ./reports
    JEST_JUNIT_OUTPUT_NAME: jest-junit.xml
```

The `--ci` flag forces `process.exitCode` non-zero on any non-skipped failure with no
allowlist. Skipped suites (per PLAN-029-2's SKIP-WITH-NOTE rows) are honored — jest
treats `describe.skip` / `it.skip` as pending, not failed.

Files to modify:

- `.github/workflows/ci.yml`

Acceptance:

- After PLAN-029-2 lands, `npx jest --runInBand --ci` exits 0 on the branch.
- The carve-out language (`continue-on-error: true`, exit-code allowlist, `|| true`)
  is removed entirely.
- A deliberately introduced failing `it()` block (no `.skip`) fails the workflow.

Estimated effort: 2h.

### Task 4 — Add `jest-junit` dependency and configure reporter

In `plugins/autonomous-dev/package.json`:

```bash
npm install --save-dev jest-junit
```

In `plugins/autonomous-dev/jest.config.cjs` (or via the `--reporters` flag in CI):

```js
reporters: [
  'default',
  ['jest-junit', { outputDirectory: './reports', outputName: 'jest-junit.xml' }],
],
```

Add a `Upload jest JUnit report` step to the `test` job in `.github/workflows/ci.yml`:

```yaml
- name: Upload jest JUnit report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: jest-junit-${{ matrix.os }}-node${{ matrix.node-version }}
    path: plugins/autonomous-dev/reports/jest-junit.xml
    retention-days: 30
```

Add `plugins/autonomous-dev/reports/` to `.gitignore`.

Files to modify:

- `plugins/autonomous-dev/package.json`
- `plugins/autonomous-dev/package-lock.json`
- `plugins/autonomous-dev/jest.config.cjs`
- `.github/workflows/ci.yml`
- `plugins/autonomous-dev/.gitignore` (or repo-root `.gitignore`)

Acceptance:

- `jest-junit` resolves at `^16.x` (current major as of 2026-05); MIT licensed; no
  native bindings (TDD-029 §8.1 requirement).
- CI artifact `jest-junit-ubuntu-latest-node20.xml` (and matrix peers) appears on the
  workflow's Artifacts tab.
- The GitHub Actions UI's test-results tab renders per-suite pass/fail (verified by
  opening the workflow run after merge).

Estimated effort: 2h.

### Task 5 — Author the meta-test

Create `plugins/autonomous-dev/tests/_meta/test-no-process-exit.test.ts` per TDD-029
§11.2:

```ts
import { execSync } from 'child_process';
import { join } from 'path';

describe('PRD-016 FR-1660: no process.exit in test files', () => {
  it('grep finds no process.exit calls under plugins/autonomous-dev/tests/', () => {
    const repoRoot = join(__dirname, '..', '..', '..', '..');
    const result = execSync(
      'grep -rn "process\\.exit" plugins/autonomous-dev/tests/ || true',
      { encoding: 'utf-8', cwd: repoRoot },
    );
    // Allow the meta-test itself to mention "process.exit" inside a comment / string.
    const hits = result
      .split('\n')
      .filter((line) => line && !line.includes('test-no-process-exit.test.ts'));
    expect(hits).toEqual([]);
  });
});
```

Files to create:

- `plugins/autonomous-dev/tests/_meta/test-no-process-exit.test.ts`

Acceptance:

- Test runs under `npx jest tests/_meta/test-no-process-exit.test.ts` in <2s.
- Test passes on the post-PLAN-029-1 tree.
- A scratch commit introducing `process.exit(1)` into another test file causes this
  meta-test to fail with a clear "found `<path>:<line>` containing process.exit"
  message.
- The `_meta` directory contains only this file (future meta-tests can be added; the
  directory acts as the conventional home for test-tree-shape assertions).

Estimated effort: 2h.

### Task 6 — Self-test the gate (documented protocol; not merged)

Per TDD-029 §11.3, exercise all three gates with a throwaway local commit.

Procedure (recorded in the PR description, not in the merged commit):

1. On a scratch branch off this plan's branch, create `tests/scratch.test.ts`
   containing `import {} from 'fs'; process.exit(1);`.
2. Run `npm run lint` from `plugins/autonomous-dev/`. **Expect:** ESLint reports the
   `no-restricted-syntax` violation with the FR-1660 message.
3. Push the scratch branch (do not open a PR to main; use a draft against the
   plan branch). **Expect:** the CI workflow's "Check for process.exit in test files"
   step fails with the `::error::` annotation.
4. Run `npx jest tests/_meta/test-no-process-exit.test.ts`. **Expect:** meta-test
   fails listing `tests/scratch.test.ts:1`.
5. Delete the scratch file and the scratch branch.

Acceptance:

- The PR description includes a section titled "Gate self-test (per TDD-029 §11.3)"
  with the three observed failure outputs (or screenshots) for the three gates.
- No scratch test file is merged.

Estimated effort: 2h.

### Task 7 — Verify post-merge CI behaviour

After Tasks 1–6 land on the plan branch, push and open the PR. Confirm:

1. The full `ci.yml` workflow runs end-to-end.
2. The `lint` job (or `harness-guard` job) runs the new grep step and passes.
3. The `test` job runs `npx jest --runInBand --ci` and passes (no carve-out).
4. The JUnit XML artifact uploads.
5. The meta-test passes.

If any check fails on a clean tree, fix the wiring before merging.

Acceptance:

- Green CI on a clean tree.
- All four artifacts (one per matrix leg) present.
- Workflow run time within the existing 8-minute NFR-1001 budget (TDD-029 §8.3
  projected the post-migration suite at ~3 min default parallelism / ~10 min
  `--runInBand`; we accept a small budget bump if `--ci` runs the full suite).

Estimated effort: 1h.

## Acceptance Criteria

- ESLint `no-restricted-syntax` rule active on `**/*.test.ts` and `**/*.spec.ts`;
  produces an error on any `process.exit(...)` call with the FR-1660 message
  (PRD-016 FR-1660).
- CI workflow contains a "Check for process.exit in test files" step that fails the
  workflow on any match (TDD-029 §7.1 option C; defense-in-depth backstop).
- CI workflow's `test` job runs `npx jest --runInBand --ci` with no allowlist; the
  legacy "3 known failures allowed" carve-out is removed (PRD-016 FR-1661).
- `jest-junit` dependency installed; reporter wired; XML artifact uploaded per matrix
  leg (PRD-016 FR-1662).
- `plugins/autonomous-dev/tests/_meta/test-no-process-exit.test.ts` exists and passes
  on the post-PLAN-029-1 tree (TDD-029 §11.2).
- Self-test protocol from TDD-029 §11.3 captured in the PR description with the three
  expected gate failures.
- Post-merge: pushing a regression (`process.exit` in a test file) fails ESLint, the
  CI grep step, and the meta-test independently.

## Testing

- **Lint self-check:** `npx eslint plugins/autonomous-dev/tests/**/*.test.ts` exits 0
  on the post-PLAN-029-1 tree.
- **CI grep self-check:** the workflow step passes on the post-PLAN-029-1 tree.
- **Jest --ci self-check:** `npx jest --runInBand --ci` exits 0 after PLAN-029-2's
  SKIP annotations.
- **JUnit XML self-check:** the artifact appears on the workflow run page; opening
  the XML shows per-suite `<testcase>` elements.
- **Meta-test self-check:** `npx jest tests/_meta/test-no-process-exit.test.ts` exits 0.
- **Gate regression test (Task 6):** all three gates fail when a `process.exit` is
  re-introduced; documented in the PR description.

## Risks

| ID    | Risk                                                                                                                                          | Probability | Impact | Mitigation                                                                                                                                                                                              |
|-------|-----------------------------------------------------------------------------------------------------------------------------------------------|-------------|--------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| R-301 | `--ci` flag turns the build red because PLAN-029-2 missed a FAIL row.                                                                          | Medium      | High   | Ship PLAN-029-3 *after* PLAN-029-2 (TDD-029 OQ-29-04). Pre-merge: confirm `npx jest --runInBand --ci` exits 0 locally before pushing.                                                                     |
| R-302 | ESLint `no-restricted-syntax` selector mismatches a non-`process.exit` call (e.g., `globalThis.process.exit(0)`) and a regression slips through. | Low         | High   | Defense-in-depth: the CI grep step's regex `process\.exit` catches `globalThis.process.exit`, `process["exit"]`, etc., that the AST selector misses. Meta-test is a third gate.                            |
| R-303 | `jest-junit` reporter writes to `./reports/` but `reports/` is not gitignored; XML artifacts get committed.                                     | Low         | Low    | Task 4 adds `plugins/autonomous-dev/reports/` to `.gitignore`. Reviewer verifies during PR.                                                                                                              |
| R-304 | The CI grep step also matches comments / strings (e.g., `// process.exit is forbidden`), producing false positives.                            | Low         | Low    | Practical: the test files post-PLAN-029-1 do not contain `process.exit` even in comments. If a future doc-comment trips the grep, the fix is to refer to the call as `process[.]exit` in comments.        |
| R-305 | `actions/upload-artifact@v4` retention-days conflict with org policy or storage quota.                                                        | Low         | Low    | Default 30-day retention matches existing CI artifact policy. Reduce to 14 days if storage cap is hit; tracked in CI metrics dashboard.                                                                  |
| R-306 | Adding `jest-junit` as a dependency triggers a security audit warning (transitive dep with known CVE).                                        | Low         | Medium | `jest-junit` is widely used (millions of weekly downloads as of 2026), MIT licensed, no native bindings (TDD-029 §8.1). Confirm at install time; pin to current major and review lockfile changes.       |
| R-307 | Post-migration jest run wall-clock exceeds CI's 8-minute NFR-1001 (TDD-016) budget once `--ci` runs the full suite end-to-end.                 | Medium      | Medium | TDD-029 §8.3 projects ~10 min `--runInBand` / ~3 min default parallel. CI uses default parallelism. If exceeded, sharding via `--shard=N/M` is a fast-follow per PRD-016 §11; not in this plan's scope.   |

## Definition of Done

- [ ] ESLint `no-restricted-syntax` rule active on test files; produces FR-1660 error.
- [ ] CI grep step in `ci.yml` fails workflow on any `process.exit` match.
- [ ] `test` job runs `npx jest --runInBand --ci`; carve-out removed.
- [ ] `jest-junit` installed and wired; XML artifact uploaded per matrix leg.
- [ ] `tests/_meta/test-no-process-exit.test.ts` exists, passes, and grep-asserts a
      clean tree.
- [ ] PR description records the TDD-029 §11.3 self-test outputs.
- [ ] `npx jest --runInBand --ci` exits 0 on a clean tree.
- [ ] All three gates independently fail when a `process.exit` is re-introduced
      (verified per Task 6 protocol).

## Dependencies

### Parent TDD

- **TDD-029** §7 (CI Gate Hardening), §11.2 (lint-rule self-test), §11.3 (CI gate
  self-test), §10.1 phase 6.

### Parent PRD

- **PRD-016** §7.7 (FR-1660, FR-1661, FR-1662), §9 (acceptance criteria for these
  FRs), §10 R-04, §12 OQ-02.

### Blocked By

- **PLAN-029-1** — `process.exit` must already be absent from
  `plugins/autonomous-dev/tests/` so the lint rule and CI grep step land green.
- **PLAN-029-2** — every FAIL must be dispositioned (FIX `next-PR` / SKIP-WITH-NOTE /
  DELETE) so `npx jest --runInBand --ci` exits 0 on this PR's tree (TDD-029 OQ-29-04).

### Blocks Downstream Plans

- **PLAN-029-4** (flake re-classification workflow, P1 fast-follow) — uses the
  `jest-junit` reporter to capture per-rerun results in CI artifacts.

### Integration Points

- The ESLint rule extends the existing `.eslintrc.js` from PLAN-016-1; it lives in an
  `overrides` block so the base config is unchanged.
- The CI grep step lives in the `lint` job (or a new sub-second `harness-guard` job)
  to keep the failure mode adjacent to other lint findings.
- The JUnit XML artifact extends the existing `actions/upload-artifact@v4` pattern
  used by PLAN-016-1 for coverage reports.
- The meta-test lives under `tests/_meta/` — a new convention for tree-shape
  assertions. Future meta-tests (e.g., "every SPEC has a corresponding test file")
  can co-locate here.
