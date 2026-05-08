/**
 * SPEC-032-1-01: orchestrator-side cost-cap helper memoization tests.
 * SPEC-032-1-04: orchestrator-level cost-cap integration matrix
 *                (Cases A, B, C, D — see TDD-032 §10.1).
 *
 * SPEC-032-1-01 verifies the module-private
 * `getOrCreateCostCapEnforcer(requestDir)` helper returns the same
 * `CostCapEnforcer` instance for identical `requestDir` and a
 * different instance for distinct values. The helper itself is not
 * exported; we exercise it via the
 * `__getOrCreateCostCapEnforcerForTest` escape hatch.
 *
 * SPEC-032-1-04 covers the four-case integration matrix:
 *   - Case A: successful runDeploy() under the new path writes a
 *     ledger entry.
 *   - Case B: over-cap runDeploy() emits `cost-cap-exceeded`
 *     telemetry and rejects with `CostCapExceededError`.
 *   - Case C: two runDeploy() calls with the same deployId record at
 *     most one ledger entry per the SPEC-023-2-04 contract.
 *   - Case D: with `AUTONOMOUS_DEV_COST_CAP_LEGACY=1` the cutover
 *     skips the enforcer (`enforcerCache` stays empty) and the legacy
 *     path drives the deploy.
 *
 * @module tests/deploy/test-orchestrator-cost-cap.test
 */

import { mkdtemp, rm, mkdir, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  __getOrCreateCostCapEnforcerForTest,
  __resetCostCapEnforcerCacheForTest,
  resetEscalationSink,
  runDeploy,
  setEscalationSink,
} from '../../intake/deploy/orchestrator';
import { CostCapEnforcer } from '../../intake/deploy/cost-cap-enforcer';
import { __setCostCapDayForTest } from '../../intake/deploy/cost-cap';
import { BackendRegistry } from '../../intake/deploy/registry';
import { CostCapExceededError } from '../../intake/deploy/errors';
import {
  resetDeployMetricsClient,
  setDeployMetricsClient,
  type DeployEvent,
} from '../../intake/deploy/telemetry';
import { makeStubRegistry } from './helpers/test-registry';
import type {
  BackendMetadata,
  BuildArtifact,
  BuildContext,
  DeploymentBackend,
  DeploymentRecord,
  HealthStatus,
  RollbackResult,
} from '../../intake/deploy/types';

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'orch-cost-cap-'));
}

describe('SPEC-032-1-01 getOrCreateCostCapEnforcer memoization', () => {
  beforeEach(() => {
    __resetCostCapEnforcerCacheForTest();
  });
  afterEach(() => {
    __resetCostCapEnforcerCacheForTest();
  });

  it('returns the same instance for the same requestDir', async () => {
    const dir = await tmp();
    try {
      const a = __getOrCreateCostCapEnforcerForTest(dir);
      const b = __getOrCreateCostCapEnforcerForTest(dir);
      expect(a).toBeInstanceOf(CostCapEnforcer);
      expect(a).toBe(b);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns distinct instances for distinct requestDirs', async () => {
    const dirA = await tmp();
    const dirB = await tmp();
    try {
      const a = __getOrCreateCostCapEnforcerForTest(dirA);
      const b = __getOrCreateCostCapEnforcerForTest(dirB);
      expect(a).not.toBe(b);
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });

  it('cache survives multiple synchronous calls in one block', async () => {
    const dir = await tmp();
    try {
      const refs = [
        __getOrCreateCostCapEnforcerForTest(dir),
        __getOrCreateCostCapEnforcerForTest(dir),
        __getOrCreateCostCapEnforcerForTest(dir),
      ];
      expect(refs[0]).toBe(refs[1]);
      expect(refs[1]).toBe(refs[2]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// SPEC-032-1-04 integration matrix
// ---------------------------------------------------------------------------

const HMAC_KEY_HEX = randomBytes(32).toString('hex');
const FIXTURE_PATH = join(__dirname, 'fixtures-023-2', 'deploy-config-valid.yaml');
const FIXED_DAY = '2026-05-02';

function nowIso(): string {
  return new Date().toISOString();
}

function makeStubBackend(opts: { name: string; estimate?: number }): DeploymentBackend & {
  setEstimate: (v: number) => void;
} {
  let estimate = opts.estimate ?? 0;
  const backend: DeploymentBackend & {
    estimateDeployCost: (p: Record<string, unknown>) => Promise<number>;
    setEstimate: (v: number) => void;
  } = {
    metadata: {
      name: opts.name,
      version: '0.0.0',
      supportedTargets: ['github-pr'],
      capabilities: ['github-pr'],
      requiredTools: [],
    } satisfies BackendMetadata,
    async build(_ctx: BuildContext): Promise<BuildArtifact> {
      return {
        artifactId: `art-${opts.name}`,
        type: 'directory',
        location: '/tmp/stub',
        checksum: '0'.repeat(64),
        sizeBytes: 0,
        metadata: {},
      };
    },
    async deploy(
      artifact: BuildArtifact,
      environment: string,
    ): Promise<DeploymentRecord> {
      return {
        deployId: `dep-${opts.name}-${Date.now()}`,
        backend: opts.name,
        environment,
        artifactId: artifact.artifactId,
        deployedAt: nowIso(),
        status: 'deployed',
        details: {},
        hmac: 'stub',
      };
    },
    async healthCheck(): Promise<HealthStatus> {
      return { healthy: true, checks: [] };
    },
    async rollback(): Promise<RollbackResult> {
      return { success: true, errors: [] };
    },
    async estimateDeployCost(): Promise<number> {
      return estimate;
    },
    setEstimate(v: number) {
      estimate = v;
    },
  };
  return backend;
}

async function makeRequestDirFromFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'spec-032-1-04-'));
  await mkdir(join(dir, '.autonomous-dev'), { recursive: true });
  await copyFile(FIXTURE_PATH, join(dir, '.autonomous-dev', 'deploy.yaml'));
  return dir;
}

describe('SPEC-032-1-04 orchestrator cost-cap integration matrix', () => {
  let requestDir: string;
  let telemetry: DeployEvent[];
  let originalLegacyFlag: string | undefined;
  let originalDailyCap: string | undefined;
  let originalKey: string | undefined;
  let staticStub: ReturnType<typeof makeStubBackend>;
  let selectorRegistry: ReturnType<typeof makeStubRegistry>;

  beforeAll(() => {
    originalKey = process.env.DEPLOY_HMAC_KEY;
    process.env.DEPLOY_HMAC_KEY = HMAC_KEY_HEX;
  });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.DEPLOY_HMAC_KEY;
    else process.env.DEPLOY_HMAC_KEY = originalKey;
  });

  beforeEach(async () => {
    originalLegacyFlag = process.env.AUTONOMOUS_DEV_COST_CAP_LEGACY;
    delete process.env.AUTONOMOUS_DEV_COST_CAP_LEGACY;
    originalDailyCap = process.env.AUTONOMOUS_DEV_COST_CAP_USD_PER_DAY;
    delete process.env.AUTONOMOUS_DEV_COST_CAP_USD_PER_DAY;

    requestDir = await makeRequestDirFromFixture();
    telemetry = [];
    setDeployMetricsClient({
      emit(_channel, payload) {
        telemetry.push(payload);
      },
    });
    setEscalationSink({ raise: () => undefined });

    BackendRegistry.clear();
    BackendRegistry.registerSync(makeStubBackend({ name: 'local-stub', estimate: 0 }));
    staticStub = makeStubBackend({ name: 'static-stub', estimate: 0 });
    BackendRegistry.registerSync(staticStub);

    selectorRegistry = makeStubRegistry({
      'local-stub': { schema: {}, defaults: {} },
      'static-stub': {
        schema: { target_dir: { type: 'string', format: 'path' } },
        defaults: {},
      },
    });

    __setCostCapDayForTest(() => FIXED_DAY);
    __resetCostCapEnforcerCacheForTest();
  });

  afterEach(async () => {
    __setCostCapDayForTest(null);
    resetDeployMetricsClient();
    resetEscalationSink();
    BackendRegistry.clear();
    __resetCostCapEnforcerCacheForTest();
    await rm(requestDir, { recursive: true, force: true });

    if (originalLegacyFlag === undefined) {
      delete process.env.AUTONOMOUS_DEV_COST_CAP_LEGACY;
    } else {
      process.env.AUTONOMOUS_DEV_COST_CAP_LEGACY = originalLegacyFlag;
    }
    if (originalDailyCap === undefined) {
      delete process.env.AUTONOMOUS_DEV_COST_CAP_USD_PER_DAY;
    } else {
      process.env.AUTONOMOUS_DEV_COST_CAP_USD_PER_DAY = originalDailyCap;
    }
  });

  function buildContextFor(deployId: string): BuildContext {
    return {
      repoPath: requestDir,
      commitSha: '0'.repeat(40),
      branch: 'main',
      requestId: deployId,
      cleanWorktree: true,
      params: {},
    };
  }

  it('Case A: new-path success writes a ledger entry and emits success telemetry', async () => {
    staticStub.setEstimate(1);
    const result = await runDeploy({
      deployId: 'spec-1-04-A',
      envName: 'dev',
      requestDir,
      actor: 'tester-A',
      selectorRegistry,
      buildContext: buildContextFor('spec-1-04-A'),
    });
    expect(result.status).toBe('completed');

    const completion = telemetry.find((e) => e.type === 'deploy.completion');
    expect(completion?.outcome).toBe('success');

    // The legacy ledger (still active under the bridge) should record
    // the deploy-id (SPEC-023-2-04 contract).
    const ledgerPath = join(
      requestDir,
      '.autonomous-dev',
      'deployments',
      'cost-ledger-dev.json',
    );
    const raw = await readFile(ledgerPath, 'utf8');
    const ledger = JSON.parse(raw) as { entries: Array<{ deployId: string }> };
    expect(ledger.entries.some((e) => e.deployId === 'spec-1-04-A')).toBe(true);
  });

  it('Case B: enforcer cap exceeded emits cost-cap-exceeded telemetry with new reason shape and throws CostCapExceededError', async () => {
    // Use the dev env (no approval, per-env cap = 0 so legacy
    // checkCostCap is bypassed) and set the operator-wide daily cap
    // env var below the estimate so the new enforcer path trips.
    process.env.AUTONOMOUS_DEV_COST_CAP_USD_PER_DAY = '1';
    // Force enforcer to use a per-test stateDir so override/warning
    // files do not touch the user's real `~/.autonomous-dev`.
    const stateDir = join(requestDir, '.autonomous-dev', 'enforcer-state');
    await mkdir(stateDir, { recursive: true });
    // Pre-warm the cache, then patch the enforcer's stateDir + clock
    // for hermetic behavior. The enforcer is a fresh instance for
    // this requestDir thanks to __resetCostCapEnforcerCacheForTest.
    const enforcer = __getOrCreateCostCapEnforcerForTest(requestDir);
    // The enforcer's private fields are not exposed; rely on
    // process-wide env vars instead. The default stateDir is
    // ~/.autonomous-dev which we tolerate for this single test
    // (it only writes warning state, not real cost data).

    staticStub.setEstimate(50);
    void enforcer; // referenced for memoization side-effect only

    await expect(
      runDeploy({
        deployId: 'spec-1-04-B',
        envName: 'dev',
        requestDir,
        actor: 'tester-B',
        selectorRegistry,
        // dev uses local-stub by default; force the static-stub which
        // returns estimate=50 so the enforcer's cap (1 USD/day from
        // env var above) is breached.
        cliBackendOverride: 'static-stub',
        buildContext: buildContextFor('spec-1-04-B'),
      }),
    ).rejects.toBeInstanceOf(CostCapExceededError);

    const comp = telemetry
      .filter((e) => e.type === 'deploy.completion')
      .pop();
    expect(comp?.outcome).toBe('cost-cap-exceeded');
    expect(typeof comp?.reason).toBe('string');
    // SPEC-032-1-02 FR-4: reason carries the enforcer's error class.
    expect(comp?.reason).toMatch(/^DailyCostCapExceededError: /);
  });

  it('Case C: two runDeploy() calls with the same deployId record exactly one ledger entry', async () => {
    staticStub.setEstimate(1);
    await runDeploy({
      deployId: 'spec-1-04-C',
      envName: 'dev',
      requestDir,
      actor: 'tester-C',
      selectorRegistry,
      buildContext: buildContextFor('spec-1-04-C'),
    });
    await runDeploy({
      deployId: 'spec-1-04-C',
      envName: 'dev',
      requestDir,
      actor: 'tester-C',
      selectorRegistry,
      buildContext: buildContextFor('spec-1-04-C'),
    });

    const ledgerPath = join(
      requestDir,
      '.autonomous-dev',
      'deployments',
      'cost-ledger-dev.json',
    );
    const raw = await readFile(ledgerPath, 'utf8');
    const ledger = JSON.parse(raw) as { entries: Array<{ deployId: string }> };
    const matching = ledger.entries.filter((e) => e.deployId === 'spec-1-04-C');
    expect(matching).toHaveLength(1);
  });

  it('Case D: AUTONOMOUS_DEV_COST_CAP_LEGACY=1 skips enforcer.check() and routes through the legacy path', async () => {
    process.env.AUTONOMOUS_DEV_COST_CAP_LEGACY = '1';
    staticStub.setEstimate(1);

    // Spy on enforcer.check so we can verify the new path is NOT
    // taken. We pre-warm the enforcer cache via the test escape
    // hatch so the spy attaches to the same instance the orchestrator
    // would otherwise reach for.
    const enforcer = __getOrCreateCostCapEnforcerForTest(requestDir);
    const checkSpy = jest.spyOn(enforcer, 'check');

    const result = await runDeploy({
      deployId: 'spec-1-04-D',
      envName: 'dev',
      requestDir,
      actor: 'tester-D',
      selectorRegistry,
      buildContext: buildContextFor('spec-1-04-D'),
    });
    expect(result.status).toBe('completed');
    expect(checkSpy).not.toHaveBeenCalled();
    checkSpy.mockRestore();
  });

  it('Case D-bis: with the flag UNSET, enforcer.check() IS invoked exactly once', async () => {
    delete process.env.AUTONOMOUS_DEV_COST_CAP_LEGACY;
    staticStub.setEstimate(1);

    const enforcer = __getOrCreateCostCapEnforcerForTest(requestDir);
    const checkSpy = jest.spyOn(enforcer, 'check');

    const result = await runDeploy({
      deployId: 'spec-1-04-D-bis',
      envName: 'dev',
      requestDir,
      actor: 'tester-D-bis',
      selectorRegistry,
      buildContext: buildContextFor('spec-1-04-D-bis'),
    });
    expect(result.status).toBe('completed');
    expect(checkSpy).toHaveBeenCalledTimes(1);
    checkSpy.mockRestore();
  });
});
