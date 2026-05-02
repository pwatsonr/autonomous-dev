/**
 * GCPBackend unit tests (SPEC-024-1-02). Mocks the Cloud Build /
 * Cloud Run SDK clients with hand-rolled fakes that satisfy the
 * structural interfaces in `cloud-build-helper.ts` /
 * `cloud-run-helper.ts`. The credential proxy is replaced with a stub
 * that returns a fixed `ScopedCredential`.
 *
 * Coverage targets the SPEC-024-1-02 acceptance criteria for GCP:
 *   - PARAM_SCHEMA validation (region enum)
 *   - proxy.acquire is called exactly once per operation with the
 *     spec-mandated arguments
 *   - build → returns BuildArtifact with the `gcr.io/...` location
 *   - deploy → calls replaceService with the artifact image and produces
 *     a signed DeploymentRecord that round-trips through verification
 *   - healthCheck → 2xx → healthy, 5xx → unhealthy
 *   - rollback → calls updateService with the prior revision pinned to
 *     100% traffic
 *
 * @module @autonomous-dev/deploy-gcp/tests/backend.test
 */

import { GCPBackend, PARAM_SCHEMA } from '../src/backend';
import type {
  CloudBuildLikeClient,
  CloudBuildBuild,
} from '../src/cloud-build-helper';
import type {
  CloudRunLikeClient,
  CloudRunService,
  CloudRunRevision,
} from '../src/cloud-run-helper';
import type {
  CredentialProxy,
  ScopedCredential,
  ResourceScope,
  CredentialProvider,
  AcquireOptions,
} from '../../autonomous-dev/intake/deploy/credential-proxy-types';
import { verifyDeploymentRecord } from '../../autonomous-dev/intake/deploy/record-signer';
import { ParameterValidationError, CloudDeployError } from '../../autonomous-dev/intake/deploy/errors';
import type { BuildContext, BuildArtifact, DeploymentRecord } from '../../autonomous-dev/intake/deploy/types';

const TEST_KEY = Buffer.alloc(32, 0x42);
beforeAll(() => {
  process.env.DEPLOY_HMAC_KEY = TEST_KEY.toString('hex');
});
afterAll(() => {
  delete process.env.DEPLOY_HMAC_KEY;
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface RecordedAcquire {
  provider: CredentialProvider;
  operationName: string;
  scope: ResourceScope;
  options?: AcquireOptions;
}

function makeProxy(): { proxy: CredentialProxy; calls: () => readonly RecordedAcquire[] } {
  const calls: RecordedAcquire[] = [];
  const proxy: CredentialProxy = {
    async acquire(provider, operationName, scope, options) {
      calls.push({ provider, operationName, scope, options });
      const cred: ScopedCredential = {
        cloud: provider,
        expiresAt: new Date(Date.now() + 900_000),
        tokenId: 'tok-1',
        token: 'fake-gcp-access-token',
      };
      return cred;
    },
  };
  return { proxy, calls: () => calls };
}

function validParams(): Record<string, string | number> {
  return {
    project_id: 'test-project',
    region: 'us-central1',
    service_name: 'api',
    image_repo: 'api',
    cpu: '1',
    memory_mib: 512,
    health_path: '/health',
    health_timeout_seconds: 30,
  };
}

function ctx(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    repoPath: '/tmp/repo',
    commitSha: 'abc123def456abc123def456abc123def456abcd',
    branch: 'main',
    requestId: 'req-1',
    cleanWorktree: true,
    params: validParams(),
    ...overrides,
  };
}

function makeBuildClient(buildResult: CloudBuildBuild): {
  client: CloudBuildLikeClient;
  createCalls: number;
  getCalls: number;
} {
  let createCalls = 0;
  let getCalls = 0;
  const client: CloudBuildLikeClient = {
    async createBuild() {
      createCalls++;
      return [{ metadata: { build: { id: 'build-12345' } } }, {}, {}];
    },
    async getBuild() {
      getCalls++;
      return [buildResult, {}, {}];
    },
  };
  return {
    client,
    get createCalls() {
      return createCalls;
    },
    get getCalls() {
      return getCalls;
    },
  };
}

function makeRunClient(opts: {
  service: CloudRunService;
  revisions?: readonly CloudRunRevision[];
}): {
  client: CloudRunLikeClient;
  replaceCalls: Array<{ name: string; service: CloudRunService }>;
  updateCalls: Array<{ name: string; service: CloudRunService }>;
} {
  const replaceCalls: Array<{ name: string; service: CloudRunService }> = [];
  const updateCalls: Array<{ name: string; service: CloudRunService }> = [];
  const client: CloudRunLikeClient = {
    async replaceService(req) {
      replaceCalls.push({ name: req.name, service: req.service });
      return [opts.service, {}, {}];
    },
    async updateService(req) {
      updateCalls.push({ name: req.name, service: req.service });
      return [opts.service, {}, {}];
    },
    async listRevisions() {
      return [opts.revisions ?? [], {}, {}];
    },
  };
  return { client, replaceCalls, updateCalls };
}

// ---------------------------------------------------------------------------
// metadata + PARAM_SCHEMA
// ---------------------------------------------------------------------------

describe('GCPBackend metadata + PARAM_SCHEMA', () => {
  it('exports PARAM_SCHEMA with region as enum', () => {
    expect(PARAM_SCHEMA.region.type).toBe('enum');
    expect(PARAM_SCHEMA.region.enum).toBeDefined();
    expect(PARAM_SCHEMA.region.enum?.includes('us-central1')).toBe(true);
  });

  it('declares supportedTargets/capabilities = gcp-cloud-run and no requiredTools', () => {
    const { proxy } = makeProxy();
    const b = new GCPBackend({ proxy });
    expect(b.metadata.name).toBe('gcp');
    expect(b.metadata.supportedTargets).toEqual(['gcp-cloud-run']);
    expect(b.metadata.capabilities).toEqual(['gcp-cloud-run']);
    expect(b.metadata.requiredTools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// build()
// ---------------------------------------------------------------------------

describe('GCPBackend.build', () => {
  it('acquires creds with operation=CloudBuild:CreateBuild and returns a docker-image artifact', async () => {
    const { proxy, calls } = makeProxy();
    const cb = makeBuildClient({
      id: 'build-12345',
      status: 'SUCCESS',
      results: {
        images: [{ digest: 'sha256:abcd' }],
      },
    });
    const b = new GCPBackend({
      proxy,
      cloudBuildClientFactory: () => cb.client,
      cloudRunClientFactory: () => makeRunClient({ service: {} }).client,
    });
    const artifact = await b.build(ctx());
    expect(artifact.type).toBe('docker-image');
    expect(artifact.location).toBe(
      'gcr.io/test-project/api:abc123def456abc123def456abc123def456abcd',
    );
    expect(artifact.checksum).toBe('abcd');
    expect(artifact.metadata.project_id).toBe('test-project');
    expect(artifact.metadata.region).toBe('us-central1');

    const acquireCalls = calls();
    expect(acquireCalls).toHaveLength(1);
    expect(acquireCalls[0].provider).toBe('gcp');
    expect(acquireCalls[0].operationName).toBe('CloudBuild:CreateBuild');
    expect(acquireCalls[0].scope.resource).toBe('projects/test-project');
    expect(acquireCalls[0].scope.region).toBe('us-central1');
  });

  it('throws CloudDeployError when Cloud Build status is FAILURE', async () => {
    const { proxy } = makeProxy();
    const cb = makeBuildClient({
      id: 'build-66666',
      status: 'FAILURE',
      statusDetail: 'Step 0 failed',
    });
    const b = new GCPBackend({
      proxy,
      cloudBuildClientFactory: () => cb.client,
      cloudRunClientFactory: () => makeRunClient({ service: {} }).client,
    });
    await expect(b.build(ctx())).rejects.toBeInstanceOf(CloudDeployError);
  });

  it('throws ParameterValidationError when region is not in GCP_REGIONS', async () => {
    const { proxy } = makeProxy();
    const b = new GCPBackend({
      proxy,
      cloudBuildClientFactory: () => makeBuildClient({ status: 'SUCCESS' }).client,
      cloudRunClientFactory: () => makeRunClient({ service: {} }).client,
    });
    await expect(
      b.build(ctx({ params: { ...validParams(), region: 'mars-central1' } })),
    ).rejects.toBeInstanceOf(ParameterValidationError);
  });
});

// ---------------------------------------------------------------------------
// deploy()
// ---------------------------------------------------------------------------

describe('GCPBackend.deploy', () => {
  async function buildArtifact(): Promise<BuildArtifact> {
    return {
      artifactId: '01HXXXXXXXXXXXXXXXXXXXXXXX',
      type: 'docker-image',
      location: 'gcr.io/test-project/api:abc123',
      checksum: 'd1ge57',
      sizeBytes: 0,
      metadata: { project_id: 'test-project', region: 'us-central1' },
    };
  }

  it('calls replaceService with artifact image, returns a signed DeploymentRecord', async () => {
    const { proxy } = makeProxy();
    const run = makeRunClient({
      service: {
        name: 'projects/test-project/locations/us-central1/services/api',
        uri: 'https://api.example.run.app',
        latestReadyRevision: 'api-00002-abc',
      },
    });
    const b = new GCPBackend({
      proxy,
      cloudBuildClientFactory: () => makeBuildClient({ status: 'SUCCESS' }).client,
      cloudRunClientFactory: () => run.client,
    });
    const record = await b.deploy(await buildArtifact(), 'staging', validParams());
    expect(record.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyDeploymentRecord(record).valid).toBe(true);
    expect(record.details.service_url).toBe('https://api.example.run.app');
    expect(record.details.revision_name).toBe('api-00002-abc');

    expect(run.replaceCalls).toHaveLength(1);
    const sentImage = run.replaceCalls[0].service.template?.containers?.[0]?.image;
    expect(sentImage).toBe('gcr.io/test-project/api:abc123');
  });

  it('rejects when region not in GCP_REGIONS', async () => {
    const { proxy } = makeProxy();
    const b = new GCPBackend({ proxy });
    await expect(
      b.deploy(await buildArtifact(), 'staging', { ...validParams(), region: 'mars-central1' }),
    ).rejects.toBeInstanceOf(ParameterValidationError);
  });

  it('propagates CloudDeployError from replaceService failure', async () => {
    const { proxy } = makeProxy();
    const failingClient: CloudRunLikeClient = {
      async replaceService() {
        throw Object.assign(new Error('denied'), { code: 7 });
      },
      async updateService() {
        throw new Error('not used');
      },
      async listRevisions() {
        return [];
      },
    };
    const b = new GCPBackend({
      proxy,
      cloudBuildClientFactory: () => makeBuildClient({ status: 'SUCCESS' }).client,
      cloudRunClientFactory: () => failingClient,
    });
    const err = await b.deploy(await buildArtifact(), 'staging', validParams()).catch((e) => e);
    expect(err).toBeInstanceOf(CloudDeployError);
    expect((err as CloudDeployError).code).toBe('AUTH_FAILED');
  });
});

// ---------------------------------------------------------------------------
// healthCheck()
// ---------------------------------------------------------------------------

describe('GCPBackend.healthCheck', () => {
  function makeRecord(extra: Partial<DeploymentRecord['details']> = {}): DeploymentRecord {
    return {
      deployId: 'd-1',
      backend: 'gcp',
      environment: 'staging',
      artifactId: 'a-1',
      deployedAt: new Date(0).toISOString(),
      status: 'deployed',
      details: {
        service_url: 'https://api.example.run.app',
        revision_name: 'api-00002-abc',
        project_id: 'test-project',
        region: 'us-central1',
        service_name: 'api',
        health_path: '/health',
        health_timeout_seconds: 5,
        ...extra,
      },
      hmac: 'x'.repeat(64),
    };
  }

  it('returns healthy:true on first 200 response', async () => {
    const { proxy } = makeProxy();
    const fetchImpl = jest.fn().mockResolvedValue({ status: 200 } as Response);
    const b = new GCPBackend({ proxy, fetchImpl: fetchImpl as unknown as typeof fetch });
    const status = await b.healthCheck(makeRecord());
    expect(status.healthy).toBe(true);
    expect(status.checks).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledWith('https://api.example.run.app/health');
  });

  it('returns healthy:false with unhealthyReason when probes are 500', async () => {
    const { proxy } = makeProxy();
    const fetchImpl = jest.fn().mockResolvedValue({ status: 500 } as Response);
    let nowMs = 0;
    const b = new GCPBackend({
      proxy,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => nowMs,
      sleep: async (ms: number) => {
        nowMs += ms;
      },
    });
    const status = await b.healthCheck(makeRecord({ health_timeout_seconds: 1 }));
    expect(status.healthy).toBe(false);
    expect(status.unhealthyReason).toBeDefined();
    expect(status.checks.every((c) => !c.passed)).toBe(true);
  });

  it('returns healthy:false when service_url missing from record', async () => {
    const { proxy } = makeProxy();
    const b = new GCPBackend({ proxy });
    const status = await b.healthCheck(makeRecord({ service_url: '' }));
    expect(status.healthy).toBe(false);
    expect(status.unhealthyReason).toBe('service-url-missing');
  });
});

// ---------------------------------------------------------------------------
// rollback()
// ---------------------------------------------------------------------------

describe('GCPBackend.rollback', () => {
  function rollbackRecord(): DeploymentRecord {
    return {
      deployId: 'd-1',
      backend: 'gcp',
      environment: 'staging',
      artifactId: 'a-1',
      deployedAt: new Date(0).toISOString(),
      status: 'deployed',
      details: {
        project_id: 'test-project',
        region: 'us-central1',
        service_name: 'api',
        revision_name: 'api-00002-abc',
        service_url: 'https://api.example.run.app',
        image_uri: 'gcr.io/test-project/api:abc123',
        health_path: '/health',
        health_timeout_seconds: 30,
      },
      hmac: 'x'.repeat(64),
    };
  }

  it('shifts traffic 100% to previous revision', async () => {
    const { proxy } = makeProxy();
    const run = makeRunClient({
      service: { name: 'projects/test-project/locations/us-central1/services/api' },
      revisions: [
        {
          name: 'api-00002-abc',
          createTime: '2025-04-01T10:00:00Z',
          containers: [{ image: 'gcr.io/test-project/api:abc123' }],
        },
        {
          name: 'api-00001-def',
          createTime: '2025-03-01T10:00:00Z',
          containers: [{ image: 'gcr.io/test-project/api:def456' }],
        },
      ],
    });
    const b = new GCPBackend({
      proxy,
      cloudRunClientFactory: () => run.client,
      cloudBuildClientFactory: () => makeBuildClient({ status: 'SUCCESS' }).client,
    });
    const result = await b.rollback(rollbackRecord());
    expect(result.success).toBe(true);
    expect(run.updateCalls).toHaveLength(1);
    expect(run.updateCalls[0].service.traffic).toEqual([
      { revision: 'api-00001-def', percent: 100 },
    ]);
    expect(result.restoredArtifactId).toBe('gcr.io/test-project/api:def456');
  });

  it('returns success:false when listRevisions has no prior revision', async () => {
    const { proxy } = makeProxy();
    const run = makeRunClient({
      service: {},
      revisions: [
        {
          name: 'api-00002-abc',
          createTime: '2025-04-01T10:00:00Z',
        },
      ],
    });
    const b = new GCPBackend({
      proxy,
      cloudRunClientFactory: () => run.client,
    });
    const result = await b.rollback(rollbackRecord());
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/no previous revision/);
  });
});
