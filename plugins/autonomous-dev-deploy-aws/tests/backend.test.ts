/**
 * AWSBackend unit tests (SPEC-024-1-02). Mocks the ECR / ECS / ELBv2
 * SDK clients with hand-rolled fakes that satisfy the structural
 * interfaces in `ecr-builder.ts`, `ecs-deployer.ts`, and
 * `health-checker.ts`. The credential proxy is replaced with a stub
 * that returns a fixed `ScopedCredential`.
 *
 * Coverage targets the SPEC-024-1-02 acceptance criteria for AWS:
 *   - PARAM_SCHEMA validation (account_id 12 digits, region enum)
 *   - proxy.acquire is called with the spec-mandated arguments
 *   - build → image URI matches `<acct>.dkr.ecr.<region>.amazonaws.com/<repo>:<sha>`
 *     and NEVER shells out (child_process spies)
 *   - deploy → describe-then-register-then-update call order +
 *     `previous_task_definition_arn` captured before update
 *   - healthCheck → all healthy → healthy:true; not all healthy → false
 *   - rollback → updateService called with the previous task def ARN
 *
 * @module @autonomous-dev/deploy-aws/tests/backend.test
 */

import { AWSBackend, PARAM_SCHEMA } from '../src/backend';

// Mock node:child_process so we can assert no shell-outs occur during build.
// Using `jest.mock` (auto-hoisted) is the only reliable way to spy on
// `child_process` exports because Node sets them non-configurable.
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
  EcrLikeClient,
  DockerLikeClient,
  DockerImage,
} from '../src/ecr-builder';
import type {
  EcsLikeClient,
} from '../src/ecs-deployer';
import type {
  ElbV2LikeClient,
} from '../src/health-checker';
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
import type { BuildArtifact, BuildContext, DeploymentRecord } from '../../autonomous-dev/intake/deploy/types';

const TEST_KEY = Buffer.alloc(32, 0x99);
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
        tokenId: 'tok-aws-1',
        awsCredentials: {
          accessKeyId: 'AKIATEST',
          secretAccessKey: 'secret',
          sessionToken: 'session',
        },
      };
      return cred;
    },
  };
  return { proxy, calls: () => calls };
}

function validParams(): Record<string, string | number> {
  return {
    account_id: '123456789012',
    region: 'us-east-1',
    cluster_name: 'web-cluster',
    service_name: 'web-svc',
    ecr_repo: 'web',
    task_family: 'web-svc',
    target_group_arn:
      'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/web-tg/1234567890abcdef',
    health_timeout_seconds: 30,
    desired_count: 2,
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

function makeEcrClient(token = Buffer.from('AWS:test-password').toString('base64')): EcrLikeClient {
  return {
    async send() {
      return {
        authorizationData: [
          {
            authorizationToken: token,
            proxyEndpoint: 'https://123456789012.dkr.ecr.us-east-1.amazonaws.com',
            expiresAt: new Date(),
          },
        ],
      };
    },
  };
}

function makeDocker(opts: { digest?: string; size?: number; failPush?: boolean } = {}): {
  docker: DockerLikeClient;
  pushed: { times: number };
  built: { times: number };
} {
  const pushed = { times: 0 };
  const built = { times: 0 };
  const dummyStream = {} as NodeJS.ReadableStream;
  const image: DockerImage = {
    async push() {
      if (opts.failPush) throw new Error('docker push failed');
      pushed.times++;
      return dummyStream;
    },
    async inspect() {
      return {
        Id: 'sha256:imageid',
        Size: opts.size ?? 1234,
        RepoDigests: [
          `123456789012.dkr.ecr.us-east-1.amazonaws.com/web@${
            opts.digest ?? 'sha256:abcd1234'
          }`,
        ],
      };
    },
  };
  const docker: DockerLikeClient = {
    async buildImage() {
      built.times++;
      return dummyStream;
    },
    modem: {
      followProgress: (_stream, cb) => {
        cb(null, []);
      },
    },
    getImage: () => image,
  };
  return { docker, pushed, built };
}

interface EcsCallLog {
  ops: string[];
  registeredImage?: string;
  updateCalls: Array<{ taskDefinition: string; service: string; cluster: string; desiredCount?: number }>;
}

function makeEcsClient(): { client: EcsLikeClient; log: EcsCallLog } {
  const log: EcsCallLog = { ops: [], updateCalls: [] };
  const client: EcsLikeClient = {
    async send(cmd) {
      log.ops.push(cmd.__op);
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
          log.registeredImage = (cmd.input.containerDefinitions ?? [])[0]?.image ?? undefined;
          return {
            taskDefinition: {
              family: 'web-svc',
              taskDefinitionArn:
                'arn:aws:ecs:us-east-1:123456789012:task-definition/web-svc:8',
            },
          };
        case 'UpdateService':
          log.updateCalls.push({
            taskDefinition: cmd.taskDefinition,
            service: cmd.service,
            cluster: cmd.cluster,
            desiredCount: cmd.desiredCount,
          });
          return {
            service: {
              serviceArn:
                'arn:aws:ecs:us-east-1:123456789012:service/web-cluster/web-svc',
              taskDefinition: cmd.taskDefinition,
            },
          };
        default:
          throw new Error(`unexpected op: ${(cmd as { __op: string }).__op}`);
      }
    },
  };
  return { client, log };
}

function makeElbV2(states: ReadonlyArray<'healthy' | 'unhealthy' | 'initial'>): {
  client: ElbV2LikeClient;
  calls: { times: number };
} {
  const calls = { times: 0 };
  const client: ElbV2LikeClient = {
    async send() {
      calls.times++;
      return {
        TargetHealthDescriptions: states.map((s, i) => ({
          Target: { Id: `10.0.0.${i + 1}`, Port: 8080 },
          TargetHealth: { State: s, Reason: s === 'healthy' ? '' : 'Target.FailedHealthChecks' },
        })),
      };
    },
  };
  return { client, calls };
}

// ---------------------------------------------------------------------------
// metadata + PARAM_SCHEMA
// ---------------------------------------------------------------------------

describe('AWSBackend metadata + PARAM_SCHEMA', () => {
  it('PARAM_SCHEMA enforces account_id ^\\d{12}$', () => {
    expect(PARAM_SCHEMA.account_id.regex?.source).toBe('^\\d{12}$');
  });
  it('declares supportedTargets/capabilities = aws-ecs-fargate and no requiredTools', () => {
    const { proxy } = makeProxy();
    const b = new AWSBackend({ proxy });
    expect(b.metadata.name).toBe('aws');
    expect(b.metadata.supportedTargets).toEqual(['aws-ecs-fargate']);
    expect(b.metadata.capabilities).toEqual(['aws-ecs-fargate']);
    expect(b.metadata.requiredTools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// build()
// ---------------------------------------------------------------------------

describe('AWSBackend.build', () => {
  it('returns a docker-image artifact at <acct>.dkr.ecr.<region>.amazonaws.com/<repo>:<sha>', async () => {
    const { proxy, calls } = makeProxy();
    const { docker } = makeDocker();
    const b = new AWSBackend({
      proxy,
      ecrClientFactory: () => makeEcrClient(),
      ecsClientFactory: () => makeEcsClient().client,
      elbV2ClientFactory: () => makeElbV2(['healthy']).client,
      dockerClientFactory: () => docker,
    });
    const artifact = await b.build(ctx());
    expect(artifact.location).toBe(
      '123456789012.dkr.ecr.us-east-1.amazonaws.com/web:abc123def456abc123def456abc123def456abcd',
    );
    expect(artifact.type).toBe('docker-image');
    expect(artifact.checksum).toBe('abcd1234');
    expect(artifact.metadata.account_id).toBe('123456789012');
    expect(artifact.metadata.region).toBe('us-east-1');

    const acquireCalls = calls();
    expect(acquireCalls).toHaveLength(1);
    expect(acquireCalls[0].provider).toBe('aws');
    expect(acquireCalls[0].operationName).toBe('ECR:PutImage');
    expect(acquireCalls[0].scope.resource).toBe(
      'arn:aws:ecr:us-east-1:123456789012:repository/web',
    );
  });

  it('does NOT shell out — child_process.execFile/spawn/exec are never called', async () => {
    const { proxy } = makeProxy();
    const { docker } = makeDocker();
    const execFileMock = childProcess.execFile as unknown as jest.Mock;
    const spawnMock = childProcess.spawn as unknown as jest.Mock;
    const execMock = childProcess.exec as unknown as jest.Mock;
    execFileMock.mockClear();
    spawnMock.mockClear();
    execMock.mockClear();
    const b = new AWSBackend({
      proxy,
      ecrClientFactory: () => makeEcrClient(),
      ecsClientFactory: () => makeEcsClient().client,
      elbV2ClientFactory: () => makeElbV2(['healthy']).client,
      dockerClientFactory: () => docker,
    });
    await b.build(ctx());
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it('rejects when account_id does not match ^\\d{12}$', async () => {
    const { proxy } = makeProxy();
    const b = new AWSBackend({ proxy });
    await expect(
      b.build(ctx({ params: { ...validParams(), account_id: '12345' } })),
    ).rejects.toBeInstanceOf(ParameterValidationError);
  });

  it('throws CloudDeployError when docker push fails', async () => {
    const { proxy } = makeProxy();
    const { docker } = makeDocker({ failPush: true });
    const b = new AWSBackend({
      proxy,
      ecrClientFactory: () => makeEcrClient(),
      dockerClientFactory: () => docker,
    });
    await expect(b.build(ctx())).rejects.toBeInstanceOf(CloudDeployError);
  });
});

// ---------------------------------------------------------------------------
// deploy()
// ---------------------------------------------------------------------------

describe('AWSBackend.deploy', () => {
  async function buildArtifact(): Promise<BuildArtifact> {
    return {
      artifactId: '01HYYYYYYYYYYYYYYYYYYYYYYY',
      type: 'docker-image',
      location:
        '123456789012.dkr.ecr.us-east-1.amazonaws.com/web:abc123def456',
      checksum: 'abcd1234',
      sizeBytes: 1024,
      metadata: { account_id: '123456789012', region: 'us-east-1' },
    };
  }

  it('describes services BEFORE registering, and registers BEFORE updating', async () => {
    const { proxy } = makeProxy();
    const ecs = makeEcsClient();
    const b = new AWSBackend({
      proxy,
      ecsClientFactory: () => ecs.client,
    });
    await b.deploy(await buildArtifact(), 'staging', validParams());
    expect(ecs.log.ops).toEqual([
      'DescribeServices',
      'DescribeTaskDefinition',
      'RegisterTaskDefinition',
      'UpdateService',
    ]);
    expect(ecs.log.registeredImage).toBe(
      '123456789012.dkr.ecr.us-east-1.amazonaws.com/web:abc123def456',
    );
    expect(ecs.log.updateCalls[0].taskDefinition).toBe(
      'arn:aws:ecs:us-east-1:123456789012:task-definition/web-svc:8',
    );
  });

  it('returns a signed DeploymentRecord whose previous_task_definition_arn matches pre-deploy ARN', async () => {
    const { proxy } = makeProxy();
    const ecs = makeEcsClient();
    const b = new AWSBackend({
      proxy,
      ecsClientFactory: () => ecs.client,
    });
    const record = await b.deploy(await buildArtifact(), 'staging', validParams());
    expect(record.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyDeploymentRecord(record).valid).toBe(true);
    expect(record.details.previous_task_definition_arn).toBe(
      'arn:aws:ecs:us-east-1:123456789012:task-definition/web-svc:7',
    );
    expect(record.details.task_definition_arn).toBe(
      'arn:aws:ecs:us-east-1:123456789012:task-definition/web-svc:8',
    );
  });

  it('rejects when account_id is not 12 digits', async () => {
    const { proxy } = makeProxy();
    const b = new AWSBackend({ proxy });
    await expect(
      b.deploy(await buildArtifact(), 'staging', { ...validParams(), account_id: '99' }),
    ).rejects.toBeInstanceOf(ParameterValidationError);
  });

  it('translates ThrottlingException to RATE_LIMIT', async () => {
    const { proxy } = makeProxy();
    const failing: EcsLikeClient = {
      async send() {
        throw Object.assign(new Error('rate limit'), { name: 'ThrottlingException' });
      },
    };
    const b = new AWSBackend({ proxy, ecsClientFactory: () => failing });
    const err = await b.deploy(await buildArtifact(), 'staging', validParams()).catch((e) => e);
    expect(err).toBeInstanceOf(CloudDeployError);
    expect((err as CloudDeployError).code).toBe('RATE_LIMIT');
    expect((err as CloudDeployError).retriable).toBe(true);
  });

  it('translates AccessDeniedException to AUTH_FAILED', async () => {
    const { proxy } = makeProxy();
    const failing: EcsLikeClient = {
      async send() {
        throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      },
    };
    const b = new AWSBackend({ proxy, ecsClientFactory: () => failing });
    const err = await b.deploy(await buildArtifact(), 'staging', validParams()).catch((e) => e);
    expect(err).toBeInstanceOf(CloudDeployError);
    expect((err as CloudDeployError).code).toBe('AUTH_FAILED');
  });
});

// ---------------------------------------------------------------------------
// healthCheck()
// ---------------------------------------------------------------------------

describe('AWSBackend.healthCheck', () => {
  function makeRecord(extra: Partial<DeploymentRecord['details']> = {}): DeploymentRecord {
    return {
      deployId: 'd-1',
      backend: 'aws',
      environment: 'staging',
      artifactId: 'a-1',
      deployedAt: new Date(0).toISOString(),
      status: 'deployed',
      details: {
        service_arn:
          'arn:aws:ecs:us-east-1:123456789012:service/web-cluster/web-svc',
        task_definition_arn:
          'arn:aws:ecs:us-east-1:123456789012:task-definition/web-svc:8',
        previous_task_definition_arn:
          'arn:aws:ecs:us-east-1:123456789012:task-definition/web-svc:7',
        target_group_arn:
          'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/web-tg/abc',
        cluster_name: 'web-cluster',
        service_name: 'web-svc',
        region: 'us-east-1',
        account_id: '123456789012',
        desired_count: 2,
        health_timeout_seconds: 5,
        ...extra,
      },
      hmac: 'x'.repeat(64),
    };
  }

  it('returns healthy:true when all targets are healthy and count matches desired', async () => {
    const { proxy } = makeProxy();
    const elb = makeElbV2(['healthy', 'healthy']);
    const b = new AWSBackend({ proxy, elbV2ClientFactory: () => elb.client });
    const status = await b.healthCheck(makeRecord());
    expect(status.healthy).toBe(true);
    expect(status.checks).toHaveLength(2);
    expect(status.checks.every((c) => c.passed)).toBe(true);
  });

  it('returns healthy:false with reason when timeout fires before all targets are healthy', async () => {
    const { proxy } = makeProxy();
    const elb = makeElbV2(['unhealthy', 'unhealthy']);
    let nowMs = 0;
    const b = new AWSBackend({
      proxy,
      elbV2ClientFactory: () => elb.client,
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

  it('returns healthy:false when target_group_arn missing from record', async () => {
    const { proxy } = makeProxy();
    const b = new AWSBackend({ proxy });
    const status = await b.healthCheck(makeRecord({ target_group_arn: '' }));
    expect(status.healthy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rollback()
// ---------------------------------------------------------------------------

describe('AWSBackend.rollback', () => {
  function rollbackRecord(): DeploymentRecord {
    return {
      deployId: 'd-1',
      backend: 'aws',
      environment: 'staging',
      artifactId: 'a-1',
      deployedAt: new Date(0).toISOString(),
      status: 'deployed',
      details: {
        service_arn:
          'arn:aws:ecs:us-east-1:123456789012:service/web-cluster/web-svc',
        task_definition_arn:
          'arn:aws:ecs:us-east-1:123456789012:task-definition/web-svc:8',
        previous_task_definition_arn:
          'arn:aws:ecs:us-east-1:123456789012:task-definition/web-svc:7',
        cluster_name: 'web-cluster',
        service_name: 'web-svc',
        region: 'us-east-1',
        account_id: '123456789012',
        desired_count: 2,
        health_timeout_seconds: 30,
        target_group_arn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/web-tg/abc',
        image_uri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/web:abc',
      },
      hmac: 'x'.repeat(64),
    };
  }

  it('updates the service to the previous task definition ARN', async () => {
    const { proxy } = makeProxy();
    const ecs = makeEcsClient();
    const b = new AWSBackend({ proxy, ecsClientFactory: () => ecs.client });
    const result = await b.rollback(rollbackRecord());
    expect(result.success).toBe(true);
    expect(result.restoredArtifactId).toBe(
      'arn:aws:ecs:us-east-1:123456789012:task-definition/web-svc:7',
    );
    expect(ecs.log.updateCalls).toHaveLength(1);
    expect(ecs.log.updateCalls[0].taskDefinition).toBe(
      'arn:aws:ecs:us-east-1:123456789012:task-definition/web-svc:7',
    );
  });

  it('returns success:false when previous_task_definition_arn missing from record', async () => {
    const { proxy } = makeProxy();
    const b = new AWSBackend({ proxy });
    const rec = rollbackRecord();
    rec.details.previous_task_definition_arn = '';
    const result = await b.rollback(rec);
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/missing/);
  });

  it('returns success:false when ecsClient.updateService throws', async () => {
    const { proxy } = makeProxy();
    const failing: EcsLikeClient = {
      async send() {
        throw new Error('boom');
      },
    };
    const b = new AWSBackend({ proxy, ecsClientFactory: () => failing });
    const result = await b.rollback(rollbackRecord());
    expect(result.success).toBe(false);
    expect(result.errors).toEqual([expect.stringMatching(/boom/)]);
  });
});

// ---------------------------------------------------------------------------
// Skipped integration tests requiring LocalStack / Docker engine (live
// infra) — promoted in SPEC-024-1-05.
// ---------------------------------------------------------------------------

describe('AWSBackend integration (skipped)', () => {
  it.skip('LocalStack: build → push → ECS deploy → ALB health → rollback (live infra)', async () => {
    // Promoted in SPEC-024-1-05; requires LocalStack + a Docker daemon.
  });
});
