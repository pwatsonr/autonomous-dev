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
      // SPEC-030-3-02 added explicit `.js` suffixes on TS imports so the
      // bin/reload-plugins.js loader can resolve them via ESM. Under
      // ts-jest's CJS module resolution those literal `.js` paths do not
      // exist on disk, so we strip the suffix here. See SPEC-030-3-03
      // closeout for the integration test that depends on this mapping.
      moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
      },
    },
    '<rootDir>/../autonomous-dev-portal/jest.config.cjs',
  ],
};
