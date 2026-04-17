import { computeDiff, VersionDiff } from '../../../../src/pipeline/versioning/diff-engine';

/**
 * Snapshot tests for diff-engine output (SPEC-003-3-02).
 *
 * These tests verify the shape and content of diff outputs against
 * stored snapshots. On first run, Jest creates the snapshot file.
 * Subsequent runs compare against the stored snapshot.
 */

// ---------------------------------------------------------------------------
// Helper: strip the computedAt field for deterministic snapshots
// ---------------------------------------------------------------------------
function stripTimestamp(diff: VersionDiff): Omit<VersionDiff, 'computedAt'> {
  const { computedAt, ...rest } = diff;
  return rest;
}

describe('diff snapshots', () => {
  test('diff output for PRD v1.0 to v1.1 matches snapshot', () => {
    const prdV1 = [
      '---',
      'title: User Authentication PRD',
      'type: PRD',
      'version: 1.0',
      'status: draft',
      '---',
      '',
      '# User Authentication PRD',
      '',
      '## Problem Statement',
      'Users need a secure way to authenticate with the system.',
      'Currently there is no authentication mechanism in place.',
      '',
      '## Functional Requirements',
      '- Support email/password login',
      '- Support OAuth providers',
      '- Session management with JWT tokens',
      '',
      '## Non-Functional Requirements',
      '- Response time under 200ms for login',
      '- Support 10,000 concurrent sessions',
      '',
      '## Success Metrics',
      '- 99.9% uptime for auth service',
      '- Less than 1% failed login rate',
    ].join('\n');

    const prdV1_1 = [
      '---',
      'title: User Authentication PRD',
      'type: PRD',
      'version: 1.1',
      'status: review',
      '---',
      '',
      '# User Authentication PRD',
      '',
      '## Problem Statement',
      'Users need a secure way to authenticate with the system.',
      'Currently there is no authentication mechanism in place.',
      '',
      '## Functional Requirements',
      '- Support email/password login',
      '- Support OAuth providers (Google, GitHub, Microsoft)',
      '- Session management with JWT tokens',
      '- Multi-factor authentication via TOTP',
      '',
      '## Non-Functional Requirements',
      '- Response time under 200ms for login',
      '- Support 10,000 concurrent sessions',
      '',
      '## Success Metrics',
      '- 99.9% uptime for auth service',
      '- Less than 1% failed login rate',
      '',
      '## Security Considerations',
      '- Rate limiting on login endpoints',
      '- Account lockout after 5 failed attempts',
    ].join('\n');

    const diff = computeDiff(prdV1, prdV1_1, '1.0', '1.1');
    expect(stripTimestamp(diff)).toMatchSnapshot();
  });

  test('diff output for TDD with added section matches snapshot', () => {
    const tddV1 = [
      '---',
      'title: Auth Service TDD',
      'type: TDD',
      'version: 1.0',
      'status: draft',
      '---',
      '',
      '# Auth Service TDD',
      '',
      '## Architecture Overview',
      'The auth service uses a microservice architecture with',
      'a dedicated database for credential storage.',
      '',
      '## API Design',
      'RESTful API with the following endpoints:',
      '- POST /auth/login',
      '- POST /auth/register',
      '- POST /auth/logout',
      '',
      '### Endpoint Details',
      'Each endpoint accepts JSON payloads and returns',
      'standard response objects with appropriate HTTP status codes.',
    ].join('\n');

    const tddV2 = [
      '---',
      'title: Auth Service TDD',
      'type: TDD',
      'version: 1.1',
      'status: draft',
      '---',
      '',
      '# Auth Service TDD',
      '',
      '## Architecture Overview',
      'The auth service uses a microservice architecture with',
      'a dedicated database for credential storage.',
      '',
      '## API Design',
      'RESTful API with the following endpoints:',
      '- POST /auth/login',
      '- POST /auth/register',
      '- POST /auth/logout',
      '- POST /auth/refresh',
      '',
      '### Endpoint Details',
      'Each endpoint accepts JSON payloads and returns',
      'standard response objects with appropriate HTTP status codes.',
      '',
      '### Error Codes',
      'Standardized error codes for all auth endpoints:',
      '- AUTH_001: Invalid credentials',
      '- AUTH_002: Account locked',
      '- AUTH_003: Token expired',
      '',
      '## Data Model',
      'The following tables are required:',
      '- users: Core user records',
      '- sessions: Active session tracking',
      '- audit_log: Login attempt history',
    ].join('\n');

    const diff = computeDiff(tddV1, tddV2, '1.0', '1.1');
    expect(stripTimestamp(diff)).toMatchSnapshot();
  });
});
