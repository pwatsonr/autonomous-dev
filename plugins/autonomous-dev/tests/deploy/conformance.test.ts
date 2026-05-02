/**
 * SPEC-023-1-04 conformance suite.
 *
 * Runs the same battery against every registered backend so any future
 * backend registered via the bootstrap automatically inherits coverage.
 * Per-backend `runTool` mocks are scoped via injected backend instances
 * (the registry is populated with mock-injected backends in `beforeAll`).
 *
 * Battery (per TDD-023 §15):
 *   1. Metadata shape (kebab-case name, semver version, etc.).
 *   2. build() returns a valid BuildArtifact (ULID id, 64-hex checksum, etc.).
 *   3. deploy() returns a signed DeploymentRecord that passes verifyDeploymentRecord.
 *   4. healthCheck() returns a valid HealthStatus.
 *   5. rollback() returns a valid RollbackResult.
 *   6. Tampering with the record invalidates the hmac.
 *
 * @module tests/deploy/conformance.test
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalBackend } from '../../intake/deploy/backends/local';
import { StaticBackend } from '../../intake/deploy/backends/static';
import { DockerLocalBackend } from '../../intake/deploy/backends/docker-local';
import { GithubPagesBackend } from '../../intake/deploy/backends/github-pages';
import { BackendRegistry, type RegisteredBackend } from '../../intake/deploy/registry';
import { verifyDeploymentRecord } from '../../intake/deploy/record-signer';
import { ULID_REGEX } from '../../intake/deploy/id';
import type {
  BuildArtifact,
  BuildContext,
  DeployParameters,
  DeploymentRecord,
  HealthStatus,
  RollbackResult,
} from '../../intake/deploy/types';

import { makeRunToolMock } from './__mocks__/run-tool';
import { localValidParams } from './fixtures/local.params';
import { staticValidParams } from './fixtures/static.params';
import { dockerLocalValidParams } from './fixtures/docker-local.params';
import { githubPagesValidParams } from './fixtures/github-pages.params';

const TEST_KEY = Buffer.alloc(32, 0x42);

interface BackendCase {
  name: string;
  buildContext: BuildContext;
  params: DeployParameters;
  setupMock: (mock: ReturnType<typeof makeRunToolMock>) => void;
  expectsTamperFailure: boolean;
}

// Set up the temp repo + target eagerly at module-load time so the
// `describe.each(makeCases())` loop sees real paths. Jest invokes
// `describe.each` synchronously during the collection phase, BEFORE any
// `beforeAll` runs, so we can't defer setup to a hook.
process.env.DEPLOY_HMAC_KEY = TEST_KEY.toString('hex');
const tmpRepo: string = mkdtempSync(join(tmpdir(), 'deploy-conformance-'));
mkdirSync(join(tmpRepo, 'dist'), { recursive: true });
writeFileSync(join(tmpRepo, 'dist', 'index.html'), '<html>ok</html>');
writeFileSync(join(tmpRepo, 'Dockerfile'), 'FROM scratch\n');
const staticTarget: string = mkdtempSync(join(tmpdir(), 'deploy-conformance-target-'));

afterAll(() => {
  delete process.env.DEPLOY_HMAC_KEY;
  if (tmpRepo) rmSync(tmpRepo, { recursive: true, force: true });
  if (staticTarget) rmSync(staticTarget, { recursive: true, force: true });
});

beforeEach(() => BackendRegistry.clear());
afterEach(() => BackendRegistry.clear());

// ---------------------------------------------------------------------------
// Per-backend cases
// ---------------------------------------------------------------------------

function makeCases(): BackendCase[] {
  return [
    {
      name: 'local',
      buildContext: makeCtx(tmpRepo, { params: localValidParams }),
      params: localValidParams,
      setupMock: (m) => {
        m.expect(/^git$/, (a) => a[0] === 'status', { stdout: '' });
        m.expect(/^git$/, (a) => a[0] === 'push', { stdout: '' });
        m.expect(
          /^gh$/,
          (a) => a[0] === 'pr' && a[1] === 'create',
          {
            stdout: 'https://github.com/example/repo/pull/42\n',
          },
        );
        m.expect(
          /^gh$/,
          (a) => a[0] === 'pr' && a[1] === 'view',
          { stdout: '{"state":"OPEN"}' },
        );
        m.expect(
          /^gh$/,
          (a) => a[0] === 'pr' && a[1] === 'close',
          { stdout: 'closed' },
        );
      },
      expectsTamperFailure: true,
    },
    {
      name: 'static',
      buildContext: makeCtx(tmpRepo, {
        params: staticValidParams(staticTarget),
      }),
      params: staticValidParams(staticTarget),
      setupMock: (m) => {
        m.expect(/^echo$/, () => true, { stdout: '' });
        m.expect(/^rsync$/, () => true, { stdout: '' });
      },
      expectsTamperFailure: true,
    },
    {
      name: 'docker-local',
      buildContext: makeCtx(tmpRepo, { params: dockerLocalValidParams }),
      params: dockerLocalValidParams,
      setupMock: (m) => {
        m.expect(/^docker$/, (a) => a[0] === 'build', { stdout: '' });
        m.expect(
          /^docker$/,
          (a) => a[0] === 'image' && a[1] === 'inspect',
          { stdout: 'sha256:deadbeef\n' },
        );
        m.expect(
          /^docker$/,
          (a) => a[0] === 'run',
          { stdout: 'container-abc\n' },
        );
        m.expect(/^docker$/, (a) => a[0] === 'stop', { stdout: '' });
        m.expect(/^docker$/, (a) => a[0] === 'rm', { stdout: '' });
        m.expect(/^docker$/, (a) => a[0] === 'inspect', { stdout: 'running\n' });
      },
      expectsTamperFailure: true,
    },
    {
      name: 'github-pages',
      buildContext: makeCtx(tmpRepo, { params: githubPagesValidParams }),
      params: githubPagesValidParams,
      setupMock: (m) => {
        m.expect(/^echo$/, () => true, { stdout: '' });
        m.expect(
          /^git$/,
          (a) => a[0] === 'ls-remote',
          { stdout: 'a'.repeat(40) + '\trefs/heads/gh-pages\n' },
        );
        m.expect(
          /^git$/,
          (a) => a[0] === 'subtree' && a[1] === 'push',
          { stdout: '' },
        );
      },
      expectsTamperFailure: true,
    },
  ];
}

function makeCtx(repoPath: string, overrides: Partial<BuildContext>): BuildContext {
  return {
    repoPath,
    commitSha: 'a'.repeat(40),
    branch: 'feat/conformance',
    requestId: 'req-conf',
    cleanWorktree: true,
    params: {},
    ...overrides,
  };
}

function fakeFetch(): typeof fetch {
  return (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
}

function instantiate(name: string, mock: ReturnType<typeof makeRunToolMock>) {
  switch (name) {
    case 'local':
      return new LocalBackend({ runTool: mock.runTool });
    case 'static':
      return new StaticBackend({ runTool: mock.runTool, fetchFn: fakeFetch() });
    case 'docker-local':
      return new DockerLocalBackend({
        runTool: mock.runTool,
        fetchFn: fakeFetch(),
        sleepFn: () => Promise.resolve(),
      });
    case 'github-pages':
      return new GithubPagesBackend({ runTool: mock.runTool, fetchFn: fakeFetch() });
    default:
      throw new Error(`unknown backend ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Conformance battery
// ---------------------------------------------------------------------------

describe.each(makeCases().map((c) => [c.name, c] as const))(
  'SPEC-023-1-04 conformance: %s',
  (_name, testCase) => {
    let backend: ReturnType<typeof instantiate>;
    let mock: ReturnType<typeof makeRunToolMock>;
    let entry: RegisteredBackend;

    beforeEach(() => {
      mock = makeRunToolMock();
      testCase.setupMock(mock);
      backend = instantiate(testCase.name, mock);
      BackendRegistry.registerSync(backend);
      entry = BackendRegistry.getEntry(testCase.name);
    });

    it('metadata shape: kebab-case name, semver version, non-empty targets, string[] tools', () => {
      const m = entry.backend.metadata;
      expect(m.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(m.supportedTargets.length).toBeGreaterThan(0);
      expect(Array.isArray(m.requiredTools)).toBe(true);
      m.requiredTools.forEach((t) => expect(typeof t).toBe('string'));
    });

    it('build returns a valid BuildArtifact', async () => {
      const a: BuildArtifact = await backend.build(testCase.buildContext);
      expect(a.artifactId).toMatch(ULID_REGEX);
      expect(['commit', 'directory', 'docker-image', 'archive']).toContain(a.type);
      expect(a.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isInteger(a.sizeBytes)).toBe(true);
      expect(a.sizeBytes).toBeGreaterThanOrEqual(0);
    });

    it('deploy returns a signed DeploymentRecord that verifies', async () => {
      const a = await backend.build(testCase.buildContext);
      const r: DeploymentRecord = await backend.deploy(a, 'test-env', testCase.params);
      expect(r.hmac).toMatch(/^[0-9a-f]{64}$/);
      expect(verifyDeploymentRecord(r).valid).toBe(true);
    });

    it('healthCheck returns a valid HealthStatus', async () => {
      const a = await backend.build(testCase.buildContext);
      const r = await backend.deploy(a, 'test-env', testCase.params);
      const h: HealthStatus = await backend.healthCheck(r);
      expect(typeof h.healthy).toBe('boolean');
      expect(Array.isArray(h.checks)).toBe(true);
      expect(h.checks.length).toBeGreaterThanOrEqual(1);
    });

    it('rollback returns a valid RollbackResult', async () => {
      const a = await backend.build(testCase.buildContext);
      const r = await backend.deploy(a, 'test-env', testCase.params);
      const rb: RollbackResult = await backend.rollback(r);
      expect(typeof rb.success).toBe('boolean');
      expect(Array.isArray(rb.errors)).toBe(true);
    });

    it('tampering with the record invalidates the hmac', async () => {
      const a = await backend.build(testCase.buildContext);
      const r = await backend.deploy(a, 'test-env', testCase.params);
      const tampered = { ...r, environment: 'evil-env' };
      expect(verifyDeploymentRecord(tampered).valid).toBe(false);
    });
  },
);
