/**
 * SPEC-023-1-05 LocalBackend deep tests.
 *
 * Mocks `runTool` for every git/gh invocation. The body-file tempfile is
 * inspected for mode 0600 and post-deploy/post-failure cleanup.
 *
 * @module tests/deploy/backends/local.test
 */

import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalBackend } from '../../../intake/deploy/backends/local';
import { ParameterValidationError } from '../../../intake/deploy/errors';
import { verifyDeploymentRecord } from '../../../intake/deploy/record-signer';
import type { BuildContext } from '../../../intake/deploy/types';
import { makeRunToolMock } from '../__mocks__/run-tool';
import { localValidParams } from '../fixtures/local.params';

const TEST_KEY = Buffer.alloc(32, 0x77);

let repoPath: string;

beforeAll(() => {
  process.env.DEPLOY_HMAC_KEY = TEST_KEY.toString('hex');
});
afterAll(() => {
  delete process.env.DEPLOY_HMAC_KEY;
});

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), 'local-backend-'));
});
afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

function ctx(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    repoPath,
    commitSha: 'abc123def456abc123def456abc123def456abcd',
    branch: 'feat/local-test',
    requestId: 'req-1',
    cleanWorktree: true,
    params: {},
    ...overrides,
  };
}

describe('LocalBackend.build', () => {
  it('is pure: makes no runTool calls', async () => {
    const m = makeRunToolMock();
    const b = new LocalBackend({ runTool: m.runTool });
    await b.build(ctx());
    expect(m.calls().length).toBe(0);
  });

  it('checksum is deterministic for same context', async () => {
    const m = makeRunToolMock();
    const b = new LocalBackend({ runTool: m.runTool });
    const a = await b.build(ctx());
    const c = await b.build(ctx());
    expect(a.checksum).toBe(c.checksum);
  });

  it('checksum differs for different commitSha', async () => {
    const m = makeRunToolMock();
    const b = new LocalBackend({ runTool: m.runTool });
    const a = await b.build(ctx());
    const c = await b.build(ctx({ commitSha: 'f'.repeat(40) }));
    expect(a.checksum).not.toBe(c.checksum);
  });
});

describe('LocalBackend.deploy', () => {
  it('aborts BEFORE git push when worktree is dirty', async () => {
    const m = makeRunToolMock();
    m.expect(/^git$/, (a) => a[0] === 'status', { stdout: ' M src/foo.ts\n' });
    const b = new LocalBackend({ runTool: m.runTool });
    const a = await b.build(ctx());
    await expect(b.deploy(a, 'env', localValidParams)).rejects.toThrow(/dirty/);
    const pushed = m.calls().some((c) => c.cmd === 'git' && c.args[0] === 'push');
    expect(pushed).toBe(false);
  });

  it('writes pr_body to a 0600 tempfile and removes it after success', async () => {
    const m = makeRunToolMock();
    m.expect(/^git$/, (a) => a[0] === 'status', { stdout: '' });
    m.expect(/^git$/, (a) => a[0] === 'push', { stdout: '' });
    let bodyFilePath = '';
    let bodyFileMode = 0;
    let bodyFileExisted = false;
    m.expect(
      /^gh$/,
      (a) => a[0] === 'pr' && a[1] === 'create',
      { stdout: 'https://github.com/org/repo/pull/9\n' },
    );
    // Inject a side effect to capture the tempfile path the moment gh
    // pr create is invoked: wrap the runTool to inspect calls then
    // delegate to the mock.
    const wrapped = async (
      cmd: string,
      args: string[],
      opts: Parameters<typeof m.runTool>[2],
    ) => {
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        const idx = args.indexOf('--body-file');
        if (idx !== -1) {
          bodyFilePath = args[idx + 1];
          bodyFileExisted = existsSync(bodyFilePath);
          if (bodyFileExisted) {
            bodyFileMode = statSync(bodyFilePath).mode & 0o777;
          }
        }
      }
      return m.runTool(cmd, args, opts);
    };
    const b = new LocalBackend({ runTool: wrapped });
    const a = await b.build(ctx());
    await b.deploy(a, 'env', localValidParams);
    expect(bodyFileExisted).toBe(true);
    expect(bodyFileMode).toBe(0o600);
    expect(existsSync(bodyFilePath)).toBe(false); // cleaned up
  });

  it('removes the pr_body tempfile when gh pr create fails', async () => {
    const m = makeRunToolMock();
    m.expect(/^git$/, (a) => a[0] === 'status', { stdout: '' });
    m.expect(/^git$/, (a) => a[0] === 'push', { stdout: '' });
    m.expect(
      /^gh$/,
      (a) => a[0] === 'pr' && a[1] === 'create',
      { exitCode: 1, stderr: 'gh: rate limited' },
    );
    let bodyFilePath = '';
    const wrapped = async (
      cmd: string,
      args: string[],
      opts: Parameters<typeof m.runTool>[2],
    ) => {
      if (cmd === 'gh') {
        const idx = args.indexOf('--body-file');
        if (idx !== -1) bodyFilePath = args[idx + 1];
      }
      return m.runTool(cmd, args, opts);
    };
    const b = new LocalBackend({ runTool: wrapped });
    const a = await b.build(ctx());
    await expect(b.deploy(a, 'env', localValidParams)).rejects.toThrow();
    expect(bodyFilePath.length).toBeGreaterThan(0);
    expect(existsSync(bodyFilePath)).toBe(false);
  });

  it('parses the PR URL from gh stdout', async () => {
    const m = makeRunToolMock();
    m.expect(/^git$/, (a) => a[0] === 'status', { stdout: '' });
    m.expect(/^git$/, (a) => a[0] === 'push', { stdout: '' });
    m.expect(
      /^gh$/,
      (a) => a[0] === 'pr' && a[1] === 'create',
      { stdout: 'noise\nhttps://github.com/octo/cat/pull/1234\nmore noise\n' },
    );
    const b = new LocalBackend({ runTool: m.runTool });
    const a = await b.build(ctx());
    const r = await b.deploy(a, 'env', localValidParams);
    expect(r.details.pr_url).toBe('https://github.com/octo/cat/pull/1234');
  });

  it('rejects pr_title containing ;', async () => {
    const m = makeRunToolMock();
    m.expect(/^git$/, (a) => a[0] === 'status', { stdout: '' });
    const b = new LocalBackend({ runTool: m.runTool });
    const a = await b.build(ctx());
    await expect(
      b.deploy(a, 'env', { ...localValidParams, pr_title: 'evil; rm -rf /' }),
    ).rejects.toThrow(ParameterValidationError);
  });

  it('produces a signed record that verifies', async () => {
    const m = makeRunToolMock();
    m.expect(/^git$/, (a) => a[0] === 'status', { stdout: '' });
    m.expect(/^git$/, (a) => a[0] === 'push', { stdout: '' });
    m.expect(
      /^gh$/,
      (a) => a[0] === 'pr' && a[1] === 'create',
      { stdout: 'https://github.com/o/r/pull/1\n' },
    );
    const b = new LocalBackend({ runTool: m.runTool });
    const a = await b.build(ctx());
    const r = await b.deploy(a, 'env', localValidParams);
    expect(r.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyDeploymentRecord(r).valid).toBe(true);
  });
});

describe('LocalBackend.healthCheck', () => {
  async function healthFor(state: string): Promise<boolean> {
    const m = makeRunToolMock();
    m.expect(/^git$/, (a) => a[0] === 'status', { stdout: '' });
    m.expect(/^git$/, (a) => a[0] === 'push', { stdout: '' });
    m.expect(
      /^gh$/,
      (a) => a[0] === 'pr' && a[1] === 'create',
      { stdout: 'https://github.com/o/r/pull/7\n' },
    );
    m.expect(
      /^gh$/,
      (a) => a[0] === 'pr' && a[1] === 'view',
      { stdout: JSON.stringify({ state }) },
    );
    const b = new LocalBackend({ runTool: m.runTool });
    const a = await b.build(ctx());
    const r = await b.deploy(a, 'env', localValidParams);
    const h = await b.healthCheck(r);
    return h.healthy;
  }

  it('returns healthy: true when state is OPEN', async () => {
    expect(await healthFor('OPEN')).toBe(true);
  });
  it('returns healthy: false when state is MERGED', async () => {
    expect(await healthFor('MERGED')).toBe(false);
  });
  it('returns healthy: false when state is CLOSED', async () => {
    expect(await healthFor('CLOSED')).toBe(false);
  });
});

describe('LocalBackend.rollback', () => {
  async function rollbackOutcome(closeExit: number) {
    const m = makeRunToolMock();
    m.expect(/^git$/, (a) => a[0] === 'status', { stdout: '' });
    m.expect(/^git$/, (a) => a[0] === 'push', { stdout: '' });
    m.expect(
      /^gh$/,
      (a) => a[0] === 'pr' && a[1] === 'create',
      { stdout: 'https://github.com/o/r/pull/9\n' },
    );
    m.expect(
      /^gh$/,
      (a) => a[0] === 'pr' && a[1] === 'close',
      closeExit === 0 ? { stdout: 'closed\n' } : { exitCode: closeExit, stderr: 'forbidden' },
    );
    const b = new LocalBackend({ runTool: m.runTool });
    const a = await b.build(ctx());
    const r = await b.deploy(a, 'env', localValidParams);
    return { result: await b.rollback(r), record: r, calls: m.calls };
  }

  it('returns success: true and references deployId in the close comment', async () => {
    const { result, record, calls } = await rollbackOutcome(0);
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    const closeCall = calls().find(
      (c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'close',
    );
    expect(closeCall).toBeDefined();
    const commentIdx = closeCall!.args.indexOf('--comment');
    expect(closeCall!.args[commentIdx + 1]).toContain(record.deployId);
  });

  it('returns success: false when gh pr close fails', async () => {
    const { result } = await rollbackOutcome(1);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
