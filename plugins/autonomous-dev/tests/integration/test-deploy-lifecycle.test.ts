/**
 * SPEC-023-1-05 full deploy-lifecycle integration test.
 *
 * Exercises build → deploy → healthCheck → rollback for the two
 * side-effect-light backends (`local` and `static`) against real
 * filesystem state. `docker-local` and `github-pages` are skipped here
 * (they live behind environmental dependencies — Docker daemon, real
 * GitHub remote — and are exercised in their own deeply-mocked unit
 * test files).
 *
 * @module tests/integration/test-deploy-lifecycle.test
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalBackend } from '../../intake/deploy/backends/local';
import { StaticBackend } from '../../intake/deploy/backends/static';
import { verifyArtifactChecksum } from '../../intake/deploy/artifact-store';
import { verifyDeploymentRecord } from '../../intake/deploy/record-signer';
import type { RunToolOptions, RunToolResult } from '../../intake/deploy/exec';
import type { BuildContext } from '../../intake/deploy/types';
import { makeRunToolMock } from '../deploy/__mocks__/run-tool';
import { localValidParams } from '../deploy/fixtures/local.params';
import { staticValidParams } from '../deploy/fixtures/static.params';

const TEST_KEY = Buffer.alloc(32, 0x99);

beforeAll(() => {
  process.env.DEPLOY_HMAC_KEY = TEST_KEY.toString('hex');
});
afterAll(() => {
  delete process.env.DEPLOY_HMAC_KEY;
});

function setupRepo(): { repoPath: string } {
  const repoPath = mkdtempSync(join(tmpdir(), 'deploy-lifecycle-'));
  mkdirSync(join(repoPath, 'dist'), { recursive: true });
  writeFileSync(join(repoPath, 'dist', 'index.html'), '<html>v1</html>');
  return { repoPath };
}

describe('SPEC-023-1-05 deploy lifecycle: local', () => {
  let repoPath: string;
  beforeEach(() => {
    repoPath = setupRepo().repoPath;
  });
  afterEach(() => rmSync(repoPath, { recursive: true, force: true }));

  it(
    'build → deploy → healthCheck → rollback completes end-to-end',
    async () => {
      const m = makeRunToolMock();
      // First deploy.
      m.expect(/^git$/, (a) => a[0] === 'status', { stdout: '' });
      m.expect(/^git$/, (a) => a[0] === 'push', { stdout: '' });
      m.expect(
        /^gh$/,
        (a) => a[0] === 'pr' && a[1] === 'create',
        { stdout: 'https://github.com/o/r/pull/1\n' },
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
      const b = new LocalBackend({ runTool: m.runTool });
      const ctx: BuildContext = {
        repoPath,
        commitSha: 'a'.repeat(40),
        branch: 'feat/integration',
        requestId: 'req-int-local',
        cleanWorktree: true,
        params: localValidParams,
      };
      // 1. build
      const artifact = await b.build(ctx);
      expect(await verifyArtifactChecksum(repoPath, artifact.artifactId)).toBe(true);
      // 2. deploy
      const record = await b.deploy(artifact, 'integration-test', localValidParams);
      expect(record.hmac).toMatch(/^[0-9a-f]{64}$/);
      expect(verifyDeploymentRecord(record).valid).toBe(true);
      // 3. record file persisted
      const recordPath = join(
        repoPath,
        '.autonomous-dev',
        'deployments',
        `${record.deployId}.json`,
      );
      expect(existsSync(recordPath)).toBe(true);
      const roundtripped = JSON.parse(readFileSync(recordPath, 'utf8'));
      expect(verifyDeploymentRecord(roundtripped).valid).toBe(true);
      // 4. healthCheck
      const h = await b.healthCheck(record);
      expect(h.healthy).toBe(true);
      // 5. rollback (PR close)
      const rb = await b.rollback(record);
      expect(rb.success).toBe(true);
      const closeCall = m.calls().find(
        (c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'close',
      );
      expect(closeCall).toBeDefined();
    },
    30_000,
  );
});

describe('SPEC-023-1-05 deploy lifecycle: static', () => {
  let repoPath: string;
  let target: string;

  beforeEach(() => {
    repoPath = setupRepo().repoPath;
    target = mkdtempSync(join(tmpdir(), 'deploy-lifecycle-target-'));
  });
  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  it(
    'build → deploy → second deploy → rollback restores first artifact',
    async () => {
      const m = makeRunToolMock();
      m.expect(/^echo$/, () => true, { stdout: '' });
      // Substitute rsync with a real cpSync.
      const wrap = async (
        cmd: string,
        args: string[],
        opts: RunToolOptions,
      ): Promise<RunToolResult> => {
        if (cmd === 'rsync') {
          const src = args[args.length - 2];
          const dst = args[args.length - 1];
          // Wipe target before copy to mirror rsync --delete.
          rmSync(dst, { recursive: true, force: true });
          mkdirSync(dst, { recursive: true });
          cpSync(src, dst, { recursive: true });
          return { stdout: '', stderr: '' };
        }
        return m.runTool(cmd, args, opts);
      };
      const b = new StaticBackend({ runTool: wrap });

      // First deploy: dist contains v1.
      const ctx1: BuildContext = {
        repoPath,
        commitSha: 'a'.repeat(40),
        branch: 'feat/integration',
        requestId: 'req-int-static',
        cleanWorktree: true,
        params: { build_command: 'echo v1', build_dir: 'dist' },
      };
      const a1 = await b.build(ctx1);
      const r1 = await b.deploy(a1, 'integration-test', staticValidParams(target));
      expect(verifyDeploymentRecord(r1).valid).toBe(true);
      // Confirm target has v1.
      expect(readFileSync(join(target, 'index.html'), 'utf8')).toContain('v1');

      // Second deploy: produce a v2 artifact in a sibling dir so rollback
      // can rsync v1 back from `dist/`.
      mkdirSync(join(repoPath, 'dist2'), { recursive: true });
      writeFileSync(join(repoPath, 'dist2', 'index.html'), '<html>v2</html>');
      const ctx2: BuildContext = { ...ctx1, requestId: 'req-int-static-2', params: { build_command: 'echo v2', build_dir: 'dist2' } };
      const a2 = await b.build(ctx2);
      const r2 = await b.deploy(a2, 'integration-test', {
        ...staticValidParams(target),
        build_dir: 'dist2',
      });
      expect(verifyDeploymentRecord(r2).valid).toBe(true);
      expect(readFileSync(join(target, 'index.html'), 'utf8')).toContain('v2');

      // Rollback r2 → restores first artifact's contents.
      const rb = await b.rollback(r2);
      expect(rb.success).toBe(true);
      expect(rb.restoredArtifactId).toBe(a1.artifactId);
      expect(readFileSync(join(target, 'index.html'), 'utf8')).toContain('v1');
    },
    30_000,
  );
});
