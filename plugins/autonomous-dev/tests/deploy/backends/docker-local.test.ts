/**
 * SPEC-023-1-05 DockerLocalBackend deep tests.
 *
 * Docker is not on PATH in the test environment; every `docker` call is
 * mocked. The whole suite is `describe.skip`-able if Docker is ever
 * required, but here we deliberately don't `it.skip` because mocked
 * tests are environment-independent.
 *
 * @module tests/deploy/backends/docker-local.test
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DockerLocalBackend } from '../../../intake/deploy/backends/docker-local';
import { ParameterValidationError } from '../../../intake/deploy/errors';
import { verifyDeploymentRecord } from '../../../intake/deploy/record-signer';
import type { BuildContext } from '../../../intake/deploy/types';
import { makeRunToolMock } from '../__mocks__/run-tool';
import { dockerLocalValidParams } from '../fixtures/docker-local.params';

const TEST_KEY = Buffer.alloc(32, 0x33);

let repoPath: string;

beforeAll(() => {
  process.env.DEPLOY_HMAC_KEY = TEST_KEY.toString('hex');
});
afterAll(() => {
  delete process.env.DEPLOY_HMAC_KEY;
});

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), 'docker-local-'));
  mkdirSync(join(repoPath, '.autonomous-dev'), { recursive: true });
  writeFileSync(join(repoPath, 'Dockerfile'), 'FROM scratch\n');
});
afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

function ctx(params: Record<string, unknown> = dockerLocalValidParams): BuildContext {
  return {
    repoPath,
    commitSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    branch: 'feat/docker',
    requestId: 'req-docker-1',
    cleanWorktree: true,
    params: params as BuildContext['params'],
  };
}

function setupHealthMocks(m: ReturnType<typeof makeRunToolMock>) {
  m.expect(/^docker$/, (a) => a[0] === 'inspect', { stdout: 'running\n' });
}

describe('DockerLocalBackend.build', () => {
  it('invokes docker build -t name:sha12 -f Dockerfile .', async () => {
    const m = makeRunToolMock();
    m.expect(/^docker$/, (a) => a[0] === 'build', { stdout: '' });
    m.expect(
      /^docker$/,
      (a) => a[0] === 'image' && a[1] === 'inspect',
      { stdout: 'sha256:abc\n' },
    );
    const b = new DockerLocalBackend({ runTool: m.runTool });
    await b.build(ctx());
    const buildCall = m.calls().find((c) => c.cmd === 'docker' && c.args[0] === 'build');
    expect(buildCall).toBeDefined();
    expect(buildCall!.args).toContain('-t');
    const tagIdx = buildCall!.args.indexOf('-t') + 1;
    expect(buildCall!.args[tagIdx]).toBe('demo-app:a1b2c3d4e5f6');
    expect(buildCall!.args).toContain('-f');
    expect(buildCall!.args).toContain('Dockerfile');
    expect(buildCall!.args[buildCall!.args.length - 1]).toBe('.');
  });

  it('captures image_id from docker image inspect', async () => {
    const m = makeRunToolMock();
    m.expect(/^docker$/, (a) => a[0] === 'build', { stdout: '' });
    m.expect(
      /^docker$/,
      (a) => a[0] === 'image' && a[1] === 'inspect',
      { stdout: 'sha256:deadbeef1234\n' },
    );
    const b = new DockerLocalBackend({ runTool: m.runTool });
    const a = await b.build(ctx());
    expect(a.metadata.image_id).toBe('sha256:deadbeef1234');
  });
});

describe('DockerLocalBackend.deploy', () => {
  function happyMocks(m: ReturnType<typeof makeRunToolMock>) {
    m.expect(/^docker$/, (a) => a[0] === 'build', { stdout: '' });
    m.expect(
      /^docker$/,
      (a) => a[0] === 'image' && a[1] === 'inspect',
      { stdout: 'sha256:abc\n' },
    );
    m.expect(/^docker$/, (a) => a[0] === 'run', { stdout: 'container-99\n' });
  }

  it('invokes docker run -d --name <image>-<requestId> -p <host>:<container> <tag>', async () => {
    const m = makeRunToolMock();
    happyMocks(m);
    const b = new DockerLocalBackend({ runTool: m.runTool });
    const a = await b.build(ctx());
    const r = await b.deploy(a, 'env', dockerLocalValidParams);
    expect(r.details.container_id).toBe('container-99');
    const runCall = m.calls().find((c) => c.cmd === 'docker' && c.args[0] === 'run');
    expect(runCall).toBeDefined();
    expect(runCall!.args).toContain('-d');
    const nameIdx = runCall!.args.indexOf('--name') + 1;
    expect(runCall!.args[nameIdx]).toBe('demo-app-req-docker-1');
    const portIdx = runCall!.args.indexOf('-p') + 1;
    expect(runCall!.args[portIdx]).toBe('8080:80');
  });

  it('rejects host_port: 80 (range)', async () => {
    const m = makeRunToolMock();
    happyMocks(m);
    const b = new DockerLocalBackend({ runTool: m.runTool });
    const a = await b.build(ctx());
    await expect(
      b.deploy(a, 'env', { ...dockerLocalValidParams, host_port: 80 }),
    ).rejects.toThrow(ParameterValidationError);
  });

  it("rejects image_name: 'My-IMAGE' (uppercase)", async () => {
    const m = makeRunToolMock();
    const b = new DockerLocalBackend({ runTool: m.runTool });
    await expect(
      b.build(ctx({ ...dockerLocalValidParams, image_name: 'My-IMAGE' })),
    ).rejects.toThrow(ParameterValidationError);
  });

  it("rejects extra_run_args containing ';'", async () => {
    const m = makeRunToolMock();
    happyMocks(m);
    const b = new DockerLocalBackend({ runTool: m.runTool });
    const a = await b.build(ctx());
    await expect(
      b.deploy(a, 'env', {
        ...dockerLocalValidParams,
        extra_run_args: ['--memory=512m', 'evil; rm -rf /'] as unknown as string,
      }),
    ).rejects.toThrow(ParameterValidationError);
  });

  it('produces a signed record', async () => {
    const m = makeRunToolMock();
    happyMocks(m);
    const b = new DockerLocalBackend({ runTool: m.runTool });
    const a = await b.build(ctx());
    const r = await b.deploy(a, 'env', dockerLocalValidParams);
    expect(verifyDeploymentRecord(r).valid).toBe(true);
  });
});

describe('DockerLocalBackend.healthCheck', () => {
  function happyDeploy(
    m: ReturnType<typeof makeRunToolMock>,
  ) {
    m.expect(/^docker$/, (a) => a[0] === 'build', { stdout: '' });
    m.expect(
      /^docker$/,
      (a) => a[0] === 'image' && a[1] === 'inspect',
      { stdout: 'sha256:abc\n' },
    );
    m.expect(/^docker$/, (a) => a[0] === 'run', { stdout: 'cid\n' });
  }

  it('returns healthy: true on first 2xx', async () => {
    const m = makeRunToolMock();
    happyDeploy(m);
    setupHealthMocks(m);
    const b = new DockerLocalBackend({
      runTool: m.runTool,
      fetchFn: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      sleepFn: () => Promise.resolve(),
    });
    const a = await b.build(ctx());
    const r = await b.deploy(a, 'env', dockerLocalValidParams);
    const h = await b.healthCheck(r);
    expect(h.healthy).toBe(true);
  });

  it('returns healthy: false with health-timeout on persistent failure', async () => {
    const m = makeRunToolMock();
    happyDeploy(m);
    setupHealthMocks(m);
    const b = new DockerLocalBackend({
      runTool: m.runTool,
      fetchFn: (async () => new Response(null, { status: 500 })) as unknown as typeof fetch,
      sleepFn: () => Promise.resolve(),
    });
    const a = await b.build(ctx());
    const r = await b.deploy(a, 'env', { ...dockerLocalValidParams, health_timeout_seconds: 1 });
    const h = await b.healthCheck(r);
    expect(h.healthy).toBe(false);
    expect(h.unhealthyReason).toBe('health-timeout');
  });
});

describe('DockerLocalBackend.rollback', () => {
  function deployHelper() {
    const m = makeRunToolMock();
    m.expect(/^docker$/, (a) => a[0] === 'build', { stdout: '' });
    m.expect(
      /^docker$/,
      (a) => a[0] === 'image' && a[1] === 'inspect',
      { stdout: 'sha256:abc\n' },
    );
    m.expect(/^docker$/, (a) => a[0] === 'run', { stdout: 'cid-deploy\n' });
    return m;
  }

  it('is idempotent: second rollback succeeds when container is already gone', async () => {
    const m = deployHelper();
    let stopCalls = 0;
    let rmCalls = 0;
    const wrap = async (
      cmd: string,
      args: string[],
      opts: Parameters<typeof m.runTool>[2],
    ) => {
      if (cmd === 'docker' && args[0] === 'stop') {
        stopCalls++;
        if (stopCalls >= 2) {
          // second call: simulate "no such container"
          throw new Error('ExternalToolError: No such container: cid-deploy');
        }
      }
      if (cmd === 'docker' && args[0] === 'rm') {
        rmCalls++;
        if (rmCalls >= 2) {
          throw new Error('ExternalToolError: No such container: cid-deploy');
        }
      }
      return m.runTool(cmd, args, opts);
    };
    m.expect(/^docker$/, (a) => a[0] === 'stop', { stdout: '' });
    m.expect(/^docker$/, (a) => a[0] === 'rm', { stdout: '' });
    const b = new DockerLocalBackend({ runTool: wrap });
    const a = await b.build(ctx());
    const r = await b.deploy(a, 'env', dockerLocalValidParams);
    const rb1 = await b.rollback(r);
    expect(rb1.success).toBe(true);
    const rb2 = await b.rollback(r);
    expect(rb2.success).toBe(true); // ignored idempotent errors
  });

  it('redeploys previous image when a previous record exists', async () => {
    // First deploy.
    const m1 = deployHelper();
    const b1 = new DockerLocalBackend({ runTool: m1.runTool });
    const a1 = await b1.build(ctx());
    const r1 = await b1.deploy(a1, 'env', dockerLocalValidParams);

    // Sleep 5ms so deployedAt strings are strictly ordered.
    await new Promise((res) => setTimeout(res, 5));

    // Second deploy via the SAME instance so artifact-store reads find r1.
    const m2 = makeRunToolMock();
    m2.expect(/^docker$/, (a) => a[0] === 'build', { stdout: '' });
    m2.expect(
      /^docker$/,
      (a) => a[0] === 'image' && a[1] === 'inspect',
      { stdout: 'sha256:def\n' },
    );
    m2.expect(/^docker$/, (a) => a[0] === 'run', { stdout: 'cid-2\n' });
    m2.expect(/^docker$/, (a) => a[0] === 'stop', { stdout: '' });
    m2.expect(/^docker$/, (a) => a[0] === 'rm', { stdout: '' });
    const b2 = new DockerLocalBackend({ runTool: m2.runTool });
    const a2 = await b2.build(ctx({
      ...dockerLocalValidParams,
      image_name: 'demo-app',
    }));
    const r2 = await b2.deploy(a2, 'env', dockerLocalValidParams);
    const rb = await b2.rollback(r2);
    expect(rb.success).toBe(true);
    expect(rb.restoredArtifactId).toBe(a1.artifactId);
    void r1;
  });
});
