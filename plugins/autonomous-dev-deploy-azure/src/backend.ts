/**
 * AzureBackend (SPEC-024-1-03 §"AzureBackend"). Implements
 * `DeploymentBackend` against Azure Container Registry (build) + Azure
 * Container Apps (deploy/rollback) + an HTTP probe (Front Door or the
 * Container App's own ingress FQDN — no Front Door SDK call).
 *
 * Zero shell invocation. Every external call goes through a typed SDK
 * client (ACR / Container Apps) or `fetch`. All credentials come from
 * the constructor-injected `CredentialProxy`; long-lived operator
 * credentials are never read or persisted.
 *
 * @module @autonomous-dev/deploy-azure/backend
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
  type AzureTokenCredential,
  toAzureTokenCredential,
} from './credential-proxy-client';
import {
  type AcrLikeClient,
  pushImage,
} from './acr-builder';
import {
  type ContainerAppsLikeClient,
  createRevision,
  swapRevisionTraffic,
} from './container-apps-deployer';
import { pollEndpointHealth } from './front-door-health-prober';

/**
 * Azure regions where Container Apps is GA. Trimmed to the most common;
 * expand as deployments demand. Closed-world validation surfaces an
 * unsupported location immediately.
 */
export const AZURE_LOCATIONS = [
  'eastus',
  'eastus2',
  'centralus',
  'northcentralus',
  'southcentralus',
  'westcentralus',
  'westus',
  'westus2',
  'westus3',
  'canadacentral',
  'canadaeast',
  'northeurope',
  'westeurope',
  'uksouth',
  'ukwest',
  'francecentral',
  'germanywestcentral',
  'switzerlandnorth',
  'swedencentral',
  'norwayeast',
  'eastasia',
  'southeastasia',
  'japaneast',
  'japanwest',
  'koreacentral',
  'australiaeast',
  'australiasoutheast',
  'centralindia',
  'southindia',
  'brazilsouth',
] as const;

/**
 * Public parameter schema. Helper agents (`azure-deploy-expert`) consume
 * this through this module export — DO NOT inline-construct elsewhere.
 */
export const PARAM_SCHEMA: Record<string, ParamSchema> = {
  subscription_id: {
    type: 'string',
    required: true,
    regex: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  },
  resource_group: { type: 'string', required: true, format: 'identifier' },
  location: {
    type: 'enum',
    required: true,
    enum: AZURE_LOCATIONS as readonly string[],
  },
  acr_name: { type: 'string', required: true, format: 'identifier' },
  container_app_name: { type: 'string', required: true, format: 'identifier' },
  image_repo: { type: 'string', required: true, format: 'shell-safe-arg' },
  cpu: { type: 'string', default: '0.5', regex: /^\d+(\.\d+)?$/ },
  memory_gib: { type: 'string', default: '1.0', regex: /^\d+(\.\d+)?$/ },
  front_door_endpoint: { type: 'string', required: false, format: 'shell-safe-arg' },
  health_path: { type: 'string', default: '/health', format: 'shell-safe-arg' },
  health_timeout_seconds: { type: 'number', default: 180, range: [10, 600] },
};

/** SDK client factory signatures. */
export interface AcrClientFactory {
  (cred: AzureTokenCredential, subscriptionId: string): AcrLikeClient;
}
export interface ContainerAppsClientFactory {
  (cred: AzureTokenCredential, subscriptionId: string): ContainerAppsLikeClient;
}

/** Constructor options. */
export interface AzureBackendOptions {
  proxy: CredentialProxy;
  acrClientFactory?: AcrClientFactory;
  containerAppsClientFactory?: ContainerAppsClientFactory;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class AzureBackend implements DeploymentBackend {
  readonly metadata: BackendMetadata = {
    name: 'azure',
    version: '0.1.0',
    supportedTargets: ['azure-container-apps'],
    capabilities: ['azure-container-apps'],
    requiredTools: [],
  };

  private readonly proxy: CredentialProxy;
  private readonly newAcr: AcrClientFactory;
  private readonly newContainerApps: ContainerAppsClientFactory;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: AzureBackendOptions) {
    this.proxy = opts.proxy;
    this.newAcr = opts.acrClientFactory ?? defaultAcrFactory;
    this.newContainerApps =
      opts.containerAppsClientFactory ?? defaultContainerAppsFactory;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep =
      opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  async build(ctx: BuildContext): Promise<BuildArtifact> {
    const validation = validateParameters(PARAM_SCHEMA, ctx.params);
    if (!validation.valid) {
      throw new ParameterValidationError(validation.errors);
    }
    const params = validation.sanitized;
    const subscriptionId = String(params.subscription_id);
    const resourceGroup = String(params.resource_group);
    const location = String(params.location);
    const acrName = String(params.acr_name);
    const imageRepo = String(params.image_repo);
    const imageUri = `${acrName}.azurecr.io/${imageRepo}:${ctx.commitSha}`;

    const cred = await this.proxy.acquire('azure', 'ACR:BuildTask', {
      resource: `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ContainerRegistry/registries/${acrName}`,
      region: location,
    });
    const tokenCred = toAzureTokenCredential(cred);
    const client = this.newAcr(tokenCred, subscriptionId);

    const result = await pushImage({
      client,
      resourceGroup,
      registryName: acrName,
      repoPath: ctx.repoPath,
      imageUri,
      now: this.now,
      sleep: this.sleep,
    });

    return {
      artifactId: generateUlid(),
      type: 'docker-image',
      location: result.imageUri,
      checksum: result.digest.replace(/^sha256:/, ''),
      sizeBytes: 0,
      metadata: {
        run_id: result.runId,
        acr_name: acrName,
        location,
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
    const subscriptionId = String(sanitized.subscription_id);
    const resourceGroup = String(sanitized.resource_group);
    const location = String(sanitized.location);
    const containerAppName = String(sanitized.container_app_name);
    const cpu = String(sanitized.cpu);
    const memoryGib = String(sanitized.memory_gib);
    const frontDoorEndpoint = sanitized.front_door_endpoint
      ? String(sanitized.front_door_endpoint)
      : '';
    const healthPath = String(sanitized.health_path);
    const healthTimeoutSeconds = Number(sanitized.health_timeout_seconds);

    const containerAppFqn = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.App/containerApps/${containerAppName}`;

    const cred = await this.proxy.acquire('azure', 'ContainerApps:CreateRevision', {
      resource: containerAppFqn,
      region: location,
    });
    const tokenCred = toAzureTokenCredential(cred);
    const client = this.newContainerApps(tokenCred, subscriptionId);

    const result = await createRevision({
      client,
      resourceGroup,
      containerAppName,
      imageUri: artifact.location,
      cpu,
      memoryGib,
    });

    const unsigned: DeploymentRecord = {
      deployId: generateUlid(),
      backend: this.metadata.name,
      environment,
      artifactId: artifact.artifactId,
      deployedAt: new Date(this.now()).toISOString(),
      status: 'deployed',
      details: {
        revision_name: result.newRevisionName,
        previous_revision: result.previousRevisionName,
        image_uri: artifact.location,
        location,
        subscription_id: subscriptionId,
        resource_group: resourceGroup,
        container_app_name: containerAppName,
        ingress_fqdn: result.ingressFqdn,
        front_door_endpoint: frontDoorEndpoint,
        health_path: healthPath,
        health_timeout_seconds: healthTimeoutSeconds,
      },
      hmac: '',
    };
    return signDeploymentRecord(unsigned);
  }

  async healthCheck(record: DeploymentRecord): Promise<HealthStatus> {
    const frontDoorEndpoint = String(record.details.front_door_endpoint ?? '');
    const ingressFqdn = String(record.details.ingress_fqdn ?? '');
    const healthPath = String(record.details.health_path ?? '/health');
    const timeoutSeconds = Number(record.details.health_timeout_seconds ?? 180);
    const baseUrl = frontDoorEndpoint
      ? frontDoorEndpoint.replace(/\/+$/, '')
      : ingressFqdn
        ? `https://${ingressFqdn.replace(/^https?:\/\//, '')}`
        : '';
    if (!baseUrl) {
      return {
        healthy: false,
        checks: [
          { name: 'record-missing-front-door-or-ingress', passed: false },
        ],
        unhealthyReason: 'record-missing-front-door-or-ingress',
      };
    }
    const url = `${baseUrl}${healthPath.startsWith('/') ? '' : '/'}${healthPath}`;
    const result = await pollEndpointHealth({
      url,
      timeoutSeconds,
      fetchImpl: this.fetchImpl,
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
    const subscriptionId = String(record.details.subscription_id ?? '');
    const resourceGroup = String(record.details.resource_group ?? '');
    const containerAppName = String(record.details.container_app_name ?? '');
    const previousRevision = String(record.details.previous_revision ?? '');
    const location = String(record.details.location ?? '');
    if (!subscriptionId || !resourceGroup || !containerAppName || !previousRevision) {
      return {
        success: false,
        errors: [
          'rollback aborted: record.details missing subscription_id/resource_group/container_app_name/previous_revision',
        ],
      };
    }
    let cred;
    try {
      cred = await this.proxy.acquire('azure', 'ContainerApps:UpdateRevision', {
        resource: `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.App/containerApps/${containerAppName}`,
        region: location,
      });
    } catch (err) {
      return { success: false, errors: [(err as Error).message] };
    }
    let tokenCred: AzureTokenCredential;
    try {
      tokenCred = toAzureTokenCredential(cred);
    } catch (err) {
      return { success: false, errors: [(err as Error).message] };
    }
    const client = this.newContainerApps(tokenCred, subscriptionId);
    try {
      await swapRevisionTraffic({
        client,
        resourceGroup,
        containerAppName,
        targetRevisionName: previousRevision,
      });
      return {
        success: true,
        restoredArtifactId: previousRevision,
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

const defaultAcrFactory: AcrClientFactory = () => {
  throw new Error(
    'AzureBackend default ACR client factory not configured; install @azure/arm-containerregistry and inject acrClientFactory.',
  );
};
const defaultContainerAppsFactory: ContainerAppsClientFactory = () => {
  throw new Error(
    'AzureBackend default Container Apps client factory not configured; install @azure/arm-appcontainers and inject containerAppsClientFactory.',
  );
};

// `CloudDeployError` re-exported for test convenience.
export { CloudDeployError };
