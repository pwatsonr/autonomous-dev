/**
 * Jest config for the autonomous-dev plugin.
 *
 * Uses CommonJS (.cjs) because package.json sets `"type": "module"`, which
 * would otherwise cause Node to refuse to load this file as ESM. ts-jest
 * itself runs the compiled TS as CJS via the tsconfig's `module: commonjs`.
 *
 * Tests are intentionally co-located next to source under `intake/` and
 * also live under `tests/`. The `testMatch` glob picks up both.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/?(*.)+(spec|test).ts'],
  // Ignore node_modules + the not-yet-runnable parallel suite (no source yet).
  testPathIgnorePatterns: ['/node_modules/'],
  // ts-jest reads tsconfig.json from this directory.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
};
