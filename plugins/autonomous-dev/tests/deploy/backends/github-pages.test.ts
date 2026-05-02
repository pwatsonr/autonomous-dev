/**
 * SPEC-023-1-05 GithubPagesBackend deep tests.
 *
 * @module tests/deploy/backends/github-pages.test
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GithubPagesBackend } from '../../../intake/deploy/backends/github-pages';
import { ParameterValidationError } from '../../../intake/deploy/errors';
import { verifyDeploymentRecord } from '../../../intake/deploy/record-signer';
import type { BuildContext } from '../../../intake/deploy/types';
import { makeRunToolMock } from '../__mocks__/run-tool';
import { githubPagesValidParams } from '../fixtures/github-pages.params';

const TEST_KEY = Buffer.alloc(32, 0x44);

let repoPath: string;
const SHA_OLD = 'a'.repeat(40);
const SHA_NEW = 'b'.repeat(40);
const SHA_RACE = 'c'.repeat(40);

beforeAll(() => {
  process.env.DEPLOY_HMAC_KEY = TEST_KEY.toString('hex');
});
afterAll(() => {
  delete process.env.DEPLOY_HMAC_KEY;
});

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), 'gh-pages-'));
  mkdirSync(join(repoPath, 'dist'), { recursive: true });
  writeFileSync(join(repoPath, 'dist', 'index.html'), '<html>hi</html>');
});
afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

function ctx(params: Record<string, unknown> = githubPagesValidParams): BuildContext {
  return {
    repoPath,
    commitSha: 'd'.repeat(40),
    branch: 'feat/gh-pages',
    requestId: 'req-gh',
    cleanWorktree: true,
    params: params as BuildContext['params'],
  };
}

describe('GithubPagesBackend.build', () => {
  it('rejects pages_branch with whitespace', async () => {
    const m = makeRunToolMock();
    const b = new GithubPagesBackend({ runTool: m.runTool });
    await expect(
      b.build(ctx({ ...githubPagesValidParams, pages_branch: 'gh pages' })),
    ).rejects.toThrow(ParameterValidationError);
  });
});

describe('GithubPagesBackend.deploy', () => {
  function happyDeploy(m: ReturnType<typeof makeRunToolMock>) {
    m.expect(/^echo$/, () => true, { stdout: '' });
    let lsCount = 0;
    m.expect(
      /^git$/,
      (a) => a[0] === 'ls-remote',
      // The first call is the pre-deploy sha; the second is the post-deploy sha.
      // We register two responses interleaved by counting through MockExpectation
      // — the simplest way is two separate expectations registered in order.
      { stdout: '' },
    );
    void lsCount;
    m.expect(
      /^git$/,
      (a) => a[0] === 'subtree' && a[1] === 'push',
      { stdout: '' },
    );
  }

  it('records previous_sha and new_sha; never uses --force in deploy', async () => {
    const m = makeRunToolMock();
    m.expect(/^echo$/, () => true, { stdout: '' });
    // First ls-remote → previous_sha (SHA_OLD), second → new_sha (SHA_NEW).
    let lsCalls = 0;
    const lsResponses = [
      `${SHA_OLD}\trefs/heads/gh-pages\n`,
      `${SHA_NEW}\trefs/heads/gh-pages\n`,
    ];
    const wrap = async (
      cmd: string,
      args: string[],
      opts: Parameters<typeof m.runTool>[2],
    ) => {
      if (cmd === 'git' && args[0] === 'ls-remote') {
        const resp = lsResponses[lsCalls] ?? '';
        lsCalls++;
        return { stdout: resp, stderr: '' };
      }
      return m.runTool(cmd, args, opts);
    };
    m.expect(
      /^git$/,
      (a) => a[0] === 'subtree' && a[1] === 'push',
      { stdout: '' },
    );
    const b = new GithubPagesBackend({ runTool: wrap });
    const a = await b.build(ctx());
    const r = await b.deploy(a, 'env', githubPagesValidParams);
    expect(r.details.previous_sha).toBe(SHA_OLD);
    expect(r.details.new_sha).toBe(SHA_NEW);
    // None of the deploy calls should mention --force (or --force-with-lease).
    const forced = m.calls().some(
      (c) =>
        c.cmd === 'git' &&
        c.args[0] === 'push' &&
        c.args.some((arg) => arg.startsWith('--force')),
    );
    expect(forced).toBe(false);
    expect(verifyDeploymentRecord(r).valid).toBe(true);
  });

  it('falls back to a worktree push when subtree fails with diverged-history error', async () => {
    const m = makeRunToolMock();
    m.expect(/^echo$/, () => true, { stdout: '' });
    let lsCalls = 0;
    const wrap = async (
      cmd: string,
      args: string[],
      opts: Parameters<typeof m.runTool>[2],
    ) => {
      if (cmd === 'git' && args[0] === 'ls-remote') {
        lsCalls++;
        return {
          stdout:
            (lsCalls === 1 ? SHA_OLD : SHA_NEW) + '\trefs/heads/gh-pages\n',
          stderr: '',
        };
      }
      return m.runTool(cmd, args, opts);
    };
    m.expect(
      /^git$/,
      (a) => a[0] === 'subtree' && a[1] === 'push',
      { exitCode: 1, stderr: 'Updates were rejected because the remote contains work that you do not have' },
    );
    m.expect(
      /^git$/,
      (a) => a[0] === 'push' && a[1] === 'origin',
      { stdout: '' },
    );
    const b = new GithubPagesBackend({ runTool: wrap });
    const a = await b.build(ctx());
    const r = await b.deploy(a, 'env', githubPagesValidParams);
    expect(verifyDeploymentRecord(r).valid).toBe(true);
    const fallback = m.calls().find(
      (c) => c.cmd === 'git' && c.args[0] === 'push' && c.args[1] === 'origin',
    );
    expect(fallback).toBeDefined();
  });
});

describe('GithubPagesBackend.rollback', () => {
  function makeWrap(lsResponses: string[]) {
    const m = makeRunToolMock();
    m.expect(/^echo$/, () => true, { stdout: '' });
    m.expect(
      /^git$/,
      (a) => a[0] === 'subtree' && a[1] === 'push',
      { stdout: '' },
    );
    m.expect(
      /^git$/,
      (a) => a[0] === 'push' && a[1].startsWith('--force-with-lease'),
      { stdout: '' },
    );
    let i = 0;
    const wrap = async (
      cmd: string,
      args: string[],
      opts: Parameters<typeof m.runTool>[2],
    ) => {
      if (cmd === 'git' && args[0] === 'ls-remote') {
        const resp = lsResponses[i] ?? '';
        i++;
        return { stdout: resp + '\trefs/heads/gh-pages\n', stderr: '' };
      }
      return m.runTool(cmd, args, opts);
    };
    return { mock: m, wrap };
  }

  it('refuses force-rollback when remote moved and allow_force_rollback=false', async () => {
    // ls-remote calls: 1 pre-deploy (SHA_OLD), 2 post-deploy (SHA_NEW), 3 rollback check (SHA_RACE).
    const { wrap } = makeWrap([SHA_OLD, SHA_NEW, SHA_RACE]);
    const b = new GithubPagesBackend({ runTool: wrap });
    const a = await b.build(ctx());
    const r = await b.deploy(a, 'env', githubPagesValidParams);
    const rb = await b.rollback(r);
    expect(rb.success).toBe(false);
    expect(rb.errors.join(' ')).toMatch(/HEAD moved/);
  });

  it('invokes git push --force-with-lease when allow_force_rollback=true', async () => {
    const { mock, wrap } = makeWrap([SHA_OLD, SHA_NEW, SHA_RACE]);
    const b = new GithubPagesBackend({ runTool: wrap });
    const a = await b.build(ctx());
    const r = await b.deploy(a, 'env', {
      ...githubPagesValidParams,
      allow_force_rollback: true,
    });
    const rb = await b.rollback(r);
    expect(rb.success).toBe(true);
    const forcedCall = mock.calls().find(
      (c) =>
        c.cmd === 'git' &&
        c.args[0] === 'push' &&
        c.args[1] === `--force-with-lease=gh-pages:${SHA_NEW}`,
    );
    expect(forcedCall).toBeDefined();
    // Refspec: <previous_sha>:<branch>
    expect(forcedCall!.args).toContain(`${SHA_OLD}:gh-pages`);
  });
});

describe('GithubPagesBackend.healthCheck', () => {
  it('returns healthy: true on 200, false on 500', async () => {
    const m = makeRunToolMock();
    m.expect(/^echo$/, () => true, { stdout: '' });
    let i = 0;
    const wrap = async (
      cmd: string,
      args: string[],
      opts: Parameters<typeof m.runTool>[2],
    ) => {
      if (cmd === 'git' && args[0] === 'ls-remote') {
        const resp = (i === 0 ? SHA_OLD : SHA_NEW) + '\trefs/heads/gh-pages\n';
        i++;
        return { stdout: resp, stderr: '' };
      }
      return m.runTool(cmd, args, opts);
    };
    m.expect(
      /^git$/,
      (a) => a[0] === 'subtree' && a[1] === 'push',
      { stdout: '' },
    );

    const ok = new GithubPagesBackend({
      runTool: wrap,
      fetchFn: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    });
    const aOk = await ok.build(ctx());
    const rOk = await ok.deploy(aOk, 'env', {
      ...githubPagesValidParams,
      pages_url: 'https://example.github.io/site',
    });
    expect((await ok.healthCheck(rOk)).healthy).toBe(true);

    // Build a fresh instance for the 500 case so ls-remote counters reset.
    let i2 = 0;
    const wrap2 = async (
      cmd: string,
      args: string[],
      opts: Parameters<typeof m.runTool>[2],
    ) => {
      if (cmd === 'git' && args[0] === 'ls-remote') {
        const resp = (i2 === 0 ? SHA_OLD : SHA_NEW) + '\trefs/heads/gh-pages\n';
        i2++;
        return { stdout: resp, stderr: '' };
      }
      return m.runTool(cmd, args, opts);
    };
    const bad = new GithubPagesBackend({
      runTool: wrap2,
      fetchFn: (async () => new Response(null, { status: 500 })) as unknown as typeof fetch,
    });
    const aBad = await bad.build(ctx());
    const rBad = await bad.deploy(aBad, 'env', {
      ...githubPagesValidParams,
      pages_url: 'https://example.github.io/site',
    });
    expect((await bad.healthCheck(rBad)).healthy).toBe(false);
  });
});
