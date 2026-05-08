/** @type {import('jest').Config} */
module.exports = {
  displayName: 'autonomous-dev-portal:auth',
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/server/auth/__tests__/**/*.test.ts'],
  // ts-jest is resolved from the parent autonomous-dev plugin so the portal
  // does not need its own copy (TDD-030 §5.4 Option A: jest gate is the
  // autonomous-dev plugin's, not the portal's).
  transform: {
    '^.+\\.ts$': [
      require.resolve('ts-jest', {
        paths: [require('path').resolve(__dirname, '../autonomous-dev')],
      }),
      { tsconfig: '<rootDir>/tsconfig.json', useESM: false, isolatedModules: true, diagnostics: false },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['server/auth/**/*.ts', '!server/auth/**/*.d.ts'],
  // coverageThreshold added in phase B (SPEC-030-1-05).
};
