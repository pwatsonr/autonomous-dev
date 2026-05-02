/**
 * SPEC-023-2-05 dev -> staging -> prod promotion integration test.
 *
 * Exercises:
 *   - Full pipeline from environment.ts through orchestrator.ts.
 *   - Approval state machine across simulated daemon restarts.
 *   - Cost-cap pre-check producing deploy.completion telemetry.
 *   - Telemetry init + completion event accounting.
 *
 * Stubs PLAN-009-X escalation and PLAN-019-3 identity via in-test seams
 * so the test runs without `gh`, `git`, or any external services.
 *
 * @module tests/integration/test-deploy-promotion.test
 */

import { promises as fs } from 'node:fs';
import { mkdtemp, rm, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  __setApprovalClockForTest,
  recordApproval,
  recordRejection,
} from '../../intake/deploy/approval';
import { __setCostCapDayForTest } from '../../intake/deploy/cost-cap';
import {
  resetEscalationSink,
  runDeploy,
  setEscalationSink,
  type EscalationSink,
  type RunDeployArgs,
} from '../../intake/deploy/orchestrator';
import { BackendRegistry } from '../../intake/deploy/registry';
import {
  resetDeployMetricsClient,
  setDeployMetricsClient,
  type DeployEvent,
} from '../../intake/deploy/telemetry';
import { CostCapExceededError } from '../../intake/deploy/errors';
import { makeStubRegistry } from '../deploy/helpers/test-registry';
import type { SelectorBackendRegistry } from '../../intake/deploy/selector';
import type {
  BackendMetadata,
  BuildArtifact,
  BuildContext,
  DeploymentBackend,
  DeploymentRecord,
  HealthStatus,
  RollbackResult,
} from '../../intake/deploy/types';

const HMAC_KEY_HEX = randomBytes(32).toString('hex');

function nowIso(): string {
  return new Date().toISOString();
}

interface StubBackendOpts {
  name: string;
  estimate?: number;
}

function makeStubBackend(opts: StubBackendOpts): DeploymentBackend {
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

const FIXTURE_PATH = join(__dirname, '..', 'deploy', 'fixtures-023-2', 'deploy-config-valid.yaml');

async function makeRequestDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'deploy-promo-'));
  await mkdir(join(dir, '.autonomous-dev'), { recursive: true });
  await copyFile(FIXTURE_PATH, join(dir, '.autonomous-dev', 'deploy.yaml'));
  return dir;
}

describe('SPEC-023-2-05 dev -> staging -> prod promotion', () => {
  let requestDir: string;
  let telemetry: DeployEvent[];
  let escalations: Array<Parameters<EscalationSink['raise']>[0]>;
  let selectorRegistry: SelectorBackendRegistry;
  let staticStub: ReturnType<typeof makeStubBackend> & { setEstimate: (v: number) => void };
  let originalKey: string | undefined;

  beforeAll(() => {
    originalKey = process.env.DEPLOY_HMAC_KEY;
    process.env.DEPLOY_HMAC_KEY = HMAC_KEY_HEX;
  });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.DEPLOY_HMAC_KEY;
    else process.env.DEPLOY_HMAC_KEY = originalKey;
  });

  beforeEach(async () => {
    requestDir = await makeRequestDir();
    telemetry = [];
    escalations = [];

    setDeployMetricsClient({
      emit(_channel, payload) {
        telemetry.push(payload);
      },
    });
    setEscalationSink({
      raise: (e) => {
        escalations.push(e);
      },
    });

    BackendRegistry.clear();
    BackendRegistry.registerSync(makeStubBackend({ name: 'local-stub', estimate: 0 }));
    staticStub = makeStubBackend({ name: 'static-stub', estimate: 1.5 }) as typeof staticStub;
    BackendRegistry.registerSync(staticStub);

    selectorRegistry = makeStubRegistry({
      'local-stub': { schema: {}, defaults: {} },
      'static-stub': {
        schema: { target_dir: { type: 'string', format: 'path' } },
        defaults: {},
      },
    });

    __setCostCapDayForTest(() => '2026-05-02');
    let counter = 0;
    __setApprovalClockForTest(() => {
      counter += 1;
      return new Date(Date.parse('2026-05-02T00:00:00Z') + counter * 1000).toISOString();
    });
  });

  afterEach(async () => {
    await rm(requestDir, { recursive: true, force: true });
    resetDeployMetricsClient();
    resetEscalationSink();
    BackendRegistry.clear();
    __setCostCapDayForTest(null);
    __setApprovalClockForTest(null);
  });

  function go(args: Partial<RunDeployArgs> & { deployId: string; envName: string }): Promise<ReturnType<typeof runDeploy>> {
    return runDeploy({
      deployId: args.deployId,
      envName: args.envName,
      requestDir,
      selectorRegistry,
      buildContext: args.buildContext ?? ({
        repoPath: requestDir,
        commitSha: '0'.repeat(40),
        branch: 'main',
        requestId: args.deployId,
        cleanWorktree: true,
        params: {},
      } satisfies BuildContext),
      ...args,
    });
  }

  // Wait one microtask so queueMicrotask-deferred telemetry emits land
  // before assertions inspect the array.
  async function flushTelemetry(): Promise<void> {
    await new Promise<void>((r) => setImmediate(r));
  }

  it('dev (none): proceeds without approval', async () => {
    const r = await go({ deployId: 'd1', envName: 'dev' });
    await flushTelemetry();
    expect(r.status).toBe('completed');
    const inits = telemetry.filter((e) => e.type === 'deploy.init');
    const comps = telemetry.filter((e) => e.type === 'deploy.completion');
    expect(inits).toHaveLength(1);
    expect(comps).toHaveLength(1);
    expect(comps[0].outcome).toBe('success');
    expect(escalations).toHaveLength(0);
  });

  it('staging (single): pauses, then resumes after one approval', async () => {
    const first = await go({ deployId: 's1', envName: 'staging' });
    await flushTelemetry();
    expect(first.status).toBe('paused');
    expect(escalations).toHaveLength(1);
    // No completion emitted on pause.
    expect(telemetry.filter((e) => e.type === 'deploy.completion')).toHaveLength(0);

    await recordApproval({
      deployId: 's1',
      approver: 'alice@example.com',
      role: 'operator',
      requestDir,
    });

    const second = await go({ deployId: 's1', envName: 'staging' });
    await flushTelemetry();
    expect(second.status).toBe('completed');
    expect(telemetry.filter((e) => e.type === 'deploy.completion')).toHaveLength(1);
  });

  it('prod (two-person): same approver twice -> DuplicateApproverError after restart', async () => {
    const first = await go({ deployId: 'p1', envName: 'prod' });
    expect(first.status).toBe('paused');

    await recordApproval({
      deployId: 'p1',
      approver: 'alice@example.com',
      role: 'operator',
      requestDir,
    });

    // Simulate daemon restart: the modules hold no in-memory caches
    // beyond the orchestrator's own registry/escalation pointers, which
    // are reset by setEscalationSink + makeStubRegistry calls below.
    resetEscalationSink();
    setEscalationSink({ raise: (e) => escalations.push(e) });

    await expect(
      recordApproval({
        deployId: 'p1',
        approver: 'alice@example.com',
        role: 'operator',
        requestDir,
      }),
    ).rejects.toThrow();

    await recordApproval({
      deployId: 'p1',
      approver: 'bob@example.com',
      role: 'operator',
      requestDir,
    });

    const second = await go({ deployId: 'p1', envName: 'prod' });
    expect(second.status).toBe('completed');
  });

  it('rejection is terminal: later runDeploy returns rejected', async () => {
    await go({ deployId: 'r1', envName: 'staging' }); // pauses
    await recordRejection({
      deployId: 'r1',
      approver: 'alice@example.com',
      role: 'operator',
      reason: 'infra freeze',
      requestDir,
    });
    const after = await go({ deployId: 'r1', envName: 'staging' });
    await flushTelemetry();
    expect(after.status).toBe('rejected');
    const comps = telemetry.filter((e) => e.type === 'deploy.completion');
    expect(comps[comps.length - 1].outcome).toBe('rejected');
  });

  it('cost-cap: prod cap=$25, $30 estimate -> CostCapExceededError', async () => {
    staticStub.setEstimate(30);
    await go({ deployId: 'c1', envName: 'prod' }); // pauses
    await recordApproval({
      deployId: 'c1',
      approver: 'alice@example.com',
      role: 'operator',
      requestDir,
    });
    await recordApproval({
      deployId: 'c1',
      approver: 'bob@example.com',
      role: 'operator',
      requestDir,
    });

    await expect(go({ deployId: 'c1', envName: 'prod' })).rejects.toBeInstanceOf(
      CostCapExceededError,
    );
    await flushTelemetry();
    const comp = telemetry.filter((e) => e.type === 'deploy.completion').pop();
    expect(comp?.outcome).toBe('cost-cap-exceeded');
  });
});
