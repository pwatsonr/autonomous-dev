# SPEC-016-1-04: ESLint + Prettier Configuration Files and CI Smoke Test

## Metadata
- **Parent Plan**: PLAN-016-1
- **Tasks Covered**: Task 6 (vendor ESLint + Prettier configs), Task 7 (cross-platform smoke pass and timing measurement)
- **Estimated effort**: 6 hours

## Description

Vendor the ESLint and Prettier configuration files at `plugins/autonomous-dev/` so the `lint` job from SPEC-016-1-03 has the rules it needs to evaluate. Configurations match TDD-016 Section 5 verbatim: `.eslintrc.js` enables `@typescript-eslint`, `security`, and `import` plugins with strict-typed defaults plus test-scoped overrides; `.prettierrc` pins the project's whitespace and quote conventions; `.prettierignore` excludes generated and vendor directories.

After the configs land, perform a CI smoke verification: open a draft PR that touches a TypeScript file, observe all four `typecheck` and `test` matrix legs complete, the `lint` job pass, and capture wall-clock measurements to confirm the workflow stays within NFR-1001 (8 minutes p95) and NFR-1002 (lint < 4 minutes warm).

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Create | `plugins/autonomous-dev/.eslintrc.js` | ESLint flat-rules configuration with TypeScript, security, and import plugins |
| Create | `plugins/autonomous-dev/.prettierrc` | Prettier formatting rules |
| Create | `plugins/autonomous-dev/.prettierignore` | Prettier exclusion patterns |
| Modify | None for the smoke test (verification task; results recorded in PR description) | -- |

## Implementation Details

### File: `plugins/autonomous-dev/.eslintrc.js`

```js
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
    ecmaVersion: 2022,
  },
  plugins: ['@typescript-eslint', 'security', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
    'plugin:security/recommended-legacy',
    'plugin:import/recommended',
    'plugin:import/typescript',
  ],
  env: {
    node: true,
    es2022: true,
  },
  rules: {
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'no-debugger': 'error',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'import/order': ['error', {
      groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
      'newlines-between': 'always',
      alphabetize: { order: 'asc', caseInsensitive: true },
    }],
    'security/detect-object-injection': 'warn',
    'security/detect-non-literal-fs-filename': 'warn',
  },
  overrides: [
    {
      files: ['tests/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        'security/detect-object-injection': 'off',
        'security/detect-non-literal-fs-filename': 'off',
      },
    },
  ],
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'coverage/',
    '*.tsbuildinfo',
    '*.js',
  ],
};
```

### File: `plugins/autonomous-dev/.prettierrc`

```json
{
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "semi": true,
  "singleQuote": true,
  "quoteProps": "as-needed",
  "trailingComma": "all",
  "bracketSpacing": true,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

### File: `plugins/autonomous-dev/.prettierignore`

```
node_modules/
dist/
coverage/
*.tsbuildinfo
package-lock.json
```

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| `root: true` | Stops ESLint walking up to a parent `.eslintrc`. The plugin is its own root for linting. |
| `parserOptions.project: './tsconfig.json'` | Enables `recommended-requiring-type-checking` rules (which need type info). Path is relative to `tsconfigRootDir`. |
| `tsconfigRootDir: __dirname` | Hardens the project path against being run from a different CWD. |
| `recommended-requiring-type-checking` | Catches common TypeScript mistakes (unbound methods, misused promises). The trade-off is a slower lint run, but it stays under NFR-1002 budget. |
| `security/recommended-legacy` | The `security` plugin's flat-config name. Catches `eval`, child_process injection, etc. |
| `import/recommended` + `import/typescript` | Enforces import resolution and TS-aware import ordering. |
| Test overrides relax `no-non-null-assertion`, `no-explicit-any`, and security rules | Test code routinely uses `!` and `any` for fixture clarity. Security plugin warnings on test fixtures are noise. |
| `'no-console': ['warn', { allow: ['warn', 'error'] }]` | Keeps `console.warn` / `console.error` for ops paths but flags `console.log` as drift. |
| `import/order` grouping | Stable, alphabetized imports avoid merge conflicts. The 6-group ordering matches the project convention. |
| `ignorePatterns` includes `*.js` | Plugin source is TypeScript-only. Generated `.js` (e.g., this config file) should not lint itself. |
| Prettier `printWidth: 100` | Matches TypeScript ecosystem default. Wider than 80 to reduce wrapping noise without going to 120. |
| Prettier `singleQuote: true`, `trailingComma: 'all'` | Project convention; matches existing source. |
| Prettier `endOfLine: 'lf'` | Avoids CRLF drift on Windows checkouts (defense in depth even though Windows is excluded from CI). |
| `.prettierignore` excludes `package-lock.json` | npm-managed; reformatting it would create churn on every install. |

### Smoke Test Procedure

1. **Pre-flight (local)** -- From `plugins/autonomous-dev/`, run:
   - `npx eslint src/ tests/ --ext .ts --format stylish` and capture the violation list.
   - `npx prettier --check 'src/**/*.ts' 'tests/**/*.ts' 'package.json' 'tsconfig*.json'`.
   - If pre-existing violations exist, document them in a follow-up issue but do NOT auto-fix in this spec; that remains a separate cleanup PR.
2. **PR creation** -- Open a draft PR titled `smoke: PLAN-016-1 CI verification` that touches a single TypeScript file (e.g., add a no-op comment to `plugins/autonomous-dev/src/index.ts`).
3. **Cold-cache run** -- Wait for the workflow to complete. Capture in the PR description:
   - Total `ci.yml` wall time
   - Per-job duration: `paths-filter`, `typecheck` (4 legs), `lint`, `test` (4 legs)
   - Cache miss/hit indicators in `actions/setup-node@v4` and `actions/cache@v4` logs
4. **Warm-cache run** -- Push a second commit (another no-op edit) and capture the same metrics.
5. **Cancel-in-progress verification** -- Push two commits within 30 seconds of each other; confirm the first run reports as `cancelled` in the GitHub Actions UI.
6. **Filter skip verification** -- Open a separate draft PR touching only `README.md` and confirm `typecheck`, `lint`, and `test` are all reported as `skipped`.
7. **Coverage artifact verification** -- Download the `coverage-report` artifact from the warm-cache run and confirm it contains `lcov.info` and a populated `lcov-report/` directory.
8. **Annotation verification** -- In a scratch branch, intentionally introduce a `no-var` violation. Confirm the resulting workflow run shows a red annotation on the offending line in the PR diff.

### Validation Notes

- The `.eslintrc.js` file uses CommonJS (`module.exports = ...`). It MUST NOT be in the `ignorePatterns` list itself; ESLint loads the config before applying ignore patterns. (`*.js` is broad, but ESLint specifically excludes its own config files from the lint pass automatically.)
- Verify the `parserOptions.project` path resolves by running `npx eslint --debug src/index.ts` and checking the output for `Parsing tsconfig` lines.
- Prettier and ESLint must NOT conflict. The project does NOT use `eslint-plugin-prettier` (deliberate -- Prettier runs as a separate step). Conflicts are caught manually if any rule flags formatting (e.g., `quotes`, `semi`). The provided `.eslintrc.js` does not enable formatting rules; it relies on Prettier for that.
- `.prettierignore` patterns are relative to the file's directory. They follow `.gitignore` syntax.

### Edge Cases

- **`@typescript-eslint/recommended-requiring-type-checking` is slow**: First lint run on a cold cache may take 60+ seconds. Subsequent runs benefit from tsc's program cache. Acceptable per NFR-1002 budget.
- **`plugin:security/recommended-legacy` may be unavailable in older `eslint-plugin-security` versions**: Pin to v3.x via `package.json` (precondition; do not modify `package.json` here).
- **Pre-existing source has many violations**: Land this spec WITHOUT auto-fixing. Open a follow-up cleanup PR scoped to violations. The lint job will fail until cleanup lands; expected and acceptable.
- **Prettier formats files differently on Windows**: `endOfLine: 'lf'` and `.gitattributes` (out of scope) protect against this. Windows runners are excluded from the CI matrix.
- **Smoke test PR conflicts with concurrent work**: Use a draft PR that does not target an active feature branch. Close after metrics capture; do not merge to `main`.

## Acceptance Criteria

### Configuration Files

1. [ ] `plugins/autonomous-dev/.eslintrc.js` exists.
2. [ ] `.eslintrc.js` declares `root: true`.
3. [ ] `.eslintrc.js` parser is `@typescript-eslint/parser`.
4. [ ] `.eslintrc.js` `parserOptions.project` is `./tsconfig.json` and `tsconfigRootDir` is `__dirname`.
5. [ ] `.eslintrc.js` extends `eslint:recommended`, `plugin:@typescript-eslint/recommended`, `plugin:@typescript-eslint/recommended-requiring-type-checking`, `plugin:security/recommended-legacy`, `plugin:import/recommended`, `plugin:import/typescript`.
6. [ ] `.eslintrc.js` has a `tests/**/*.ts` override that disables `no-non-null-assertion`, `no-explicit-any`, `security/detect-object-injection`, and `security/detect-non-literal-fs-filename`.
7. [ ] `.eslintrc.js` has `import/order` configured with the six-group ordering and alphabetization.
8. [ ] `plugins/autonomous-dev/.prettierrc` exists and is valid JSON.
9. [ ] `.prettierrc` sets `printWidth: 100`, `tabWidth: 2`, `singleQuote: true`, `trailingComma: 'all'`, `endOfLine: 'lf'`.
10. [ ] `plugins/autonomous-dev/.prettierignore` exists.
11. [ ] `.prettierignore` includes `node_modules/`, `dist/`, `coverage/`, `*.tsbuildinfo`, and `package-lock.json`.
12. [ ] Running `npx eslint src/ tests/` from `plugins/autonomous-dev/` either exits 0 or produces a documented list of pre-existing violations recorded in a follow-up issue.
13. [ ] Running `npx prettier --check src/ tests/` from `plugins/autonomous-dev/` either exits 0 or produces a documented list of pre-existing violations recorded in a follow-up issue.

### Smoke Test

14. [ ] A draft PR titled `smoke: PLAN-016-1 CI verification` touching a single TS file shows all four `typecheck` legs and all four `test` legs running to completion.
15. [ ] Total workflow wall time on a warm cache is under 8 minutes (NFR-1001).
16. [ ] `lint` job wall time on a warm cache is under 4 minutes (NFR-1002).
17. [ ] Pushing a second commit to the same draft PR within 30 seconds cancels the first workflow run.
18. [ ] A separate draft PR touching only `README.md` shows `typecheck`, `lint`, and `test` jobs reported as `skipped`.
19. [ ] The `coverage-report` artifact downloads successfully and contains `lcov.info` plus a populated `lcov-report/` HTML directory.
20. [ ] An intentional `no-var` violation in a scratch PR produces a red annotation on the offending line in the PR diff view.
21. [ ] Smoke test results (durations, cache hits, cancel verification, skip verification) are recorded in the smoke PR description for archival.

## Test Cases

1. **test_eslintrc_exists** -- Assert `plugins/autonomous-dev/.eslintrc.js` exists.
2. **test_eslintrc_loadable** -- `node -e "require('./plugins/autonomous-dev/.eslintrc.js')"` exits 0.
3. **test_eslintrc_root_true** -- The loaded module's `root` property is `true`.
4. **test_eslintrc_parser** -- The loaded module's `parser` is `@typescript-eslint/parser`.
5. **test_eslintrc_extends_includes_typecheck** -- The `extends` array contains `plugin:@typescript-eslint/recommended-requiring-type-checking`.
6. **test_eslintrc_test_override_present** -- The `overrides[0].files` array contains `tests/**/*.ts`.
7. **test_eslintrc_import_order_configured** -- `rules['import/order']` is non-null and includes the six-group order.
8. **test_prettierrc_exists** -- Assert `plugins/autonomous-dev/.prettierrc` exists.
9. **test_prettierrc_valid_json** -- `jq '.' .prettierrc` exits 0.
10. **test_prettierrc_printwidth_100** -- `jq '.printWidth' .prettierrc` returns `100`.
11. **test_prettierrc_eol_lf** -- `jq '.endOfLine' .prettierrc` returns `lf`.
12. **test_prettierignore_exists** -- Assert `plugins/autonomous-dev/.prettierignore` exists.
13. **test_prettierignore_excludes_node_modules** -- The file contains a line equal to `node_modules/`.
14. **test_prettierignore_excludes_lockfile** -- The file contains `package-lock.json`.
15. **test_eslint_runs_against_source** -- From `plugins/autonomous-dev/`, `npx eslint src/ tests/ --ext .ts --no-error-on-unmatched-pattern` runs without an unhandled exception (exit 0 or non-zero with a violation list, never with a parser config error).
16. **test_prettier_runs_against_source** -- From `plugins/autonomous-dev/`, `npx prettier --check 'src/**/*.ts' 'tests/**/*.ts'` runs without an unhandled exception.
17. **test_smoke_warm_under_8min** (CI-observable) -- The smoke PR's warm-cache workflow run shows total wall time < 8 minutes.
18. **test_smoke_lint_under_4min** (CI-observable) -- The smoke PR's warm-cache `lint` job shows duration < 4 minutes.
19. **test_smoke_cancel_in_progress** (CI-observable) -- Two commits 5 seconds apart cause the first run to report status `cancelled`.
20. **test_smoke_filter_skip** (CI-observable) -- A README-only PR shows `typecheck`, `lint`, `test` as `skipped`.

## Dependencies

- **Blocked by**: SPEC-016-1-01, SPEC-016-1-02, SPEC-016-1-03 (all three must be merged before the smoke test exercises the full workflow).
- **Blocks**: PLAN-016-2 (shell/markdown/actionlint jobs) -- those jobs build on a fully validated `ci.yml` baseline.
- **External**: `plugins/autonomous-dev/package.json` MUST list `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `eslint-plugin-security` (v3+), `eslint-plugin-import`, `eslint-import-resolver-typescript`, and `prettier` under `devDependencies`. `plugins/autonomous-dev/tsconfig.json` MUST exist.

## Notes

- This spec deliberately separates configuration vendoring from cleanup of pre-existing violations. The lint job WILL fail on the first push if the existing source has violations under the new ruleset. That is acceptable; address it via a scoped follow-up PR.
- The smoke test PR is a draft and MUST be closed (not merged) after metrics capture. The PR description is the artifact, not the merge.
- Wall-time measurements should be repeated three times and the p95 reported. A single warm-cache run is not statistically meaningful for SLO verification, but it is sufficient for this spec's acceptance.
- `eslint-plugin-security` v3.x removes the `recommended` config in favor of `recommended-legacy`. If the project pins to v2.x, change the `extends` line accordingly. Pinning is a `package.json` concern (out of scope here).
- The `.eslintrc.js` format is the legacy "eslintrc" config style. ESLint v9+ moves to flat config (`eslint.config.js`). The project currently uses ESLint v8.x; migration is tracked separately.
- This spec MUST NOT modify `tsconfig.json`, `package.json`, or `jest.config.js`. Those are preconditions.
- This spec MUST NOT modify `ci.yml`. The configs delivered here are consumed by SPEC-016-1-03's lint job; no workflow edits are required.
