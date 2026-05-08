/**
 * Jest config for the autonomous-dev plugin.
 *
 * Uses CommonJS (.cjs) because package.json sets `"type": "module"`, which
 * would otherwise cause Node to refuse to load this file as ESM. ts-jest
 * itself runs the compiled TS as CJS via the tsconfig's `module: commonjs`.
 *
 * Tests are intentionally co-located next to source under `intake/` and
 * also live under `tests/`. The `testMatch` glob picks up both.
 *
 * SPEC-030-1-01 introduces a second project for the portal's auth tests.
 * The portal's tsconfig differs (ESM, bundler resolution); using `projects`
 * lets each project supply its own `transform` and `testEnvironment`.
 */
module.exports = {
  projects: [
    {
      displayName: 'autonomous-dev',
      rootDir: __dirname,
      preset: 'ts-jest',
      testEnvironment: 'node',
      roots: [
        '<rootDir>',
        '<rootDir>/../autonomous-dev-deploy-gcp',
        '<rootDir>/../autonomous-dev-deploy-aws',
        '<rootDir>/../autonomous-dev-deploy-azure',
        '<rootDir>/../autonomous-dev-deploy-k8s',
      ],
      testMatch: ['**/?(*.)+(spec|test).ts'],
      testPathIgnorePatterns: ['/node_modules/'],
      transform: {
        '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
      },
    },
    '<rootDir>/../autonomous-dev-portal/jest.config.cjs',
  ],
};
