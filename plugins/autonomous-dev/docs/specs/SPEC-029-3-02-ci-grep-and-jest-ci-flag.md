# SPEC-029-3-02: CI Grep Step + Replace "3 Known Failures Allowed" Carve-Out with `--ci`

## Metadata
- **Parent Plan**: PLAN-029-3 (CI Gate — ESLint Rule, CI Grep, `--ci` Flag, JUnit Reporter)
- **Parent TDD**: TDD-029
- **Parent PRD**: PRD-016
- **Tasks Covered**: PLAN-029-3 Task 2 (add CI grep step in `.github/workflows/ci.yml`) + PLAN-029-3 Task 3 (replace existing "3 known failures allowed" carve-out with `npx jest --runInBand --ci`)
- **Estimated effort**: 3 hours total (~1h grep step + ~2h carve-out replacement and verification)
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/.github/workflows/ci.yml` (modifications)
- **Depends on**: SPEC-029-1-05 (the test tree must be `process.exit`-free before the CI grep step lands), SPEC-029-2-04 (every FAIL must be skipped or deleted before `--ci` lands; otherwise the workflow goes red)

## Description

Modify `.github/workflows/ci.yml` in two coordinated edits:

1. **Add a `harness-guard` grep step** to the `lint` job (or as a dedicated job) that runs `grep -rn "process\.exit" plugins/autonomous-dev/tests/ plugins/autonomous-dev-portal/tests/` and fails the workflow on any match with a `::error::` annotation referencing PRD-016 FR-1660. This is the second of three independent gates (the first is SPEC-029-3-01's ESLint rule; the third is SPEC-029-3-04's meta-test).

2. **Replace the existing "3 known failures allowed" carve-out** in the `test` job with `npx jest --runInBand --ci --reporters=default --reporters=jest-junit` (the JUnit reporter wiring is SPEC-029-3-03's responsibility; this spec only flips to `--ci`). The `--ci` flag forces non-zero exit on any non-skipped failure. Because SPEC-029-2-04 has dispositioned every FAIL into a `.skip`, `DELETE`, or out-of-PR FIX, the new invocation lands green on the post-disposition tree.

After this spec ships, the CI workflow has no allowlist, no `continue-on-error: true`, no `|| true` mask. Any non-skipped FAIL turns the build red.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.github/workflows/ci.yml` | Modify | Add harness-guard grep step (Task 2); replace existing jest invocation in `test` job with `--runInBand --ci ...` (Task 3) |

Two commits:

1. **Task 2 commit**: harness-guard grep step.
2. **Task 3 commit**: `--ci` flag wiring + carve-out removal.

## Implementation Details

### Task 2 — Add the harness-guard CI grep step

#### Step 1: Locate `.github/workflows/ci.yml`

```
$ ls .github/workflows/ci.yml
```

If the file uses a different name (e.g., `ci.yaml`, `main.yml`), use the actual path. The CI workflow is the single canonical workflow; PLAN-029-3 does not create a new workflow file.

Identify the `lint` job (or equivalent — a job that runs lint/typecheck/quick checks). If no `lint` job exists, identify the lowest-cost job and add the step there. A dedicated `harness-guard` job is acceptable but not required; the goal is for the step to run on every PR.

#### Step 2: Add the grep step

Append to the `lint` job's `steps` array (after checkout but before any heavy installs; the grep step needs only the working tree):

```yaml
- name: Check for process.exit in test files (PRD-016 FR-1660)
  run: |
    if grep -rn "process\.exit" plugins/autonomous-dev/tests/ plugins/autonomous-dev-portal/tests/ ; then
      echo "::error::process.exit() found in test files. See PRD-016 FR-1660."
      exit 1
    fi
```

Rules:

- The step name MUST contain `PRD-016 FR-1660` so the GitHub Actions UI surface links the failure to the requirement.
- The grep pattern MUST be `process\.exit` (escaped dot, no parens). This catches `process.exit(...)`, `process.exit;` (rare), and `globalThis.process.exit` (which the ESLint AST selector misses) — defense-in-depth for SPEC-029-3-01.
- The `if grep -rn ... ; then` shape inverts the exit code: `grep` exits 0 on match (which we want to be a failure) and 1 on no-match (success). The `if` block fails the workflow on match.
- The `::error::` annotation is the GitHub Actions structured-log format; it surfaces in the workflow's "Annotations" tab.
- Both directories (`plugins/autonomous-dev/tests/` AND `plugins/autonomous-dev-portal/tests/`) MUST be searched. The portal-side tree may not have any test files yet; an empty directory or missing directory should not trip grep. Use:

  ```bash
  if grep -rn "process\.exit" plugins/autonomous-dev/tests/ plugins/autonomous-dev-portal/tests/ 2>/dev/null ; then
  ```

  The `2>/dev/null` suppresses "No such file or directory" if the portal tree is absent, while preserving the match-detection semantics.
- The step MUST NOT be gated by a `paths-filter`. A contributor cannot bypass it by routing changes through a non-test path.

#### Step 3: Verify on the clean tree

After editing, run the same grep locally to mimic the CI behavior:

```
$ grep -rn "process\.exit" plugins/autonomous-dev/tests/ plugins/autonomous-dev-portal/tests/ 2>/dev/null ; echo "exit=$?"
```

Expected: nothing prints (no match) and exit code is 1 (grep's no-match exit).

If anything prints, SPEC-029-1-05's invariant is broken. Stop and surface to the orchestrator.

#### Step 4: Task 2 commit

```
ci: add harness-guard grep step for process.exit (PRD-016 FR-1660)

Add a grep step to the `lint` job in .github/workflows/ci.yml that
fails the workflow if any `process.exit` token is found under
plugins/autonomous-dev/tests/ or plugins/autonomous-dev-portal/tests/.
This is the second of three independent gates (lint + CI grep +
meta-test) for PRD-016 FR-1660.

Defense-in-depth backstop for SPEC-029-3-01's ESLint AST rule:
  - Catches `globalThis.process.exit` and `process["exit"]` that the
    AST selector misses.
  - Runs in CI even when local pre-commit hooks are bypassed.
  - Step name surfaces FR-1660 in GitHub Actions annotations tab.

Verified locally:
  - `grep -rn "process\.exit" plugins/autonomous-dev/tests/
     plugins/autonomous-dev-portal/tests/` returns no matches on the
     post-PLAN-029-1 tree.
  - A scratch commit introducing process.exit(1) into a test file
     would fail the workflow with the FR-1660 ::error:: annotation
     (verified via SPEC-029-3-04 self-test protocol).

Refs PRD-016 FR-1660; TDD-029 §7.1 option C; PLAN-029-3 Task 2.
```

### Task 3 — Replace "3 known failures allowed" carve-out with `--ci`

#### Step 1: Locate the existing carve-out

In `.github/workflows/ci.yml`'s `test` job, find the current jest invocation. The carve-out manifests as one of:

- `continue-on-error: true` on the jest step.
- A bash chain like `npx jest ... || true` or `npx jest ... ; exit 0`.
- An exit-code allowlist via `if` block (e.g., `if jest exits with 1, exit 0; if more, fail`).
- A specific test-result-count check (e.g., "fail only if more than 3 suites fail").

Identify the literal lines that implement the carve-out. The change is a delete-and-replace, not an in-place tweak.

#### Step 2: Replace with the `--ci` invocation

Replace the existing invocation with:

```yaml
- name: Run jest (PRD-016 FR-1661)
  working-directory: plugins/autonomous-dev
  run: npx jest --runInBand --ci --reporters=default --reporters=jest-junit
  env:
    JEST_JUNIT_OUTPUT_DIR: ./reports
    JEST_JUNIT_OUTPUT_NAME: jest-junit.xml
```

Rules:

- The step name MUST contain `PRD-016 FR-1661`.
- `working-directory` MUST be `plugins/autonomous-dev`. Running jest from the repo root with a `--config plugins/autonomous-dev/jest.config.cjs` flag is acceptable but the working-directory form is what the parent plan documents and matches local-developer muscle memory.
- The `--ci` flag is the keystone. It forces `process.exitCode` non-zero on any non-skipped failure with NO allowlist. Skipped suites (per SPEC-029-2-03's annotations) are pending, not failed; jest does not count them.
- `--reporters=default --reporters=jest-junit` wires the JUnit reporter. The `jest-junit` dependency itself is installed by SPEC-029-3-03; this spec's invocation references the reporter assuming SPEC-029-3-03 has shipped (which is the parent plan's task ordering). If SPEC-029-3-03 has NOT shipped yet, the run fails with "Cannot find module 'jest-junit'". The plan's task order (Task 3 then Task 4) is intentionally tight on this; ship in order.
- The `JEST_JUNIT_OUTPUT_DIR` and `JEST_JUNIT_OUTPUT_NAME` env vars configure the reporter. They MUST match the values SPEC-029-3-03 wires up.
- Remove the carve-out's `continue-on-error`, `|| true`, allowlist, and any specific-failure-count check. The acceptance criterion is "the post-replacement workflow contains zero of these masks."
- Do NOT add a new `continue-on-error` to the new step. The whole point is to fail the build.

#### Step 3: Confirm SPEC-029-2-04 invariant

Before pushing, confirm locally that `npx jest --runInBand --ci` from `plugins/autonomous-dev/` exits 0:

```
$ cd plugins/autonomous-dev
$ npx jest --runInBand --ci
$ echo "exit=$?"
```

Expected: exit code 0. The `--ci` flag's non-zero behavior triggers on any non-skipped FAIL; SPEC-029-2-04 has dispositioned every FAIL.

If the run fails, SPEC-029-2-04's invariant is broken. Stop and surface to the orchestrator. Do NOT ship `--ci` against an un-coherent matrix; the build will be red on day one.

This local check is REQUIRED, not optional. It is the single most important pre-merge action for this spec because the cost of shipping a red CI gate is high (every PR after this one is blocked until reverted).

Note: the `--reporters=jest-junit` flag may fail this local check if SPEC-029-3-03's `jest-junit` install has not landed yet. For the local pre-merge check, an alternative invocation `npx jest --runInBand --ci` (without the `--reporters` flags) is acceptable. The full invocation runs in CI after SPEC-029-3-03 ships.

#### Step 4: Task 3 commit

```
ci: replace "3 known failures allowed" carve-out with --ci (PRD-016 FR-1661)

Replace the existing jest invocation in the `test` job of
.github/workflows/ci.yml with:

    npx jest --runInBand --ci --reporters=default --reporters=jest-junit

Removed:
  - <list of specific carve-out elements found and removed:
     continue-on-error: true / || true / allowlist / count check>

The --ci flag forces non-zero exit on any non-skipped FAIL with no
allowlist. SKIP-WITH-NOTE suites (per SPEC-029-2-03) are honored
because jest treats describe.skip / it.skip as pending, not failed.

Pre-merge invariant verified:
  - `npx jest --runInBand --ci` from plugins/autonomous-dev/ exits 0
    on this branch (SPEC-029-2-04 dispositioned every FAIL).

The --reporters flags reference jest-junit which is installed by
SPEC-029-3-03 (next-up in PLAN-029-3 task order).

Refs PRD-016 FR-1661; TDD-029 §7.2; PLAN-029-3 Task 3.
```

### What NOT to do

- Do NOT collapse the two tasks into a single commit. The grep-step landing is conceptually independent from the carve-out replacement; reviewers benefit from two small diffs over one large one.
- Do NOT add `continue-on-error: true` to the new jest step. That defeats the entire point of `--ci`.
- Do NOT use `working-directory` other than `plugins/autonomous-dev`. The working-directory choice ties the jest config resolution to the canonical local-developer command.
- Do NOT search additional directories in the grep step (e.g., src/, .claude/). The rule is scoped to test files; broader scans risk false positives.
- Do NOT remove the `2>/dev/null` from the grep command. If the portal tree is absent on a future PR, `grep`'s "No such file or directory" output would print to stderr and confuse log readers.
- Do NOT ship `--ci` if `npx jest --runInBand --ci` exits non-zero locally. The pre-merge local check is non-negotiable.
- Do NOT add a `paths-filter` to the harness-guard step. The point is for it to run on every PR.
- Do NOT remove or modify the existing `lint` job's other steps. This spec is additive within the `lint` job and replace-only within the `test` job.

## Acceptance Criteria

Harness-guard grep step (Task 2):

- [ ] `.github/workflows/ci.yml` contains a step named `Check for process.exit in test files (PRD-016 FR-1660)` (or equivalent name with `PRD-016 FR-1660` in it) within the `lint` job (or a dedicated `harness-guard` job).
- [ ] The step's `run` script uses `grep -rn "process\.exit"` against `plugins/autonomous-dev/tests/` and `plugins/autonomous-dev-portal/tests/`, with `2>/dev/null` to handle missing portal directory.
- [ ] On match, the script emits `::error::process.exit() found in test files. See PRD-016 FR-1660.` and `exit 1`.
- [ ] On no-match, the script exits 0.
- [ ] The step is NOT gated by a `paths-filter` or `if:` predicate; it runs on every workflow invocation.
- [ ] Local verification: `grep -rn "process\.exit" plugins/autonomous-dev/tests/ plugins/autonomous-dev-portal/tests/ 2>/dev/null` returns nothing on the post-SPEC-029-1-05 tree.
- [ ] Task 2 commit body matches the §Task 2 step 4 template; references `PRD-016 FR-1660; TDD-029 §7.1 option C; PLAN-029-3 Task 2`.

`--ci` flag wiring (Task 3):

- [ ] `.github/workflows/ci.yml`'s `test` job contains a step named `Run jest (PRD-016 FR-1661)` (or equivalent name with `PRD-016 FR-1661` in it).
- [ ] The step's `run` is exactly `npx jest --runInBand --ci --reporters=default --reporters=jest-junit`.
- [ ] The step's `working-directory` is `plugins/autonomous-dev`.
- [ ] The step's `env` block sets `JEST_JUNIT_OUTPUT_DIR: ./reports` and `JEST_JUNIT_OUTPUT_NAME: jest-junit.xml`.
- [ ] The previous jest-invocation step is removed from the workflow (verified by `git diff .github/workflows/ci.yml` showing the deletion).
- [ ] Any of the following carve-out patterns are absent from the `test` job after this commit: `continue-on-error: true`, `|| true`, exit-code allowlists, "N known failures allowed" count checks. Verified by:

  ```
  $ grep -E "continue-on-error|\|\| true" .github/workflows/ci.yml
  ```

  returning no matches in the `test` job.

- [ ] Pre-merge local check captured in PR description: `npx jest --runInBand --ci` from `plugins/autonomous-dev/` exits 0 on the post-SPEC-029-2-04 tree (the `--reporters=jest-junit` portion of the full invocation is verified later by SPEC-029-3-03's CI integration; local check excludes it if `jest-junit` is not yet installed).
- [ ] Task 3 commit body matches the §Task 3 step 4 template; references `PRD-016 FR-1661; TDD-029 §7.2; PLAN-029-3 Task 3`. Body MUST list the specific carve-out elements that were removed.

Cross-cutting:

- [ ] Exactly two commits land. `git log --oneline` shows one commit per task on this spec's branch range.
- [ ] No test files modified. No production source files modified. No ESLint config modified (those changes belong to SPEC-029-3-01). No `package.json` / `jest.config.cjs` modified (those belong to SPEC-029-3-03). Verified by `git diff --name-only HEAD~2..HEAD` returning exactly `.github/workflows/ci.yml`.

## Dependencies

- **Blocked by**: SPEC-029-1-05. The post-migration tree must be `process.exit`-free before the CI grep step lands; otherwise the first workflow run fails on the existing tree.
- **Blocked by**: SPEC-029-2-04. The post-disposition tree must produce zero non-skipped FAILs before `--ci` lands; otherwise the first workflow run after merge is red and blocks every subsequent PR.
- **Blocks**: SPEC-029-3-03 (jest-junit reporter wiring). Task 3's `--reporters=jest-junit` flag references the reporter that SPEC-029-3-03 installs. The two specs ship adjacent in PLAN-029-3 task order.
- **Blocks**: SPEC-029-3-04 (meta-test + self-test). The meta-test verifies the same invariant as the CI grep; the self-test exercises both gates against a scratch `process.exit` introduction.

## Notes

- The pre-merge local check `npx jest --runInBand --ci` is the spec's keystone gate. The cost of getting this wrong (red CI on `main`) is asymmetric: every subsequent PR is blocked until the gate is reverted or fixed. Treat the local check as mandatory.
- The two-commit split is deliberate. The grep step is independently reviewable: a reviewer can verify Task 2's correctness without reading Task 3's diff. Conversely, the carve-out replacement is the higher-risk change and benefits from a focused review.
- The `--ci` flag's behavior is documented in jest's CLI docs: it prevents writing snapshot updates and forces non-zero exit on failure. The `--ci` flag IS the run-completion gate; SPEC-029-3-04's meta-test is a separate runtime assertion.
- `working-directory: plugins/autonomous-dev` matches the local-developer command the team types. Keeping the CI invocation identical to the local one minimises "works on my machine" debugging.
- The grep step's defense-in-depth role is not theoretical: AST selectors miss `globalThis.process.exit`, `process["exit"]`, and any computed-property variant. Regex matching the literal token catches all of them at the cost of occasional false positives in comments. Per parent plan R-304, the false-positive rate on the post-PLAN-029-1 tree is zero, so the trade-off is worth it.
- The reviewer's checklist for the Task 3 commit specifically: (1) confirm the carve-out is gone (grep for `continue-on-error`, `|| true`, allowlist patterns), (2) confirm the new step name contains `PRD-016 FR-1661`, (3) read the PR description's local-check capture and confirm exit 0, (4) confirm `working-directory` and env vars are correct.
- If a future PR introduces a new test runner or sharding flag, the `npx jest --runInBand --ci ...` invocation may need to change. The spec's contract is the FR-1661 behavior (no allowlist, fail on non-skipped failure), not the literal command. Future amendments are PRs against this spec.
