# PLAN-016-1: ci.yml Main Workflow (TypeScript Validation Pipeline)

| Field          | Value                                                |
|----------------|------------------------------------------------------|
| **Parent TDD** | TDD-016: Baseline CI & Plugin Validation             |
| **Plan ID**    | PLAN-016-1                                           |
| **Version**    | 1.0                                                  |
| **Date**       | 2026-04-28                                           |
| **Status**     | Draft                                                |
| **Priority**   | P0                                                   |
| **Estimated effort** | 3 days                                         |

## Objective

Deliver the foundational `.github/workflows/ci.yml` file that powers TypeScript validation on every pull request. This plan implements the workflow trigger configuration, the `dorny/paths-filter` job that gates downstream work, the TypeScript matrix (Node.js 18/20 across ubuntu-latest and macos-latest) for `typecheck` and `test` jobs, the single-runner `lint` job (ESLint + Prettier), and the concurrency group that cancels superseded runs. It produces a working CI pipeline that validates only the TypeScript surface of the autonomous-dev repository -- shell, markdown, plugin manifest, and security jobs are added by sibling plans (PLAN-016-2/3/4).

## Scope

### In Scope
- `.github/workflows/ci.yml` skeleton: name, `on:` triggers (push to main, pull_request opened/synchronize/ready_for_review), top-level `concurrency` group with `cancel-in-progress: true`, and `env:` block for `NODE_VERSION_MATRIX` and `CLAUDE_CLI_VERSION`
- `paths-filter` job using `dorny/paths-filter@v3` with the `typescript`, `shell`, `markdown`, `workflows`, and `plugins` filter definitions from TDD-016 Section 4 (so downstream plans can wire their own jobs without redefining filters)
- `typecheck` job: `needs: paths-filter`, gated by `typescript == 'true'`, matrix over `os: [ubuntu-latest, macos-latest]` and `node-version: [18, 20]`, with `actions/setup-node@v4` npm caching, `npm ci` in `plugins/autonomous-dev`, `npx tsc --noEmit --incremental`, and `actions/cache@v4` for `tsconfig.tsbuildinfo`
- `lint` job: single ubuntu-latest runner on Node 20, runs `npx eslint src/ tests/ --ext .ts --format github` and `npx prettier --check` over source, tests, and config JSON files
- `test` job: same matrix as `typecheck`, runs `npm test -- --coverage` with lcov + html reporters, uploads coverage artifact (`actions/upload-artifact@v4`) only from the ubuntu-latest + Node 20 leg, retention 30 days
- `fail-fast: false` on both matrix jobs so all four matrix legs report independently
- ESLint and Prettier configuration files (`.eslintrc.js`, `.prettierrc`, `.prettierignore`) per TDD-016 Section 5, scoped to `plugins/autonomous-dev/`

### Out of Scope
- `shell`, `markdown`, and `actionlint` jobs in `ci.yml` -- delivered by PLAN-016-2
- `plugin-validate` job, `.github/schemas/plugin.schema.json`, Claude CLI bootstrap, JSON schema fallback -- delivered by PLAN-016-3
- `security-baseline` job (gitleaks, trufflehog, SARIF upload) -- delivered by PLAN-016-4
- `tsconfig.json`, `package.json`, or test runner configuration changes -- those files exist already
- Branch protection rule configuration -- operator concern, tracked separately
- Release workflows, deploy steps, and Claude review automation -- TDD-017

## Tasks

1. **Create the ci.yml skeleton with triggers and concurrency** -- Create `.github/workflows/ci.yml` containing the `name`, `on:` block (push to main, pull_request with `[opened, synchronize, ready_for_review]`), top-level `concurrency` group keyed by `ci-${{ github.ref }}` with `cancel-in-progress: true`, and `env:` declarations for `NODE_VERSION_MATRIX` and `CLAUDE_CLI_VERSION`.
   - Files to create: `.github/workflows/ci.yml`
   - Acceptance criteria: File exists, parses as valid YAML, passes `actionlint` with no errors. Concurrency cancellation verified by pushing two consecutive commits to a branch and observing the first run is cancelled.
   - Estimated effort: 2h

2. **Implement the paths-filter job** -- Add the `paths-filter` job using `dorny/paths-filter@v3` with the five filter groups (`typescript`, `shell`, `markdown`, `workflows`, `plugins`) and patterns from TDD-016 Section 4. Expose all five outputs at the job level so sibling plans can read them without redefinition.
   - Files to modify: `.github/workflows/ci.yml`
   - Acceptance criteria: A PR that touches only `plugins/autonomous-dev/src/index.ts` produces `typescript=true` and the rest `false`. A PR that touches only a `plugins/**/.claude-plugin/plugin.json` produces `plugins=true` only. Filter outputs are visible in the GitHub Actions UI.
   - Estimated effort: 3h

3. **Implement the typecheck matrix job** -- Add the `typecheck` job with `needs: paths-filter`, the `if:` guard on the `typescript` output, the 2x2 matrix (`os: [ubuntu-latest, macos-latest]`, `node-version: [18, 20]`), `fail-fast: false`, `actions/checkout@v4`, `actions/setup-node@v4` with npm caching against `plugins/autonomous-dev/package-lock.json`, `npm ci` in the plugin working directory, `npx tsc --noEmit --incremental`, and the `actions/cache@v4` step keyed by `runner.os`, `matrix.node-version`, and the hash of `src/**/*.ts` and `tsconfig*.json`.
   - Files to modify: `.github/workflows/ci.yml`
   - Acceptance criteria: All four matrix legs run when the `typescript` filter is true. A type error in any TypeScript file fails the corresponding leg. Cache restore is observed in the second consecutive run for the same source hash. Job is skipped entirely when `typescript == 'false'`.
   - Estimated effort: 4h

4. **Implement the lint job** -- Add a single-runner `lint` job (ubuntu-latest, Node 20 only) gated on the `typescript` filter. Runs `npm ci`, then `npx eslint src/ tests/ --ext .ts --format github` (so violations annotate PR diffs), then `npx prettier --check` over `src/`, `tests/`, `package.json`, and all `tsconfig*.json` files at `--log-level warn`.
   - Files to modify: `.github/workflows/ci.yml`
   - Acceptance criteria: A deliberately introduced ESLint violation fails the job and produces a GitHub annotation. A deliberately mis-formatted file fails the Prettier check. With clean code the job passes in under 4 minutes on a cold cache.
   - Estimated effort: 2h

5. **Implement the test matrix job** -- Add the `test` job with the same matrix shape as `typecheck`, `fail-fast: false`, gated on `typescript == 'true'`. Runs `npm test -- --coverage --coverageReporters=text-lcov --coverageReporters=html` with `NODE_ENV=test`. Adds an `actions/upload-artifact@v4` step (`name: coverage-report`, retention 30 days) that runs only when `matrix.os == 'ubuntu-latest' && matrix.node-version == '20'`.
   - Files to modify: `.github/workflows/ci.yml`
   - Acceptance criteria: All four matrix legs execute the test suite independently. A failing test in any leg fails only that leg. Coverage artifact is uploaded exactly once per workflow run (the ubuntu-20 leg). Artifact contains both lcov and html coverage outputs.
   - Estimated effort: 3h

6. **Vendor ESLint and Prettier configuration files** -- Create `.eslintrc.js`, `.prettierrc`, and `.prettierignore` at `plugins/autonomous-dev/` per TDD-016 Section 5. Confirms `parserOptions.project` points at the existing `tsconfig.json`, `tests/**/*.ts` overrides relax non-null-assertion and object-injection rules, and `.prettierignore` excludes `node_modules/`, `dist/`, `coverage/`, and `*.tsbuildinfo`.
   - Files to create: `plugins/autonomous-dev/.eslintrc.js`, `plugins/autonomous-dev/.prettierrc`, `plugins/autonomous-dev/.prettierignore`
   - Acceptance criteria: `npx eslint src/ tests/` and `npx prettier --check src/ tests/` both run cleanly against the current source tree (or produce a small, reviewable list of pre-existing violations to fix in a follow-up commit). Configurations match TDD-016 Section 5 verbatim except for any documented deviations.
   - Estimated effort: 4h

7. **Cross-platform smoke pass and timing measurement** -- Open a draft PR that touches a TypeScript file, observe all four `typecheck` and `test` matrix legs complete, capture wall-clock duration, and confirm p95 stays under the 8-minute NFR-1001 budget. Validate that the `lint` job completes in under 4 minutes on a warm cache.
   - Files to modify: none (verification task; results recorded in PR description)
   - Acceptance criteria: All four matrix legs pass on a clean source tree. Total `ci.yml` wall time under 8 minutes for a TypeScript-only change with warm caches. Cancel-in-progress confirmed by pushing two commits within 30 seconds.
   - Estimated effort: 2h

## Acceptance Criteria

- `.github/workflows/ci.yml` exists, is valid YAML, and passes `actionlint` with zero errors or warnings
- Workflow triggers on push to `main` and on `pull_request` events of types `opened`, `synchronize`, and `ready_for_review`
- `concurrency` group cancels in-progress runs when a new commit lands on the same ref
- `paths-filter` job emits the five outputs (`typescript`, `shell`, `markdown`, `workflows`, `plugins`) for downstream consumption
- `typecheck` job runs the full 2x2 matrix when TypeScript files change and is skipped otherwise
- `lint` job runs ESLint with GitHub-format annotations and Prettier in check mode against source, tests, and config JSON
- `test` job runs the full 2x2 matrix with coverage; coverage artifact uploaded exactly once per run from the ubuntu-20 leg
- `fail-fast: false` is set on both matrix jobs so independent leg failures are reported separately
- TypeScript build cache (`tsbuildinfo`) is restored on warm runs and rebuilt on source changes
- ESLint and Prettier config files are vendored at `plugins/autonomous-dev/` and align with TDD-016 Section 5
- A clean PR completes the full `ci.yml` workflow in under 8 minutes (NFR-1001)

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| macOS runner queue times exceed 8-minute NFR budget under high GitHub load | Medium | High -- p95 SLO breach on PRs | Aggressive npm + tsbuildinfo caching; consider moving `test` matrix to ubuntu-only with a single nightly macos cron if budget breached repeatedly. Track wall-time in CI metrics dashboard. |
| `dorny/paths-filter@v3` mis-detects changes on force-pushed branches, skipping required jobs | Low | High -- broken code merges undetected | Always `needs: paths-filter` rather than treating outputs as advisory. Add a `required-checks` aggregation job in PLAN-016-2 that runs unconditionally. Pin filter action to a SHA, not a tag. |
| `actions/setup-node@v4` npm cache key drift across matrix legs causes redundant installs | Medium | Low -- runtime overhead only | Use the explicit `cache-dependency-path: 'plugins/autonomous-dev/package-lock.json'` parameter so the cache key is stable across `os` and `node-version` axes. Verify cache hit rate after first week. |
| Cross-platform path differences (Windows-style vs POSIX) break tests on macos-latest legs | Low | Medium -- false negatives or flakes | All shell steps use forward-slash paths and the GitHub-supplied `runner.os` rather than hardcoded paths. The matrix excludes `windows-latest`. |
| ESLint configuration introduced here flags large amounts of pre-existing code | High | Medium -- noisy first PR | Land a `// eslint-disable-next-line` cleanup PR ahead of enabling lint in CI, or scope initial enablement to `--max-warnings 0` only on changed files via a pre-commit hook. |
| Coverage artifact upload fails intermittently on the matrix leg, blocking PR merge | Low | Medium -- false PR failures | Wrap the upload step with `continue-on-error: false` but use `if: always()` so the test result is the gating signal, not the artifact upload. |

## Dependencies

### Parent TDD
- **TDD-016: Baseline CI & Plugin Validation** -- Section 4 (ci.yml Design), Section 5 (ESLint + Prettier Configuration)

### Blocked By
- None. Foundational plan; lands first to establish the `paths-filter` outputs that sibling plans consume.

### Blocks Downstream Plans
- **PLAN-016-2** -- adds `shell`, `markdown`, and `actionlint` jobs that read `paths-filter` outputs from this plan
- **PLAN-016-3** -- adds the `plugin-validate` job, schema vendoring, and Claude CLI bootstrap; consumes the `plugins` filter output
- **PLAN-016-4** -- adds the `security-baseline` job; lives in the same `ci.yml` file delivered here

### Integration Points
- Other plans extend `.github/workflows/ci.yml` by adding new `jobs:` entries; they MUST NOT modify the `paths-filter`, `typecheck`, `lint`, `test`, `concurrency`, or `env` blocks owned by this plan without a coordinated update.
- The `package-lock.json` at `plugins/autonomous-dev/` must exist and be committed before the workflow runs; this is an external precondition.
