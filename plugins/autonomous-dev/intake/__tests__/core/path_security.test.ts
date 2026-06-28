/**
 * Path validation + repo-allowlist tests (SPEC-012-1-01 §Task 2).
 *
 * @module __tests__/core/path_security.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildRequestPath,
  setAllowedRepositoriesForTest,
  validateRequestId,
} from '../../core/path_security';
import {
  InvalidRequestIdError,
  SecurityError,
} from '../../core/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-dev-test-'));
  return fs.realpathSync(dir);
}

function rmRepo(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}

// ---------------------------------------------------------------------------
// validateRequestId
// ---------------------------------------------------------------------------

describe('validateRequestId', () => {
  test('accepts canonical REQ-NNNNNN', () => {
    expect(() => validateRequestId('REQ-000001')).not.toThrow();
    expect(() => validateRequestId('REQ-999999')).not.toThrow();
  });

  test('rejects empty string', () => {
    expect(() => validateRequestId('')).toThrow(InvalidRequestIdError);
  });

  test('rejects whitespace', () => {
    expect(() => validateRequestId(' REQ-000001')).toThrow();
    expect(() => validateRequestId('REQ-000001 ')).toThrow();
  });

  test('rejects too few digits', () => {
    expect(() => validateRequestId('REQ-12')).toThrow();
  });

  test('rejects too many digits', () => {
    expect(() => validateRequestId('REQ-1234567')).toThrow();
  });

  test('rejects path-traversal attempt embedded in id', () => {
    expect(() => validateRequestId('REQ-000001/../../etc')).toThrow();
  });

  test('rejects non-numeric chars in suffix', () => {
    expect(() => validateRequestId('REQ-ABC123')).toThrow();
  });

  test('rejects wrong prefix', () => {
    expect(() => validateRequestId('FOO-000001')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildRequestPath — happy + security
// ---------------------------------------------------------------------------

describe('buildRequestPath', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkRepo();
    setAllowedRepositoriesForTest([repo]);
  });

  afterEach(() => {
    setAllowedRepositoriesForTest(null);
    rmRepo(repo);
  });

  test('happy path returns descendant of repo', () => {
    const out = buildRequestPath(repo, 'REQ-000001');
    expect(out).toBe(path.join(repo, '.autonomous-dev', 'requests', 'REQ-000001'));
  });

  test('throws SecurityError when repo not in allowlist', () => {
    setAllowedRepositoriesForTest([]);
    expect(() => buildRequestPath(repo, 'REQ-000001')).toThrow(SecurityError);
  });

  test('throws SecurityError on path-traversal-shaped requestId', () => {
    expect(() => buildRequestPath(repo, 'REQ-000001/../../etc')).toThrow(
      InvalidRequestIdError,
    );
  });

  test('throws SecurityError when request dir is a symlink to outside the repo', () => {
    const outside = mkRepo();
    try {
      const requestsDir = path.join(repo, '.autonomous-dev', 'requests');
      fs.mkdirSync(requestsDir, { recursive: true });
      // Create symlink: repo/.autonomous-dev/requests/REQ-999999 → /tmp/outside
      const link = path.join(requestsDir, 'REQ-999999');
      fs.symlinkSync(outside, link);
      expect(() => buildRequestPath(repo, 'REQ-999999')).toThrow(SecurityError);
    } finally {
      rmRepo(outside);
    }
  });

  test('reuses existing request dir on second call (idempotent)', () => {
    const a = buildRequestPath(repo, 'REQ-000002');
    const b = buildRequestPath(repo, 'REQ-000002');
    expect(a).toBe(b);
    expect(fs.existsSync(path.dirname(a))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Allowlist config fallback ($HOME/.claude/autonomous-dev.json)
// ---------------------------------------------------------------------------

describe('allowlist config fallback', () => {
  let repo: string;
  let homeDir: string;
  let originalHome: string | undefined;
  let originalEnvAllowed: string | undefined;

  beforeEach(() => {
    repo = mkRepo();

    // Build a fake HOME containing .claude/autonomous-dev.json with the repo
    // in repositories.allowlist.
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-dev-home-'));
    const claudeDir = path.join(homeDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'autonomous-dev.json'),
      JSON.stringify({ repositories: { allowlist: [repo] } }),
    );

    originalHome = process.env.HOME;
    originalEnvAllowed = process.env.AUTONOMOUS_DEV_ALLOWED_REPOS;

    // The env override MUST be unset so the loader falls through to the config.
    delete process.env.AUTONOMOUS_DEV_ALLOWED_REPOS;
    process.env.HOME = homeDir;

    // Reset the module allowlist cache so the next call re-loads from config.
    setAllowedRepositoriesForTest(null);
  });

  afterEach(() => {
    // Restore HOME.
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    // Restore / delete the env override.
    if (originalEnvAllowed === undefined) {
      delete process.env.AUTONOMOUS_DEV_ALLOWED_REPOS;
    } else {
      process.env.AUTONOMOUS_DEV_ALLOWED_REPOS = originalEnvAllowed;
    }
    // Reset cache the same way the other tests do.
    setAllowedRepositoriesForTest(null);
    rmRepo(repo);
    rmRepo(homeDir);
  });

  test('loads the allowlist from the daemon config when env is unset', () => {
    // Repo is in the config allowlist → accepted.
    const out = buildRequestPath(repo, 'REQ-000001');
    expect(out).toBe(path.join(repo, '.autonomous-dev', 'requests', 'REQ-000001'));

    // A repo NOT in the config allowlist → rejected.
    const outside = mkRepo();
    try {
      expect(() => buildRequestPath(outside, 'REQ-000001')).toThrow(SecurityError);
    } finally {
      rmRepo(outside);
    }
  });
});
