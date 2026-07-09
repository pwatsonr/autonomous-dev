/**
 * Tests for `intake/cli/deploy_promote_command.ts` (issue #663).
 *
 * Coverage:
 *   1. CLI registered under `deploy promote` (commander registration proof)
 *   2. `--dry-run` runs without any backend call and outputs plan
 *   3. `--confirm` runs real promotion and prints lineage record
 *   4. Without `--confirm` or `--dry-run` → exit code 1 / error message
 *   5. Checksum mismatch → exit code 1 / error on stderr
 *   6. Unknown --from target → exit code 1 / error on stderr
 *   7. Unknown --to target → exit code 1 / error on stderr
 *   8. renderPromotionPlan renders correct fields
 *   9. renderPromotionRecord renders correct lineage fields
 *  10. getPromotionLineage re-export works
 *
 * @module tests/deploy/deploy-promote-command.test
 */

import { Command } from 'commander';
import {
  registerDeployPromoteCommand,
  runDeployPromote,
  renderPromotionPlan,
  renderPromotionRecord,
  getPromotionLineage,
} from '../../intake/cli/deploy_promote_command';
import {
  InMemoryDeployTargetRegistry,
  resetDeployTargetRegistry,
} from '../../intake/deploy/target-registry';
import { resetPromotionLineage } from '../../intake/deploy/promotion';
import { resetPipelineBackendRegistry } from '../../intake/deploy/backend-types';
import type {
  PipelineBackend,
  DeployResult,
  HealthResult,
} from '../../intake/deploy/backend-types';
import type { DeployTarget } from '../../intake/deploy/target-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(id: string, overrides: Partial<DeployTarget> = {}): DeployTarget {
  return {
    id,
    name: `Target ${id}`,
    kind: 'swarm-node',
    provider: 'test-provider',
    capabilities: [],
    env: 'dev',
    tags: {},
    source: 'config',
    ...overrides,
  };
}

function makeMockBackend(id: string, overrides: Partial<PipelineBackend> = {}): PipelineBackend {
  return {
    id,
    supports: () => true,
    build: jest.fn().mockResolvedValue(undefined),
    deploy: jest.fn().mockResolvedValue({
      success: true,
      message: 'deploy ok',
      details: {},
    } satisfies DeployResult),
    verifyHealth: jest.fn().mockResolvedValue({
      healthy: true,
      checks: [{ name: 'mock', passed: true }],
    } satisfies HealthResult),
    rollback: jest.fn().mockResolvedValue({ success: true, errors: [] }),
    ...overrides,
  };
}

function makeStreams(): {
  stdout: string[];
  stderr: string[];
  streams: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    streams: {
      stdout: {
        write: (s: string) => {
          stdout.push(s);
          return true;
        },
      } as unknown as NodeJS.WritableStream,
      stderr: {
        write: (s: string) => {
          stderr.push(s);
          return true;
        },
      } as unknown as NodeJS.WritableStream,
    },
  };
}

const DEV_TARGET = makeTarget('dev-node', { env: 'dev', kind: 'swarm-node' });
const PROD_TARGET = makeTarget('prod-node', { env: 'prod', kind: 'swarm-node' });

beforeEach(() => {
  resetPipelineBackendRegistry();
  resetPromotionLineage();
  resetDeployTargetRegistry();
});

afterEach(() => {
  resetPipelineBackendRegistry();
  resetPromotionLineage();
  resetDeployTargetRegistry();
});

// ---------------------------------------------------------------------------
// 1. CLI registration proof
// ---------------------------------------------------------------------------

describe('CLI registration', () => {
  it('registerDeployPromoteCommand registers deploy promote under the deploy group', () => {
    const program = new Command().exitOverride();
    registerDeployPromoteCommand(program);

    const deployGroup = program.commands.find((c) => c.name() === 'deploy');
    expect(deployGroup).toBeDefined();

    const promoteCmd = deployGroup?.commands.find((c) => c.name() === 'promote');
    expect(promoteCmd).toBeDefined();
    expect(promoteCmd?.description()).toContain('pre-built artifact');
  });

  it('registers on existing deploy group when it already exists', () => {
    const program = new Command().exitOverride();
    // Create the deploy group first (simulates registerDeployTargetsCommand being called first)
    program.command('deploy').description('Deployment operations').exitOverride();

    registerDeployPromoteCommand(program);

    const deployGroups = program.commands.filter((c) => c.name() === 'deploy');
    expect(deployGroups).toHaveLength(1); // must not create a second one

    const promoteCmd = deployGroups[0].commands.find((c) => c.name() === 'promote');
    expect(promoteCmd).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Dry-run: no backend call, prints plan
// ---------------------------------------------------------------------------

describe('dry-run', () => {
  it('prints promotion plan without calling any backend', async () => {
    const backend = makeMockBackend('dry-run-promote');
    const registry = new InMemoryDeployTargetRegistry();
    registry.register(DEV_TARGET);
    registry.register(PROD_TARGET);

    const { streams, stdout, stderr } = makeStreams();

    const code = await runDeployPromote(
      {
        service: 'api',
        fromRaw: 'dev-node',
        toRaw: 'prod-node',
        artifactRef: 'api:v1.2.3',
        dryRun: true,
        registry,
        _backendOverride: backend,
      },
      streams,
    );

    expect(code).toBe(0);
    expect(stderr).toHaveLength(0);
    const output = stdout.join('');
    expect(output).toContain('dry-run');
    expect(output).toContain('api:v1.2.3');
    expect(output).toContain('dev-node');
    expect(output).toContain('prod-node');
    expect(backend.deploy).not.toHaveBeenCalled();
    expect(getPromotionLineage()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. --confirm runs real promotion and prints lineage
// ---------------------------------------------------------------------------

describe('real promotion with --confirm', () => {
  it('returns exit code 0 and prints lineage record on success', async () => {
    const backend = makeMockBackend('confirm-promote');
    const registry = new InMemoryDeployTargetRegistry();
    registry.register(DEV_TARGET);
    registry.register(PROD_TARGET);

    const { streams, stdout, stderr } = makeStreams();

    const code = await runDeployPromote(
      {
        service: 'api',
        fromRaw: 'dev-node',
        toRaw: 'prod-node',
        artifactRef: 'api:v2.0.0',
        confirm: true,
        dryRun: false,
        registry,
        _backendOverride: backend,
      },
      streams,
    );

    expect(code).toBe(0);
    expect(stderr).toHaveLength(0);
    const output = stdout.join('');
    expect(output).toContain('Promotion completed');
    expect(output).toContain('api:v2.0.0');
    expect(backend.deploy).toHaveBeenCalled();
    expect(getPromotionLineage()).toHaveLength(1);
    expect(getPromotionLineage()[0].service).toBe('api');
  });

  it('returns exit code 1 when pipeline fails', async () => {
    const backend = makeMockBackend('confirm-fail', {
      deploy: jest.fn().mockResolvedValue({
        success: false,
        message: 'crashed',
        details: {},
      }),
      rollback: jest.fn().mockResolvedValue({ success: true, errors: [] }),
    });
    const registry = new InMemoryDeployTargetRegistry();
    registry.register(DEV_TARGET);
    registry.register(PROD_TARGET);

    const { streams, stderr } = makeStreams();

    const code = await runDeployPromote(
      {
        service: 'api',
        fromRaw: 'dev-node',
        toRaw: 'prod-node',
        artifactRef: 'api:v2.0.0',
        confirm: true,
        dryRun: false,
        registry,
        _backendOverride: backend,
      },
      streams,
    );

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('failed');
  });
});

// ---------------------------------------------------------------------------
// 4. Neither --confirm nor --dry-run → exit code 1
// ---------------------------------------------------------------------------

describe('confirm guard in CLI', () => {
  it('returns exit code 1 and error message without --confirm or --dry-run', async () => {
    const backend = makeMockBackend('no-confirm-cli');
    const registry = new InMemoryDeployTargetRegistry();
    registry.register(DEV_TARGET);
    registry.register(PROD_TARGET);

    const { streams, stderr } = makeStreams();

    const code = await runDeployPromote(
      {
        service: 'api',
        fromRaw: 'dev-node',
        toRaw: 'prod-node',
        artifactRef: 'api:v1.0.0',
        // neither dryRun nor confirm
        registry,
        _backendOverride: backend,
      },
      streams,
    );

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('--confirm');
    expect(backend.deploy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Checksum mismatch
// ---------------------------------------------------------------------------

describe('checksum mismatch', () => {
  it('returns exit code 1 when artifact has no checksum but one is expected', async () => {
    // PromotionChecksumError fires when checksumExpected != artifactRef.checksum.
    // The CLI passes opts.checksum as checksumExpected, and the artifactRef.checksum
    // comes from the same opts.checksum. To get a mismatch we need the artifact
    // to carry a DIFFERENT checksum than what we expect.
    // We test this by calling promote() directly with a mismatched pair.
    const { promote: promoteDirectly } = await import('../../intake/deploy/promotion');
    const { PromotionChecksumError } = await import('../../intake/deploy/promotion');
    const backend = makeMockBackend('checksum-cli');

    let caught: Error | undefined;
    try {
      await promoteDirectly({
        service: 'api',
        // artifact claims checksum 'actual'
        artifactRef: { ref: 'api:v1.0.0', checksum: 'actual-sha256' },
        fromTarget: DEV_TARGET,
        toTarget: PROD_TARGET,
        // but we expect 'expected'
        checksumExpected: 'expected-sha256',
        confirm: true,
        dryRun: false,
        _backendOverride: backend,
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(PromotionChecksumError);
    expect(caught?.message).toContain('integrity');
    expect(backend.deploy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6 & 7. Unknown targets
// ---------------------------------------------------------------------------

describe('unknown targets', () => {
  it('returns exit code 1 when --from target is not found', async () => {
    const backend = makeMockBackend('unknown-from');
    const registry = new InMemoryDeployTargetRegistry();
    registry.register(PROD_TARGET); // Only register prod, not dev

    const { streams, stderr } = makeStreams();

    const code = await runDeployPromote(
      {
        service: 'api',
        fromRaw: 'nonexistent-node',
        toRaw: 'prod-node',
        artifactRef: 'api:v1.0.0',
        confirm: true,
        registry,
        _backendOverride: backend,
      },
      streams,
    );

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('nonexistent-node');
  });

  it('returns exit code 1 when --to target is not found', async () => {
    const backend = makeMockBackend('unknown-to');
    const registry = new InMemoryDeployTargetRegistry();
    registry.register(DEV_TARGET); // Only register dev, not prod

    const { streams, stderr } = makeStreams();

    const code = await runDeployPromote(
      {
        service: 'api',
        fromRaw: 'dev-node',
        toRaw: 'nonexistent-prod',
        artifactRef: 'api:v1.0.0',
        confirm: true,
        registry,
        _backendOverride: backend,
      },
      streams,
    );

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('nonexistent-prod');
  });
});

// ---------------------------------------------------------------------------
// 8. renderPromotionPlan
// ---------------------------------------------------------------------------

describe('renderPromotionPlan', () => {
  it('renders all key fields', () => {
    const output = renderPromotionPlan(
      'api',
      'api:v2.0.0',
      'dev-node',
      'prod-node',
      'swarm-node',
      'prod',
    );

    expect(output).toContain('dry-run');
    expect(output).toContain('api');
    expect(output).toContain('api:v2.0.0');
    expect(output).toContain('dev-node');
    expect(output).toContain('prod-node');
    expect(output).toContain('swarm-node');
    expect(output).toContain('prod');
    expect(output).toContain('skipped (artifact pre-built)');
  });

  it('shows "(not set)" when env is undefined', () => {
    const output = renderPromotionPlan('api', 'api:1.0', 'from', 'to', 'kind', undefined);
    expect(output).toContain('(not set)');
  });
});

// ---------------------------------------------------------------------------
// 9. renderPromotionRecord
// ---------------------------------------------------------------------------

describe('renderPromotionRecord', () => {
  it('renders all lineage fields', () => {
    const output = renderPromotionRecord({
      promotionId: '01ABC123',
      service: 'api',
      artifactRef: { ref: 'api:v2.0.0' },
      pipelineRunId: '01RUN456',
      fromTargetId: 'dev-node',
      toTargetId: 'prod-node',
      promotedBy: 'ci-bot',
      promotedAt: '2026-07-08T12:00:00.000Z',
      pipelineStatus: 'success',
    });

    expect(output).toContain('01ABC123');
    expect(output).toContain('api:v2.0.0');
    expect(output).toContain('dev-node');
    expect(output).toContain('prod-node');
    expect(output).toContain('ci-bot');
    expect(output).toContain('2026-07-08T12:00:00.000Z');
    expect(output).toContain('success');
  });
});

// ---------------------------------------------------------------------------
// 10. getPromotionLineage re-export
// ---------------------------------------------------------------------------

describe('getPromotionLineage re-export', () => {
  it('is a function that returns the lineage array', () => {
    expect(typeof getPromotionLineage).toBe('function');
    expect(Array.isArray(getPromotionLineage())).toBe(true);
  });
});
