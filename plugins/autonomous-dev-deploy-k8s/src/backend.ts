/**
 * K8sBackend (SPEC-024-1-03 §"K8sBackend"). Implements
 * `DeploymentBackend` against `@kubernetes/client-node` typed clients.
 *
 * NO build step (by design — TDD-024 §6.4): operators are expected to
 * push their image with a separate pipeline (or the GCP/AWS/Azure
 * backends) and reference it via the manifest's `containers[].image`.
 *
 * Zero shell invocation. ALL cluster mutations go through the typed
 * client. Defense-in-depth: every manifest doc is rejected if its
 * `metadata.namespace` differs from the configured namespace OR if its
 * `kind` is in the cluster-scoped denylist.
 *
 * @module @autonomous-dev/deploy-k8s/backend
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

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
  ScopedCredential,
} from '../../autonomous-dev/intake/deploy/credential-proxy-types';

import {
  type KubeConfigFactory,
  type KubeConfigLike,
  toKubeConfig,
} from './credential-proxy-client';
import {
  type AppsV1LikeApi,
  type CoreV1LikeApi,
  type KubernetesObjectLikeApi,
  type ManifestDoc,
  applyManifest,
  getDeploymentStatus,
  mapK8sError,
  rolloutUndo,
  validateManifestScope,
} from './manifest-applier';

/**
 * Public parameter schema. Helper agents (`k8s-deploy-expert`) consume
 * this through this module export — DO NOT inline-construct elsewhere.
 */
export const PARAM_SCHEMA: Record<string, ParamSchema> = {
  namespace: { type: 'string', required: true, format: 'identifier' },
  manifest_path: { type: 'string', required: true, format: 'path' },
  deployment_name: { type: 'string', required: true, format: 'identifier' },
  context_name: { type: 'string', required: false, format: 'identifier' },
  ready_timeout_seconds: { type: 'number', default: 180, range: [10, 600] },
};

/** Test seam: parse a YAML string into manifest docs. */
export interface YamlMultiParser {
  (yaml: string): ManifestDoc[];
}

/**
 * Test seam: extract typed API clients from a `KubeConfigLike`. Real
 * code calls `kc.makeApiClient(AppsV1Api)` etc.; tests inject directly.
 */
export interface ApiClientResolver {
  (kc: KubeConfigLike): {
    appsV1: AppsV1LikeApi;
    coreV1: CoreV1LikeApi;
    objectApi: KubernetesObjectLikeApi;
  };
}

/** Constructor options. */
export interface K8sBackendOptions {
  proxy: CredentialProxy;
  /** Test seam: build a `KubeConfigLike` from a YAML string. */
  kubeConfigFactory?: KubeConfigFactory;
  /** Test seam: extract typed API clients from a kubeconfig. */
  apiClientResolver?: ApiClientResolver;
  /** Test seam: parse a multi-document YAML string. */
  yamlParser?: YamlMultiParser;
  /** Test seam: deterministic clock. */
  now?: () => number;
  /** Test seam: replace setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: filesystem read for the manifest. */
  readFile?: (path: string) => string;
}

export class K8sBackend implements DeploymentBackend {
  readonly metadata: BackendMetadata = {
    name: 'k8s',
    version: '0.1.0',
    supportedTargets: ['k8s-kubectl-apply'],
    capabilities: ['k8s-kubectl-apply'],
    requiredTools: [],
  };

  private readonly proxy: CredentialProxy;
  private readonly kubeConfigFactory: KubeConfigFactory;
  private readonly resolveApi: ApiClientResolver;
  private readonly parseYaml: YamlMultiParser;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly readFile: (path: string) => string;

  constructor(opts: K8sBackendOptions) {
    this.proxy = opts.proxy;
    this.kubeConfigFactory = opts.kubeConfigFactory ?? defaultKubeConfigFactory;
    this.resolveApi = opts.apiClientResolver ?? defaultApiClientResolver;
    this.parseYaml = opts.yamlParser ?? defaultYamlParser;
    this.now = opts.now ?? Date.now;
    this.sleep =
      opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.readFile =
      opts.readFile ?? ((p) => readFileSync(p, 'utf8'));
  }

  /**
   * No-op build by design (TDD-024 §6.4). Returns a reference artifact
   * whose checksum is reproducible across two invocations with the same
   * `(commitSha, requestId)` pair.
   */
  async build(ctx: BuildContext): Promise<BuildArtifact> {
    const validation = validateParameters(PARAM_SCHEMA, ctx.params);
    if (!validation.valid) {
      throw new ParameterValidationError(validation.errors);
    }
    const checksum = createHash('sha256')
      .update(`${ctx.commitSha}|${ctx.requestId}`)
      .digest('hex');
    return {
      artifactId: generateUlid(),
      type: 'commit',
      location: ctx.commitSha,
      checksum,
      sizeBytes: 0,
      metadata: { kind: 'k8s-manifest-ref' },
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
    const namespace = String(sanitized.namespace);
    const manifestPath = String(sanitized.manifest_path);
    const deploymentName = String(sanitized.deployment_name);
    const contextName = sanitized.context_name
      ? String(sanitized.context_name)
      : '';
    const readyTimeoutSeconds = Number(sanitized.ready_timeout_seconds);

    // Read + parse manifests.
    let yamlText: string;
    try {
      yamlText = this.readFile(manifestPath);
    } catch (err) {
      throw new CloudDeployError(
        'DEPLOY_FAILED',
        'k8s',
        'K8s:Apply',
        false,
        `failed to read manifest_path=${manifestPath}: ${(err as Error).message}`,
        err,
      );
    }
    const docs = this.parseYaml(yamlText).filter((d) => !!d && !!d.kind);

    // Defense-in-depth namespace + cluster-scoped checks.
    const scopeErrors = validateManifestScope(docs, namespace);
    if (scopeErrors.length > 0) {
      throw new ParameterValidationError(
        scopeErrors.map((m) => ({ key: 'manifest_path', message: m })),
      );
    }

    // Acquire kubeconfig for K8s:Apply scope.
    const cred = await this.proxy.acquire('k8s', 'K8s:Apply', {
      resource: `cluster:${contextName || 'default'}/namespace:${namespace}`,
    });
    const kubeConfig = toKubeConfig(cred, this.kubeConfigFactory);
    const { appsV1, coreV1, objectApi } = this.resolveApi(kubeConfig);

    // Capture previous_revision BEFORE applying.
    let previousRevision = '';
    try {
      const dep = await appsV1.readNamespacedDeployment(deploymentName, namespace);
      const ann = dep.body.metadata?.annotations ?? {};
      previousRevision = ann['deployment.kubernetes.io/revision'] ?? '';
    } catch (err) {
      // If not-found, treat as fresh deploy with no prior revision.
      const mapped = mapK8sError(err, 'K8s:ReadDeployment');
      if (mapped.code !== 'NOT_FOUND') {
        throw mapped;
      }
    }

    // Apply.
    const applied = await applyManifest({
      appsV1,
      coreV1,
      objectApi,
      namespace,
      docs,
    });

    const unsigned: DeploymentRecord = {
      deployId: generateUlid(),
      backend: this.metadata.name,
      environment,
      artifactId: artifact.artifactId,
      deployedAt: new Date(this.now()).toISOString(),
      status: 'deployed',
      details: {
        namespace,
        deployment_name: deploymentName,
        previous_revision: previousRevision,
        applied_kinds: applied.appliedKinds.join(','),
        applied_count: applied.appliedCount,
        context_name: contextName,
        manifest_path: manifestPath,
        ready_timeout_seconds: readyTimeoutSeconds,
      },
      hmac: '',
    };
    return signDeploymentRecord(unsigned);
  }

  async healthCheck(record: DeploymentRecord): Promise<HealthStatus> {
    const namespace = String(record.details.namespace ?? '');
    const deploymentName = String(record.details.deployment_name ?? '');
    const contextName = String(record.details.context_name ?? '');
    const readyTimeoutSeconds = Number(record.details.ready_timeout_seconds ?? 180);
    if (!namespace || !deploymentName) {
      return {
        healthy: false,
        checks: [{ name: 'record-missing-namespace-or-deployment', passed: false }],
        unhealthyReason: 'record-missing-namespace-or-deployment',
      };
    }
    const cred = await this.proxy.acquire('k8s', 'K8s:Read', {
      resource: `cluster:${contextName || 'default'}/namespace:${namespace}`,
    });
    const kubeConfig = toKubeConfig(cred, this.kubeConfigFactory);
    const { appsV1, coreV1 } = this.resolveApi(kubeConfig);
    const result = await getDeploymentStatus({
      appsV1,
      coreV1,
      namespace,
      deploymentName,
      readyTimeoutSeconds,
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
    const namespace = String(record.details.namespace ?? '');
    const deploymentName = String(record.details.deployment_name ?? '');
    const previousRevision = String(record.details.previous_revision ?? '');
    const contextName = String(record.details.context_name ?? '');
    if (!namespace || !deploymentName) {
      return {
        success: false,
        errors: ['rollback aborted: record.details missing namespace/deployment_name'],
      };
    }
    let cred: ScopedCredential;
    try {
      cred = await this.proxy.acquire('k8s', 'K8s:Patch', {
        resource: `cluster:${contextName || 'default'}/namespace:${namespace}`,
      });
    } catch (err) {
      return { success: false, errors: [(err as Error).message] };
    }
    let kubeConfig: KubeConfigLike;
    try {
      kubeConfig = toKubeConfig(cred, this.kubeConfigFactory);
    } catch (err) {
      return { success: false, errors: [(err as Error).message] };
    }
    const { appsV1 } = this.resolveApi(kubeConfig);
    try {
      const result = await rolloutUndo({
        appsV1,
        namespace,
        deploymentName,
      });
      return {
        success: true,
        restoredArtifactId: result.revisionRestored || previousRevision,
        errors: [],
      };
    } catch (err) {
      const mapped = mapK8sError(err, 'K8s:Rollback');
      return { success: false, errors: [mapped.message] };
    }
  }
}

// ---------------------------------------------------------------------------
// Default factories — throw at runtime if invoked without injection.
// ---------------------------------------------------------------------------

const defaultKubeConfigFactory: KubeConfigFactory = () => {
  throw new Error(
    'K8sBackend default KubeConfig factory not configured; install @kubernetes/client-node and inject kubeConfigFactory.',
  );
};
const defaultApiClientResolver: ApiClientResolver = () => {
  throw new Error(
    'K8sBackend default API client resolver not configured; install @kubernetes/client-node and inject apiClientResolver.',
  );
};
const defaultYamlParser: YamlMultiParser = () => {
  throw new Error(
    'K8sBackend default YAML parser not configured; install js-yaml and inject yamlParser.',
  );
};

// `CloudDeployError` re-exported for test convenience.
export { CloudDeployError };
