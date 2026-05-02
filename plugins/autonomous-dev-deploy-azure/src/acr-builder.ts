/**
 * Azure Container Registry build helper (SPEC-024-1-03 §"AzureBackend.build").
 *
 * Wraps the structural shape of `@azure/arm-containerregistry`'s
 * `ContainerRegistryManagementClient` so `AzureBackend.build()` can
 * submit an ACR build run and poll until terminal without depending on
 * the SDK at compile time.
 *
 * @module @autonomous-dev/deploy-azure/acr-builder
 */

import { CloudDeployError } from '../../autonomous-dev/intake/deploy/errors';
import { mapAzureError } from './error-mapper';

/** ACR run status enum subset we care about. */
export type AcrRunStatus =
  | 'Queued'
  | 'Started'
  | 'Running'
  | 'Succeeded'
  | 'Failed'
  | 'Canceled'
  | 'Error'
  | 'Timeout';

/** Subset of the ACR `Run` resource fields used here. */
export interface AcrRun {
  runId?: string | null;
  status?: AcrRunStatus | null;
  outputImages?: ReadonlyArray<{
    registry?: string | null;
    repository?: string | null;
    tag?: string | null;
    digest?: string | null;
  }>;
  imageUpdateTrigger?: { id?: string | null };
}

/**
 * Structural subset of the ACR management client. Real client provides
 * a `runs` sub-resource with `beginScheduleRun`/`get`; we use a flat
 * shape for ergonomics in tests.
 */
export interface AcrLikeClient {
  scheduleDockerBuildRun(req: {
    resourceGroup: string;
    registryName: string;
    repoPath: string;
    imageName: string;
  }): Promise<AcrRun>;
  getRun(req: {
    resourceGroup: string;
    registryName: string;
    runId: string;
  }): Promise<AcrRun>;
}

/** Options for `pushImage`. */
export interface PushImageOptions {
  client: AcrLikeClient;
  resourceGroup: string;
  registryName: string;
  repoPath: string;
  /** Full image URI: `<registry>.azurecr.io/<repo>:<sha>`. */
  imageUri: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Result of a successful ACR build run. */
export interface PushImageResult {
  runId: string;
  imageUri: string;
  digest: string;
}

const DEFAULT_POLL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Submit an ACR docker-build run, poll until terminal, and return the
 * resulting image digest.
 */
export async function pushImage(opts: PushImageOptions): Promise<PushImageResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let started: AcrRun;
  try {
    started = await opts.client.scheduleDockerBuildRun({
      resourceGroup: opts.resourceGroup,
      registryName: opts.registryName,
      repoPath: opts.repoPath,
      imageName: opts.imageUri,
    });
  } catch (err) {
    throw mapAzureError(err, 'ACR:ScheduleDockerBuildRun');
  }
  const runId = started.runId;
  if (!runId) {
    throw new CloudDeployError(
      'BUILD_FAILED',
      'azure',
      'ACR:ScheduleDockerBuildRun',
      false,
      'ACR scheduleDockerBuildRun returned no runId',
    );
  }

  const start = now();
  while (true) {
    let run: AcrRun;
    try {
      run = await opts.client.getRun({
        resourceGroup: opts.resourceGroup,
        registryName: opts.registryName,
        runId,
      });
    } catch (err) {
      throw mapAzureError(err, 'ACR:GetRun');
    }
    const status = run.status ?? 'Queued';
    if (status === 'Succeeded') {
      const digest = run.outputImages?.[0]?.digest;
      if (!digest) {
        throw new CloudDeployError(
          'BUILD_FAILED',
          'azure',
          'ACR:GetRun',
          false,
          `ACR run ${runId} succeeded but produced no digest`,
        );
      }
      return { runId, imageUri: opts.imageUri, digest };
    }
    if (status === 'Failed' || status === 'Canceled' || status === 'Error' || status === 'Timeout') {
      throw new CloudDeployError(
        'BUILD_FAILED',
        'azure',
        'ACR:GetRun',
        status === 'Error',
        `ACR run ${runId} terminated with status ${status}`,
      );
    }
    if (now() - start > timeoutMs) {
      throw new CloudDeployError(
        'BUILD_FAILED',
        'azure',
        'ACR:GetRun',
        true,
        `ACR run ${runId} did not reach a terminal status within ${timeoutMs}ms (last=${status})`,
      );
    }
    await sleep(pollMs);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
