/**
 * Tests for `intake/cli/deploy_reconcile_command.ts` (issue #664).
 *
 * Coverage:
 *   1. CLI registered under `deploy reconcile` (commander registration proof)
 *   2. renderReconcilePlan shows correct counts and action groups
 *   3. renderApplyResults shows success/failure summaries
 *   4. runDeployReconcile — dry-run (default):
 *      a. exits 0 when plan is empty (no drift)
 *      b. exits 1 when plan has mutating actions (drift detected)
 *      c. no backend calls in dry-run
 *   5. runDeployReconcile — apply mode:
 *      a. applies mutating actions via pipeline runner
 *      b. exits 0 when all actions succeed
 *      c. exits 2 when any action fails
 *      d. skips 'none' actions
 *   6. JSON output: emits valid JSON with summary and actions
 *   7. dry-run emits no pipeline applies
 *
 * @module tests/deploy/deploy-reconcile-command.test
 */

import { Command } from 'commander';
import {
  registerDeployReconcileCommand,
  runDeployReconcile,
  renderReconcilePlan,
  renderApplyResults,
} from '../../intake/cli/deploy_reconcile_command';
import {
  InMemoryDeployTargetRegistry,
  resetDeployTargetRegistry,
} from '../../intake/deploy/target-registry';
import { resetPipelineBackendRegistry } from '../../intake/deploy/backend-types';
import type { PipelineBackend, DeployResult, HealthResult } from '../../intake/deploy/backend-types';
import type { DeployTarget } from '../../intake/deploy/target-types';
import type { DesiredState, ObservedState, ReconcileAction, ApplyReconcileActionResult } from '../../intake/deploy/reconcile';

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

function makeMockBackend(
  id: string,
  overrides: Partial<PipelineBackend> = {},
): PipelineBackend {
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
      stdout: { write: (s: string) => { stdout.push(s); return true; } } as unknown as NodeJS.WritableStream,
      stderr: { write: (s: string) => { stderr.push(s); return true; } } as unknown as NodeJS.WritableStream,
    },
  };
}

const TARGET_A = makeTarget('target-a');
const TARGET_B = makeTarget('target-b');

beforeEach(() => {
  resetPipelineBackendRegistry();
  resetDeployTargetRegistry();
});

afterEach(() => {
  resetPipelineBackendRegistry();
  resetDeployTargetRegistry();
});

// ---------------------------------------------------------------------------
// 1. CLI registration proof
// ---------------------------------------------------------------------------

describe('CLI registration', () => {
  it('registerDeployReconcileCommand registers deploy reconcile under the deploy group', () => {
    const program = new Command().exitOverride();
    registerDeployReconcileCommand(program);

    const deployGroup = program.commands.find((c) => c.name() === 'deploy');
    expect(deployGroup).toBeDefined();

    const reconcileCmd = deployGroup?.commands.find((c) => c.name() === 'reconcile');
    expect(reconcileCmd).toBeDefined();
    expect(reconcileCmd?.description()).toContain('desired state');
  });

  it('attaches to existing deploy group without duplicating it', () => {
    const program = new Command().exitOverride();
    program.command('deploy').description('Deployment operations').exitOverride();

    registerDeployReconcileCommand(program);

    const deployGroups = program.commands.filter((c) => c.name() === 'deploy');
    expect(deployGroups).toHaveLength(1);

    const reconcileCmd = deployGroups[0].commands.find((c) => c.name() === 'reconcile');
    expect(reconcileCmd).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. renderReconcilePlan
// ---------------------------------------------------------------------------

describe('renderReconcilePlan', () => {
  const mixed: ReconcileAction[] = [
    {
      kind: 'deploy',
      targetId: 'target-a',
      service: 'new-svc',
      desiredArtifactRef: 'new-svc:1.0',
      reason: 'Not deployed',
    },
    {
      kind: 'update',
      targetId: 'target-a',
      service: 'api',
      desiredArtifactRef: 'api:2.0',
      observedArtifactRef: 'api:1.0',
      reason: 'Artifact changed',
    },
    {
      kind: 'remove',
      targetId: 'target-b',
      service: 'old-svc',
      observedArtifactRef: 'old-svc:1.0',
      reason: 'Not in desired',
    },
    {
      kind: 'none',
      targetId: 'target-b',
      service: 'cache',
      desiredArtifactRef: 'cache:3.0',
      observedArtifactRef: 'cache:3.0',
      reason: 'In sync',
    },
  ];

  it('shows counts for each action kind in dry-run', () => {
    const output = renderReconcilePlan(mixed, true);
    expect(output).toContain('dry-run');
    expect(output).toContain('1 deploy');
    expect(output).toContain('1 update');
    expect(output).toContain('1 remove');
    expect(output).toContain('1 service(s) already in desired state');
  });

  it('shows DEPLOY, UPDATE, REMOVE, NO-OP sections', () => {
    const output = renderReconcilePlan(mixed, true);
    expect(output).toContain('[DEPLOY]');
    expect(output).toContain('[UPDATE]');
    expect(output).toContain('[REMOVE]');
    expect(output).toContain('[NO-OP]');
  });

  it('shows the reason for each action', () => {
    const output = renderReconcilePlan(mixed, false);
    expect(output).toContain('Not deployed');
    expect(output).toContain('Artifact changed');
    expect(output).toContain('Not in desired');
  });

  it('empty plan shows 0 actions required', () => {
    const output = renderReconcilePlan([], true);
    expect(output).toContain('0 action(s) required');
  });
});

// ---------------------------------------------------------------------------
// 3. renderApplyResults
// ---------------------------------------------------------------------------

describe('renderApplyResults', () => {
  it('shows success and failure counts', () => {
    const results: Array<ApplyReconcileActionResult & { error?: Error }> = [
      {
        action: {
          kind: 'deploy',
          targetId: 'target-a',
          service: 'api',
          desiredArtifactRef: 'api:1.0',
          reason: 'Not deployed',
        },
        pipelineResult: {
          runId: 'run1',
          status: 'success',
          stages: [],
          policyDecision: { allowed: true, requiredApprovals: [], violations: [], matchedRules: [] },
          startedAt: new Date().toISOString(),
          totalDurationMs: 100,
        },
      },
      {
        action: {
          kind: 'update',
          targetId: 'target-a',
          service: 'worker',
          desiredArtifactRef: 'worker:2.0',
          reason: 'Changed',
        },
        pipelineResult: null,
        error: new Error('Target not found'),
      },
    ];

    const output = renderApplyResults(results);
    expect(output).toContain('1 action(s) succeeded');
    expect(output).toContain('1 failed');
  });
});

// ---------------------------------------------------------------------------
// 4. runDeployReconcile — dry-run
// ---------------------------------------------------------------------------

describe('runDeployReconcile — dry-run (default)', () => {
  it('4a. exits 0 when plan is empty (no drift)', async () => {
    const { streams } = makeStreams();

    const code = await runDeployReconcile(
      { desired: [], observed: [] },
      streams,
    );

    expect(code).toBe(0);
  });

  it('4b. exits 1 when plan has mutating actions (drift detected)', async () => {
    const desired: DesiredState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:2.0' },
    ];
    const observed: ObservedState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:1.0' },
    ];

    const { streams, stdout } = makeStreams();

    const code = await runDeployReconcile(
      { desired, observed },
      streams,
    );

    expect(code).toBe(1);
    expect(stdout.join('')).toContain('dry-run');
  });

  it('4c. no backend calls in dry-run', async () => {
    const backend = makeMockBackend('dry-run-no-backend');
    const registry = new InMemoryDeployTargetRegistry();
    registry.register(TARGET_A);

    const desired: DesiredState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:1.0' },
    ];

    const { streams } = makeStreams();

    await runDeployReconcile(
      { desired, observed: [], registry, _backendOverride: backend },
      streams,
    );

    expect(backend.deploy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. runDeployReconcile — apply mode
// ---------------------------------------------------------------------------

describe('runDeployReconcile — apply mode', () => {
  it('5a. applies mutating actions via pipeline runner', async () => {
    const backend = makeMockBackend('apply-actions');
    const registry = new InMemoryDeployTargetRegistry();
    registry.register(TARGET_A);

    const desired: DesiredState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:1.0' },
    ];

    const { streams } = makeStreams();

    const code = await runDeployReconcile(
      {
        desired,
        observed: [],
        apply: true,
        registry,
        _backendOverride: backend,
      },
      streams,
    );

    expect(backend.deploy).toHaveBeenCalled();
    expect(code).toBe(0);
  });

  it('5b. exits 0 when all actions succeed', async () => {
    const backend = makeMockBackend('apply-success');
    const registry = new InMemoryDeployTargetRegistry();
    registry.register(TARGET_A);

    const desired: DesiredState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:2.0' },
    ];
    const observed: ObservedState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:1.0' },
    ];

    const { streams } = makeStreams();

    const code = await runDeployReconcile(
      {
        desired,
        observed,
        apply: true,
        registry,
        _backendOverride: backend,
      },
      streams,
    );

    expect(code).toBe(0);
  });

  it('5c. exits 2 when any action fails', async () => {
    const backend = makeMockBackend('apply-fail', {
      deploy: jest.fn().mockResolvedValue({
        success: false,
        message: 'crashed',
        details: {},
      }),
      rollback: jest.fn().mockResolvedValue({ success: true, errors: [] }),
    });
    const registry = new InMemoryDeployTargetRegistry();
    registry.register(TARGET_A);

    const desired: DesiredState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:1.0' },
    ];

    const { streams } = makeStreams();

    const code = await runDeployReconcile(
      {
        desired,
        observed: [],
        apply: true,
        registry,
        _backendOverride: backend,
      },
      streams,
    );

    expect(code).toBe(2);
  });

  it('5d. skips none actions (in sync services)', async () => {
    const backend = makeMockBackend('apply-skip-none');
    const registry = new InMemoryDeployTargetRegistry();
    registry.register(TARGET_A);

    const desired: DesiredState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:1.0' },
    ];
    const observed: ObservedState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:1.0' },
    ];

    const { streams, stdout } = makeStreams();

    const code = await runDeployReconcile(
      {
        desired,
        observed,
        apply: true,
        registry,
        _backendOverride: backend,
      },
      streams,
    );

    expect(backend.deploy).not.toHaveBeenCalled();
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('No actions required');
  });
});

// ---------------------------------------------------------------------------
// 6. JSON output
// ---------------------------------------------------------------------------

describe('JSON output', () => {
  it('emits valid JSON with mode, summary, and actions array', async () => {
    const desired: DesiredState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:2.0' },
    ];
    const observed: ObservedState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:1.0' },
    ];

    const { streams, stdout } = makeStreams();

    await runDeployReconcile(
      { desired, observed, json: true },
      streams,
    );

    const jsonStr = stdout.join('');
    const parsed = JSON.parse(jsonStr);
    expect(parsed.mode).toBe('dry-run');
    expect(parsed.summary).toBeDefined();
    expect(parsed.summary.update).toBe(1);
    expect(Array.isArray(parsed.actions)).toBe(true);
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0].kind).toBe('update');
  });

  it('exits 1 in JSON mode when there is drift', async () => {
    const desired: DesiredState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:1.0' },
    ];

    const { streams } = makeStreams();

    const code = await runDeployReconcile(
      { desired, observed: [], json: true },
      streams,
    );

    expect(code).toBe(1);
  });

  it('exits 0 in JSON mode when no drift', async () => {
    const { streams } = makeStreams();

    const code = await runDeployReconcile(
      { desired: [], observed: [], json: true },
      streams,
    );

    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Dry-run emits no pipeline applies
// ---------------------------------------------------------------------------

describe('dry-run emits no pipeline applies', () => {
  it('does not call any backend even with a large desired state', async () => {
    const backend = makeMockBackend('large-dry-run');
    const registry = new InMemoryDeployTargetRegistry();
    registry.register(TARGET_A);
    registry.register(TARGET_B);

    const desired: DesiredState[] = Array.from({ length: 10 }, (_, i) => ({
      targetId: 'target-a',
      service: `svc-${i}`,
      artifactRef: `svc-${i}:1.0`,
    }));

    const { streams } = makeStreams();

    // dry-run is default
    await runDeployReconcile(
      { desired, observed: [], registry, _backendOverride: backend },
      streams,
    );

    expect(backend.deploy).not.toHaveBeenCalled();
  });
});
