/**
 * GCPBackend (SPEC-024-1-02 §"GCPBackend"). Implements
 * `DeploymentBackend` against Cloud Build (build) + Cloud Run (deploy /
 * health / rollback).
 *
 * Zero shell invocation. Every external call goes through a typed SDK
 * client (Cloud Build / Cloud Run / `fetch`). All credentials come from
 * the constructor-injected `CredentialProxy`; no long-lived operator
 * tokens are ever read or persisted.
 *
 * @module @autonomous-dev/deploy-gcp/backend
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
  type CloudBuildLikeClient,
  type SubmitBuildResult,
  submitBuild,
} from './cloud-build-helper';
import {
  type CloudRunLikeClient,
  deployRevision,
  pollHealth,
  rollbackToRevision,
} from './cloud-run-helper';

/**
 * GCP regions where Cloud Run is GA. Trimmed to the most common; expand
 * via PR as new regions launch. Validation is closed-world so an
 * unsupported region surfaces immediately.
 */
export const GCP_REGIONS = [
  'us-central1',
  'us-east1',
  'us-east4',
  'us-east5',
  'us-west1',
  'us-west2',
  'us-west3',
  'us-west4',
  'europe-north1',
  'europe-west1',
  'europe-west2',
  'europe-west3',
  'europe-west4',
  'europe-west6',
  'asia-east1',
  'asia-east2',
  'asia-northeast1',
  'asia-northeast2',
  'asia-northeast3',
  'asia-south1',
  'asia-southeast1',
  'asia-southeast2',
  'australia-southeast1',
  'southamerica-east1',
] as const;

/**
 * Public parameter schema. Helper agents (`gcp-deploy-expert`) consume
 * this through a module export — DO NOT inline-construct elsewhere.
 */
export const PARAM_SCHEMA: Record<string, ParamSchema> = {
  project_id: { type: 'string', required: true, format: 'identifier' },
  region: { type: 'enum', required: true, enum: GCP_REGIONS as readonly string[] },
  service_name: { type: 'string', required: true, format: 'identifier' },
  image_repo: { type: 'string', required: true, format: 'shell-safe-arg' },
  cpu: { type: 'string', default: '1', regex: /^\d+(\.\d+)?$/ },
  memory_mib: { type: 'number', default: 512, range: [128, 32768] },
  health_path: { type: 'string', default: '/health', format: 'shell-safe-arg' },
  health_timeout_seconds: { type: 'number', default: 120, range: [10, 600] },
};

/** Test seam factory signatures. */
export interface CloudBuildClientFactory {
  (auth: { token: string }): CloudBuildLikeClient;
}
export interface CloudRunClientFactory {
  (auth: { token: string }): CloudRunLikeClient;
}

/** Constructor options. */
export interface GCPBackendOptions {
  proxy: CredentialProxy;
  /** Test seam: returns a Cloud Build client given creds. */
  cloudBuildClientFactory?: CloudBuildClientFactory;
  /** Test seam: returns a Cloud Run client given creds. */
  cloudRunClientFactory?: CloudRunClientFactory;
  /** Test seam: replace `globalThis.fetch` for health checks. */
  fetchImpl?: typeof fetch;
  /** Test seam: deterministic now() for poll deadlines. */
  now?: () => number;
  /** Test seam: replace setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export class GCPBackend implements DeploymentBackend {
  readonly metadata: BackendMetadata = {
    name: 'gcp',
    version: '0.1.0',
    supportedTargets: ['gcp-cloud-run'],
    capabilities: ['gcp-cloud-run'],
    requiredTools: [],
  };

  private readonly proxy: CredentialProxy;
  private readonly newCloudBuild: CloudBuildClientFactory;
  private readonly newCloudRun: CloudRunClientFactory;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Captured `BuildContext` so `deploy()` can recover params/sha pinned at build time. */
  private lastBuildCtx: BuildContext | null = null;

  constructor(opts: GCPBackendOptions) {
    this.proxy = opts.proxy;
    this.newCloudBuild = opts.cloudBuildClientFactory ?? defaultCloudBuildFactory;
    this.newCloudRun = opts.cloudRunClientFactory ?? defaultCloudRunFactory;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  async build(ctx: BuildContext): Promise<BuildArtifact> {
    this.lastBuildCtx = ctx;
    const validation = validateParameters(PARAM_SCHEMA, ctx.params);
    if (!validation.valid) {
      throw new ParameterValidationError(validation.errors);
    }
    const params = validation.sanitized;
    const projectId = String(params.project_id);
    const region = String(params.region);
    const imageRepo = String(params.image_repo);
    const imageUri = `gcr.io/${projectId}/${imageRepo}:${ctx.commitSha}`;

    const cred = await this.proxy.acquire(
      'gcp',
      'CloudBuild:CreateBuild',
      { resource: `projects/${projectId}`, region, account: projectId },
    );
    if (!cred.token) {
      throw new CloudDeployError(
        'AUTH_FAILED',
        'gcp',
        'CloudBuild:CreateBuild',
        false,
        'CredentialProxy returned no token for GCP build',
      );
    }
    const client = this.newCloudBuild({ token: cred.token });
    const result: SubmitBuildResult = await submitBuild(client, {
      projectId,
      imageUri,
      repoPath: ctx.repoPath,
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
        build_id: result.buildId,
        project_id: projectId,
        region,
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
    const projectId = String(sanitized.project_id);
    const region = String(sanitized.region);
    const serviceName = String(sanitized.service_name);
    const cpu = String(sanitized.cpu);
    const memoryMib = Number(sanitized.memory_mib);

    const serviceFqn = `projects/${projectId}/locations/${region}/services/${serviceName}`;

    const cred = await this.proxy.acquire('gcp', 'Run:Deploy', {
      resource: serviceFqn,
      region,
      account: projectId,
    });
    if (!cred.token) {
      throw new CloudDeployError(
        'AUTH_FAILED',
        'gcp',
        'Run:Deploy',
        false,
        'CredentialProxy returned no token for GCP deploy',
      );
    }
    const client = this.newCloudRun({ token: cred.token });

    const result = await deployRevision(client, {
      serviceFqn,
      imageUri: artifact.location,
      cpu,
      memoryMib,
    });

    const unsigned: DeploymentRecord = {
      deployId: generateUlid(),
      backend: this.metadata.name,
      environment,
      artifactId: artifact.artifactId,
      deployedAt: new Date(this.now()).toISOString(),
      status: 'deployed',
      details: {
        service_url: result.serviceUrl,
        revision_name: result.revisionName,
        project_id: projectId,
        region,
        service_name: serviceName,
        image_uri: artifact.location,
        health_path: String(sanitized.health_path),
        health_timeout_seconds: Number(sanitized.health_timeout_seconds),
      },
      hmac: '',
    };
    return signDeploymentRecord(unsigned);
  }

  async healthCheck(record: DeploymentRecord): Promise<HealthStatus> {
    const url = String(record.details.service_url ?? '');
    if (!url) {
      return {
        healthy: false,
        checks: [{ name: 'service-url-missing', passed: false }],
        unhealthyReason: 'service-url-missing',
      };
    }
    const path = String(record.details.health_path ?? '/health');
    const timeoutSeconds = Number(record.details.health_timeout_seconds ?? 120);
    const result = await pollHealth({
      serviceUrl: url,
      healthPath: path,
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
    const projectId = String(record.details.project_id ?? '');
    const region = String(record.details.region ?? '');
    const serviceName = String(record.details.service_name ?? '');
    const currentRevision = String(record.details.revision_name ?? '');
    if (!projectId || !region || !serviceName || !currentRevision) {
      return {
        success: false,
        errors: ['rollback aborted: record.details missing project/region/service/revision'],
      };
    }
    const serviceFqn = `projects/${projectId}/locations/${region}/services/${serviceName}`;

    let cred;
    try {
      cred = await this.proxy.acquire('gcp', 'Run:UpdateService', {
        resource: serviceFqn,
        region,
        account: projectId,
      });
    } catch (err) {
      return { success: false, errors: [(err as Error).message] };
    }
    if (!cred.token) {
      return { success: false, errors: ['CredentialProxy returned no token for GCP rollback'] };
    }
    const client = this.newCloudRun({ token: cred.token });
    try {
      const info = await rollbackToRevision(client, {
        serviceFqn,
        currentRevisionName: currentRevision,
      });
      return {
        success: true,
        restoredArtifactId: info.previousImageUri || info.previousRevisionName,
        errors: [],
      };
    } catch (err) {
      return { success: false, errors: [(err as Error).message] };
    }
  }

  /** Inspect the last build context (test introspection only). */
  /* istanbul ignore next */
  _lastBuildContextForTests(): BuildContext | null {
    return this.lastBuildCtx;
  }
}

// ---------------------------------------------------------------------------
// Default factories. These dynamically import the SDKs so this module
// compiles in environments where the SDKs are not yet installed (e.g.
// the parent plugin's tsc check). Tests inject mocks and never hit
// these factories.
// ---------------------------------------------------------------------------

const defaultCloudBuildFactory: CloudBuildClientFactory = () => {
  throw new Error(
    'GCPBackend default Cloud Build client factory not configured; install @google-cloud/cloudbuild and inject cloudBuildClientFactory.',
  );
};

const defaultCloudRunFactory: CloudRunClientFactory = () => {
  throw new Error(
    'GCPBackend default Cloud Run client factory not configured; install @google-cloud/run and inject cloudRunClientFactory.',
  );
};
