import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests', '<rootDir>/intake'],
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/*.test.ts',
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: false,
      tsconfig: 'tsconfig.json',
    }],
  },
  // Don't run bash tests through Jest
  testPathIgnorePatterns: [
    '/node_modules/',
    '\\.sh$',
    '/docs/',
  ],
  // Generous timeout for integration tests
  testTimeout: 30000,
  // Run test files in parallel
  maxWorkers: '50%',
  // Collect coverage but don't enforce thresholds yet
  collectCoverageFrom: [
    'src/**/*.ts',
    'intake/**/*.ts',
    '!**/*.test.ts',
    '!**/node_modules/**',
  ],
};

export default config;
