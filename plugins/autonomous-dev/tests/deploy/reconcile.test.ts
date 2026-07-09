/**
 * Tests for `intake/deploy/reconcile.ts` (issue #664).
 *
 * Coverage:
 *   1. computeReconcilePlan — pure diff:
 *      a. desired but not observed → 'deploy'
 *      b. observed but not desired → 'remove'
 *      c. desired and observed, same artifact → 'none'
 *      d. desired and observed, different artifact → 'update'
 *      e. mixed plan: deploy + update + remove + none all in one call
 *      f. empty desired + empty observed → empty plan
 *      g. empty desired + some observed → all 'remove'
 *      h. some desired + empty observed → all 'deploy'
 *      i. result ordering: deploy → update → remove → none
 *      j. purity: same inputs always produce same output
 *   2. applyReconcileAction:
 *      a. 'none' action → returns pipelineResult: null, no backend call
 *      b. 'deploy' action → calls runPipeline (route through runner)
 *      c. 'update' action → calls runPipeline (route through runner)
 *      d. 'remove' action → returns no-backend pipeline result (not implemented)
 *      e. dry-run: no backend call, dry-run pipeline result
 *      f. confirm required: throws ReconcileApplyConfirmRequiredError when neither
 *   3. apply + policy:
 *      a. policy deny blocks action; pipelineResult.status='denied'
 *   4. applyReconcilePlan (batch):
 *      a. skips 'none' actions
 *      b. applies mutating actions and collects results
 *      c. unknown target → error in result
 *
 * @module tests/deploy/reconcile.test
 */

import {
  computeReconcilePlan,
  applyReconcileAction,
  applyReconcilePlan,
  ReconcileApplyConfirmRequiredError,
} from '../../intake/deploy/reconcile';
import type { DesiredState, ObservedState, ReconcileAction } from '../../intake/deploy/reconcile';
import { resetPipelineBackendRegistry } from '../../intake/deploy/backend-types';
import type {
  PipelineBackend,
  DeployResult,
  HealthResult,
} from '../../intake/deploy/backend-types';
import type { DeployTarget } from '../../intake/deploy/target-types';
import type { PolicyDocument } from '../../intake/deploy/policy-types';

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

const TARGET_A = makeTarget('target-a');
const TARGET_B = makeTarget('target-b');

beforeEach(() => {
  resetPipelineBackendRegistry();
});

afterEach(() => {
  resetPipelineBackendRegistry();
});

// ---------------------------------------------------------------------------
// 1. computeReconcilePlan (pure diff)
// ---------------------------------------------------------------------------

describe('computeReconcilePlan — pure diff', () => {
  it('1a. desired but not observed → deploy action', () => {
    const desired: DesiredState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:1.0' },
    ];
    const observed: ObservedState[] = [];

    const plan = computeReconcilePlan(desired, observed);

    expect(plan).toHaveLength(1);
    expect(plan[0].kind).toBe('deploy');
    expect(plan[0].service).toBe('api');
    expect(plan[0].targetId).toBe('target-a');
    expect(plan[0].desiredArtifactRef).toBe('api:1.0');
  });

  it('1b. observed but not desired → remove action', () => {
    const desired: DesiredState[] = [];
    const observed: ObservedState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:1.0' },
    ];

    const plan = computeReconcilePlan(desired, observed);

    expect(plan).toHaveLength(1);
    expect(plan[0].kind).toBe('remove');
    expect(plan[0].service).toBe('api');
    expect(plan[0].observedArtifactRef).toBe('api:1.0');
  });

  it('1c. desired and observed with same artifact → none action', () => {
    const desired: DesiredState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:1.0' },
    ];
    const observed: ObservedState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:1.0' },
    ];

    const plan = computeReconcilePlan(desired, observed);

    expect(plan).toHaveLength(1);
    expect(plan[0].kind).toBe('none');
  });

  it('1d. desired and observed with different artifact → update action', () => {
    const desired: DesiredState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:2.0' },
    ];
    const observed: ObservedState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:1.0' },
    ];

    const plan = computeReconcilePlan(desired, observed);

    expect(plan).toHaveLength(1);
    expect(plan[0].kind).toBe('update');
    expect(plan[0].desiredArtifactRef).toBe('api:2.0');
    expect(plan[0].observedArtifactRef).toBe('api:1.0');
  });

  it('1e. mixed plan: deploy + update + remove + none all in one call', () => {
    const desired: DesiredState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:2.0' }, // update
      { targetId: 'target-a', service: 'worker', artifactRef: 'worker:1.0' }, // deploy (not observed)
      { targetId: 'target-b', service: 'cache', artifactRef: 'cache:3.0' }, // none (matches)
    ];
    const observed: ObservedState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:1.0' }, // update
      { targetId: 'target-b', service: 'cache', artifactRef: 'cache:3.0' }, // none
      { targetId: 'target-b', service: 'old-svc', artifactRef: 'old:1.0' }, // remove
    ];

    const plan = computeReconcilePlan(desired, observed);

    const kinds = plan.map((a) => a.kind);
    expect(kinds).toContain('deploy');
    expect(kinds).toContain('update');
    expect(kinds).toContain('remove');
    expect(kinds).toContain('none');
    expect(plan).toHaveLength(4);
  });

  it('1f. empty desired + empty observed → empty plan', () => {
    const plan = computeReconcilePlan([], []);
    expect(plan).toHaveLength(0);
  });

  it('1g. empty desired + some observed → all remove', () => {
    const observed: ObservedState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:1.0' },
      { targetId: 'target-a', service: 'worker', artifactRef: 'worker:1.0' },
    ];

    const plan = computeReconcilePlan([], observed);

    expect(plan).toHaveLength(2);
    expect(plan.every((a) => a.kind === 'remove')).toBe(true);
  });

  it('1h. some desired + empty observed → all deploy', () => {
    const desired: DesiredState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:1.0' },
      { targetId: 'target-b', service: 'worker', artifactRef: 'worker:2.0' },
    ];

    const plan = computeReconcilePlan(desired, []);

    expect(plan).toHaveLength(2);
    expect(plan.every((a) => a.kind === 'deploy')).toBe(true);
  });

  it('1i. result ordering: deploy → update → remove → none', () => {
    const desired: DesiredState[] = [
      { targetId: 'target-a', service: 'update-me', artifactRef: 'svc:2.0' },
      { targetId: 'target-a', service: 'deploy-me', artifactRef: 'new:1.0' },
      { targetId: 'target-a', service: 'leave-me', artifactRef: 'same:1.0' },
    ];
    const observed: ObservedState[] = [
      { targetId: 'target-a', service: 'update-me', artifactRef: 'svc:1.0' },
      { targetId: 'target-a', service: 'leave-me', artifactRef: 'same:1.0' },
      { targetId: 'target-a', service: 'remove-me', artifactRef: 'old:1.0' },
    ];

    const plan = computeReconcilePlan(desired, observed);
    const kinds = plan.map((a) => a.kind);

    // deploy must come before update, update before remove, remove before none
    const firstDeploy = kinds.indexOf('deploy');
    const firstUpdate = kinds.indexOf('update');
    const firstRemove = kinds.indexOf('remove');
    const firstNone = kinds.indexOf('none');

    expect(firstDeploy).toBeLessThan(firstUpdate);
    expect(firstUpdate).toBeLessThan(firstRemove);
    expect(firstRemove).toBeLessThan(firstNone);
  });

  it('1j. purity: same inputs always produce same output (idempotent)', () => {
    const desired: DesiredState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:2.0' },
      { targetId: 'target-a', service: 'worker', artifactRef: 'worker:1.0' },
    ];
    const observed: ObservedState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:1.0' },
    ];

    const plan1 = computeReconcilePlan(desired, observed);
    const plan2 = computeReconcilePlan(desired, observed);

    expect(JSON.stringify(plan1)).toBe(JSON.stringify(plan2));
  });

  it('observed entry with undefined artifactRef triggers deploy (not running)', () => {
    const desired: DesiredState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: 'api:1.0' },
    ];
    const observed: ObservedState[] = [
      { targetId: 'target-a', service: 'api', artifactRef: undefined },
    ];

    const plan = computeReconcilePlan(desired, observed);

    expect(plan[0].kind).toBe('deploy');
  });

  it('ReconcileAction carries desiredState and observedState references', () => {
    const d: DesiredState = { targetId: 'target-a', service: 'api', artifactRef: 'api:2.0' };
    const o: ObservedState = { targetId: 'target-a', service: 'api', artifactRef: 'api:1.0' };

    const plan = computeReconcilePlan([d], [o]);

    expect(plan[0].kind).toBe('update');
    expect(plan[0].desiredState).toStrictEqual(d);
    expect(plan[0].observedState).toStrictEqual(o);
  });
});

// ---------------------------------------------------------------------------
// 2. applyReconcileAction
// ---------------------------------------------------------------------------

describe('applyReconcileAction', () => {
  const noneAction: ReconcileAction = {
    kind: 'none',
    targetId: 'target-a',
    service: 'api',
    desiredArtifactRef: 'api:1.0',
    observedArtifactRef: 'api:1.0',
    reason: 'Already in sync',
  };

  const deployAction: ReconcileAction = {
    kind: 'deploy',
    targetId: 'target-a',
    service: 'new-svc',
    desiredArtifactRef: 'new-svc:1.0',
    reason: 'Not yet deployed',
  };

  const updateAction: ReconcileAction = {
    kind: 'update',
    targetId: 'target-a',
    service: 'api',
    desiredArtifactRef: 'api:2.0',
    observedArtifactRef: 'api:1.0',
    reason: 'Artifact changed',
  };

  const removeAction: ReconcileAction = {
    kind: 'remove',
    targetId: 'target-a',
    service: 'old-svc',
    observedArtifactRef: 'old-svc:1.0',
    reason: 'Not in desired state',
  };

  it('2a. none action → pipelineResult: null, no backend called', async () => {
    const backend = makeMockBackend('none-action');

    const result = await applyReconcileAction({
      action: noneAction,
      target: TARGET_A,
      dryRun: false,
      confirm: true,
      _backendOverride: backend,
    });

    expect(result.pipelineResult).toBeNull();
    expect(backend.deploy).not.toHaveBeenCalled();
  });

  it('2b. deploy action → routes through runPipeline', async () => {
    const backend = makeMockBackend('deploy-action');

    const result = await applyReconcileAction({
      action: deployAction,
      target: TARGET_A,
      dryRun: false,
      confirm: true,
      _backendOverride: backend,
    });

    expect(result.pipelineResult).not.toBeNull();
    expect(result.pipelineResult?.status).toBe('success');
    expect(backend.deploy).toHaveBeenCalled();
  });

  it('2c. update action → routes through runPipeline', async () => {
    const backend = makeMockBackend('update-action');

    const result = await applyReconcileAction({
      action: updateAction,
      target: TARGET_A,
      dryRun: false,
      confirm: true,
      _backendOverride: backend,
    });

    expect(result.pipelineResult).not.toBeNull();
    expect(result.pipelineResult?.status).toBe('success');
    expect(backend.deploy).toHaveBeenCalled();
  });

  it('2d. remove action → returns no-backend result (not implemented)', async () => {
    const backend = makeMockBackend('remove-action');

    const result = await applyReconcileAction({
      action: removeAction,
      target: TARGET_A,
      dryRun: false,
      confirm: true,
      _backendOverride: backend,
    });

    expect(result.pipelineResult).not.toBeNull();
    expect(result.pipelineResult?.status).toBe('no-backend');
    expect(backend.deploy).not.toHaveBeenCalled();
  });

  it('2e. dry-run: no backend call, returns dry-run pipeline result for deploy', async () => {
    const backend = makeMockBackend('dry-run-apply');

    const result = await applyReconcileAction({
      action: deployAction,
      target: TARGET_A,
      dryRun: true,
      _backendOverride: backend,
    });

    expect(result.pipelineResult?.status).toBe('dry-run');
    expect(backend.deploy).not.toHaveBeenCalled();
  });

  it('2f. ReconcileApplyConfirmRequiredError when neither dryRun nor confirm', async () => {
    const backend = makeMockBackend('no-confirm-apply');

    await expect(
      applyReconcileAction({
        action: deployAction,
        target: TARGET_A,
        // neither dryRun nor confirm
        _backendOverride: backend,
      }),
    ).rejects.toThrow(ReconcileApplyConfirmRequiredError);

    expect(backend.deploy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Apply + policy
// ---------------------------------------------------------------------------

describe('apply + policy', () => {
  it('policy deny blocks action; pipelineResult.status=denied', async () => {
    const backend = makeMockBackend('policy-block');

    const action: ReconcileAction = {
      kind: 'deploy',
      targetId: 'target-a',
      service: 'api',
      desiredArtifactRef: 'api:1.0',
      reason: 'Not deployed',
    };

    const result = await applyReconcileAction({
      action,
      target: TARGET_A,
      policy: denyPolicy,
      dryRun: false,
      confirm: true,
      _backendOverride: backend,
    });

    expect(result.pipelineResult?.status).toBe('denied');
    expect(result.pipelineResult?.policyDecision.allowed).toBe(false);
    expect(backend.deploy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. applyReconcilePlan (batch)
// ---------------------------------------------------------------------------

describe('applyReconcilePlan (batch)', () => {
  it('4a. skips none actions', async () => {
    const backend = makeMockBackend('batch-none');
    const actions: ReconcileAction[] = [
      {
        kind: 'none',
        targetId: 'target-a',
        service: 'api',
        desiredArtifactRef: 'api:1.0',
        observedArtifactRef: 'api:1.0',
        reason: 'In sync',
      },
    ];

    const results = await applyReconcilePlan(actions, async () => TARGET_A, {
      dryRun: false,
      confirm: true,
      _backendOverride: backend,
    });

    expect(results).toHaveLength(0);
    expect(backend.deploy).not.toHaveBeenCalled();
  });

  it('4b. applies mutating actions and collects results', async () => {
    const backend = makeMockBackend('batch-apply');
    const actions: ReconcileAction[] = [
      {
        kind: 'deploy',
        targetId: 'target-a',
        service: 'api',
        desiredArtifactRef: 'api:1.0',
        reason: 'Not deployed',
      },
      {
        kind: 'update',
        targetId: 'target-a',
        service: 'worker',
        desiredArtifactRef: 'worker:2.0',
        observedArtifactRef: 'worker:1.0',
        reason: 'Artifact changed',
      },
    ];

    const results = await applyReconcilePlan(actions, async () => TARGET_A, {
      dryRun: false,
      confirm: true,
      _backendOverride: backend,
    });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.pipelineResult?.status === 'success')).toBe(true);
    expect(backend.deploy).toHaveBeenCalledTimes(2);
  });

  it('4c. unknown target → error in result, continues with other actions', async () => {
    const backend = makeMockBackend('batch-unknown');
    const actions: ReconcileAction[] = [
      {
        kind: 'deploy',
        targetId: 'unknown-target',
        service: 'api',
        desiredArtifactRef: 'api:1.0',
        reason: 'Missing target',
      },
      {
        kind: 'deploy',
        targetId: 'target-a',
        service: 'worker',
        desiredArtifactRef: 'worker:1.0',
        reason: 'Not deployed',
      },
    ];

    const results = await applyReconcilePlan(
      actions,
      async (id) => (id === 'target-a' ? TARGET_A : undefined),
      { dryRun: false, confirm: true, _backendOverride: backend },
    );

    expect(results).toHaveLength(2);
    // First action had unknown target → no-backend pipeline result
    expect(results[0].pipelineResult?.status).toBe('no-backend');
    // Second action succeeded
    expect(results[1].pipelineResult?.status).toBe('success');
  });
});
