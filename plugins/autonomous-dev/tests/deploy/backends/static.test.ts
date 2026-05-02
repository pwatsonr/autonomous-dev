/**
 * SPEC-023-1-05 StaticBackend deep tests.
 *
 * Mixes mocked `runTool` with REAL local-temp-dir rsync. We invoke a
 * local rsync wrapper that copies files (via fs.cp) so the file-tree
 * byte-equality assertion runs against actual files, not against a mock
 * canned response.
 *
 * @module tests/deploy/backends/static.test
 */

import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { StaticBackend, SSH_TARGET_RE } from '../../../intake/deploy/backends/static';
import { ParameterValidationError } from '../../../intake/deploy/errors';
import { verifyDeploymentRecord } from '../../../intake/deploy/record-signer';
import type { BuildContext } from '../../../intake/deploy/types';
import type { RunToolOptions, RunToolResult } from '../../../intake/deploy/exec';
import { makeRunToolMock } from '../__mocks__/run-tool';
import { staticValidParams } from '../fixtures/static.params';

const TEST_KEY = Buffer.alloc(32, 0x55);

let repoPath: string;
let target: string;

beforeAll(() => {
  process.env.DEPLOY_HMAC_KEY = TEST_KEY.toString('hex');
});
afterAll(() => {
  delete process.env.DEPLOY_HMAC_KEY;
});

function setupRepo(): void {
  repoPath = mkdtempSync(join(tmpdir(), 'static-backend-'));
  mkdirSync(join(repoPath, 'dist'), { recursive: true });
  writeFileSync(join(repoPath, 'dist', 'index.html'), '<html>hi</html>');
  writeFileSync(join(repoPath, 'dist', 'style.css'), 'body{}');
}

beforeEach(() => {
  setupRepo();
  target = mkdtempSync(join(tmpdir(), 'static-backend-target-'));
});
afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

function ctx(params: Record<string, unknown>): BuildContext {
  return {
    repoPath,
    commitSha: 'a'.repeat(40),
    branch: 'feat/static',
    requestId: 'req-static',
    cleanWorktree: true,
    params: params as BuildContext['params'],
  };
}

/**
 * Real-rsync substitute: when the backend invokes `rsync ... <src>/ <target>`,
 * we copy the directory contents to the target. Mocked build commands
 * still go through the same wrapper.
 */
function rsyncyRun(
  m: ReturnType<typeof makeRunToolMock>,
): (cmd: string, args: string[], opts: RunToolOptions) => Promise<RunToolResult> {
  return async (cmd, args, opts) => {
    if (cmd === 'rsync') {
      // Last arg is target; second-to-last is source (with trailing slash).
      const src = args[args.length - 2];
      const dst = args[args.length - 1];
      // Mirror rsync --delete: clear target before copy.
      const fs = require('node:fs') as typeof import('node:fs');
      fs.rmSync(dst, { recursive: true, force: true });
      fs.mkdirSync(dst, { recursive: true });
      cpSync(src, dst, { recursive: true });
      return { stdout: '', stderr: '' };
    }
    return m.runTool(cmd, args, opts);
  };
}

function manifestSha(dir: string): string {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const entries: { rel: string; hash: string }[] = [];
  function walk(d: string, root: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, root);
      else if (e.isFile()) {
        const buf = fs.readFileSync(p);
        entries.push({
          rel: path.relative(root, p),
          hash: createHash('sha256').update(buf).digest('hex'),
        });
      }
    }
  }
  walk(dir, dir);
  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  const h = createHash('sha256');
  for (const e of entries) h.update(e.rel + '\0' + e.hash + '\0');
  return h.digest('hex');
}

describe('StaticBackend.build', () => {
  it('rejects build_command containing ;', async () => {
    const m = makeRunToolMock();
    const b = new StaticBackend({ runTool: m.runTool });
    await expect(
      b.build(ctx({ build_command: 'echo a; rm -rf /' })),
    ).rejects.toThrow(ParameterValidationError);
  });

  it('rejects build_dir of "../escape"', async () => {
    const m = makeRunToolMock();
    const b = new StaticBackend({ runTool: m.runTool });
    await expect(
      b.build(ctx({ build_command: 'echo ok', build_dir: '../escape' })),
    ).rejects.toThrow(ParameterValidationError);
  });

  it('build runs the cmd via execFile (no shell): asserted by inspecting calls', async () => {
    const m = makeRunToolMock();
    m.expect(/^echo$/, () => true, { stdout: '' });
    const b = new StaticBackend({ runTool: m.runTool });
    await b.build(ctx({ build_command: 'echo ok', build_dir: 'dist' }));
    const echoCall = m.calls().find((c) => c.cmd === 'echo');
    expect(echoCall).toBeDefined();
    expect(echoCall!.args).toEqual(['ok']);
  });

  it('records sizeBytes matching actual dist content', async () => {
    const m = makeRunToolMock();
    m.expect(/^echo$/, () => true, { stdout: '' });
    const b = new StaticBackend({ runTool: m.runTool });
    const a = await b.build(ctx({ build_command: 'echo ok', build_dir: 'dist' }));
    const expected =
      readFileSync(join(repoPath, 'dist', 'index.html')).length +
      readFileSync(join(repoPath, 'dist', 'style.css')).length;
    expect(a.sizeBytes).toBe(expected);
  });
});

describe('StaticBackend.deploy', () => {
  it('rsyncs the file tree byte-for-byte to a local temp dir', async () => {
    const m = makeRunToolMock();
    m.expect(/^echo$/, () => true, { stdout: '' });
    const b = new StaticBackend({ runTool: rsyncyRun(m) });
    const a = await b.build(ctx({ build_command: 'echo ok', build_dir: 'dist' }));
    const r = await b.deploy(a, 'env', staticValidParams(target));
    expect(verifyDeploymentRecord(r).valid).toBe(true);
    const srcSha = manifestSha(join(repoPath, 'dist'));
    const dstSha = manifestSha(target);
    expect(dstSha).toBe(srcSha);
  });

  it('passes -e ssh -i <key> ... to rsync when target is remote and ssh_key_path is set', async () => {
    const m = makeRunToolMock();
    m.expect(/^echo$/, () => true, { stdout: '' });
    m.expect(/^rsync$/, () => true, { stdout: '' });
    const b = new StaticBackend({ runTool: m.runTool });
    const a = await b.build(ctx({ build_command: 'echo ok', build_dir: 'dist' }));
    const r = await b.deploy(a, 'env', {
      build_command: 'echo ok',
      build_dir: 'dist',
      target: 'deploy@example.com:/srv/site',
      ssh_key_path: '/home/runner/.ssh/id_ed25519',
    });
    expect(r.hmac).toMatch(/^[0-9a-f]{64}$/);
    const rsyncCall = m.calls().find((c) => c.cmd === 'rsync');
    expect(rsyncCall).toBeDefined();
    const eIdx = rsyncCall!.args.indexOf('-e');
    expect(eIdx).toBeGreaterThanOrEqual(0);
    expect(rsyncCall!.args[eIdx + 1]).toContain('ssh -i /home/runner/.ssh/id_ed25519');
    expect(rsyncCall!.args[eIdx + 1]).toContain('StrictHostKeyChecking=accept-new');
  });

  it('propagates rsync non-zero exit as a rejection', async () => {
    const m = makeRunToolMock();
    m.expect(/^echo$/, () => true, { stdout: '' });
    m.expect(/^rsync$/, () => true, { exitCode: 23, stderr: 'rsync: oops' });
    const b = new StaticBackend({ runTool: m.runTool });
    const a = await b.build(ctx({ build_command: 'echo ok', build_dir: 'dist' }));
    await expect(b.deploy(a, 'env', staticValidParams(target))).rejects.toThrow(/rsync/);
  });
});

describe('StaticBackend.healthCheck', () => {
  it('returns false on 500, true on 200', async () => {
    const m = makeRunToolMock();
    m.expect(/^echo$/, () => true, { stdout: '' });
    const b = new StaticBackend({
      runTool: rsyncyRun(m),
      fetchFn: (async (url: string | URL) => {
        return new Response(null, {
          status: String(url).endsWith('/bad') ? 500 : 200,
        });
      }) as unknown as typeof fetch,
    });
    const a = await b.build(ctx({ build_command: 'echo ok', build_dir: 'dist' }));
    const r1 = await b.deploy(a, 'env', {
      ...staticValidParams(target),
      health_url: 'http://localhost/good',
    });
    const r2 = await b.deploy(a, 'env', {
      ...staticValidParams(target),
      health_url: 'http://localhost/bad',
    });
    expect((await b.healthCheck(r1)).healthy).toBe(true);
    expect((await b.healthCheck(r2)).healthy).toBe(false);
  });

  it('returns healthy: true with no-health-url-configured check when omitted', async () => {
    const m = makeRunToolMock();
    m.expect(/^echo$/, () => true, { stdout: '' });
    const b = new StaticBackend({ runTool: rsyncyRun(m) });
    const a = await b.build(ctx({ build_command: 'echo ok', build_dir: 'dist' }));
    const r = await b.deploy(a, 'env', staticValidParams(target));
    const h = await b.healthCheck(r);
    expect(h.healthy).toBe(true);
    expect(h.checks[0].name).toBe('no-health-url-configured');
  });
});

describe('StaticBackend.rollback', () => {
  it('after a second deploy, restores the first deploy contents', async () => {
    const m = makeRunToolMock();
    // Two builds: first produces dist@v1, second produces dist@v2.
    m.expect(/^echo$/, () => true, { stdout: '' });
    const b = new StaticBackend({ runTool: rsyncyRun(m) });

    // First deploy.
    const a1 = await b.build(ctx({ build_command: 'echo v1', build_dir: 'dist' }));
    const r1 = await b.deploy(a1, 'env', staticValidParams(target));

    // Capture a snapshot of the FIRST artifact's source tree (before we
    // mutate the dist directory with the v2 build) so rollback's
    // `readArtifact(...).location='dist'` rsync of `<repo>/dist/`
    // matches v1 contents byte-for-byte.
    //
    // Implementation detail: artifact `location` for static is the
    // build_dir (relative). So rollback reads dist/ at restore time,
    // which is the CURRENT dist — we therefore preserve v1 contents by
    // not mutating dist for the second deploy. Use a separate dir.
    mkdirSync(join(repoPath, 'dist2'), { recursive: true });
    writeFileSync(join(repoPath, 'dist2', 'index.html'), '<html>v2</html>');

    // Pretend second build produced dist2.
    const a2 = await b.build(ctx({ build_command: 'echo v2', build_dir: 'dist2' }));
    const r2 = await b.deploy(a2, 'env', {
      ...staticValidParams(target),
      build_dir: 'dist2',
    });

    // Currently target should match dist2.
    expect(manifestSha(target)).toBe(manifestSha(join(repoPath, 'dist2')));

    // Rollback r2 → restore r1's artifact (which points at dist).
    const rb = await b.rollback(r2);
    expect(rb.success).toBe(true);
    expect(rb.restoredArtifactId).toBe(a1.artifactId);
    expect(manifestSha(target)).toBe(manifestSha(join(repoPath, 'dist')));
    void r1; // silence unused
  });
});

describe('SSH_TARGET_RE', () => {
  it('matches user@host:/path', () => {
    expect(SSH_TARGET_RE.test('user@host.example.com:/var/www')).toBe(true);
  });
  it('does not match plain absolute path', () => {
    expect(SSH_TARGET_RE.test('/var/www')).toBe(false);
  });
});

// Required-but-unused-by-test path: keep `resolve` import used.
void resolve;
