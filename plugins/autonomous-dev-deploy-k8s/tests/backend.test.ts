/**
 * K8sBackend unit tests (SPEC-024-1-03). Mocks `KubeConfig` and the
 * typed `AppsV1Api`/`CoreV1Api`/`KubernetesObjectApi` clients with
 * hand-rolled fakes that satisfy the structural interfaces in
 * `manifest-applier.ts`. The credential proxy is replaced with a stub
 * that returns a fixed `ScopedCredential` carrying a kubeconfig YAML.
 *
 * Coverage targets the SPEC-024-1-03 acceptance criteria for K8s:
 *   - PARAM_SCHEMA validation
 *   - build is a no-op returning a reproducible-checksum reference artifact
 *   - proxy.acquire is called with the spec-mandated arguments
 *   - deploy NEVER shells out (child_process spies)
 *   - manifest scope check rejects cross-namespace + cluster-scoped kinds
 *   - previous_revision captured from the Deployment annotation BEFORE apply
 *   - OPA Gatekeeper rejection translates to POLICY_VIOLATION + reason
 *   - healthCheck happy path and ImagePullBackOff path
 *   - rollback calls createNamespacedDeploymentRollback; failure surfaces error
 *
 * @module @autonomous-dev/deploy-k8s/tests/backend.test
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { K8sBackend, PARAM_SCHEMA } from '../src/backend';

// Mock node:child_process so we can assert no shell-outs occur.
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
import type {
  AppsV1LikeApi,
  CoreV1LikeApi,
  KubernetesObjectLikeApi,
  ManifestDoc,
} from '../src/manifest-applier';
import type { KubeConfigLike } from '../src/credential-proxy-client';
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

const TEST_KEY = Buffer.alloc(32, 0x55);
beforeAll(() => {
  process.env.DEPLOY_HMAC_KEY = TEST_KEY.toString('hex');
});
afterAll(() => {
  delete process.env.DEPLOY_HMAC_KEY;
});

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

const FIXTURES = join(__dirname, 'fixtures', 'manifests');
function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}
function readFixtureJson<T>(name: string): T {
  return JSON.parse(readFixture(name)) as T;
}

interface OpaResponseShape {
  statusCode: number;
  body: {
    kind?: string;
    code?: number;
    reason?: string;
    message?: string;
    details?: {
      kind?: string;
      causes?: Array<{ message?: string; reason?: string; field?: string }>;
    };
  };
}

/**
 * Hand-rolled YAML splitter sufficient for the fixtures: splits on
 * `---` lines and parses each chunk as a flat object via a tiny
 * recursive-descent. Production code uses `js-yaml`, but tests inject
 * this stub so we don't add a dev-dep dance.
 */
function tinyYamlParser(text: string): ManifestDoc[] {
  const docs: ManifestDoc[] = [];
  for (const chunk of text.split(/^---\s*$/m)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const doc = parseFlatYaml(trimmed);
    if (doc) docs.push(doc);
  }
  return docs;
}

function parseFlatYaml(text: string): ManifestDoc | null {
  // Convert to a JSON-able object: track indentation depth, emit nested
  // maps. Sufficient for our fixtures (no flow scalars, no anchors).
  const lines = text.split(/\r?\n/);
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; container: Record<string, unknown> | unknown[] }> = [
    { indent: -1, container: root },
  ];
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^ */)?.[0].length ?? 0;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const top = stack[stack.length - 1];
    const line = raw.trim();
    if (line.startsWith('- ')) {
      // Sequence entry — wrap parent into an array if needed.
      if (!Array.isArray(top.container)) {
        // Coerce: replace the parent's last key value with an array.
        // Our fixtures only use sequences as values, so we look up the
        // last set key on the grandparent.
        const grand = stack[stack.length - 2];
        if (!grand) continue;
        const keys = Object.keys(grand.container as Record<string, unknown>);
        const lastKey = keys[keys.length - 1];
        const arr: unknown[] = [];
        (grand.container as Record<string, unknown>)[lastKey] = arr;
        top.container = arr;
      }
      const arr = top.container as unknown[];
      const rest = line.slice(2).trim();
      if (rest.includes(':')) {
        const obj: Record<string, unknown> = {};
        arr.push(obj);
        const [k, v] = splitKv(rest);
        if (v !== undefined) {
          obj[k] = coerceScalar(v);
        }
        stack.push({ indent, container: obj });
      } else {
        arr.push(coerceScalar(rest));
      }
      continue;
    }
    if (line.includes(':')) {
      const [k, v] = splitKv(line);
      if (v === undefined || v === '') {
        const child: Record<string, unknown> = {};
        if (Array.isArray(top.container)) {
          // Inline mapping inside a list item.
          (top.container[top.container.length - 1] as Record<string, unknown>)[k] = child;
        } else {
          (top.container as Record<string, unknown>)[k] = child;
        }
        stack.push({ indent, container: child });
      } else {
        if (Array.isArray(top.container)) {
          (top.container[top.container.length - 1] as Record<string, unknown>)[k] =
            coerceScalar(v);
        } else {
          (top.container as Record<string, unknown>)[k] = coerceScalar(v);
        }
      }
    }
  }
  return root as ManifestDoc;
}

function splitKv(line: string): [string, string | undefined] {
  const idx = line.indexOf(':');
  const k = line.slice(0, idx).trim();
  const v = line.slice(idx + 1).trim();
  return [k, v.length === 0 ? undefined : v];
}

function coerceScalar(v: string): string | number | boolean {
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v.replace(/^['"]|['"]$/g, '');
}

// ---------------------------------------------------------------------------
// proxy + KubeConfig stubs
// ---------------------------------------------------------------------------

interface RecordedAcquire {
  provider: CredentialProvider;
  operationName: string;
  scope: ResourceScope;
  options?: AcquireOptions;
}

function makeProxy(
  overrides: { kubeconfig?: string } = {},
): { proxy: CredentialProxy; calls: () => readonly RecordedAcquire[] } {
  const calls: RecordedAcquire[] = [];
  const proxy: CredentialProxy = {
    async acquire(provider, operationName, scope, options) {
      calls.push({ provider, operationName, scope, options });
      const cred: ScopedCredential = {
        cloud: provider,
        expiresAt: new Date(Date.now() + 900_000),
        tokenId: 'tok-k8s-1',
        kubeconfig:
          overrides.kubeconfig ??
          'apiVersion: v1\nkind: Config\ncurrent-context: stub\n',
      };
      return cred;
    },
  };
  return { proxy, calls: () => calls };
}

function makeKubeConfigFactory(): {
  factory: (yaml: string) => KubeConfigLike;
  yamls: string[];
} {
  const yamls: string[] = [];
  const factory = (yaml: string): KubeConfigLike => {
    yamls.push(yaml);
    return {
      getCurrentContext: () => 'stub',
      makeApiClient: () => {
        throw new Error('makeApiClient should be replaced by apiClientResolver in tests');
      },
    };
  };
  return { factory, yamls };
}

interface AppsCallLog {
  ops: string[];
  readDeploymentResponses: Array<{
    annotations?: Record<string, string>;
    generation?: number;
    status?: {
      replicas?: number;
      readyReplicas?: number;
      observedGeneration?: number;
    };
  }>;
  rollbackResponse?: { revision?: string };
  failOnRead?: 'not-found' | 'forbidden';
  failOnReplace?: 'opa' | 'forbidden' | 'rate-limit';
  failOnRollback?: number;
}

function makeApis(log: AppsCallLog): {
  appsV1: AppsV1LikeApi;
  coreV1: CoreV1LikeApi;
  objectApi: KubernetesObjectLikeApi;
} {
  let readIdx = 0;
  const appsV1: AppsV1LikeApi = {
    async readNamespacedDeployment(name, namespace) {
      log.ops.push(`Read:${namespace}/${name}`);
      if (log.failOnRead === 'not-found') {
        throw {
          statusCode: 404,
          body: { reason: 'NotFound', message: 'not found' },
        };
      }
      if (log.failOnRead === 'forbidden') {
        throw {
          statusCode: 403,
          body: { reason: 'Forbidden', message: 'rbac denies' },
        };
      }
      const response =
        log.readDeploymentResponses[readIdx] ??
        log.readDeploymentResponses[log.readDeploymentResponses.length - 1] ?? {};
      readIdx++;
      return {
        body: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: {
            name,
            namespace,
            annotations: response.annotations ?? {},
            generation: response.generation,
          } as ManifestDoc['metadata'] & { generation?: number },
          status: response.status,
        },
      };
    },
    async replaceNamespacedDeployment(name, namespace) {
      log.ops.push(`Replace:${namespace}/${name}`);
      if (log.failOnReplace === 'opa') {
        const opa = readFixtureJson<OpaResponseShape>('opa-violation-response.json');
        throw opa;
      }
      if (log.failOnReplace === 'forbidden') {
        throw { statusCode: 403, body: { reason: 'Forbidden', message: 'denied' } };
      }
      if (log.failOnReplace === 'rate-limit') {
        throw { statusCode: 429, body: { message: 'too many' } };
      }
      return { body: { kind: 'Deployment' } };
    },
    async createNamespacedDeploymentRollback(name, namespace) {
      log.ops.push(`Rollback:${namespace}/${name}`);
      if (log.failOnRollback) {
        throw {
          statusCode: log.failOnRollback,
          body: { reason: 'NotFound', message: 'no prior revision' },
        };
      }
      return {
        body: {
          kind: 'Deployment',
          metadata: {
            name,
            namespace,
            annotations: {
              'deployment.kubernetes.io/revision':
                log.rollbackResponse?.revision ?? '4',
            },
          },
        },
      };
    },
  };
  const coreV1: CoreV1LikeApi = {
    async replaceNamespacedService(name, namespace) {
      log.ops.push(`SvcReplace:${namespace}/${name}`);
      return { body: { kind: 'Service' } };
    },
    async listNamespacedPod(namespace) {
      log.ops.push(`PodList:${namespace}`);
      return {
        body: {
          items: [
            {
              metadata: { name: 'web-abc' },
              status: {
                phase: 'Pending',
                containerStatuses: [
                  {
                    name: 'web',
                    ready: false,
                    state: {
                      waiting: { reason: 'ImagePullBackOff', message: 'pull denied' },
                    },
                  },
                ],
              },
            },
          ],
        },
      };
    },
  };
  const objectApi: KubernetesObjectLikeApi = {
    async patch(body) {
      log.ops.push(`Patch:${body.kind}/${body.metadata?.name ?? '?'}`);
      return { body };
    },
  };
  return { appsV1, coreV1, objectApi };
}

// ---------------------------------------------------------------------------
// builder + helpers
// ---------------------------------------------------------------------------

function validParams(): Record<string, string | number> {
  return {
    namespace: 'default',
    manifest_path: join(FIXTURES, 'valid-deployment.yaml'),
    deployment_name: 'web',
    context_name: 'test-ctx',
    ready_timeout_seconds: 30,
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

function makeBackend(opts: {
  appsLog: AppsCallLog;
  proxy?: CredentialProxy;
  readFile?: (p: string) => string;
}): K8sBackend {
  const proxy = opts.proxy ?? makeProxy().proxy;
  const apis = makeApis(opts.appsLog);
  const { factory } = makeKubeConfigFactory();
  return new K8sBackend({
    proxy,
    kubeConfigFactory: factory,
    apiClientResolver: () => apis,
    yamlParser: tinyYamlParser,
    sleep: async () => {},
    readFile: opts.readFile,
  });
}

// ---------------------------------------------------------------------------
// metadata + PARAM_SCHEMA
// ---------------------------------------------------------------------------

describe('K8sBackend metadata + PARAM_SCHEMA', () => {
  it('declares supportedTargets/capabilities = k8s-kubectl-apply and no requiredTools', () => {
    const { proxy } = makeProxy();
    const log: AppsCallLog = { ops: [], readDeploymentResponses: [] };
    const b = makeBackend({ appsLog: log, proxy });
    expect(b.metadata.name).toBe('k8s');
    expect(b.metadata.supportedTargets).toEqual(['k8s-kubectl-apply']);
    expect(b.metadata.capabilities).toEqual(['k8s-kubectl-apply']);
    expect(b.metadata.requiredTools).toEqual([]);
  });

  it('PARAM_SCHEMA requires namespace and manifest_path', () => {
    expect(PARAM_SCHEMA.namespace.required).toBe(true);
    expect(PARAM_SCHEMA.manifest_path.required).toBe(true);
    expect(PARAM_SCHEMA.deployment_name.required).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// build()
// ---------------------------------------------------------------------------

describe('K8sBackend.build (no-op by design)', () => {
  it('returns a reference artifact with type=commit, sizeBytes=0', async () => {
    const log: AppsCallLog = { ops: [], readDeploymentResponses: [] };
    const b = makeBackend({ appsLog: log });
    const artifact = await b.build(ctx());
    expect(artifact.type).toBe('commit');
    expect(artifact.sizeBytes).toBe(0);
    expect(artifact.location).toBe(ctx().commitSha);
    expect(artifact.metadata.kind).toBe('k8s-manifest-ref');
  });

  it('produces a reproducible checksum across two calls with the same context', async () => {
    const log: AppsCallLog = { ops: [], readDeploymentResponses: [] };
    const b = makeBackend({ appsLog: log });
    const a1 = await b.build(ctx());
    const a2 = await b.build(ctx());
    expect(a1.checksum).toEqual(a2.checksum);
    expect(a1.artifactId).not.toEqual(a2.artifactId); // ULID unique per call
  });

  it('rejects when params fail validation', async () => {
    const log: AppsCallLog = { ops: [], readDeploymentResponses: [] };
    const b = makeBackend({ appsLog: log });
    await expect(
      b.build(ctx({ params: { ...validParams(), namespace: 'has spaces' } })),
    ).rejects.toBeInstanceOf(ParameterValidationError);
  });
});

// ---------------------------------------------------------------------------
// deploy()
// ---------------------------------------------------------------------------

describe('K8sBackend.deploy', () => {
  function buildArtifact(): BuildArtifact {
    return {
      artifactId: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      type: 'commit',
      location: 'abc123',
      checksum: 'cafe',
      sizeBytes: 0,
      metadata: { kind: 'k8s-manifest-ref' },
    };
  }

  it('calls proxy.acquire with K8s:Apply scoped to cluster:<ctx>/namespace:<ns> exactly once', async () => {
    const { proxy, calls } = makeProxy();
    const log: AppsCallLog = {
      ops: [],
      readDeploymentResponses: [
        { annotations: { 'deployment.kubernetes.io/revision': '3' } },
      ],
    };
    const b = makeBackend({ appsLog: log, proxy });
    await b.deploy(buildArtifact(), 'staging', validParams());
    const acquireCalls = calls();
    expect(acquireCalls).toHaveLength(1);
    expect(acquireCalls[0].provider).toBe('k8s');
    expect(acquireCalls[0].operationName).toBe('K8s:Apply');
    expect(acquireCalls[0].scope.resource).toBe(
      'cluster:test-ctx/namespace:default',
    );
  });

  it('does NOT shell out — child_process.execFile/spawn/exec are never called', async () => {
    const log: AppsCallLog = {
      ops: [],
      readDeploymentResponses: [
        { annotations: { 'deployment.kubernetes.io/revision': '3' } },
      ],
    };
    const execFileMock = childProcess.execFile as unknown as jest.Mock;
    const spawnMock = childProcess.spawn as unknown as jest.Mock;
    const execMock = childProcess.exec as unknown as jest.Mock;
    execFileMock.mockClear();
    spawnMock.mockClear();
    execMock.mockClear();
    const b = makeBackend({ appsLog: log });
    await b.deploy(buildArtifact(), 'staging', validParams());
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it('rejects a manifest whose metadata.namespace does NOT match configured namespace', async () => {
    const log: AppsCallLog = { ops: [], readDeploymentResponses: [] };
    const b = makeBackend({
      appsLog: log,
      readFile: (p) => readFileSync(p, 'utf8'),
    });
    const params = {
      ...validParams(),
      manifest_path: join(FIXTURES, 'cross-namespace-escape.yaml'),
    };
    const err = await b
      .deploy(buildArtifact(), 'staging', params)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ParameterValidationError);
    expect((err as ParameterValidationError).message).toMatch(
      /namespace='kube-system' does not match/,
    );
  });

  it('rejects a manifest whose kind is in the cluster-scoped denylist', async () => {
    const log: AppsCallLog = { ops: [], readDeploymentResponses: [] };
    const b = makeBackend({ appsLog: log });
    const params = {
      ...validParams(),
      manifest_path: join(FIXTURES, 'cluster-role-rejection.yaml'),
    };
    const err = await b
      .deploy(buildArtifact(), 'staging', params)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ParameterValidationError);
    expect((err as ParameterValidationError).message).toMatch(
      /ClusterRole is cluster-scoped/,
    );
  });

  it('captures previous_revision from the Deployment annotation BEFORE applying', async () => {
    const log: AppsCallLog = {
      ops: [],
      readDeploymentResponses: [
        { annotations: { 'deployment.kubernetes.io/revision': '7' } },
      ],
    };
    const b = makeBackend({ appsLog: log });
    const record = await b.deploy(buildArtifact(), 'staging', validParams());
    // Call order: Read happens before Replace.
    const readIdx = log.ops.findIndex((op) => op.startsWith('Read:'));
    const replaceIdx = log.ops.findIndex((op) => op.startsWith('Replace:'));
    expect(readIdx).toBeGreaterThanOrEqual(0);
    expect(replaceIdx).toBeGreaterThan(readIdx);
    expect(record.details.previous_revision).toBe('7');
    expect(record.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyDeploymentRecord(record).valid).toBe(true);
  });

  it('treats Deployment-not-found on read as fresh deploy (previous_revision empty)', async () => {
    const log: AppsCallLog = {
      ops: [],
      readDeploymentResponses: [],
      failOnRead: 'not-found',
    };
    const b = makeBackend({ appsLog: log });
    const record = await b.deploy(buildArtifact(), 'staging', validParams());
    expect(record.details.previous_revision).toBe('');
  });

  it('translates an OPA Gatekeeper rejection to POLICY_VIOLATION with reason in message', async () => {
    const log: AppsCallLog = {
      ops: [],
      readDeploymentResponses: [
        { annotations: { 'deployment.kubernetes.io/revision': '3' } },
      ],
      failOnReplace: 'opa',
    };
    const b = makeBackend({ appsLog: log });
    const err = await b
      .deploy(buildArtifact(), 'staging', validParams())
      .catch((e) => e);
    expect(err).toBeInstanceOf(CloudDeployError);
    expect((err as CloudDeployError).code).toBe('POLICY_VIOLATION');
    expect((err as CloudDeployError).message).toMatch(/drop ALL capabilities/);
  });

  it('translates a generic 403 to AUTH_FAILED', async () => {
    const log: AppsCallLog = {
      ops: [],
      readDeploymentResponses: [
        { annotations: { 'deployment.kubernetes.io/revision': '3' } },
      ],
      failOnReplace: 'forbidden',
    };
    const b = makeBackend({ appsLog: log });
    const err = await b
      .deploy(buildArtifact(), 'staging', validParams())
      .catch((e) => e);
    expect(err).toBeInstanceOf(CloudDeployError);
    expect((err as CloudDeployError).code).toBe('AUTH_FAILED');
  });

  it('translates a 429 to RATE_LIMIT (retriable)', async () => {
    const log: AppsCallLog = {
      ops: [],
      readDeploymentResponses: [
        { annotations: { 'deployment.kubernetes.io/revision': '3' } },
      ],
      failOnReplace: 'rate-limit',
    };
    const b = makeBackend({ appsLog: log });
    const err = await b
      .deploy(buildArtifact(), 'staging', validParams())
      .catch((e) => e);
    expect(err).toBeInstanceOf(CloudDeployError);
    expect((err as CloudDeployError).code).toBe('RATE_LIMIT');
    expect((err as CloudDeployError).retriable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// healthCheck()
// ---------------------------------------------------------------------------

describe('K8sBackend.healthCheck', () => {
  function makeRecord(extra: Partial<DeploymentRecord['details']> = {}): DeploymentRecord {
    return {
      deployId: 'd-1',
      backend: 'k8s',
      environment: 'staging',
      artifactId: 'a-1',
      deployedAt: new Date(0).toISOString(),
      status: 'deployed',
      details: {
        namespace: 'default',
        deployment_name: 'web',
        previous_revision: '7',
        applied_kinds: 'Deployment,Service',
        applied_count: 2,
        context_name: 'test-ctx',
        manifest_path: '/tmp/repo/k8s/web.yaml',
        ready_timeout_seconds: 5,
        ...extra,
      },
      hmac: 'x'.repeat(64),
    };
  }

  it('returns healthy:true when readyReplicas===replicas AND observedGeneration>=generation', async () => {
    const log: AppsCallLog = {
      ops: [],
      readDeploymentResponses: [
        {
          generation: 4,
          status: { replicas: 2, readyReplicas: 2, observedGeneration: 4 },
        },
      ],
    };
    const b = makeBackend({ appsLog: log });
    const status = await b.healthCheck(makeRecord());
    expect(status.healthy).toBe(true);
  });

  it('returns healthy:false with ImagePullBackOff when timeout fires while pods are stuck', async () => {
    let nowMs = 0;
    const log: AppsCallLog = {
      ops: [],
      readDeploymentResponses: [
        {
          generation: 4,
          status: { replicas: 2, readyReplicas: 0, observedGeneration: 4 },
        },
      ],
    };
    const apis = makeApis(log);
    const { factory } = makeKubeConfigFactory();
    const { proxy } = makeProxy();
    const b = new K8sBackend({
      proxy,
      kubeConfigFactory: factory,
      apiClientResolver: () => apis,
      yamlParser: tinyYamlParser,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
    });
    const status = await b.healthCheck(makeRecord({ ready_timeout_seconds: 1 }));
    expect(status.healthy).toBe(false);
    expect(status.unhealthyReason).toBe('ImagePullBackOff');
  });

  it('returns healthy:false when record is missing namespace/deployment_name', async () => {
    const log: AppsCallLog = { ops: [], readDeploymentResponses: [] };
    const b = makeBackend({ appsLog: log });
    const status = await b.healthCheck(
      makeRecord({ namespace: '', deployment_name: '' }),
    );
    expect(status.healthy).toBe(false);
    expect(status.unhealthyReason).toBe('record-missing-namespace-or-deployment');
  });
});

// ---------------------------------------------------------------------------
// rollback()
// ---------------------------------------------------------------------------

describe('K8sBackend.rollback', () => {
  function rollbackRecord(): DeploymentRecord {
    return {
      deployId: 'd-1',
      backend: 'k8s',
      environment: 'staging',
      artifactId: 'a-1',
      deployedAt: new Date(0).toISOString(),
      status: 'deployed',
      details: {
        namespace: 'default',
        deployment_name: 'web',
        previous_revision: '7',
        applied_kinds: 'Deployment',
        applied_count: 1,
        context_name: 'test-ctx',
        manifest_path: '/tmp/repo/k8s/web.yaml',
        ready_timeout_seconds: 30,
      },
      hmac: 'x'.repeat(64),
    };
  }

  it('calls createNamespacedDeploymentRollback (kubectl rollout undo equivalent)', async () => {
    const log: AppsCallLog = {
      ops: [],
      readDeploymentResponses: [],
      rollbackResponse: { revision: '7' },
    };
    const b = makeBackend({ appsLog: log });
    const result = await b.rollback(rollbackRecord());
    expect(result.success).toBe(true);
    expect(result.restoredArtifactId).toBe('7');
    expect(log.ops.some((op) => op.startsWith('Rollback:default/web'))).toBe(true);
  });

  it('returns success:false with API error when rollback returns 404', async () => {
    const log: AppsCallLog = {
      ops: [],
      readDeploymentResponses: [],
      failOnRollback: 404,
    };
    const b = makeBackend({ appsLog: log });
    const result = await b.rollback(rollbackRecord());
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/no prior revision/);
  });

  it('returns success:false with API error when rollback returns 500', async () => {
    const log: AppsCallLog = {
      ops: [],
      readDeploymentResponses: [],
      failOnRollback: 500,
    };
    const b = makeBackend({ appsLog: log });
    const result = await b.rollback(rollbackRecord());
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it('returns success:false when record is missing namespace/deployment_name', async () => {
    const log: AppsCallLog = { ops: [], readDeploymentResponses: [] };
    const b = makeBackend({ appsLog: log });
    const rec = rollbackRecord();
    rec.details.namespace = '';
    const result = await b.rollback(rec);
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/missing/);
  });
});

// ---------------------------------------------------------------------------
// Skipped integration tests (kind cluster) — promoted in SPEC-024-1-05.
// ---------------------------------------------------------------------------

describe('K8sBackend integration (skipped)', () => {
  it.skip('kind cluster: deploy → poll readiness → rollout undo (live infra)', async () => {
    // Promoted in SPEC-024-1-05; requires a kind cluster.
  });
});
