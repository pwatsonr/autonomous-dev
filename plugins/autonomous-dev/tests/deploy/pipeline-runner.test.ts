/**
 * Tests for the target-aware staged deploy pipeline runner (issue #662).
 *
 * Coverage:
 *   1. Stage ordering — pipeline runs stages in the correct order
 *   2. Dry-run — emits planned events; no backend methods called
 *   3. Policy deny — blocks pipeline before any backend stage
 *   4. Policy approval-required — blocks with approval-required status
 *   5. Successful full run — build → push → deploy → health-verify
 *   6. Push skipped when not required
 *   7. Push executed when target has 'registry-push' capability
 *   8. Deploy failure → auto-rollback triggered
 *   9. Health-verify failure → auto-rollback triggered
 *  10. Rollback skipped when backend has no rollback()
 *  11. No-backend → fails with 'no-backend' status
 *  12. Stage events emitted correctly
 *  13. Registry dispatch by target kind (not by id)
 *  14. Build failure stops pipeline, no deploy
 *
 * @module tests/deploy/pipeline-runner.test
 */

import {
  runPipeline,
  type PipelineRunOptions,
  type StageEvent,
  type StageName,
  type StageStatus,
} from '../../intake/deploy/pipeline-runner';
import {
  resetPipelineBackendRegistry,
  registerPipelineBackend,
  type PipelineBackend,
  type PipelineContext,
  type DeployResult,
  type HealthResult,
  type RollbackResult,
} from '../../intake/deploy/backend-types';
import { EMPTY_POLICY } from '../../intake/deploy/policy-types';
import type { PolicyDocument } from '../../intake/deploy/policy-types';
import type { DeployTarget } from '../../intake/deploy/target-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(overrides: Partial<DeployTarget> = {}): DeployTarget {
  return {
    id: 'test-target',
    name: 'Test Target',
    kind: 'swarm-node',
    provider: 'test-provider',
    capabilities: [],
    tags: {},
    source: 'config',
    ...overrides,
  };
}

/** Minimal always-succeeding mock backend. */
function makeMockBackend(
  id: string,
  overrides: Partial<PipelineBackend> = {},
): PipelineBackend {
  return {
    id,
    supports: (_t) => true,
    build: jest.fn().mockResolvedValue(undefined),
    push: jest.fn().mockResolvedValue(undefined),
    deploy: jest.fn().mockResolvedValue({
      success: true,
      message: 'deploy ok',
      details: {},
    } satisfies DeployResult),
    verifyHealth: jest.fn().mockResolvedValue({
      healthy: true,
      checks: [{ name: 'mock-check', passed: true }],
    } satisfies HealthResult),
    rollback: jest.fn().mockResolvedValue({
      success: true,
      errors: [],
    } satisfies RollbackResult),
    ...overrides,
  };
}

function baseOpts(
  overrides: Partial<PipelineRunOptions> = {},
): PipelineRunOptions {
  return {
    target: makeTarget(),
    service: 'my-service',
    artifact: { name: 'my-service', meta: {} },
    policy: EMPTY_POLICY,
    ...overrides,
  };
}

beforeEach(() => {
  resetPipelineBackendRegistry();
});

afterEach(() => {
  resetPipelineBackendRegistry();
});

// ---------------------------------------------------------------------------
// 1. Stage ordering
// ---------------------------------------------------------------------------

describe('stage ordering', () => {
  it('runs stages in order: policy-check → build → push → deploy → health-verify', async () => {
    const callOrder: string[] = [];
    const backend = makeMockBackend('ordered', {
      requiresPush: true,
      build: jest.fn().mockImplementation(async () => { callOrder.push('build'); }),
      push: jest.fn().mockImplementation(async () => { callOrder.push('push'); }),
      deploy: jest.fn().mockImplementation(async () => { callOrder.push('deploy'); return { success: true, details: {} }; }),
      verifyHealth: jest.fn().mockImplementation(async () => { callOrder.push('health-verify'); return { healthy: true, checks: [] }; }),
    });

    const result = await runPipeline(baseOpts({ _backendOverride: backend }));

    expect(result.status).toBe('success');
    expect(callOrder).toEqual(['build', 'push', 'deploy', 'health-verify']);
  });

  it('records stages in the result in order', async () => {
    const backend = makeMockBackend('order-record', { requiresPush: true });
    const result = await runPipeline(baseOpts({ _backendOverride: backend }));

    const stageNames = result.stages.map((s) => s.stage);
    expect(stageNames).toContain('policy-check');
    expect(stageNames).toContain('build');
    expect(stageNames).toContain('push');
    expect(stageNames).toContain('deploy');
    expect(stageNames).toContain('health-verify');

    // policy-check must come first
    expect(stageNames.indexOf('policy-check')).toBeLessThan(stageNames.indexOf('build'));
    expect(stageNames.indexOf('build')).toBeLessThan(stageNames.indexOf('push'));
    expect(stageNames.indexOf('push')).toBeLessThan(stageNames.indexOf('deploy'));
    expect(stageNames.indexOf('deploy')).toBeLessThan(stageNames.indexOf('health-verify'));
  });
});

// ---------------------------------------------------------------------------
// 2. Dry-run
// ---------------------------------------------------------------------------

describe('dry-run', () => {
  it('returns dry-run status without calling any backend method', async () => {
    const backend = makeMockBackend('dry-run-backend');
    const result = await runPipeline(baseOpts({ dryRun: true, _backendOverride: backend }));

    expect(result.status).toBe('dry-run');
    expect(backend.build).not.toHaveBeenCalled();
    expect(backend.push).not.toHaveBeenCalled();
    expect(backend.deploy).not.toHaveBeenCalled();
    expect(backend.verifyHealth).not.toHaveBeenCalled();
    expect(backend.rollback).not.toHaveBeenCalled();
  });

  it('emits planned stage events for all stages', async () => {
    const events: StageEvent[] = [];
    const backend = makeMockBackend('dry-run-events');

    await runPipeline(
      baseOpts({
        dryRun: true,
        _backendOverride: backend,
        onStageEvent: (e) => events.push(e),
      }),
    );

    const plannedStages = events.filter((e) => e.status === 'planned').map((e) => e.stage);
    expect(plannedStages).toContain('build');
    expect(plannedStages).toContain('deploy');
    expect(plannedStages).toContain('health-verify');
  });

  it('dry-run still evaluates policy', async () => {
    const denyPolicy: PolicyDocument = {
      version: '1.0',
      rules: [
        {
          id: 'deny-all',
          type: 'placement',
          effect: 'deny',
          params: { forbid: { kind: 'swarm-node' } },
        },
      ],
    };
    // Dry-run still evaluates policy but does NOT block — it returns the
    // policy decision in the result for the operator to inspect.
    const result = await runPipeline(
      baseOpts({ dryRun: true, policy: denyPolicy }),
    );
    // Dry-run always returns dry-run status (policy is shown, not enforced as a block).
    expect(result.status).toBe('dry-run');
    // Policy is evaluated and reflected.
    expect(result.policyDecision.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Policy deny
// ---------------------------------------------------------------------------

describe('policy deny', () => {
  it('blocks the pipeline with status "denied" before any build', async () => {
    const backend = makeMockBackend('policy-deny');
    const denyPolicy: PolicyDocument = {
      version: '1.0',
      rules: [
        {
          id: 'deny-all',
          type: 'placement',
          effect: 'deny',
          params: { forbid: { kind: 'swarm-node' } },
        },
      ],
    };

    const result = await runPipeline(
      baseOpts({ policy: denyPolicy, _backendOverride: backend }),
    );

    expect(result.status).toBe('denied');
    expect(result.policyDecision.allowed).toBe(false);
    expect(backend.build).not.toHaveBeenCalled();
    expect(backend.deploy).not.toHaveBeenCalled();
  });

  it('records the policy-check stage as failed on deny', async () => {
    const denyPolicy: PolicyDocument = {
      version: '1.0',
      rules: [
        {
          id: 'deny-all',
          type: 'placement',
          effect: 'deny',
          params: { forbid: { kind: 'swarm-node' } },
        },
      ],
    };

    const result = await runPipeline(baseOpts({ policy: denyPolicy }));

    const policyStage = result.stages.find((s) => s.stage === 'policy-check');
    expect(policyStage).toBeDefined();
    expect(policyStage?.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// 4. Policy approval-required
// ---------------------------------------------------------------------------

describe('policy approval-required', () => {
  it('blocks with approval-required status', async () => {
    const backend = makeMockBackend('approval-backend');
    // Use forbid so the rule fires (target IS swarm-node, so it matches the
    // forbidden selector). The require-approval effect then accumulates ops-team.
    const approvalPolicy: PolicyDocument = {
      version: '1.0',
      rules: [
        {
          id: 'require-approval',
          type: 'placement',
          effect: 'require-approval',
          params: {
            forbid: { kind: 'swarm-node' },
            approvers: ['ops-team'],
          },
        },
      ],
    };

    const result = await runPipeline(
      baseOpts({ policy: approvalPolicy, _backendOverride: backend }),
    );

    expect(result.status).toBe('approval-required');
    expect(result.policyDecision.requiredApprovals).toContain('ops-team');
    expect(backend.build).not.toHaveBeenCalled();
    expect(backend.deploy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Successful full run
// ---------------------------------------------------------------------------

describe('successful full run', () => {
  it('returns success with all stages recorded', async () => {
    const backend = makeMockBackend('success-backend', { requiresPush: true });
    const result = await runPipeline(baseOpts({ _backendOverride: backend }));

    expect(result.status).toBe('success');
    expect(result.deployResult?.success).toBe(true);
    expect(result.healthResult?.healthy).toBe(true);
    expect(result.rollbackResult).toBeUndefined();

    const successStages = result.stages.filter((s) => s.status === 'success').map((s) => s.stage);
    expect(successStages).toContain('policy-check');
    expect(successStages).toContain('build');
    expect(successStages).toContain('deploy');
    expect(successStages).toContain('health-verify');
  });

  it('passes the correct context to each stage', async () => {
    const capturedCtx: PipelineContext[] = [];
    const backend = makeMockBackend('ctx-backend', {
      build: jest.fn().mockImplementation(async (ctx: PipelineContext) => { capturedCtx.push(ctx); }),
      deploy: jest.fn().mockImplementation(async (ctx: PipelineContext) => { capturedCtx.push(ctx); return { success: true, details: {} }; }),
    });

    await runPipeline(
      baseOpts({
        service: 'api-service',
        target: makeTarget({ id: 'prod-node', kind: 'swarm-node' }),
        _backendOverride: backend,
      }),
    );

    expect(capturedCtx.length).toBeGreaterThan(0);
    for (const ctx of capturedCtx) {
      expect(ctx.service).toBe('api-service');
      expect(ctx.target.id).toBe('prod-node');
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Push skipped when not required
// ---------------------------------------------------------------------------

describe('push stage', () => {
  it('skips push when target has no registry-push capability and backend does not requiresPush', async () => {
    const backend = makeMockBackend('no-push-backend', { requiresPush: false });
    const target = makeTarget({ capabilities: [] });

    const result = await runPipeline(baseOpts({ _backendOverride: backend, target }));

    expect(result.status).toBe('success');
    expect(backend.push).not.toHaveBeenCalled();

    const pushStage = result.stages.find((s) => s.stage === 'push');
    expect(pushStage?.status).toBe('skipped');
  });

  it('executes push when target has registry-push capability', async () => {
    const backend = makeMockBackend('push-cap-backend', { requiresPush: false });
    const target = makeTarget({ capabilities: ['registry-push'] });

    const result = await runPipeline(baseOpts({ _backendOverride: backend, target }));

    expect(result.status).toBe('success');
    expect(backend.push).toHaveBeenCalledTimes(1);

    const pushStage = result.stages.find((s) => s.stage === 'push');
    expect(pushStage?.status).toBe('success');
  });

  it('executes push when backend requiresPush is true', async () => {
    const backend = makeMockBackend('requires-push-backend', { requiresPush: true });
    const target = makeTarget({ capabilities: [] });

    const result = await runPipeline(baseOpts({ _backendOverride: backend, target }));

    expect(result.status).toBe('success');
    expect(backend.push).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Deploy failure → auto-rollback
// ---------------------------------------------------------------------------

describe('deploy failure triggers rollback', () => {
  it('triggers rollback when deploy returns success=false', async () => {
    const backend = makeMockBackend('deploy-fail-backend', {
      deploy: jest.fn().mockResolvedValue({
        success: false,
        message: 'deploy exploded',
        details: {},
      } satisfies DeployResult),
    });

    const result = await runPipeline(baseOpts({ _backendOverride: backend }));

    expect(result.status).toBe('deploy-failed');
    expect(backend.rollback).toHaveBeenCalledTimes(1);
    expect(result.rollbackResult?.success).toBe(true);

    const rollbackStage = result.stages.find((s) => s.stage === 'rollback');
    expect(rollbackStage?.status).toBe('success');
  });

  it('triggers rollback when deploy throws', async () => {
    const backend = makeMockBackend('deploy-throw-backend', {
      deploy: jest.fn().mockRejectedValue(new Error('deploy threw')),
    });

    const result = await runPipeline(baseOpts({ _backendOverride: backend }));

    expect(result.status).toBe('deploy-failed');
    expect(backend.rollback).toHaveBeenCalledTimes(1);
  });

  it('records rollback result when rollback fails', async () => {
    const backend = makeMockBackend('rollback-fail-backend', {
      deploy: jest.fn().mockResolvedValue({ success: false, message: 'fail', details: {} } satisfies DeployResult),
      rollback: jest.fn().mockResolvedValue({ success: false, errors: ['rollback exploded'] } satisfies RollbackResult),
    });

    const result = await runPipeline(baseOpts({ _backendOverride: backend }));

    expect(result.status).toBe('deploy-failed');
    expect(result.rollbackResult?.success).toBe(false);
    expect(result.rollbackResult?.errors).toContain('rollback exploded');
  });
});

// ---------------------------------------------------------------------------
// 8. Health-verify failure → auto-rollback
// ---------------------------------------------------------------------------

describe('health-verify failure triggers rollback', () => {
  it('triggers rollback when verifyHealth returns healthy=false', async () => {
    const backend = makeMockBackend('health-fail-backend', {
      verifyHealth: jest.fn().mockResolvedValue({
        healthy: false,
        reason: 'service not responding',
        checks: [{ name: 'http', passed: false }],
      } satisfies HealthResult),
    });

    const result = await runPipeline(baseOpts({ _backendOverride: backend }));

    expect(result.status).toBe('health-failed');
    expect(backend.rollback).toHaveBeenCalledTimes(1);
    expect(result.rollbackResult?.success).toBe(true);

    const rollbackStage = result.stages.find((s) => s.stage === 'rollback');
    expect(rollbackStage?.status).toBe('success');
  });

  it('triggers rollback when verifyHealth throws', async () => {
    const backend = makeMockBackend('health-throw-backend', {
      verifyHealth: jest.fn().mockRejectedValue(new Error('health check threw')),
    });

    const result = await runPipeline(baseOpts({ _backendOverride: backend }));

    expect(result.status).toBe('health-failed');
    expect(backend.rollback).toHaveBeenCalledTimes(1);
  });

  it('records health result with checks in the final result', async () => {
    const backend = makeMockBackend('health-checks-backend', {
      verifyHealth: jest.fn().mockResolvedValue({
        healthy: false,
        reason: 'probe failed',
        checks: [
          { name: 'http', passed: false, message: '503' },
          { name: 'container', passed: true },
        ],
      } satisfies HealthResult),
    });

    const result = await runPipeline(baseOpts({ _backendOverride: backend }));

    expect(result.healthResult?.healthy).toBe(false);
    expect(result.healthResult?.checks).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 9. Rollback skipped when backend has no rollback()
// ---------------------------------------------------------------------------

describe('rollback skipped', () => {
  it('records rollback as skipped when backend has no rollback()', async () => {
    const { rollback: _r, ...withoutRollback } = makeMockBackend('no-rollback-backend');
    const backend: PipelineBackend = {
      ...withoutRollback,
      deploy: jest.fn().mockResolvedValue({ success: false, message: 'fail', details: {} } satisfies DeployResult),
    };

    const result = await runPipeline(baseOpts({ _backendOverride: backend }));

    const rollbackStage = result.stages.find((s) => s.stage === 'rollback');
    expect(rollbackStage?.status).toBe('skipped');
  });
});

// ---------------------------------------------------------------------------
// 10. No-backend → 'no-backend' status
// ---------------------------------------------------------------------------

describe('no backend registered', () => {
  it('returns no-backend status when no backend supports the target', async () => {
    // Registry is empty (reset in beforeEach). No _backendOverride.
    const result = await runPipeline({
      target: makeTarget({ kind: 'unknown-kind' }),
      service: 'svc',
      artifact: { name: 'svc', meta: {} },
    });

    expect(result.status).toBe('no-backend');
  });
});

// ---------------------------------------------------------------------------
// 11. Stage events emitted correctly
// ---------------------------------------------------------------------------

describe('stage events', () => {
  it('emits running then completion events for each stage', async () => {
    const events: StageEvent[] = [];
    const backend = makeMockBackend('events-backend', { requiresPush: true });

    await runPipeline(
      baseOpts({
        _backendOverride: backend,
        onStageEvent: (e) => events.push(e),
      }),
    );

    // Each completed stage should have a running event + completion event.
    const stageNames: StageName[] = ['policy-check', 'build', 'push', 'deploy', 'health-verify'];
    for (const name of stageNames) {
      const runningEvt = events.find((e) => e.stage === name && e.status === 'running');
      const completedEvt = events.find(
        (e) =>
          e.stage === name &&
          (e.status === 'success' || e.status === 'skipped' || e.status === 'failed'),
      );
      expect(runningEvt).toBeDefined();
      expect(completedEvt).toBeDefined();
    }
  });

  it('completion events carry durationMs', async () => {
    const events: StageEvent[] = [];
    const backend = makeMockBackend('duration-backend');

    await runPipeline(
      baseOpts({
        _backendOverride: backend,
        onStageEvent: (e) => events.push(e),
      }),
    );

    const completed = events.filter(
      (e) => e.status === 'success' || e.status === 'skipped',
    );
    for (const evt of completed) {
      expect(typeof evt.durationMs).toBe('number');
      expect(evt.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('does not throw when event listener throws', async () => {
    const backend = makeMockBackend('bad-listener-backend');
    const throwingListener = () => { throw new Error('listener error'); };

    await expect(
      runPipeline(baseOpts({ _backendOverride: backend, onStageEvent: throwingListener })),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 12. Registry dispatch by kind (not by id)
// ---------------------------------------------------------------------------

describe('registry dispatch by target kind', () => {
  it('dispatches to the correct backend based on target.kind', async () => {
    const swarmBackend = makeMockBackend('swarm-backend', {
      supports: (t) => t.kind === 'swarm-node',
    });
    const k8sBackend = makeMockBackend('k8s-backend', {
      supports: (t) => t.kind === 'k3s-cluster',
    });

    registerPipelineBackend(swarmBackend);
    registerPipelineBackend(k8sBackend);

    // Deploy to a swarm target.
    const swarmResult = await runPipeline({
      ...baseOpts(),
      target: makeTarget({ id: 'swarm-1', kind: 'swarm-node' }),
    });
    expect(swarmResult.status).toBe('success');
    expect(swarmBackend.deploy).toHaveBeenCalledTimes(1);
    expect(k8sBackend.deploy).not.toHaveBeenCalled();

    // Reset mocks.
    jest.clearAllMocks();

    // Deploy to a k3s target.
    const k8sResult = await runPipeline({
      ...baseOpts(),
      target: makeTarget({ id: 'k8s-1', kind: 'k3s-cluster' }),
    });
    expect(k8sResult.status).toBe('success');
    expect(k8sBackend.deploy).toHaveBeenCalledTimes(1);
    expect(swarmBackend.deploy).not.toHaveBeenCalled();
  });

  it('first registered backend wins when multiple support the same kind', async () => {
    const firstBackend = makeMockBackend('first', { supports: () => true });
    const secondBackend = makeMockBackend('second', { supports: () => true });

    registerPipelineBackend(firstBackend);
    registerPipelineBackend(secondBackend);

    await runPipeline(baseOpts());

    expect(firstBackend.deploy).toHaveBeenCalledTimes(1);
    expect(secondBackend.deploy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 13. Build failure stops pipeline
// ---------------------------------------------------------------------------

describe('build failure', () => {
  it('returns build-failed status without calling deploy', async () => {
    const backend = makeMockBackend('build-fail-backend', {
      build: jest.fn().mockRejectedValue(new Error('docker build failed')),
    });

    const result = await runPipeline(baseOpts({ _backendOverride: backend }));

    expect(result.status).toBe('build-failed');
    expect(backend.deploy).not.toHaveBeenCalled();
    expect(backend.rollback).not.toHaveBeenCalled();

    const buildStage = result.stages.find((s) => s.stage === 'build');
    expect(buildStage?.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// 14. Run ID and timing metadata
// ---------------------------------------------------------------------------

describe('run metadata', () => {
  it('returns a runId that looks like a ULID', async () => {
    const backend = makeMockBackend('meta-backend');
    const result = await runPipeline(baseOpts({ _backendOverride: backend }));
    expect(result.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('returns startedAt as an ISO-8601 timestamp', async () => {
    const backend = makeMockBackend('meta-ts-backend');
    const result = await runPipeline(baseOpts({ _backendOverride: backend }));
    expect(() => new Date(result.startedAt)).not.toThrow();
    expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns totalDurationMs >= 0', async () => {
    const backend = makeMockBackend('meta-dur-backend');
    const result = await runPipeline(baseOpts({ _backendOverride: backend }));
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});
