/**
 * Shared fixtures for deploy unit / conformance tests.
 *
 * @module tests/deploy/fixtures/contexts
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BuildContext } from '../../../intake/deploy/types';

export function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-test-'));
  // Create a tiny `dist/` so directory-based backends have something to
  // hash without invoking a real build command in the conformance suite.
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.html'), '<html><body>hi</body></html>');
  writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
  return dir;
}

export function makeBuildContext(
  repoPath: string,
  overrides: Partial<BuildContext> = {},
): BuildContext {
  return {
    repoPath,
    commitSha: 'a'.repeat(40),
    branch: 'feat/test-branch',
    requestId: 'req-conformance',
    cleanWorktree: true,
    params: {},
    ...overrides,
  };
}
