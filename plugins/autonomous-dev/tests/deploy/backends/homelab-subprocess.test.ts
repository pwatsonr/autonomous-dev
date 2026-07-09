/**
 * Tests for the homelab subprocess deploy backend (issue #662).
 *
 * Coverage:
 *   1. supports() — matches on kind, never on id (invariant #674)
 *   2. registerHomelabKind() — dynamically extends the supported set
 *   3. build() — correct argv built, stdout stored in ctx.meta
 *   4. push() — correct argv; uses builtTag from meta when present
 *   5. deploy() — correct argv; returns DeployResult
 *   6. verifyHealth() — correct argv; healthy on success / unhealthy on fail
 *   7. rollback() — correct argv; success/failure mapped correctly
 *   8. VAULT_TOKEN forwarded to child env
 *   9. resolveCliPath() — reads HOMELAB_PLUGIN_PATH env var
 *  10. Auto-registration in the pipeline backend registry
 *
 * All tests mock the subprocess call (execFile); no real processes are spawned.
 *
 * @module tests/deploy/backends/homelab-subprocess.test
 */

import {
  HomelabSubprocessBackend,
  registerHomelabKind,
  listHomelabKinds,
  resolveCliPath,
  homelabSubprocessBackend,
  DEFAULT_HOMELAB_CLI_PATH,
  type HomelabSubprocessBackendDeps,
  type SpawnResult,
} from '../../../intake/deploy/backends/homelab-subprocess';
import {
  findPipelineBackend,
  resetPipelineBackendRegistry,
} from '../../../intake/deploy/backend-types';
import type { PipelineContext, DeployResult } from '../../../intake/deploy/backend-types';
import type { DeployTarget } from '../../../intake/deploy/target-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(overrides: Partial<DeployTarget> = {}): DeployTarget {
  return {
    id: 'homelab-target-1',
    name: 'Homelab Node 1',
    kind: 'swarm-node',
    provider: 'homelab-subprocess',
    capabilities: [],
    tags: {},
    source: 'discovery',
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    runId: '01HNXYZ000000000000000001',
    service: 'my-api',
    target: makeTarget(),
    artifact: { name: 'my-api', meta: {} },
    meta: {},
    ...overrides,
  };
}

/** Create a mock execFile that resolves with given stdout/stderr. */
function mockExec(stdout = '', stderr = ''): jest.MockedFunction<HomelabSubprocessBackendDeps['execFileFn'] & {}> {
  return jest.fn().mockResolvedValue({ stdout, stderr });
}

/** Create a mock execFile that rejects with an error. */
function mockExecFail(message: string): jest.MockedFunction<HomelabSubprocessBackendDeps['execFileFn'] & {}> {
  return jest.fn().mockRejectedValue(new Error(message));
}

/** Build a backend with injected deps. */
function makeBackend(
  overrides: Partial<HomelabSubprocessBackendDeps> = {},
): HomelabSubprocessBackend {
  return new HomelabSubprocessBackend({
    cliPath: '/fake/cli.js',
    execFileFn: mockExec(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. supports() — kind-based dispatch, never id
// ---------------------------------------------------------------------------

describe('supports()', () => {
  it('returns true for known homelab kinds', () => {
    const backend = makeBackend();
    for (const kind of ['swarm-node', 'k3s-cluster', 'proxmox-vm', 'proxmox-lxc', 'unraid', 'homelab']) {
      expect(backend.supports(makeTarget({ kind }))).toBe(true);
    }
  });

  it('returns false for unknown kinds', () => {
    const backend = makeBackend();
    expect(backend.supports(makeTarget({ kind: 'cloud-run-service' }))).toBe(false);
    expect(backend.supports(makeTarget({ kind: 'static-site' }))).toBe(false);
    expect(backend.supports(makeTarget({ kind: 'local-pr' }))).toBe(false);
  });

  it('does NOT match on target id — only on kind (invariant #674)', () => {
    const backend = makeBackend();
    // Target with non-homelab kind but homelab-sounding id should NOT match.
    const t = makeTarget({ id: 'swarm-node', kind: 'cloud-run-service' });
    expect(backend.supports(t)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. registerHomelabKind()
// ---------------------------------------------------------------------------

describe('registerHomelabKind()', () => {
  it('extends the supported kinds set', () => {
    const backend = makeBackend();
    expect(backend.supports(makeTarget({ kind: 'talos-node' }))).toBe(false);

    registerHomelabKind('talos-node');
    expect(backend.supports(makeTarget({ kind: 'talos-node' }))).toBe(true);

    // Cleanup — re-registering is idempotent but we can confirm it's there.
    expect(listHomelabKinds()).toContain('talos-node');
  });
});

// ---------------------------------------------------------------------------
// 3. build() — correct argv
// ---------------------------------------------------------------------------

describe('build()', () => {
  it('calls CLI with: deploy build <service>', async () => {
    const exec = mockExec('my-api:latest');
    const backend = makeBackend({ execFileFn: exec });
    const ctx = makeCtx();

    await backend.build(ctx);

    expect(exec).toHaveBeenCalledTimes(1);
    const [cmd, args] = exec.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('node');
    expect(args).toContain('/fake/cli.js');
    expect(args).toContain('deploy');
    expect(args).toContain('build');
    expect(args).toContain('my-api');
  });

  it('includes --tag when artifact.tag is set', async () => {
    const exec = mockExec();
    const backend = makeBackend({ execFileFn: exec });
    const ctx = makeCtx({ artifact: { name: 'my-api', tag: 'v1.2.3', meta: {} } });

    await backend.build(ctx);

    const [, args] = exec.mock.calls[0] as unknown as [string, string[]];
    expect(args).toContain('--tag');
    expect(args).toContain('v1.2.3');
  });

  it('includes --source-dir when artifact.sourceDir is set', async () => {
    const exec = mockExec();
    const backend = makeBackend({ execFileFn: exec });
    const ctx = makeCtx({
      artifact: { name: 'my-api', sourceDir: '/src/my-api', meta: {} },
    });

    await backend.build(ctx);

    const [, args] = exec.mock.calls[0] as unknown as [string, string[]];
    expect(args).toContain('--source-dir');
    expect(args).toContain('/src/my-api');
  });

  it('stores stdout in ctx.meta["builtTag"]', async () => {
    const exec = mockExec('my-api:sha-abc123');
    const backend = makeBackend({ execFileFn: exec });
    const ctx = makeCtx();

    await backend.build(ctx);

    expect(ctx.meta['builtTag']).toBe('my-api:sha-abc123');
  });

  it('throws when exec fails', async () => {
    const exec = mockExecFail('docker build failed: no Dockerfile');
    const backend = makeBackend({ execFileFn: exec });

    await expect(backend.build(makeCtx())).rejects.toThrow('docker build failed');
  });
});

// ---------------------------------------------------------------------------
// 4. push() — correct argv
// ---------------------------------------------------------------------------

describe('push()', () => {
  it('calls CLI with: deploy push <service>', async () => {
    const exec = mockExec();
    const backend = makeBackend({ execFileFn: exec });

    await backend.push(makeCtx());

    const [, args] = exec.mock.calls[0] as unknown as [string, string[]];
    expect(args).toContain('deploy');
    expect(args).toContain('push');
    expect(args).toContain('my-api');
  });

  it('uses builtTag from ctx.meta when present', async () => {
    const exec = mockExec();
    const backend = makeBackend({ execFileFn: exec });
    const ctx = makeCtx({ meta: { builtTag: 'my-api:sha-abc123' } });

    await backend.push(ctx);

    const [, args] = exec.mock.calls[0] as unknown as [string, string[]];
    expect(args).toContain('--tag');
    expect(args).toContain('my-api:sha-abc123');
  });

  it('falls back to artifact.tag when no builtTag in meta', async () => {
    const exec = mockExec();
    const backend = makeBackend({ execFileFn: exec });
    const ctx = makeCtx({ artifact: { name: 'my-api', tag: 'v2.0.0', meta: {} } });

    await backend.push(ctx);

    const [, args] = exec.mock.calls[0] as unknown as [string, string[]];
    expect(args).toContain('--tag');
    expect(args).toContain('v2.0.0');
  });
});

// ---------------------------------------------------------------------------
// 5. deploy() — correct argv; maps success/failure
// ---------------------------------------------------------------------------

describe('deploy()', () => {
  it('calls CLI with: deploy apply <service> --target <target-id>', async () => {
    const exec = mockExec('deployment started');
    const backend = makeBackend({ execFileFn: exec });
    const ctx = makeCtx({ target: makeTarget({ id: 'node-42', kind: 'swarm-node' }) });

    const result = await backend.deploy(ctx);

    const [, args] = exec.mock.calls[0] as unknown as [string, string[]];
    expect(args).toContain('deploy');
    expect(args).toContain('apply');
    expect(args).toContain('my-api');
    expect(args).toContain('--target');
    expect(args).toContain('node-42');

    expect(result.success).toBe(true);
    expect(result.message).toContain('deployment started');
  });

  it('includes --tag when builtTag is in ctx.meta', async () => {
    const exec = mockExec();
    const backend = makeBackend({ execFileFn: exec });
    const ctx = makeCtx({ meta: { builtTag: 'my-api:sha-deadbeef' } });

    await backend.deploy(ctx);

    const [, args] = exec.mock.calls[0] as unknown as [string, string[]];
    expect(args).toContain('--tag');
    expect(args).toContain('my-api:sha-deadbeef');
  });

  it('returns success=false when exec fails', async () => {
    const exec = mockExecFail('container failed to start: port in use');
    const backend = makeBackend({ execFileFn: exec });

    const result = await backend.deploy(makeCtx());

    expect(result.success).toBe(false);
    expect(result.message).toContain('port in use');
  });
});

// ---------------------------------------------------------------------------
// 6. verifyHealth() — maps healthy/unhealthy
// ---------------------------------------------------------------------------

describe('verifyHealth()', () => {
  it('calls CLI with: deploy health <service> --target <id>', async () => {
    const exec = mockExec('service healthy');
    const backend = makeBackend({ execFileFn: exec });
    const ctx = makeCtx({ target: makeTarget({ id: 'node-42' }) });

    const result = await backend.verifyHealth(ctx);

    const [, args] = exec.mock.calls[0] as unknown as [string, string[]];
    expect(args).toContain('deploy');
    expect(args).toContain('health');
    expect(args).toContain('my-api');
    expect(args).toContain('--target');
    expect(args).toContain('node-42');

    expect(result.healthy).toBe(true);
    expect(result.checks[0].passed).toBe(true);
  });

  it('returns healthy=false when exec fails', async () => {
    const exec = mockExecFail('health endpoint returned 503');
    const backend = makeBackend({ execFileFn: exec });

    const result = await backend.verifyHealth(makeCtx());

    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('503');
    expect(result.checks[0].passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. rollback() — maps success/failure
// ---------------------------------------------------------------------------

describe('rollback()', () => {
  it('calls CLI with: deploy rollback <service> --target <id>', async () => {
    const exec = mockExec('rolled back to v1.0.0');
    const backend = makeBackend({ execFileFn: exec });
    const ctx = makeCtx({ target: makeTarget({ id: 'node-42' }) });

    const result = await backend.rollback(ctx);

    const [, args] = exec.mock.calls[0] as unknown as [string, string[]];
    expect(args).toContain('deploy');
    expect(args).toContain('rollback');
    expect(args).toContain('my-api');
    expect(args).toContain('--target');
    expect(args).toContain('node-42');

    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.restoredVersion).toContain('v1.0.0');
  });

  it('returns success=false when exec fails', async () => {
    const exec = mockExecFail('rollback failed: no previous version');
    const backend = makeBackend({ execFileFn: exec });

    const result = await backend.rollback(makeCtx());

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('no previous version');
  });

  it('accepts a deployResult argument (informational, does not affect rollback call)', async () => {
    const exec = mockExec();
    const backend = makeBackend({ execFileFn: exec });
    const failedDeploy: DeployResult = { success: false, message: 'failed', details: {} };

    const result = await backend.rollback(makeCtx(), failedDeploy);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. VAULT_TOKEN forwarding
// ---------------------------------------------------------------------------

describe('VAULT_TOKEN', () => {
  it('forwards VAULT_TOKEN from env to the child process', async () => {
    const exec = mockExec();
    const backend = makeBackend({
      execFileFn: exec,
      env: { VAULT_TOKEN: 'secret-vault-token', PATH: '/usr/bin' },
    });

    await backend.deploy(makeCtx());

    const [, , options] = exec.mock.calls[0] as unknown as [string, string[], { env?: NodeJS.ProcessEnv }];
    expect(options?.env?.['VAULT_TOKEN']).toBe('secret-vault-token');
  });

  it('does not set VAULT_TOKEN when not in env', async () => {
    const exec = mockExec();
    const backend = makeBackend({
      execFileFn: exec,
      env: { PATH: '/usr/bin' }, // no VAULT_TOKEN
    });

    await backend.build(makeCtx());

    const [, , options] = exec.mock.calls[0] as unknown as [string, string[], { env?: NodeJS.ProcessEnv }];
    // VAULT_TOKEN should not be injected if absent.
    expect(options?.env?.['VAULT_TOKEN']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 9. resolveCliPath()
// ---------------------------------------------------------------------------

describe('resolveCliPath()', () => {
  it('returns default path when HOMELAB_PLUGIN_PATH is not set', () => {
    const path = resolveCliPath({});
    expect(path).toBe(DEFAULT_HOMELAB_CLI_PATH);
  });

  it('returns HOMELAB_PLUGIN_PATH when set', () => {
    const path = resolveCliPath({ HOMELAB_PLUGIN_PATH: '/custom/homelab/cli.js' });
    expect(path).toBe('/custom/homelab/cli.js');
  });
});

// ---------------------------------------------------------------------------
// 10. Auto-registration in the pipeline backend registry
// ---------------------------------------------------------------------------

describe('auto-registration', () => {
  afterEach(() => {
    // Restore the singleton after registry reset.
    resetPipelineBackendRegistry();
    // Re-import would re-register, but here we just use the exported singleton.
    const { registerPipelineBackend } = require('../../../intake/deploy/backend-types');
    registerPipelineBackend(homelabSubprocessBackend);
  });

  it('homelabSubprocessBackend is findable in the registry for homelab kinds', () => {
    const found = findPipelineBackend(makeTarget({ kind: 'swarm-node' }));
    expect(found).toBeDefined();
    expect(found?.id).toBe('homelab-subprocess');
  });

  it('homelabSubprocessBackend is NOT returned for non-homelab kinds', () => {
    const found = findPipelineBackend(makeTarget({ kind: 'cloud-run-service' }));
    // May be undefined (no other backends registered) or a non-homelab backend.
    if (found) {
      expect(found.id).not.toBe('homelab-subprocess');
    }
  });
});

// ---------------------------------------------------------------------------
// Argument builder unit tests (no subprocess)
// ---------------------------------------------------------------------------

describe('argument builders', () => {
  const backend = makeBackend();

  it('buildBuildArgs: minimal', () => {
    const args = backend.buildBuildArgs(makeCtx({ artifact: { name: 'svc', meta: {} } }));
    expect(args).toEqual(['deploy', 'build', 'my-api']);
  });

  it('buildBuildArgs: with tag and sourceDir', () => {
    const args = backend.buildBuildArgs(
      makeCtx({ artifact: { name: 'svc', tag: 'v1', sourceDir: '/src', meta: {} } }),
    );
    expect(args).toEqual(['deploy', 'build', 'my-api', '--tag', 'v1', '--source-dir', '/src']);
  });

  it('buildPushArgs: uses builtTag from meta', () => {
    const args = backend.buildPushArgs(makeCtx({ meta: { builtTag: 'svc:sha-abc' } }));
    expect(args).toContain('--tag');
    expect(args).toContain('svc:sha-abc');
  });

  it('buildDeployArgs: includes --target <id>', () => {
    const args = backend.buildDeployArgs(
      makeCtx({ target: makeTarget({ id: 'gpu-node-7', kind: 'swarm-node' }) }),
    );
    expect(args).toContain('--target');
    expect(args).toContain('gpu-node-7');
  });

  it('buildHealthArgs: includes --target <id>', () => {
    const args = backend.buildHealthArgs(
      makeCtx({ target: makeTarget({ id: 'gpu-node-7' }) }),
    );
    expect(args).toEqual(['deploy', 'health', 'my-api', '--target', 'gpu-node-7']);
  });

  it('buildRollbackArgs: includes --target <id>', () => {
    const args = backend.buildRollbackArgs(
      makeCtx({ target: makeTarget({ id: 'gpu-node-7' }) }),
    );
    expect(args).toEqual(['deploy', 'rollback', 'my-api', '--target', 'gpu-node-7']);
  });
});
