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
  // Adoption baseline (#570): this config produced ~5,200 problems the first
  // time it actually ran (the gate had silently config-errored since the
  // eslint v9 bump, so nothing was ever enforced). Rather than block on a
  // multi-thousand-violation cleanup, we enforce the high-value, low-volume
  // rules as errors and surface the large aspirational backlogs (full
  // type-safety, import ordering) as WARNINGS — visible, non-blocking, and
  // ratchetable to `error` as they are paid down. The CI step does not pass
  // `--max-warnings 0`, so warnings do not fail the gate.
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    // NOTE: `recommended-requiring-type-checking` is intentionally omitted.
    // The codebase has pervasive `any` at MCP/adapter/CLI boundaries, so the
    // type-aware strict rules (no-unsafe-*, require-await, unbound-method, …)
    // accounted for ~2,700 errors. Adopting full type-safety is a separate
    // epic; the most valuable members of that layer (no-floating-promises,
    // no-misused-promises) are re-enabled below as warnings.
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
    // Real dead-code signal, but ~300 pre-existing hits — warn (ratchet later).
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    // ~30 dynamic require()s (plugin loaders etc.) — warn, not a hard error.
    '@typescript-eslint/no-var-requires': 'warn',
    // High-value async-safety rules from the dropped type-checking layer,
    // kept visible as warnings (type info is still configured via `project`).
    '@typescript-eslint/no-floating-promises': 'warn',
    '@typescript-eslint/no-misused-promises': 'warn',
    // ~1,000 unordered-import hits across the tree; auto-fixable, but the churn
    // would conflict with in-flight PRs. Warn now; clear via a dedicated
    // `eslint --fix` pass once the queue drains, then ratchet to error.
    'import/order': [
      'warn',
      {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        'newlines-between': 'always',
        alphabetize: { order: 'asc', caseInsensitive: true },
      },
    ],
    'security/detect-object-injection': 'warn',
    'security/detect-non-literal-fs-filename': 'warn',
    // Remaining low-volume residue from first-ever enforcement — warn (visible)
    // rather than block. Each is either intentional (a `while(true)` retry
    // loop, a control-char regex in a path-traversal test, quarantined `.skip`
    // tests) or cosmetic (a redundant regex escape, let-that-could-be-const).
    // Auto-fix is intentionally NOT used: `eslint --fix` corrupted an import on
    // this never-linted tree, so fixes are manual + ratcheted.
    'prefer-const': 'warn',
    'no-useless-escape': 'warn',
    'no-constant-condition': ['warn', { checkLoops: false }],
    'no-control-regex': 'warn',
    'import/export': 'warn',
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
