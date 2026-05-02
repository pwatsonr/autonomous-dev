/**
 * SPEC-024-1-05 cloud-conformance suite.
 *
 * Runs the SAME conformance battery used in `tests/deploy/conformance.test.ts`
 * (SPEC-023-1-04) against the four cloud backends shipped by SPEC-024-1-02
 * and SPEC-024-1-03. Each backend is constructed with hand-rolled SDK
 * mocks and a stub `CredentialProxy`; per-cloud SDK mock JSON fixtures
 * live under `tests/fixtures/cloud/sdk-mocks/<cloud>/`.
 *
 * Battery (per TDD-023 §15, mirrored from SPEC-023-1-04):
 *   1. Metadata shape (kebab-case name, semver, supportedTargets, tools).
 *   2. build() returns a valid BuildArtifact (ULID id, 64-hex checksum).
 *   3. deploy() returns a signed DeploymentRecord that verifies.
 *   4. healthCheck() returns a valid HealthStatus.
 *   5. rollback() returns a valid RollbackResult.
 *   6. Tampering with the record invalidates the hmac.
 *
 * The intention from SPEC-024-1-05 is that adding a fictional fifth
 * backend means appending one entry to the `CASES` array — no new test
 * code per backend.
 *
 * @module tests/deploy/cloud-conformance.test
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GCPBackend } from '../../../autonomous-dev-deploy-gcp/src/backend';
import type {
  CloudBuildLikeClient,
  CloudBuildBuild,
} from '../../../autonomous-dev-deploy-gcp/src/cloud-build-helper';
import type {
  CloudRunLikeClient,
  CloudRunService,
  CloudRunRevision,
} from '../../../autonomous-dev-deploy-gcp/src/cloud-run-helper';
import { AWSBackend } from '../../../autonomous-dev-deploy-aws/src/backend';
import type {
  EcrLikeClient,
  DockerLikeClient,
  DockerImage,
} from '../../../autonomous-dev-deploy-aws/src/ecr-builder';
import type { EcsLikeClient } from '../../../autonomous-dev-deploy-aws/src/ecs-deployer';
import type { ElbV2LikeClient } from '../../../autonomous-dev-deploy-aws/src/health-checker';
import { AzureBackend } from '../../../autonomous-dev-deploy-azure/src/backend';
import type {
  AcrLikeClient,
  AcrRun,
} from '../../../autonomous-dev-deploy-azure/src/acr-builder';
import type {
  ContainerAppResource,
  ContainerAppsLikeClient,
} from '../../../autonomous-dev-deploy-azure/src/container-apps-deployer';
import { K8sBackend } from '../../../autonomous-dev-deploy-k8s/src/backend';
import type { KubeConfigLike } from '../../../autonomous-dev-deploy-k8s/src/credential-proxy-client';
import type {
  AppsV1LikeApi,
  CoreV1LikeApi,
  KubernetesObjectLikeApi,
  ManifestDoc,
} from '../../../autonomous-dev-deploy-k8s/src/manifest-applier';

import { verifyDeploymentRecord } from '../../intake/deploy/record-signer';
import { ULID_REGEX } from '../../intake/deploy/id';
import type {
  BuildArtifact,
  BuildContext,
  DeployParameters,
  DeploymentBackend,
  DeploymentRecord,
  HealthStatus,
  RollbackResult,
} from '../../intake/deploy/types';
import type {
  CredentialProxy,
  CredentialProvider,
  ScopedCredential,
} from '../../intake/deploy/credential-proxy-types';

import { gcpValidParams } from '../fixtures/cloud/gcp.params';
import { awsValidParams } from '../fixtures/cloud/aws.params';
import { azureValidParams } from '../fixtures/cloud/azure.params';
import { k8sValidParams } from '../fixtures/cloud/k8s.params';

const TEST_KEY = Buffer.alloc(32, 0x42);
process.env.DEPLOY_HMAC_KEY = TEST_KEY.toString('hex');

// ---------------------------------------------------------------------------
// One tmp dir for K8s manifest fixtures.
// ---------------------------------------------------------------------------

const tmpRoot: string = mkdtempSync(join(tmpdir(), 'cloud-conformance-'));
const k8sManifestPath = join(tmpRoot, 'manifest.yaml');
writeFileSync(
  k8sManifestPath,
  [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '  name: web',
    '  namespace: default',
    'spec:',
    '  replicas: 1',
    '  selector:',
    '    matchLabels: { app: web }',
    '  template:',
    '    metadata: { labels: { app: web } }',
    '    spec:',
    '      containers:',
    '        - name: web',
    '          image: registry.example.com/web:abc123',
    '',
  ].join('\n'),
);
mkdirSync(join(tmpRoot, 'repo'), { recursive: true });
const repoPath = join(tmpRoot, 'repo');

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Stub CredentialProxy. Every cloud's flow gets a shape its
// `credential-proxy-client` accepts.
// ---------------------------------------------------------------------------

function makeMockProxy(provider: CredentialProvider): CredentialProxy {
  return {
    async acquire(p) {
      const cred: ScopedCredential = {
        cloud: p,
        expiresAt: new Date(Date.now() + 900_000),
        tokenId: 'tok-conf-1',
      };
      switch (p) {
        case 'gcp':
        case 'azure':
          return { ...cred, token: 'mock-bearer-token' };
        case 'aws':
          return {
            ...cred,
            awsCredentials: {
              accessKeyId: 'AKIATEST',
              secretAccessKey: 'secret',
              sessionToken: 'session',
            },
          };
        case 'k8s':
          return {
            ...cred,
            kubeconfig: 'apiVersion: v1\nkind: Config\ncurrent-context: test',
          };
      }
      // unreachable; exhaustive switch above
      return cred;
    },
  };
}

// ---------------------------------------------------------------------------
// Per-cloud SDK mocks (success path used by the conformance battery).
// ---------------------------------------------------------------------------

function gcpClients(): {
  cloudBuild: CloudBuildLikeClient;
  cloudRun: CloudRunLikeClient;
  fetchImpl: typeof fetch;
} {
  const buildResult: CloudBuildBuild = {
    id: 'build-12345',
    status: 'SUCCESS',
    results: { images: [{ digest: `sha256:${'a'.repeat(64)}` }] },
  };
  const cloudBuild: CloudBuildLikeClient = {
    async createBuild() {
      return [{ metadata: { build: { id: 'build-12345' } } }, {}, {}];
    },
    async getBuild() {
      return [buildResult, {}, {}];
    },
  };
  const service: CloudRunService = {
    name: 'projects/test-project/locations/us-central1/services/api',
    uri: 'https://api-test-project.a.run.app',
    latestReadyRevision: 'api-00002-abc',
  };
  const revisions: readonly CloudRunRevision[] = [
    {
      name: 'api-00002-abc',
      createTime: '2026-05-02T12:00:00Z',
      containers: [{ image: 'gcr.io/test-project/api:newsha' }],
    },
    {
      name: 'api-00001-xyz',
      createTime: '2026-05-01T12:00:00Z',
      containers: [{ image: 'gcr.io/test-project/api:prevsha' }],
    },
  ];
  const cloudRun: CloudRunLikeClient = {
    async replaceService() {
      return [service, {}, {}];
    },
    async updateService() {
      return [service, {}, {}];
    },
    async listRevisions() {
      return [revisions, {}, {}];
    },
  };
  const fetchImpl = (async () =>
    new Response('ok', { status: 200 })) as unknown as typeof fetch;
  return { cloudBuild, cloudRun, fetchImpl };
}

function awsClients(): {
  ecr: EcrLikeClient;
  ecs: EcsLikeClient;
  elbV2: ElbV2LikeClient;
  docker: DockerLikeClient;
} {
  const ecr: EcrLikeClient = {
    async send() {
      return {
        authorizationData: [
          {
            authorizationToken: Buffer.from('AWS:test-pw').toString('base64'),
            proxyEndpoint:
              'https://123456789012.dkr.ecr.us-east-1.amazonaws.com',
            expiresAt: new Date(),
          },
        ],
      };
    },
  };
  const dummyStream = {} as NodeJS.ReadableStream;
  const image: DockerImage = {
    async push() {
      return dummyStream;
    },
    async inspect() {
      return {
        Id: 'sha256:imageid',
        Size: 1234,
        RepoDigests: [
          `123456789012.dkr.ecr.us-east-1.amazonaws.com/web@sha256:${'b'.repeat(64)}`,
        ],
      };
    },
  };
  const docker: DockerLikeClient = {
    async buildImage() {
      return dummyStream;
    },
    modem: {
      followProgress: (_stream, cb) => {
        cb(null, []);
      },
    },
    getImage: () => image,
  };
  const ecs: EcsLikeClient = {
    async send(cmd) {
      switch (cmd.__op) {
        case 'DescribeServices':
          return {
            services: [
              {
                serviceArn:
                  'arn:aws:ecs:us-east-1:123456789012:service/web-cluster/web-svc',
                serviceName: 'web-svc',
                taskDefinition:
                  'arn:aws:ecs:us-east-1:123456789012:task-definition/web-svc:7',
                desiredCount: 2,
              },
            ],
          };
        case 'DescribeTaskDefinition':
          return {
            taskDefinition: {
              family: 'web-svc',
              taskDefinitionArn:
                'arn:aws:ecs:us-east-1:123456789012:task-definition/web-svc:7',
              taskRoleArn: 'arn:aws:iam::123456789012:role/ecs-task-role',
              executionRoleArn: 'arn:aws:iam::123456789012:role/ecs-exec-role',
              networkMode: 'awsvpc',
              cpu: '512',
              memory: '1024',
              requiresCompatibilities: ['FARGATE'],
              containerDefinitions: [
                {
                  name: 'web',
                  image:
                    '123456789012.dkr.ecr.us-east-1.amazonaws.com/web:old-sha',
                  cpu: 512,
                  memory: 1024,
                },
              ],
            },
          };
        case 'RegisterTaskDefinition':
          return {
            taskDefinition: {
              family: 'web-svc',
              taskDefinitionArn:
                'arn:aws:ecs:us-east-1:123456789012:task-definition/web-svc:8',
            },
          };
        case 'UpdateService':
          return {
            service: {
              serviceArn:
                'arn:aws:ecs:us-east-1:123456789012:service/web-cluster/web-svc',
              taskDefinition: cmd.taskDefinition,
            },
          };
        default:
          return {};
      }
    },
  };
  const elbV2: ElbV2LikeClient = {
    async send() {
      return {
        TargetHealthDescriptions: [
          {
            Target: { Id: '10.0.0.1', Port: 8080 },
            TargetHealth: { State: 'healthy' },
          },
          {
            Target: { Id: '10.0.0.2', Port: 8080 },
            TargetHealth: { State: 'healthy' },
          },
        ],
      };
    },
  };
  return { ecr, ecs, elbV2, docker };
}

function azureClients(): {
  acr: AcrLikeClient;
  containerApps: ContainerAppsLikeClient;
  fetchImpl: typeof fetch;
} {
  const runStarted: AcrRun = { runId: 'run-abc123', status: 'Running' };
  const runDone: AcrRun = {
    runId: 'run-abc123',
    status: 'Succeeded',
    outputImages: [
      {
        registry: 'myacr.azurecr.io',
        repository: 'web',
        tag: 'abc123def456',
        digest: `sha256:${'c'.repeat(64)}`,
      },
    ],
  };
  let getCalls = 0;
  const acr: AcrLikeClient = {
    async scheduleDockerBuildRun() {
      return runStarted;
    },
    async getRun() {
      getCalls += 1;
      return getCalls > 0 ? runDone : runStarted;
    },
  };
  const baseApp: ContainerAppResource = {
    name: 'web-app',
    properties: {
      latestRevisionName: 'web-app--rev1',
      latestReadyRevisionName: 'web-app--rev1',
      configuration: {
        activeRevisionsMode: 'Multiple',
        ingress: {
          fqdn: 'web-app.azurecontainerapps.io',
          traffic: [{ revisionName: 'web-app--rev1', weight: 100 }],
        },
      },
      template: {
        containers: [
          {
            name: 'app',
            image: 'myacr.azurecr.io/web:old-sha',
            resources: { cpu: 0.5, memory: '1.0Gi' },
          },
        ],
      },
    },
  };
  const updatedApp: ContainerAppResource = {
    ...baseApp,
    properties: {
      ...baseApp.properties,
      latestRevisionName: 'web-app--rev2',
      latestReadyRevisionName: 'web-app--rev2',
    },
  };
  const containerApps: ContainerAppsLikeClient = {
    async getContainerApp() {
      return baseApp;
    },
    async updateContainerApp() {
      return updatedApp;
    },
    async updateTraffic() {
      return updatedApp;
    },
  };
  const fetchImpl = (async () =>
    new Response('ok', { status: 200 })) as unknown as typeof fetch;
  return { acr, containerApps, fetchImpl };
}

interface K8sStubResolverState {
  readDeploymentCalls: number;
}

function k8sClients(): {
  kubeConfig: KubeConfigLike;
  resolver: () => {
    appsV1: AppsV1LikeApi;
    coreV1: CoreV1LikeApi;
    objectApi: KubernetesObjectLikeApi;
  };
  yamlParser: (text: string) => ManifestDoc[];
  state: K8sStubResolverState;
} {
  const state: K8sStubResolverState = { readDeploymentCalls: 0 };
  const kubeConfig: KubeConfigLike = {
    getCurrentContext: () => 'test',
    makeApiClient: () => ({} as never),
  };
  const deployment: ManifestDoc & {
    status?: { replicas?: number; readyReplicas?: number; observedGeneration?: number };
  } = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: 'web',
      namespace: 'default',
      annotations: { 'deployment.kubernetes.io/revision': '1' },
    },
    status: { replicas: 1, readyReplicas: 1, observedGeneration: 1 },
  };
  const appsV1: AppsV1LikeApi = {
    async readNamespacedDeployment() {
      state.readDeploymentCalls += 1;
      return { body: deployment };
    },
    async replaceNamespacedDeployment(_n, _ns, body) {
      return { body };
    },
    async createNamespacedDeploymentRollback() {
      return {
        body: {
          metadata: {
            annotations: { 'deployment.kubernetes.io/revision': '1' },
          },
        },
      };
    },
  };
  const coreV1: CoreV1LikeApi = {
    async replaceNamespacedService(_n, _ns, body) {
      return { body };
    },
    async listNamespacedPod() {
      return {
        body: {
          items: [
            {
              metadata: { name: 'web-1' },
              status: {
                phase: 'Running',
                containerStatuses: [{ name: 'web', ready: true }],
              },
            },
          ],
        },
      };
    },
  };
  const objectApi: KubernetesObjectLikeApi = {
    async patch(body) {
      return { body };
    },
  };
  // Tiny multi-doc YAML parser: split on '---' and parse each chunk
  // structurally for the K8s fixture used here.
  const yamlParser = (text: string): ManifestDoc[] => {
    const docs: ManifestDoc[] = [];
    for (const chunk of text.split(/^---\s*$/m)) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/kind:\s*(\w+)[\s\S]*?metadata:\s*\n\s+name:\s*(\S+)\s*\n\s+namespace:\s*(\S+)/);
      if (m) {
        docs.push({
          apiVersion: 'apps/v1',
          kind: m[1],
          metadata: { name: m[2], namespace: m[3] },
        });
      }
    }
    return docs;
  };
  const resolver = () => ({ appsV1, coreV1, objectApi });
  return { kubeConfig, resolver, yamlParser, state };
}

// ---------------------------------------------------------------------------
// Cases array — adding a fifth backend means appending one entry here.
// ---------------------------------------------------------------------------

interface CloudCase {
  name: string;
  make: () => DeploymentBackend;
  params: DeployParameters;
  fixturesRoot: string;
}

function makeCases(): CloudCase[] {
  return [
    {
      name: 'gcp',
      params: gcpValidParams,
      fixturesRoot: 'tests/fixtures/cloud/sdk-mocks/gcp',
      make: () => {
        const { cloudBuild, cloudRun, fetchImpl } = gcpClients();
        return new GCPBackend({
          proxy: makeMockProxy('gcp'),
          cloudBuildClientFactory: () => cloudBuild,
          cloudRunClientFactory: () => cloudRun,
          fetchImpl,
          now: () => Date.parse('2026-05-02T12:00:00Z'),
          sleep: () => Promise.resolve(),
        });
      },
    },
    {
      name: 'aws',
      params: awsValidParams,
      fixturesRoot: 'tests/fixtures/cloud/sdk-mocks/aws',
      make: () => {
        const { ecr, ecs, elbV2, docker } = awsClients();
        return new AWSBackend({
          proxy: makeMockProxy('aws'),
          ecrClientFactory: () => ecr,
          ecsClientFactory: () => ecs,
          elbV2ClientFactory: () => elbV2,
          dockerClientFactory: () => docker,
          now: () => Date.parse('2026-05-02T12:00:00Z'),
          sleep: () => Promise.resolve(),
        });
      },
    },
    {
      name: 'azure',
      params: azureValidParams,
      fixturesRoot: 'tests/fixtures/cloud/sdk-mocks/azure',
      make: () => {
        const { acr, containerApps, fetchImpl } = azureClients();
        return new AzureBackend({
          proxy: makeMockProxy('azure'),
          acrClientFactory: () => acr,
          containerAppsClientFactory: () => containerApps,
          fetchImpl,
          now: () => Date.parse('2026-05-02T12:00:00Z'),
          sleep: () => Promise.resolve(),
        });
      },
    },
    {
      name: 'k8s',
      params: k8sValidParams(k8sManifestPath),
      fixturesRoot: 'tests/fixtures/cloud/sdk-mocks/k8s',
      make: () => {
        const { kubeConfig, resolver, yamlParser } = k8sClients();
        return new K8sBackend({
          proxy: makeMockProxy('k8s'),
          kubeConfigFactory: () => kubeConfig,
          apiClientResolver: resolver,
          yamlParser,
          now: () => Date.parse('2026-05-02T12:00:00Z'),
          sleep: () => Promise.resolve(),
        });
      },
    },
  ];
}

function makeCtx(params: DeployParameters): BuildContext {
  return {
    repoPath,
    commitSha: 'a'.repeat(40),
    branch: 'feat/conformance',
    requestId: 'req-cloud-conf',
    cleanWorktree: true,
    params,
  };
}

// ---------------------------------------------------------------------------
// Conformance battery (mirrors SPEC-023-1-04 exactly).
// ---------------------------------------------------------------------------

describe.each(makeCases().map((c) => [c.name, c] as const))(
  'SPEC-024-1-05 cloud conformance: %s',
  (_name, testCase) => {
    let backend: DeploymentBackend;

    beforeEach(() => {
      backend = testCase.make();
    });

    it('metadata shape: kebab-case name, semver version, non-empty targets, string[] tools', () => {
      const m = backend.metadata;
      expect(m.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(m.supportedTargets.length).toBeGreaterThan(0);
      expect(Array.isArray(m.requiredTools)).toBe(true);
      m.requiredTools.forEach((t) => expect(typeof t).toBe('string'));
    });

    it('build returns a valid BuildArtifact', async () => {
      const a: BuildArtifact = await backend.build(makeCtx(testCase.params));
      expect(a.artifactId).toMatch(ULID_REGEX);
      expect(['commit', 'directory', 'docker-image', 'archive']).toContain(a.type);
      expect(a.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isInteger(a.sizeBytes)).toBe(true);
      expect(a.sizeBytes).toBeGreaterThanOrEqual(0);
    });

    it('deploy returns a signed DeploymentRecord that verifies', async () => {
      const a = await backend.build(makeCtx(testCase.params));
      const r: DeploymentRecord = await backend.deploy(a, 'test-env', testCase.params);
      expect(r.hmac).toMatch(/^[0-9a-f]{64}$/);
      expect(verifyDeploymentRecord(r).valid).toBe(true);
    });

    it('healthCheck returns a valid HealthStatus', async () => {
      const a = await backend.build(makeCtx(testCase.params));
      const r = await backend.deploy(a, 'test-env', testCase.params);
      const h: HealthStatus = await backend.healthCheck(r);
      expect(typeof h.healthy).toBe('boolean');
      expect(Array.isArray(h.checks)).toBe(true);
    });

    it('rollback returns a valid RollbackResult', async () => {
      const a = await backend.build(makeCtx(testCase.params));
      const r = await backend.deploy(a, 'test-env', testCase.params);
      const rb: RollbackResult = await backend.rollback(r);
      expect(typeof rb.success).toBe('boolean');
      expect(Array.isArray(rb.errors)).toBe(true);
    });

    it('tampering with the record invalidates the hmac', async () => {
      const a = await backend.build(makeCtx(testCase.params));
      const r = await backend.deploy(a, 'test-env', testCase.params);
      const tampered = { ...r, environment: 'evil-env' };
      expect(verifyDeploymentRecord(tampered).valid).toBe(false);
    });

    it('declares an SDK-mock fixture directory referenced by name', () => {
      // The fixtures live under `tests/fixtures/cloud/sdk-mocks/<name>/`
      // and contain at minimum: build-create, build-status-success,
      // deploy-success, healthcheck-success, healthcheck-failure,
      // rollback-success. Verified at the suite level (one test per
      // backend so failures point to the missing fixture cleanly).
      const required = [
        'build-create.json',
        'build-status-success.json',
        'deploy-success.json',
        'healthcheck-success.json',
        'healthcheck-failure.json',
        'rollback-success.json',
      ];
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs') as typeof import('node:fs');
      for (const f of required) {
        expect(fs.existsSync(join(testCase.fixturesRoot, f))).toBe(true);
      }
    });
  },
);
