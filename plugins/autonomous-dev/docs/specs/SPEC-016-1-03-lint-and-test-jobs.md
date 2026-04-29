# SPEC-016-1-03: lint and test Jobs (ESLint + Prettier; Jest Matrix with Coverage Artifact)

## Metadata
- **Parent Plan**: PLAN-016-1
- **Tasks Covered**: Task 4 (lint job: ESLint github format + Prettier check), Task 5 (test matrix job + coverage artifact)
- **Estimated effort**: 5 hours

## Description

Add the `lint` and `test` jobs to `.github/workflows/ci.yml`. The `lint` job runs ESLint with the `github` formatter (so violations annotate PR diffs) and Prettier in check mode against source, tests, and config JSON files on a single ubuntu-latest runner. The `test` job runs `npm test -- --coverage` across the same 2x2 matrix (`os: [ubuntu-latest, macos-latest]` x `node-version: [18, 20]`) used by `typecheck`, with `lcov` and `html` reporters, and uploads a coverage artifact exactly once per workflow run from the `ubuntu-latest + Node 20` leg.

Both jobs are gated on the `typescript` filter output from SPEC-016-1-01 and depend on the ESLint/Prettier configuration files delivered by SPEC-016-1-04.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Modify | `.github/workflows/ci.yml` | Append the `lint` and `test` jobs to the existing `jobs:` block |

## Implementation Details

### lint Job

Append after the `typecheck` job from SPEC-016-1-02.

```yaml
  lint:
    name: Lint (ESLint + Prettier)
    needs: paths-filter
    if: needs.paths-filter.outputs.typescript == 'true'
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: plugins/autonomous-dev
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js 20
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
          cache-dependency-path: 'plugins/autonomous-dev/package-lock.json'

      - name: Install dependencies
        run: npm ci

      - name: ESLint
        run: npx eslint src/ tests/ --ext .ts --format github

      - name: Prettier
        run: npx prettier --check 'src/**/*.ts' 'tests/**/*.ts' 'package.json' 'tsconfig*.json' --log-level warn
```

### test Job

Append after the `lint` job.

```yaml
  test:
    name: Test (${{ matrix.os }}, Node ${{ matrix.node-version }})
    needs: paths-filter
    if: needs.paths-filter.outputs.typescript == 'true'
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        node-version: [18, 20]
    defaults:
      run:
        working-directory: plugins/autonomous-dev
    env:
      NODE_ENV: test
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'
          cache-dependency-path: 'plugins/autonomous-dev/package-lock.json'

      - name: Install dependencies
        run: npm ci

      - name: Run Jest with coverage
        run: npm test -- --coverage --coverageReporters=text-lcov --coverageReporters=html

      - name: Upload coverage artifact
        if: matrix.os == 'ubuntu-latest' && matrix.node-version == 20
        uses: actions/upload-artifact@v4
        with:
          name: coverage-report
          path: |
            plugins/autonomous-dev/coverage/lcov.info
            plugins/autonomous-dev/coverage/lcov-report/
          retention-days: 30
          if-no-files-found: error
```

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| `lint` runs on a single ubuntu-latest + Node 20 | Lint output is OS- and version-independent for TypeScript. Running once is cheaper and avoids duplicate annotations across legs. |
| `lint` uses `--format github` | Emits `::error file=...,line=...` annotations that GitHub renders inline on the PR diff, giving authors immediate visual feedback. |
| Prettier `--log-level warn` | Suppresses verbose per-file logs while still surfacing failures. Keeps job logs scannable. |
| Prettier glob patterns explicit | Single-quoted globs prevent the shell from expanding them; node-glob (via Prettier) does the matching. Targets `src/`, `tests/`, `package.json`, and all `tsconfig*.json`. |
| `test` matrix mirrors `typecheck` | Catches Node-version-specific runtime regressions (e.g., new built-ins) and OS-specific differences (path handling, file watchers). |
| `fail-fast: false` on `test` | Independent leg reporting (same rationale as `typecheck`). |
| `NODE_ENV: test` | Standard convention; some test fixtures gate on it. Set at the job level so every step inherits it. |
| Coverage upload gated on a single leg | `if: matrix.os == 'ubuntu-latest' && matrix.node-version == 20` ensures exactly one upload per workflow run. Avoids artifact collisions and the four-way race that would otherwise occur. |
| Coverage reporters: `text-lcov` + `html` | `lcov.info` enables external coverage tooling; HTML enables human review by downloading the artifact. The default `text` reporter (console) is also produced by Jest implicitly. |
| Retention 30 days | Long enough to bisect regressions across a sprint; short enough to control storage costs. |
| `if-no-files-found: error` | Fails fast if Jest's coverage output path moved unexpectedly, preventing silent loss of coverage data. |
| `lint` is a single job, not split | A combined ESLint + Prettier job halves checkout/install time. Failures from either tool surface as separate step failures with distinct labels. |

### Validation Notes

- `npx eslint` must run AFTER `npm ci` so the local `eslint` binary is on path. `npx` falls back to the system version otherwise -- a flake source.
- The Prettier glob list MUST match the `prettierIgnore` exclusions delivered by SPEC-016-1-04. Running Prettier against `node_modules/`, `dist/`, or `coverage/` would fail or be slow.
- `actions/upload-artifact@v4` does not auto-merge artifacts of the same name across jobs. The single-leg gate is essential.
- The `test` job inherits the npm cache populated by `typecheck`. Cache hit logs should appear on the second job to run.
- `npm test` resolves to the `test` script in `package.json`. Confirm the script exists and invokes Jest (`jest`) -- this is a precondition; do not modify `package.json` here.

### Edge Cases

- **Prettier finds zero files matching a glob**: `--check` exits 0 with a warning. This is acceptable; it means the glob is over-broad but harmless.
- **ESLint exits 1 due to warnings**: ESLint's default behavior is to exit 0 on warnings; only errors fail. The `--format github` formatter still annotates warnings with `::warning` notices but does not fail the job. (Acceptable per TDD-016.)
- **Jest creates partial coverage on test failure**: `actions/upload-artifact@v4` with `if-no-files-found: error` will succeed if any of the listed paths exist. The upload step also has implicit `if: success()` semantics by default; if Jest fails, the upload is skipped. To preserve partial coverage, sibling specs may add `if: always() && matrix.os == 'ubuntu-latest' && matrix.node-version == 20` -- not done here to keep failure signals clean.
- **Coverage path drift**: If Jest is reconfigured to write to `.coverage/` instead of `coverage/`, the `path` block must be updated. This is caught by `if-no-files-found: error`.
- **Node 18 ESM differences**: The `lint` job runs only on Node 20 to avoid resolver edge cases. `test` runs on both Node 18 and Node 20 because runtime behavior is the actual signal.

## Acceptance Criteria

### lint Job

1. [ ] `.github/workflows/ci.yml` contains a `lint` job under `jobs:`.
2. [ ] `lint.needs` is `paths-filter`.
3. [ ] `lint.if` is `needs.paths-filter.outputs.typescript == 'true'`.
4. [ ] `lint.runs-on` is `ubuntu-latest`.
5. [ ] `lint.defaults.run.working-directory` is `plugins/autonomous-dev`.
6. [ ] Setup-node step pins to Node 20 with npm cache against the plugin lockfile.
7. [ ] ESLint step runs `npx eslint src/ tests/ --ext .ts --format github`.
8. [ ] Prettier step runs `npx prettier --check` over `src/`, `tests/`, `package.json`, and all `tsconfig*.json` with `--log-level warn`.
9. [ ] Introducing a deliberate ESLint violation in any `src/**/*.ts` file fails the job AND produces a GitHub annotation visible in the PR diff.
10. [ ] Introducing a deliberately mis-formatted `.ts` file fails the Prettier step.
11. [ ] On a clean tree with warm caches, the job completes in under 4 minutes (NFR-1002 budget).

### test Job

12. [ ] `.github/workflows/ci.yml` contains a `test` job under `jobs:`.
13. [ ] `test.needs` is `paths-filter`.
14. [ ] `test.if` is `needs.paths-filter.outputs.typescript == 'true'`.
15. [ ] `test.strategy.fail-fast` is `false`.
16. [ ] `test.strategy.matrix.os` is `[ubuntu-latest, macos-latest]`.
17. [ ] `test.strategy.matrix.node-version` is `[18, 20]`.
18. [ ] `test.env.NODE_ENV` is `test`.
19. [ ] `test` job runs `npm test -- --coverage --coverageReporters=text-lcov --coverageReporters=html`.
20. [ ] Coverage upload step has `if: matrix.os == 'ubuntu-latest' && matrix.node-version == 20`.
21. [ ] Coverage upload uses `actions/upload-artifact@v4` with `name: coverage-report`, `retention-days: 30`, `if-no-files-found: error`.
22. [ ] Coverage artifact contains both `lcov.info` and the `lcov-report/` HTML directory.
23. [ ] A failing test on any leg fails only that leg, not the others.
24. [ ] Exactly one coverage artifact is produced per workflow run.
25. [ ] `actionlint` reports zero errors against the modified `ci.yml`.

## Test Cases

1. **test_lint_job_exists** -- `yq '.jobs.lint'` is non-null.
2. **test_lint_node_version_20** -- `yq '.jobs.lint.steps[1].with."node-version"'` is `20`.
3. **test_lint_eslint_format_github** -- The ESLint step's `run` value contains `--format github`.
4. **test_lint_prettier_check_present** -- Prettier step contains `--check` and at least the patterns `src/**/*.ts`, `tests/**/*.ts`, `package.json`, `tsconfig*.json`.
5. **test_lint_eslint_failure_annotates_pr** (CI-observable) -- A PR introducing `var x = 1;` (ESLint `no-var` violation) shows a red annotation in the GitHub PR diff at the offending line.
6. **test_lint_prettier_failure** (CI-observable) -- A PR with `const x =1;` (missing space) fails the Prettier step with a non-zero exit.
7. **test_lint_clean_under_4min** (CI-observable) -- A clean PR shows the `lint` job duration < 4 minutes on a warm cache.
8. **test_test_job_exists** -- `yq '.jobs.test'` is non-null.
9. **test_test_matrix_shape** -- Same matrix as `typecheck`: `[ubuntu-latest, macos-latest]` x `[18, 20]`.
10. **test_test_node_env_set** -- `yq '.jobs.test.env.NODE_ENV'` is `test`.
11. **test_test_runs_jest_coverage** -- The Jest step's `run` value contains `npm test -- --coverage --coverageReporters=text-lcov --coverageReporters=html`.
12. **test_coverage_upload_gated** -- The upload step's `if:` exactly matches `matrix.os == 'ubuntu-latest' && matrix.node-version == 20`.
13. **test_coverage_artifact_paths** -- The artifact `path:` block lists both `coverage/lcov.info` and `coverage/lcov-report/`.
14. **test_coverage_retention_30** -- `retention-days` is `30`.
15. **test_coverage_if_no_files_found** -- `if-no-files-found` is `error`.
16. **test_test_independent_legs** (CI-observable) -- A test that fails only on Node 18 produces 2 failed legs (Node 18 ubuntu + macOS) and 2 passing legs (Node 20).
17. **test_one_coverage_artifact_per_run** (CI-observable) -- The "Artifacts" section of a successful workflow run lists `coverage-report` exactly once.
18. **test_actionlint_clean_after_modify** -- `actionlint` exits 0 against the updated `ci.yml`.

## Dependencies

- **Blocked by**: SPEC-016-1-01 (paths-filter outputs), SPEC-016-1-02 (typecheck job; not strictly required but conventional ordering means typecheck lands first), SPEC-016-1-04 (ESLint and Prettier configs must exist for the lint job to succeed; the lint job will fail on a clean checkout without those files).
- **Blocks**: PLAN-016-2 (when adding shell/markdown/actionlint jobs, those jobs land after `test` to keep the readers' mental order consistent).
- **External**: `plugins/autonomous-dev/package.json` MUST contain a `test` script that invokes Jest with appropriate test file discovery. `eslint`, `prettier`, and `jest` MUST be listed under `devDependencies` (precondition).

## Notes

- The `lint` job intentionally does NOT run on Node 18. ESLint and Prettier behave identically across LTS Node versions, and a single-version run is sufficient.
- The Prettier glob list overlaps with the ESLint `--ext .ts` scope but adds JSON config files. Both are required because ESLint does not check JSON formatting.
- Coverage thresholds are NOT enforced here; they live in `jest.config.js` (out of scope for this spec). If coverage thresholds fail, Jest fails the test step naturally.
- The single-leg coverage upload is a deliberate simplification. A future enhancement could merge per-leg coverage reports via `actions/upload-artifact@v4` with named suffixes and a downstream merge job, but that complexity is unjustified at the project's current scale.
- The `lint` step ordering (ESLint first, then Prettier) means a Prettier failure is reported only after ESLint passes. Reordering is acceptable; the spec does not pin the order.
- This spec MUST NOT modify the `paths-filter` or `concurrency` blocks owned by SPEC-016-1-01.
