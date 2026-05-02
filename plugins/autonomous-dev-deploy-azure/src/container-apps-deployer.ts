/**
 * Azure Container Apps deploy + revision-traffic helpers (SPEC-024-1-03
 * §"AzureBackend.deploy" / §"AzureBackend.rollback").
 *
 * Steps `createRevision` performs (in order — verified by acceptance
 * criteria):
 *   1. `getContainerApp` — capture the active (`previous`) revision
 *      BEFORE any update.
 *   2. `updateContainerApp` — set the template image to `imageUri`. In
 *      `Multiple` revision mode this materialises a brand-new revision.
 *   3. Captures the new revision name from the response (or, if absent,
 *      via a follow-up `getContainerApp`).
 *
 * `swapRevisionTraffic` is the rollback path: a single call that pins
 * 100% of traffic to a chosen revision name.
 *
 * @module @autonomous-dev/deploy-azure/container-apps-deployer
 */

import { CloudDeployError } from '../../autonomous-dev/intake/deploy/errors';
import { mapAzureError } from './error-mapper';

/** Subset of the Container App resource fields used here. */
export interface ContainerAppResource {
  name?: string | null;
  properties?: {
    latestRevisionName?: string | null;
    latestReadyRevisionName?: string | null;
    configuration?: {
      activeRevisionsMode?: 'Single' | 'Multiple' | string | null;
      ingress?: {
        fqdn?: string | null;
        traffic?: ReadonlyArray<{
          revisionName?: string | null;
          weight?: number | null;
          latestRevision?: boolean | null;
        }>;
      } | null;
    } | null;
    template?: {
      containers?: ReadonlyArray<{
        name?: string | null;
        image?: string | null;
        resources?: { cpu?: number | null; memory?: string | null } | null;
      }>;
    } | null;
  } | null;
}

/** Structural subset of the Container Apps client. */
export interface ContainerAppsLikeClient {
  getContainerApp(req: {
    resourceGroup: string;
    containerAppName: string;
  }): Promise<ContainerAppResource>;
  updateContainerApp(req: {
    resourceGroup: string;
    containerAppName: string;
    update: ContainerAppResource;
  }): Promise<ContainerAppResource>;
  updateTraffic(req: {
    resourceGroup: string;
    containerAppName: string;
    traffic: ReadonlyArray<{ revisionName: string; weight: number }>;
  }): Promise<ContainerAppResource>;
}

/** Options for `createRevision`. */
export interface CreateRevisionOptions {
  client: ContainerAppsLikeClient;
  resourceGroup: string;
  containerAppName: string;
  imageUri: string;
  cpu: string;
  memoryGib: string;
}

/** Result of `createRevision`. */
export interface CreateRevisionResult {
  newRevisionName: string;
  previousRevisionName: string;
  ingressFqdn: string;
}

/**
 * Push the new image into the Container App template (which causes
 * Container Apps to materialise a new revision). Captures the active
 * revision name BEFORE the update so rollback has a single name.
 */
export async function createRevision(
  opts: CreateRevisionOptions,
): Promise<CreateRevisionResult> {
  // 1. Capture pre-update active revision.
  let existing: ContainerAppResource;
  try {
    existing = await opts.client.getContainerApp({
      resourceGroup: opts.resourceGroup,
      containerAppName: opts.containerAppName,
    });
  } catch (err) {
    throw mapAzureError(err, 'ContainerApps:Get');
  }
  const prevRevision =
    existing.properties?.latestReadyRevisionName ??
    existing.properties?.latestRevisionName ??
    '';
  const ingressFqdn = existing.properties?.configuration?.ingress?.fqdn ?? '';

  // 2. Update the template image (and CPU/memory).
  const update: ContainerAppResource = {
    properties: {
      template: {
        containers: [
          {
            name: 'app',
            image: opts.imageUri,
            resources: {
              cpu: Number(opts.cpu),
              memory: `${opts.memoryGib}Gi`,
            },
          },
        ],
      },
    },
  };
  let updated: ContainerAppResource;
  try {
    updated = await opts.client.updateContainerApp({
      resourceGroup: opts.resourceGroup,
      containerAppName: opts.containerAppName,
      update,
    });
  } catch (err) {
    throw mapAzureError(err, 'ContainerApps:Update');
  }

  const newRevision =
    updated.properties?.latestRevisionName ??
    updated.properties?.latestReadyRevisionName ??
    '';
  if (!newRevision) {
    throw new CloudDeployError(
      'DEPLOY_FAILED',
      'azure',
      'ContainerApps:Update',
      false,
      `Container App ${opts.containerAppName} update did not surface a new revision name`,
    );
  }
  return {
    newRevisionName: newRevision,
    previousRevisionName: prevRevision,
    ingressFqdn:
      ingressFqdn ||
      updated.properties?.configuration?.ingress?.fqdn ||
      '',
  };
}

/** Options for `swapRevisionTraffic`. */
export interface SwapRevisionTrafficOptions {
  client: ContainerAppsLikeClient;
  resourceGroup: string;
  containerAppName: string;
  /** Revision to receive 100% of traffic. */
  targetRevisionName: string;
}

/**
 * Pin 100% of traffic to a specific revision. Used by rollback to swap
 * back to the previous revision.
 */
export async function swapRevisionTraffic(
  opts: SwapRevisionTrafficOptions,
): Promise<void> {
  try {
    await opts.client.updateTraffic({
      resourceGroup: opts.resourceGroup,
      containerAppName: opts.containerAppName,
      traffic: [{ revisionName: opts.targetRevisionName, weight: 100 }],
    });
  } catch (err) {
    throw mapAzureError(err, 'ContainerApps:UpdateTraffic');
  }
}
