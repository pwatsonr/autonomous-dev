/**
 * ECS Fargate deploy + revert helpers (SPEC-024-1-02 §"AWSBackend.deploy").
 *
 * Steps `updateService` performs (in order — verified by acceptance
 * criteria):
 *   1. `describeServices` — capture `previousTaskDefinitionArn` BEFORE
 *      registering anything.
 *   2. `describeTaskDefinition` — copy the existing task def fields.
 *   3. `registerTaskDefinition` — new revision with the new image.
 *   4. `updateService` — point the service at the new revision.
 *
 * `revertTaskDef` rolls back via a single `updateService` against
 * `previousTaskDefinitionArn`.
 *
 * @module @autonomous-dev/deploy-aws/ecs-deployer
 */

import { CloudDeployError } from '../../autonomous-dev/intake/deploy/errors';
import { mapAwsError } from './error-mapper';

/** Subset of ECS `TaskDefinition` fields we copy. */
export interface EcsTaskDefinition {
  family?: string | null;
  taskDefinitionArn?: string | null;
  taskRoleArn?: string | null;
  executionRoleArn?: string | null;
  networkMode?: string | null;
  containerDefinitions?: ReadonlyArray<{
    name?: string | null;
    image?: string | null;
    cpu?: number;
    memory?: number;
    portMappings?: ReadonlyArray<Record<string, unknown>>;
    environment?: ReadonlyArray<Record<string, unknown>>;
  }>;
  cpu?: string | null;
  memory?: string | null;
  requiresCompatibilities?: ReadonlyArray<string>;
}

/** Subset of ECS `Service` description used here. */
export interface EcsService {
  serviceArn?: string | null;
  serviceName?: string | null;
  taskDefinition?: string | null;
  desiredCount?: number;
}

/** Structural subset of `ECSClient`. */
export interface EcsLikeClient {
  send(
    command:
      | { __op: 'DescribeServices'; cluster: string; services: ReadonlyArray<string> }
      | { __op: 'DescribeTaskDefinition'; taskDefinition: string }
      | { __op: 'RegisterTaskDefinition'; input: EcsTaskDefinition }
      | { __op: 'UpdateService'; cluster: string; service: string; taskDefinition: string; desiredCount?: number },
  ): Promise<{
    services?: ReadonlyArray<EcsService>;
    taskDefinition?: EcsTaskDefinition;
    service?: EcsService;
  }>;
}

/** Options for `updateService`. */
export interface EcsUpdateServiceOptions {
  client: EcsLikeClient;
  cluster: string;
  service: string;
  taskFamily: string;
  imageUri: string;
  desiredCount: number;
}

/** Result of `updateService`. */
export interface EcsUpdateServiceResult {
  serviceArn: string;
  newTaskDefinitionArn: string;
  previousTaskDefinitionArn: string;
}

/**
 * Register a new task def revision and shift the service to it.
 * Captures the previous task def ARN BEFORE registering so rollback has
 * a single ARN to revert to.
 */
export async function updateService(
  opts: EcsUpdateServiceOptions,
): Promise<EcsUpdateServiceResult> {
  const { client, cluster, service, taskFamily, imageUri, desiredCount } = opts;

  // 1. Capture `previousTaskDefinitionArn` from the live service.
  let previousTaskDefArn: string;
  let serviceArn: string;
  try {
    const resp = await client.send({
      __op: 'DescribeServices',
      cluster,
      services: [service],
    });
    const svc = resp.services?.[0];
    if (!svc?.taskDefinition || !svc.serviceArn) {
      throw new CloudDeployError(
        'NOT_FOUND',
        'aws',
        'ECS:DescribeServices',
        false,
        `service ${service} in cluster ${cluster} not found or has no taskDefinition`,
      );
    }
    previousTaskDefArn = svc.taskDefinition;
    serviceArn = svc.serviceArn;
  } catch (err) {
    if (err instanceof CloudDeployError) throw err;
    throw mapAwsError(err, 'ECS:DescribeServices');
  }

  // 2. Read the existing task def so we can copy its fields.
  let existingTaskDef: EcsTaskDefinition;
  try {
    const resp = await client.send({
      __op: 'DescribeTaskDefinition',
      taskDefinition: taskFamily,
    });
    if (!resp.taskDefinition) {
      throw new CloudDeployError(
        'NOT_FOUND',
        'aws',
        'ECS:DescribeTaskDefinition',
        false,
        `task definition family ${taskFamily} not found`,
      );
    }
    existingTaskDef = resp.taskDefinition;
  } catch (err) {
    if (err instanceof CloudDeployError) throw err;
    throw mapAwsError(err, 'ECS:DescribeTaskDefinition');
  }

  // 3. Register a new revision with the new image.
  const newContainerDefs = (existingTaskDef.containerDefinitions ?? []).map((c, i) =>
    i === 0 ? { ...c, image: imageUri } : c,
  );
  const registerInput: EcsTaskDefinition = {
    family: existingTaskDef.family ?? taskFamily,
    taskRoleArn: existingTaskDef.taskRoleArn ?? null,
    executionRoleArn: existingTaskDef.executionRoleArn ?? null,
    networkMode: existingTaskDef.networkMode ?? null,
    cpu: existingTaskDef.cpu ?? null,
    memory: existingTaskDef.memory ?? null,
    requiresCompatibilities: existingTaskDef.requiresCompatibilities ?? [],
    containerDefinitions: newContainerDefs,
  };
  let newTaskDefArn: string;
  try {
    const resp = await client.send({
      __op: 'RegisterTaskDefinition',
      input: registerInput,
    });
    if (!resp.taskDefinition?.taskDefinitionArn) {
      throw new CloudDeployError(
        'DEPLOY_FAILED',
        'aws',
        'ECS:RegisterTaskDefinition',
        false,
        `RegisterTaskDefinition for family ${taskFamily} returned no taskDefinitionArn`,
      );
    }
    newTaskDefArn = resp.taskDefinition.taskDefinitionArn;
  } catch (err) {
    if (err instanceof CloudDeployError) throw err;
    throw mapAwsError(err, 'ECS:RegisterTaskDefinition');
  }

  // 4. Point the service at the new task def.
  try {
    await client.send({
      __op: 'UpdateService',
      cluster,
      service,
      taskDefinition: newTaskDefArn,
      desiredCount,
    });
  } catch (err) {
    throw mapAwsError(err, 'ECS:UpdateService');
  }

  return {
    serviceArn,
    newTaskDefinitionArn: newTaskDefArn,
    previousTaskDefinitionArn: previousTaskDefArn,
  };
}

/** Options for `revertTaskDef`. */
export interface EcsRevertOptions {
  client: EcsLikeClient;
  cluster: string;
  service: string;
  previousTaskDefinitionArn: string;
}

/** Roll back the service to a prior task definition revision. */
export async function revertTaskDef(opts: EcsRevertOptions): Promise<void> {
  try {
    await opts.client.send({
      __op: 'UpdateService',
      cluster: opts.cluster,
      service: opts.service,
      taskDefinition: opts.previousTaskDefinitionArn,
    });
  } catch (err) {
    throw mapAwsError(err, 'ECS:UpdateService');
  }
}
