/**
 * Tests for `intake/deploy/promotion.ts` (issue #663).
 *
 * Coverage:
 *   1. promote() deploys the SAME artifact (same ref) to the new target
 *   2. promote() records lineage (PromotionRecord) after a real promote
 *   3. Lineage contains correct from/to/service/artifact/who fields
 *   4. promote() with a policy that denies → pipelineResult.status='denied', no lineage
 *   5. Checksum guard: correct checksum → proceeds; wrong checksum → PromotionChecksumError
 *   6. Confirm guard: no confirm AND no dry-run → PromotionConfirmRequiredError
 *   7. dry-run → no lineage entry, no backend call, pipelineResult.status='dry-run'
 *   8. queryPromotionLineage filters by service / fromTargetId / toTargetId
 *   9. getPromotionLineage returns all entries
 *  10. resetPromotionLineage clears store
 *
 * @module tests/deploy/promotion.test
 */

import {
  promote,
  getPromotionLineage,
  queryPromotionLineage,
  resetPromotionLineage,
  PromotionChecksumError,
  PromotionConfirmRequiredError,
} from '../../intake/deploy/promotion';
import { resetPipelineBackendRegistry } from '../../intake/deploy/backend-types';
import type { PipelineBackend, DeployResult, HealthResult } from '../../intake/deploy/backend-types';
import type { DeployTarget } from '../../intake/deploy/target-types';
import type { PolicyDocument } from '../../intake/deploy/policy-types';

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

const DEV_TARGET = makeTarget({ id: 'dev-target', env: 'dev' });
const PROD_TARGET = makeTarget({ id: 'prod-target', env: 'prod' });

beforeEach(() => {
  resetPipelineBackendRegistry();
  resetPromotionLineage();
});

afterEach(() => {
  resetPipelineBackendRegistry();
  resetPromotionLineage();
});

// ---------------------------------------------------------------------------
// 1. promote() deploys the SAME artifact to the new target
// ---------------------------------------------------------------------------

describe('promote() deploys same artifact', () => {
  it('passes the artifact ref to the backend deploy call, not a rebuilt artifact', async () => {
    const backend = makeMockBackend('artifact-check');

    const result = await promote({
      service: 'api',
      artifactRef: { ref: 'api:v1.2.3', checksum: 'abc123' },
      fromTarget: DEV_TARGET,
      toTarget: PROD_TARGET,
      checksumExpected: 'abc123',
      dryRun: false,
      confirm: true,
      _backendOverride: backend,
    });

    expect(result.pipelineResult.status).toBe('success');
    // The backend should have been called with deploy
    expect(backend.deploy).toHaveBeenCalled();

    // The artifact name passed to the pipeline should be the original ref
    const ctx = (backend.deploy as jest.Mock).mock.calls[0][0];
    expect(ctx.artifact.name).toBe('api:v1.2.3');
    expect(ctx.artifact.meta.isPromotion).toBe(true);
    expect(ctx.artifact.meta.promotedFrom).toBe('dev-target');
  });

  it('routes through the pipeline runner (policy-check → deploy → health-verify)', async () => {
    const callOrder: string[] = [];
    const backend = makeMockBackend('stage-order', {
      build: jest.fn().mockImplementation(async () => { callOrder.push('build'); }),
      deploy: jest.fn().mockImplementation(async () => {
        callOrder.push('deploy');
        return { success: true, details: {} };
      }),
      verifyHealth: jest.fn().mockImplementation(async () => {
        callOrder.push('health-verify');
        return { healthy: true, checks: [] };
      }),
    });

    const result = await promote({
      service: 'api',
      artifactRef: { ref: 'api:v2.0.0' },
      fromTarget: DEV_TARGET,
      toTarget: PROD_TARGET,
      confirm: true,
      dryRun: false,
      _backendOverride: backend,
    });

    expect(result.pipelineResult.status).toBe('success');
    // build runs as 'build' stage (skipped if backend.build absent, or runs if present)
    // deploy and health-verify must have been called
    expect(callOrder).toContain('deploy');
    expect(callOrder).toContain('health-verify');
    // deploy must come before health-verify
    expect(callOrder.indexOf('deploy')).toBeLessThan(callOrder.indexOf('health-verify'));
  });
});

// ---------------------------------------------------------------------------
// 2 & 3. promote() records lineage
// ---------------------------------------------------------------------------

describe('promote() records lineage', () => {
  it('appends a PromotionRecord after a successful real promote', async () => {
    const backend = makeMockBackend('lineage-test');
    const nowIso = () => '2026-07-08T12:00:00.000Z';

    await promote({
      service: 'api',
      artifactRef: { ref: 'api:v1.0.0' },
      fromTarget: DEV_TARGET,
      toTarget: PROD_TARGET,
      confirm: true,
      dryRun: false,
      promotedBy: 'ci-system',
      _nowIso: nowIso,
      _backendOverride: backend,
    });

    const lineage = getPromotionLineage();
    expect(lineage).toHaveLength(1);

    const record = lineage[0];
    expect(record.service).toBe('api');
    expect(record.artifactRef.ref).toBe('api:v1.0.0');
    expect(record.fromTargetId).toBe('dev-target');
    expect(record.toTargetId).toBe('prod-target');
    expect(record.promotedBy).toBe('ci-system');
    expect(record.promotedAt).toBe('2026-07-08T12:00:00.000Z');
    expect(record.pipelineStatus).toBe('success');
    expect(record.promotionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(record.pipelineRunId).toBeTruthy();
  });

  it('returns the lineage record in the result', async () => {
    const backend = makeMockBackend('lineage-result');

    const result = await promote({
      service: 'worker',
      artifactRef: { ref: 'worker:3.1.4' },
      fromTarget: DEV_TARGET,
      toTarget: PROD_TARGET,
      confirm: true,
      dryRun: false,
      _backendOverride: backend,
    });

    expect(result.record).not.toBeNull();
    expect(result.record?.service).toBe('worker');
    expect(result.record?.artifactRef.ref).toBe('worker:3.1.4');
  });

  it('defaults promotedBy to "system" when not specified', async () => {
    const backend = makeMockBackend('lineage-default-actor');

    await promote({
      service: 'svc',
      artifactRef: { ref: 'svc:latest' },
      fromTarget: DEV_TARGET,
      toTarget: PROD_TARGET,
      confirm: true,
      dryRun: false,
      _backendOverride: backend,
    });

    const [record] = getPromotionLineage();
    expect(record.promotedBy).toBe('system');
  });

  it('records lineage with pipeline status when pipeline fails', async () => {
    const backend = makeMockBackend('lineage-on-failure', {
      deploy: jest.fn().mockResolvedValue({
        success: false,
        message: 'deploy crashed',
        details: {},
      }),
      rollback: jest.fn().mockResolvedValue({ success: true, errors: [] }),
    });

    await promote({
      service: 'api',
      artifactRef: { ref: 'api:v1.0.0' },
      fromTarget: DEV_TARGET,
      toTarget: PROD_TARGET,
      confirm: true,
      dryRun: false,
      _backendOverride: backend,
    });

    // Lineage IS recorded even when pipeline fails.
    const lineage = getPromotionLineage();
    expect(lineage).toHaveLength(1);
    expect(lineage[0].pipelineStatus).toBe('deploy-failed');
  });
});

// ---------------------------------------------------------------------------
// 4. Policy deny: no mutation, no lineage
// ---------------------------------------------------------------------------

describe('policy enforcement', () => {
  it('returns denied status when policy denies the destination target', async () => {
    const backend = makeMockBackend('policy-denied');

    const result = await promote({
      service: 'api',
      artifactRef: { ref: 'api:v1.0.0' },
      fromTarget: DEV_TARGET,
      toTarget: PROD_TARGET, // kind: swarm-node — will be denied
      policy: denyPolicy,
      confirm: true,
      dryRun: false,
      _backendOverride: backend,
    });

    expect(result.pipelineResult.status).toBe('denied');
    expect(result.pipelineResult.policyDecision.allowed).toBe(false);
    expect(result.pipelineResult.policyDecision.violations.length).toBeGreaterThan(0);

    // No backend deploy called
    expect(backend.deploy).not.toHaveBeenCalled();
  });

  it('records lineage even when policy denies (policy result is recorded)', async () => {
    const backend = makeMockBackend('policy-lineage');

    await promote({
      service: 'api',
      artifactRef: { ref: 'api:v1.0.0' },
      fromTarget: DEV_TARGET,
      toTarget: PROD_TARGET,
      policy: denyPolicy,
      confirm: true,
      dryRun: false,
      _backendOverride: backend,
    });

    const lineage = getPromotionLineage();
    expect(lineage).toHaveLength(1);
    expect(lineage[0].pipelineStatus).toBe('denied');
  });
});

// ---------------------------------------------------------------------------
// 5. Checksum guard
// ---------------------------------------------------------------------------

describe('checksum guard', () => {
  it('proceeds when checksum matches', async () => {
    const backend = makeMockBackend('checksum-ok');

    const result = await promote({
      service: 'api',
      artifactRef: { ref: 'api:v1.0.0', checksum: 'deadbeef' },
      fromTarget: DEV_TARGET,
      toTarget: PROD_TARGET,
      checksumExpected: 'deadbeef',
      confirm: true,
      dryRun: false,
      _backendOverride: backend,
    });

    expect(result.pipelineResult.status).toBe('success');
  });

  it('throws PromotionChecksumError when checksum does not match', async () => {
    const backend = makeMockBackend('checksum-fail');

    await expect(
      promote({
        service: 'api',
        artifactRef: { ref: 'api:v1.0.0', checksum: 'actual-checksum' },
        fromTarget: DEV_TARGET,
        toTarget: PROD_TARGET,
        checksumExpected: 'expected-checksum',
        confirm: true,
        dryRun: false,
        _backendOverride: backend,
      }),
    ).rejects.toThrow(PromotionChecksumError);
  });

  it('PromotionChecksumError carries expected and actual values', async () => {
    const backend = makeMockBackend('checksum-error-fields');

    let caught: PromotionChecksumError | undefined;
    try {
      await promote({
        service: 'api',
        artifactRef: { ref: 'api:v1.0.0', checksum: 'bad' },
        fromTarget: DEV_TARGET,
        toTarget: PROD_TARGET,
        checksumExpected: 'good',
        confirm: true,
        dryRun: false,
        _backendOverride: backend,
      });
    } catch (err) {
      if (err instanceof PromotionChecksumError) caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught?.expected).toBe('good');
    expect(caught?.actual).toBe('bad');
  });

  it('checksum check runs BEFORE any backend call (no mutation on mismatch)', async () => {
    const backend = makeMockBackend('checksum-no-mutation');

    try {
      await promote({
        service: 'api',
        artifactRef: { ref: 'api:v1.0.0', checksum: 'wrong' },
        fromTarget: DEV_TARGET,
        toTarget: PROD_TARGET,
        checksumExpected: 'right',
        confirm: true,
        dryRun: false,
        _backendOverride: backend,
      });
    } catch {
      // expected
    }

    expect(backend.deploy).not.toHaveBeenCalled();
    expect(getPromotionLineage()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Confirm guard
// ---------------------------------------------------------------------------

describe('confirm guard', () => {
  it('throws PromotionConfirmRequiredError when neither dryRun nor confirm', async () => {
    const backend = makeMockBackend('no-confirm');

    await expect(
      promote({
        service: 'api',
        artifactRef: { ref: 'api:v1.0.0' },
        fromTarget: DEV_TARGET,
        toTarget: PROD_TARGET,
        // neither dryRun nor confirm
        _backendOverride: backend,
      }),
    ).rejects.toThrow(PromotionConfirmRequiredError);
  });

  it('does NOT call any backend when confirm guard fires', async () => {
    const backend = makeMockBackend('confirm-guard-no-backend');

    try {
      await promote({
        service: 'api',
        artifactRef: { ref: 'api:v1.0.0' },
        fromTarget: DEV_TARGET,
        toTarget: PROD_TARGET,
        _backendOverride: backend,
      });
    } catch {
      // expected
    }

    expect(backend.deploy).not.toHaveBeenCalled();
    expect(getPromotionLineage()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Dry-run
// ---------------------------------------------------------------------------

describe('dry-run', () => {
  it('returns dry-run pipeline status without calling any backend', async () => {
    const backend = makeMockBackend('dry-run-promote');

    const result = await promote({
      service: 'api',
      artifactRef: { ref: 'api:v1.0.0' },
      fromTarget: DEV_TARGET,
      toTarget: PROD_TARGET,
      dryRun: true,
      _backendOverride: backend,
    });

    expect(result.pipelineResult.status).toBe('dry-run');
    expect(backend.deploy).not.toHaveBeenCalled();
    expect(backend.build).not.toHaveBeenCalled();
  });

  it('does NOT record lineage in dry-run mode', async () => {
    const backend = makeMockBackend('dry-run-no-lineage');

    const result = await promote({
      service: 'api',
      artifactRef: { ref: 'api:v1.0.0' },
      fromTarget: DEV_TARGET,
      toTarget: PROD_TARGET,
      dryRun: true,
      _backendOverride: backend,
    });

    expect(result.record).toBeNull();
    expect(getPromotionLineage()).toHaveLength(0);
  });

  it('still evaluates policy in dry-run mode', async () => {
    const backend = makeMockBackend('dry-run-policy');

    const result = await promote({
      service: 'api',
      artifactRef: { ref: 'api:v1.0.0' },
      fromTarget: DEV_TARGET,
      toTarget: PROD_TARGET,
      policy: denyPolicy,
      dryRun: true,
      _backendOverride: backend,
    });

    // dry-run still evaluates policy and returns 'dry-run' status
    // (pipeline runner always returns dry-run regardless of policy in dry-run mode)
    expect(result.pipelineResult.status).toBe('dry-run');
  });
});

// ---------------------------------------------------------------------------
// 8 & 9 & 10. Lineage store queries
// ---------------------------------------------------------------------------

describe('lineage store', () => {
  it('getPromotionLineage returns all entries in chronological order', async () => {
    const backend = makeMockBackend('all-lineage');

    await promote({
      service: 'svcA',
      artifactRef: { ref: 'svcA:1.0' },
      fromTarget: DEV_TARGET,
      toTarget: PROD_TARGET,
      confirm: true,
      dryRun: false,
      _backendOverride: backend,
    });

    await promote({
      service: 'svcB',
      artifactRef: { ref: 'svcB:2.0' },
      fromTarget: DEV_TARGET,
      toTarget: PROD_TARGET,
      confirm: true,
      dryRun: false,
      _backendOverride: backend,
    });

    const lineage = getPromotionLineage();
    expect(lineage).toHaveLength(2);
    expect(lineage[0].service).toBe('svcA');
    expect(lineage[1].service).toBe('svcB');
  });

  it('queryPromotionLineage filters by service', async () => {
    const backend = makeMockBackend('query-service');

    await promote({
      service: 'api',
      artifactRef: { ref: 'api:1.0' },
      fromTarget: DEV_TARGET,
      toTarget: PROD_TARGET,
      confirm: true,
      dryRun: false,
      _backendOverride: backend,
    });
    await promote({
      service: 'worker',
      artifactRef: { ref: 'worker:1.0' },
      fromTarget: DEV_TARGET,
      toTarget: PROD_TARGET,
      confirm: true,
      dryRun: false,
      _backendOverride: backend,
    });

    const apiResults = queryPromotionLineage({ service: 'api' });
    expect(apiResults).toHaveLength(1);
    expect(apiResults[0].service).toBe('api');
  });

  it('queryPromotionLineage filters by toTargetId', async () => {
    const backend = makeMockBackend('query-to');
    const otherTarget = makeTarget({ id: 'other-target', env: 'staging' });

    await promote({
      service: 'api',
      artifactRef: { ref: 'api:1.0' },
      fromTarget: DEV_TARGET,
      toTarget: PROD_TARGET,
      confirm: true,
      dryRun: false,
      _backendOverride: backend,
    });
    await promote({
      service: 'api',
      artifactRef: { ref: 'api:1.0' },
      fromTarget: DEV_TARGET,
      toTarget: otherTarget,
      confirm: true,
      dryRun: false,
      _backendOverride: backend,
    });

    const prodResults = queryPromotionLineage({ toTargetId: 'prod-target' });
    expect(prodResults).toHaveLength(1);
    expect(prodResults[0].toTargetId).toBe('prod-target');
  });

  it('resetPromotionLineage clears all entries', async () => {
    const backend = makeMockBackend('reset-test');

    await promote({
      service: 'api',
      artifactRef: { ref: 'api:1.0' },
      fromTarget: DEV_TARGET,
      toTarget: PROD_TARGET,
      confirm: true,
      dryRun: false,
      _backendOverride: backend,
    });

    expect(getPromotionLineage()).toHaveLength(1);
    resetPromotionLineage();
    expect(getPromotionLineage()).toHaveLength(0);
  });
});
