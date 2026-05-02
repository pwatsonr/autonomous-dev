/**
 * AzureBackend unit tests (SPEC-024-1-03). Mocks the ACR / Container
 * Apps SDK clients with hand-rolled fakes that satisfy the structural
 * interfaces in `acr-builder.ts` and `container-apps-deployer.ts`. The
 * credential proxy is replaced with a stub that returns a fixed
 * `ScopedCredential` carrying a bearer token.
 *
 * Coverage targets the SPEC-024-1-03 acceptance criteria for Azure:
 *   - PARAM_SCHEMA validation (subscription_id GUID regex, location enum)
 *   - proxy.acquire is called with the spec-mandated arguments
 *   - build → image URI matches `<acr>.azurecr.io/<repo>:<sha>`
 *     and NEVER shells out (child_process spies)
 *   - deploy → captures `previous_revision` BEFORE update (mock call order)
 *   - deploy → returned record's HMAC verifies
 *   - healthCheck → uses front_door_endpoint when set, falls back to
 *     ingress_fqdn otherwise
 *   - rollback → updateTraffic called with weight:100 for previous revision
 *
 * @module @autonomous-dev/deploy-azure/tests/backend.test
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AzureBackend, AZURE_LOCATIONS, PARAM_SCHEMA } from '../src/backend';

// Mock node:child_process so we can assert no shell-outs occur during build.
jest.mock('node:child_process', () => {
  const actual = jest.requireActual('node:child_process') as Record<string, unknown>;
  return {
    ...actual,
    execFile: jest.fn(),
    spawn: jest.fn(),
    exec: jest.fn(),
  };
});

// eslint-disable-next-line import/order
import * as childProcess from 'node:child_process';
import type { AcrLikeClient, AcrRun } from '../src/acr-builder';
import type {
  ContainerAppResource,
  ContainerAppsLikeClient,
} from '../src/container-apps-deployer';
import type {
  CredentialProxy,
  ScopedCredential,
  ResourceScope,
  CredentialProvider,
  AcquireOptions,
} from '../../autonomous-dev/intake/deploy/credential-proxy-types';
import { verifyDeploymentRecord } from '../../autonomous-dev/intake/deploy/record-signer';
import {
  CloudDeployError,
  ParameterValidationError,
} from '../../autonomous-dev/intake/deploy/errors';
import type {
  BuildArtifact,
  BuildContext,
  DeploymentRecord,
} from '../../autonomous-dev/intake/deploy/types';

const TEST_KEY = Buffer.alloc(32, 0x77);
beforeAll(() => {
  process.env.DEPLOY_HMAC_KEY = TEST_KEY.toString('hex');
});
afterAll(() => {
  delete process.env.DEPLOY_HMAC_KEY;
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const FIXTURES = join(__dirname, 'fixtures');
function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

const ACR_RUN_STARTED = readJson<AcrRun>('acr-run-started.json');
const ACR_RUN_SUCCEEDED = readJson<AcrRun>('acr-run-succeeded.json');
const CONTAINER_APP_GET = readJson<ContainerAppResource>('container-app-get.json');
const CONTAINER_APP_UPDATE = readJson<ContainerAppResource>('container-app-update.json');

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
        tokenId: 'tok-azure-1',
        token: 'azure-bearer-token',
      };
      return cred;
    },
  };
  return { proxy, calls: () => calls };
}

const VALID_SUBSCRIPTION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function validParams(): Record<string, string | number> {
  return {
    subscription_id: VALID_SUBSCRIPTION,
    resource_group: 'web-rg',
    location: 'eastus',
    acr_name: 'myacr',
    container_app_name: 'web-app',
    image_repo: 'web',
    cpu: '0.5',
    memory_gib: '1.0',
    front_door_endpoint: 'https://app.azurefd.net',
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

function makeAcrClient(opts: {
  failSchedule?: boolean;
  succeedAfter?: number;
} = {}): { client: AcrLikeClient; calls: { schedule: number; get: number } } {
  const calls = { schedule: 0, get: 0 };
  const succeedAfter = opts.succeedAfter ?? 0;
  const client: AcrLikeClient = {
    async scheduleDockerBuildRun() {
      calls.schedule++;
      if (opts.failSchedule) {
        throw Object.assign(new Error('throttled'), { code: 'Throttled' });
      }
      return ACR_RUN_STARTED;
    },
    async getRun() {
      calls.get++;
      if (calls.get > succeedAfter) {
        return ACR_RUN_SUCCEEDED;
      }
      return { runId: ACR_RUN_STARTED.runId, status: 'Running' };
    },
  };
  return { client, calls };
}

interface ContainerAppsCallLog {
  ops: string[];
  trafficUpdates: Array<{ revisionName: string; weight: number }[]>;
}

function makeContainerAppsClient(opts: {
  failGet?: boolean;
  failUpdate?: boolean;
  failTraffic?: boolean;
} = {}): { client: ContainerAppsLikeClient; log: ContainerAppsCallLog } {
  const log: ContainerAppsCallLog = { ops: [], trafficUpdates: [] };
  const client: ContainerAppsLikeClient = {
    async getContainerApp() {
      log.ops.push('Get');
      if (opts.failGet) {
        throw Object.assign(new Error('forbidden'), {
          code: 'AuthenticationFailed',
        });
      }
      return CONTAINER_APP_GET;
    },
    async updateContainerApp() {
      log.ops.push('Update');
      if (opts.failUpdate) {
        throw Object.assign(new Error('throttled'), { code: 'Throttled' });
      }
      return CONTAINER_APP_UPDATE;
    },
    async updateTraffic({ traffic }) {
      log.ops.push('UpdateTraffic');
      log.trafficUpdates.push([...traffic]);
      if (opts.failTraffic) {
        throw new Error('boom');
      }
      return CONTAINER_APP_UPDATE;
    },
  };
  return { client, log };
}

// ---------------------------------------------------------------------------
// metadata + PARAM_SCHEMA
// ---------------------------------------------------------------------------

describe('AzureBackend metadata + PARAM_SCHEMA', () => {
  it('PARAM_SCHEMA enforces subscription_id GUID regex', () => {
    const re = PARAM_SCHEMA.subscription_id.regex;
    expect(re).toBeDefined();
    expect(re?.test(VALID_SUBSCRIPTION)).toBe(true);
    expect(re?.test('not-a-guid')).toBe(false);
  });

  it('PARAM_SCHEMA includes a closed-world location enum', () => {
    expect(PARAM_SCHEMA.location.type).toBe('enum');
    expect(PARAM_SCHEMA.location.enum).toEqual(AZURE_LOCATIONS);
  });

  it('declares supportedTargets/capabilities = azure-container-apps and no requiredTools', () => {
    const { proxy } = makeProxy();
    const b = new AzureBackend({ proxy });
    expect(b.metadata.name).toBe('azure');
    expect(b.metadata.supportedTargets).toEqual(['azure-container-apps']);
    expect(b.metadata.capabilities).toEqual(['azure-container-apps']);
    expect(b.metadata.requiredTools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// build()
// ---------------------------------------------------------------------------

describe('AzureBackend.build', () => {
  it('returns a docker-image artifact at <acr>.azurecr.io/<repo>:<sha>', async () => {
    const { proxy, calls } = makeProxy();
    const acr = makeAcrClient();
    const b = new AzureBackend({
      proxy,
      acrClientFactory: () => acr.client,
      containerAppsClientFactory: () => makeContainerAppsClient().client,
      sleep: async () => {},
    });
    const artifact = await b.build(ctx());
    expect(artifact.location).toBe(
      'myacr.azurecr.io/web:abc123def456abc123def456abc123def456abcd',
    );
    expect(artifact.type).toBe('docker-image');
    expect(artifact.checksum).toBe('deadbeefcafe1234');
    expect(artifact.metadata.run_id).toBe('run-abc123');
    expect(artifact.metadata.acr_name).toBe('myacr');
    expect(artifact.metadata.location).toBe('eastus');

    const acquireCalls = calls();
    expect(acquireCalls).toHaveLength(1);
    expect(acquireCalls[0].provider).toBe('azure');
    expect(acquireCalls[0].operationName).toBe('ACR:BuildTask');
    expect(acquireCalls[0].scope.resource).toBe(
      `/subscriptions/${VALID_SUBSCRIPTION}/resourceGroups/web-rg/providers/Microsoft.ContainerRegistry/registries/myacr`,
    );
  });

  it('does NOT shell out — child_process.execFile/spawn/exec are never called', async () => {
    const { proxy } = makeProxy();
    const acr = makeAcrClient();
    const execFileMock = childProcess.execFile as unknown as jest.Mock;
    const spawnMock = childProcess.spawn as unknown as jest.Mock;
    const execMock = childProcess.exec as unknown as jest.Mock;
    execFileMock.mockClear();
    spawnMock.mockClear();
    execMock.mockClear();
    const b = new AzureBackend({
      proxy,
      acrClientFactory: () => acr.client,
      containerAppsClientFactory: () => makeContainerAppsClient().client,
      sleep: async () => {},
    });
    await b.build(ctx());
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it('rejects when subscription_id does not match the GUID regex', async () => {
    const { proxy } = makeProxy();
    const b = new AzureBackend({ proxy });
    await expect(
      b.build(ctx({ params: { ...validParams(), subscription_id: 'not-a-guid' } })),
    ).rejects.toBeInstanceOf(ParameterValidationError);
  });

  it('translates Throttled SDK error to RATE_LIMIT', async () => {
    const { proxy } = makeProxy();
    const acr = makeAcrClient({ failSchedule: true });
    const b = new AzureBackend({
      proxy,
      acrClientFactory: () => acr.client,
      sleep: async () => {},
    });
    const err = await b.build(ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(CloudDeployError);
    expect((err as CloudDeployError).code).toBe('RATE_LIMIT');
    expect((err as CloudDeployError).retriable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deploy()
// ---------------------------------------------------------------------------

describe('AzureBackend.deploy', () => {
  function makeArtifact(): BuildArtifact {
    return {
      artifactId: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      type: 'docker-image',
      location:
        'myacr.azurecr.io/web:abc123def456abc123def456abc123def456abcd',
      checksum: 'deadbeefcafe1234',
      sizeBytes: 0,
      metadata: { run_id: 'run-abc123' },
    };
  }

  it('captures previous_revision BEFORE updating (Get then Update)', async () => {
    const { proxy } = makeProxy();
    const ca = makeContainerAppsClient();
    const b = new AzureBackend({
      proxy,
      containerAppsClientFactory: () => ca.client,
    });
    const record = await b.deploy(makeArtifact(), 'staging', validParams());
    expect(ca.log.ops).toEqual(['Get', 'Update']);
    expect(record.details.previous_revision).toBe('web-app--rev1');
    expect(record.details.revision_name).toBe('web-app--rev2');
  });

  it('returns a signed DeploymentRecord whose hmac verifies', async () => {
    const { proxy } = makeProxy();
    const ca = makeContainerAppsClient();
    const b = new AzureBackend({
      proxy,
      containerAppsClientFactory: () => ca.client,
    });
    const record = await b.deploy(makeArtifact(), 'staging', validParams());
    expect(record.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyDeploymentRecord(record).valid).toBe(true);
    expect(record.details.image_uri).toBe(
      'myacr.azurecr.io/web:abc123def456abc123def456abc123def456abcd',
    );
    expect(record.details.location).toBe('eastus');
  });

  it('calls proxy.acquire with the operation-scoped Container App resource', async () => {
    const { proxy, calls } = makeProxy();
    const ca = makeContainerAppsClient();
    const b = new AzureBackend({
      proxy,
      containerAppsClientFactory: () => ca.client,
    });
    await b.deploy(makeArtifact(), 'staging', validParams());
    const acquireCalls = calls();
    expect(acquireCalls).toHaveLength(1);
    expect(acquireCalls[0].provider).toBe('azure');
    expect(acquireCalls[0].operationName).toBe('ContainerApps:CreateRevision');
    expect(acquireCalls[0].scope.resource).toBe(
      `/subscriptions/${VALID_SUBSCRIPTION}/resourceGroups/web-rg/providers/Microsoft.App/containerApps/web-app`,
    );
  });

  it('rejects when subscription_id is not a GUID', async () => {
    const { proxy } = makeProxy();
    const b = new AzureBackend({ proxy });
    await expect(
      b.deploy(makeArtifact(), 'staging', { ...validParams(), subscription_id: 'bad' }),
    ).rejects.toBeInstanceOf(ParameterValidationError);
  });

  it('translates AuthenticationFailed to AUTH_FAILED', async () => {
    const { proxy } = makeProxy();
    const ca = makeContainerAppsClient({ failGet: true });
    const b = new AzureBackend({
      proxy,
      containerAppsClientFactory: () => ca.client,
    });
    const err = await b
      .deploy(makeArtifact(), 'staging', validParams())
      .catch((e) => e);
    expect(err).toBeInstanceOf(CloudDeployError);
    expect((err as CloudDeployError).code).toBe('AUTH_FAILED');
  });
});

// ---------------------------------------------------------------------------
// healthCheck()
// ---------------------------------------------------------------------------

describe('AzureBackend.healthCheck', () => {
  function makeRecord(extra: Partial<DeploymentRecord['details']> = {}): DeploymentRecord {
    return {
      deployId: 'd-1',
      backend: 'azure',
      environment: 'staging',
      artifactId: 'a-1',
      deployedAt: new Date(0).toISOString(),
      status: 'deployed',
      details: {
        revision_name: 'web-app--rev2',
        previous_revision: 'web-app--rev1',
        image_uri: 'myacr.azurecr.io/web:abc',
        location: 'eastus',
        subscription_id: VALID_SUBSCRIPTION,
        resource_group: 'web-rg',
        container_app_name: 'web-app',
        ingress_fqdn: 'web-app.azurecontainerapps.io',
        front_door_endpoint: 'https://app.azurefd.net',
        health_path: '/health',
        health_timeout_seconds: 5,
        ...extra,
      },
      hmac: 'x'.repeat(64),
    };
  }

  it('polls front_door_endpoint + health_path when set', async () => {
    const { proxy } = makeProxy();
    const calls: string[] = [];
    const fetchImpl: typeof fetch = (async (url: string) => {
      calls.push(url);
      return { status: 200 } as unknown as Response;
    }) as unknown as typeof fetch;
    const b = new AzureBackend({ proxy, fetchImpl });
    const status = await b.healthCheck(makeRecord());
    expect(status.healthy).toBe(true);
    expect(calls).toEqual(['https://app.azurefd.net/health']);
  });

  it('falls back to ingress_fqdn when front_door_endpoint not set', async () => {
    const { proxy } = makeProxy();
    const calls: string[] = [];
    const fetchImpl: typeof fetch = (async (url: string) => {
      calls.push(url);
      return { status: 204 } as unknown as Response;
    }) as unknown as typeof fetch;
    const b = new AzureBackend({ proxy, fetchImpl });
    const status = await b.healthCheck(makeRecord({ front_door_endpoint: '' }));
    expect(status.healthy).toBe(true);
    expect(calls).toEqual(['https://web-app.azurecontainerapps.io/health']);
  });

  it('returns healthy:false with reason on timeout', async () => {
    const { proxy } = makeProxy();
    let nowMs = 0;
    const fetchImpl: typeof fetch = (async () =>
      ({ status: 503 }) as unknown as Response) as unknown as typeof fetch;
    const b = new AzureBackend({
      proxy,
      fetchImpl,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
    });
    const status = await b.healthCheck(makeRecord({ health_timeout_seconds: 1 }));
    expect(status.healthy).toBe(false);
    expect(status.unhealthyReason).toBe('http-503');
  });

  it('returns healthy:false when both front_door_endpoint and ingress_fqdn missing', async () => {
    const { proxy } = makeProxy();
    const b = new AzureBackend({ proxy });
    const status = await b.healthCheck(
      makeRecord({ front_door_endpoint: '', ingress_fqdn: '' }),
    );
    expect(status.healthy).toBe(false);
    expect(status.unhealthyReason).toBe('record-missing-front-door-or-ingress');
  });
});

// ---------------------------------------------------------------------------
// rollback()
// ---------------------------------------------------------------------------

describe('AzureBackend.rollback', () => {
  function rollbackRecord(): DeploymentRecord {
    return {
      deployId: 'd-1',
      backend: 'azure',
      environment: 'staging',
      artifactId: 'a-1',
      deployedAt: new Date(0).toISOString(),
      status: 'deployed',
      details: {
        revision_name: 'web-app--rev2',
        previous_revision: 'web-app--rev1',
        image_uri: 'myacr.azurecr.io/web:abc',
        location: 'eastus',
        subscription_id: VALID_SUBSCRIPTION,
        resource_group: 'web-rg',
        container_app_name: 'web-app',
        ingress_fqdn: 'web-app.azurecontainerapps.io',
        front_door_endpoint: '',
        health_path: '/health',
        health_timeout_seconds: 30,
      },
      hmac: 'x'.repeat(64),
    };
  }

  it('updates traffic with weight:100 for the previous revision', async () => {
    const { proxy } = makeProxy();
    const ca = makeContainerAppsClient();
    const b = new AzureBackend({
      proxy,
      containerAppsClientFactory: () => ca.client,
    });
    const result = await b.rollback(rollbackRecord());
    expect(result.success).toBe(true);
    expect(result.restoredArtifactId).toBe('web-app--rev1');
    expect(ca.log.trafficUpdates).toHaveLength(1);
    expect(ca.log.trafficUpdates[0]).toEqual([
      { revisionName: 'web-app--rev1', weight: 100 },
    ]);
  });

  it('returns success:false when previous_revision missing from record', async () => {
    const { proxy } = makeProxy();
    const b = new AzureBackend({ proxy });
    const rec = rollbackRecord();
    rec.details.previous_revision = '';
    const result = await b.rollback(rec);
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/missing/);
  });

  it('returns success:false when updateTraffic throws', async () => {
    const { proxy } = makeProxy();
    const ca = makeContainerAppsClient({ failTraffic: true });
    const b = new AzureBackend({
      proxy,
      containerAppsClientFactory: () => ca.client,
    });
    const result = await b.rollback(rollbackRecord());
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/boom/);
  });
});

// ---------------------------------------------------------------------------
// Skipped integration tests requiring real Azure (no public emulator).
// Promoted to a release-time manual smoke step in SPEC-024-1-05.
// ---------------------------------------------------------------------------

describe('AzureBackend integration (skipped)', () => {
  it.skip('Live Azure: build → ACR push → Container Apps deploy → Front Door health → rollback', async () => {
    // Promoted to release-time manual smoke in SPEC-024-1-05; Azure has no public emulator.
  });
});
