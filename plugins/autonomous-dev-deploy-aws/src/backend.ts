/**
 * AWSBackend (SPEC-024-1-02 §"AWSBackend"). Implements
 * `DeploymentBackend` against ECR (build) + ECS Fargate (deploy) +
 * ELBv2 (health) using the AWS SDK v3 modular clients.
 *
 * Zero shell invocation. Image build/push uses `dockerode` against the
 * Docker Engine HTTP API. All credentials come from the
 * constructor-injected `CredentialProxy`.
 *
 * @module @autonomous-dev/deploy-aws/backend
 */

import {
  type ParamSchema,
  validateParameters,
} from '../../autonomous-dev/intake/deploy/parameters';
import {
  CloudDeployError,
  ParameterValidationError,
} from '../../autonomous-dev/intake/deploy/errors';
import { signDeploymentRecord } from '../../autonomous-dev/intake/deploy/record-signer';
import { generateUlid } from '../../autonomous-dev/intake/deploy/id';
import type {
  BackendMetadata,
  BuildArtifact,
  BuildContext,
  DeployParameters,
  DeploymentBackend,
  DeploymentRecord,
  HealthStatus,
  RollbackResult,
} from '../../autonomous-dev/intake/deploy/types';
import type {
  CredentialProxy,
} from '../../autonomous-dev/intake/deploy/credential-proxy-types';

import {
  type AwsClientOptions,
  toAwsClientOptions,
} from './credential-proxy-client';
import {
  type DockerLikeClient,
  type EcrLikeClient,
  loginAndPush,
} from './ecr-builder';
import {
  type EcsLikeClient,
  revertTaskDef,
  updateService,
} from './ecs-deployer';
import {
  type ElbV2LikeClient,
  pollAlbHealth,
} from './health-checker';

/**
 * AWS commercial regions. Trimmed to the most common; expand as
 * deployments demand. Closed-world validation surfaces an unsupported
 * region immediately.
 */
export const AWS_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ca-central-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-north-1',
  'eu-south-1',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-south-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'sa-east-1',
] as const;

/**
 * Public parameter schema. Helper agents (`aws-deploy-expert`) consume
 * this through this module export — DO NOT inline-construct elsewhere.
 */
export const PARAM_SCHEMA: Record<string, ParamSchema> = {
  account_id: { type: 'string', required: true, regex: /^\d{12}$/ },
  region: { type: 'enum', required: true, enum: AWS_REGIONS as readonly string[] },
  cluster_name: { type: 'string', required: true, format: 'identifier' },
  service_name: { type: 'string', required: true, format: 'identifier' },
  ecr_repo: { type: 'string', required: true, format: 'identifier' },
  task_family: { type: 'string', required: true, format: 'identifier' },
  target_group_arn: { type: 'string', required: true, format: 'shell-safe-arg' },
  health_timeout_seconds: { type: 'number', default: 180, range: [10, 600] },
  desired_count: { type: 'number', default: 1, range: [1, 100] },
};

/** SDK client factory signatures. */
export interface EcrClientFactory {
  (opts: AwsClientOptions): EcrLikeClient;
}
export interface EcsClientFactory {
  (opts: AwsClientOptions): EcsLikeClient;
}
export interface ElbV2ClientFactory {
  (opts: AwsClientOptions): ElbV2LikeClient;
}
export interface DockerClientFactory {
  (): DockerLikeClient;
}

/** Constructor options. */
export interface AWSBackendOptions {
  proxy: CredentialProxy;
  ecrClientFactory?: EcrClientFactory;
  ecsClientFactory?: EcsClientFactory;
  elbV2ClientFactory?: ElbV2ClientFactory;
  dockerClientFactory?: DockerClientFactory;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class AWSBackend implements DeploymentBackend {
  readonly metadata: BackendMetadata = {
    name: 'aws',
    version: '0.1.0',
    supportedTargets: ['aws-ecs-fargate'],
    capabilities: ['aws-ecs-fargate'],
    requiredTools: [],
  };

  private readonly proxy: CredentialProxy;
  private readonly newEcr: EcrClientFactory;
  private readonly newEcs: EcsClientFactory;
  private readonly newElbV2: ElbV2ClientFactory;
  private readonly newDocker: DockerClientFactory;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: AWSBackendOptions) {
    this.proxy = opts.proxy;
    this.newEcr = opts.ecrClientFactory ?? defaultEcrFactory;
    this.newEcs = opts.ecsClientFactory ?? defaultEcsFactory;
    this.newElbV2 = opts.elbV2ClientFactory ?? defaultElbV2Factory;
    this.newDocker = opts.dockerClientFactory ?? defaultDockerFactory;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  async build(ctx: BuildContext): Promise<BuildArtifact> {
    const validation = validateParameters(PARAM_SCHEMA, ctx.params);
    if (!validation.valid) {
      throw new ParameterValidationError(validation.errors);
    }
    const params = validation.sanitized;
    const accountId = String(params.account_id);
    const region = String(params.region);
    const ecrRepo = String(params.ecr_repo);
    const imageUri = `${accountId}.dkr.ecr.${region}.amazonaws.com/${ecrRepo}:${ctx.commitSha}`;

    const cred = await this.proxy.acquire('aws', 'ECR:PutImage', {
      resource: `arn:aws:ecr:${region}:${accountId}:repository/${ecrRepo}`,
      region,
      account: accountId,
    });
    const clientOpts = toAwsClientOptions(cred, region);
    const ecrClient = this.newEcr(clientOpts);
    const docker = this.newDocker();

    const result = await loginAndPush({
      ecrClient,
      docker,
      repoPath: ctx.repoPath,
      imageUri,
    });

    return {
      artifactId: generateUlid(),
      type: 'docker-image',
      location: result.imageUri,
      checksum: result.digest.replace(/^sha256:/, ''),
      sizeBytes: result.sizeBytes,
      metadata: {
        ecr_repo: ecrRepo,
        region,
        account_id: accountId,
      },
    };
  }

  async deploy(
    artifact: BuildArtifact,
    environment: string,
    params: DeployParameters,
  ): Promise<DeploymentRecord> {
    const validation = validateParameters(PARAM_SCHEMA, params);
    if (!validation.valid) {
      throw new ParameterValidationError(validation.errors);
    }
    const sanitized = validation.sanitized;
    const accountId = String(sanitized.account_id);
    const region = String(sanitized.region);
    const cluster = String(sanitized.cluster_name);
    const service = String(sanitized.service_name);
    const taskFamily = String(sanitized.task_family);
    const targetGroupArn = String(sanitized.target_group_arn);
    const desired = Number(sanitized.desired_count);

    const serviceArnGuess = `arn:aws:ecs:${region}:${accountId}:service/${cluster}/${service}`;

    const cred = await this.proxy.acquire('aws', 'ECS:UpdateService', {
      resource: serviceArnGuess,
      region,
      account: accountId,
    });
    const clientOpts = toAwsClientOptions(cred, region);
    const ecsClient = this.newEcs(clientOpts);

    const result = await updateService({
      client: ecsClient,
      cluster,
      service,
      taskFamily,
      imageUri: artifact.location,
      desiredCount: desired,
    });

    const unsigned: DeploymentRecord = {
      deployId: generateUlid(),
      backend: this.metadata.name,
      environment,
      artifactId: artifact.artifactId,
      deployedAt: new Date(this.now()).toISOString(),
      status: 'deployed',
      details: {
        service_arn: result.serviceArn,
        task_definition_arn: result.newTaskDefinitionArn,
        previous_task_definition_arn: result.previousTaskDefinitionArn,
        target_group_arn: targetGroupArn,
        cluster_name: cluster,
        service_name: service,
        region,
        account_id: accountId,
        desired_count: desired,
        health_timeout_seconds: Number(sanitized.health_timeout_seconds),
        image_uri: artifact.location,
      },
      hmac: '',
    };
    return signDeploymentRecord(unsigned);
  }

  async healthCheck(record: DeploymentRecord): Promise<HealthStatus> {
    const region = String(record.details.region ?? '');
    const accountId = String(record.details.account_id ?? '');
    const targetGroupArn = String(record.details.target_group_arn ?? '');
    const desiredCount = Number(record.details.desired_count ?? 1);
    const timeoutSeconds = Number(record.details.health_timeout_seconds ?? 180);
    if (!region || !targetGroupArn) {
      return {
        healthy: false,
        checks: [{ name: 'record-missing-region-or-target-group', passed: false }],
        unhealthyReason: 'record-missing-region-or-target-group',
      };
    }
    const cred = await this.proxy.acquire(
      'aws',
      'ELBv2:DescribeTargetHealth',
      { resource: targetGroupArn, region, account: accountId },
    );
    const clientOpts = toAwsClientOptions(cred, region);
    const client = this.newElbV2(clientOpts);

    const result = await pollAlbHealth({
      client,
      targetGroupArn,
      desiredCount,
      timeoutSeconds,
      now: this.now,
      sleep: this.sleep,
    });
    return {
      healthy: result.healthy,
      checks: result.checks,
      ...(result.healthy ? {} : { unhealthyReason: result.unhealthyReason ?? 'unknown' }),
    };
  }

  async rollback(record: DeploymentRecord): Promise<RollbackResult> {
    const region = String(record.details.region ?? '');
    const accountId = String(record.details.account_id ?? '');
    const cluster = String(record.details.cluster_name ?? '');
    const service = String(record.details.service_name ?? '');
    const previousTaskDef = String(record.details.previous_task_definition_arn ?? '');
    if (!region || !cluster || !service || !previousTaskDef) {
      return {
        success: false,
        errors: ['rollback aborted: record.details missing region/cluster/service/previous_task_definition_arn'],
      };
    }
    let cred;
    try {
      cred = await this.proxy.acquire('aws', 'ECS:UpdateService', {
        resource: `arn:aws:ecs:${region}:${accountId}:service/${cluster}/${service}`,
        region,
        account: accountId,
      });
    } catch (err) {
      return { success: false, errors: [(err as Error).message] };
    }
    const clientOpts = toAwsClientOptions(cred, region);
    const client = this.newEcs(clientOpts);
    try {
      await revertTaskDef({
        client,
        cluster,
        service,
        previousTaskDefinitionArn: previousTaskDef,
      });
      return {
        success: true,
        restoredArtifactId: previousTaskDef,
        errors: [],
      };
    } catch (err) {
      return { success: false, errors: [(err as Error).message] };
    }
  }
}

// ---------------------------------------------------------------------------
// Default factories. Throw at runtime if invoked without injection: real
// SDKs live in this plugin's node_modules and are pulled in by code that
// owns the runtime entry point. Tests inject mocks so these never run.
// ---------------------------------------------------------------------------

const defaultEcrFactory: EcrClientFactory = () => {
  throw new Error(
    'AWSBackend default ECR client factory not configured; install @aws-sdk/client-ecr and inject ecrClientFactory.',
  );
};
const defaultEcsFactory: EcsClientFactory = () => {
  throw new Error(
    'AWSBackend default ECS client factory not configured; install @aws-sdk/client-ecs and inject ecsClientFactory.',
  );
};
const defaultElbV2Factory: ElbV2ClientFactory = () => {
  throw new Error(
    'AWSBackend default ELBv2 client factory not configured; install @aws-sdk/client-elastic-load-balancing-v2 and inject elbV2ClientFactory.',
  );
};
const defaultDockerFactory: DockerClientFactory = () => {
  throw new Error(
    'AWSBackend default Docker client factory not configured; install dockerode and inject dockerClientFactory.',
  );
};

// `CloudDeployError` re-exported for test convenience.
export { CloudDeployError };
