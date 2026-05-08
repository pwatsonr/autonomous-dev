/** @type {import('jest').Config} */
module.exports = {
  displayName: 'autonomous-dev-portal:auth',
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/server/auth/__tests__/**/*.test.ts',
    '<rootDir>/server/integration/__tests__/**/*.test.ts',
  ],
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
  collectCoverageFrom: [
    // SPEC-030-1-05: scoped to the 9 auth files PLAN-030-1 targeted with
    // dedicated test suites. Files outside this list (tailscale-client.ts
    // beyond its mocked surface, oauth/providers/*, base-auth.ts) have
    // their own coverage deltas tracked in TDD-031 follow-up; they are
    // intentionally excluded so the gate measures what the plan shipped.
    'server/auth/cidr-utils.ts',
    'server/auth/localhost-auth.ts',
    'server/auth/network-binding.ts',
    'server/auth/tailscale-auth.ts',
    'server/auth/oauth/oauth-auth.ts',
    'server/auth/oauth/oauth-state.ts',
    'server/auth/oauth/pkce-utils.ts',
    'server/auth/oauth/token-exchange.ts',
    'server/auth/session/file-session-store.ts',
    'server/auth/session/session-cookie.ts',
    'server/auth/session/session-manager.ts',
    'server/security/csrf-protection.ts',
    '!server/auth/**/*.d.ts',
    '!server/auth/**/__tests__/**',
    '!server/auth/**/__mocks__/**',
  ],
  // SPEC-030-1-05: enforce >=90% line coverage on the auth surface
  // shipped by PLAN-030-1. Glob keys match against the project rootDir
  // (this file's location). The gate is intentionally lines-only —
  // branches are not part of the PRD-016 R-04 / TDD-030 §11.1 contract;
  // defensive `/* istanbul ignore next */` branches would skew an
  // enforced number. Threshold applies cumulatively across the matched
  // files.
  coverageThreshold: {
    './server/auth/': {
      lines: 90,
    },
  },
};
