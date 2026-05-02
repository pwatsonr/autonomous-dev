/**
 * K8s manifest validator + applier (SPEC-024-1-03 §"K8sBackend.deploy").
 *
 * Two layers of namespace-scope enforcement:
 *   1. Reject any manifest doc whose `metadata.namespace` is set AND
 *      differs from the configured `namespace`.
 *   2. Reject any manifest doc whose `kind` is in the cluster-scoped
 *      denylist.
 *
 * Apply path uses typed clients (`AppsV1LikeApi`, `CoreV1LikeApi`,
 * `KubernetesObjectLikeApi`) — NEVER `kubectl`. OPA Gatekeeper rejections
 * (HTTP 403 with `details.kind: 'AdmissionReview'`) are translated to
 * `CloudDeployError { code: 'POLICY_VIOLATION' }`.
 *
 * @module @autonomous-dev/deploy-k8s/manifest-applier
 */

import { CloudDeployError } from '../../autonomous-dev/intake/deploy/errors';

/**
 * Cluster-scoped kinds we refuse to apply (defense in depth on top of
 * RBAC restrictions baked into the proxy-issued kubeconfig). Operators
 * who need to manage cluster-scoped resources should NOT use this
 * backend.
 */
export const CLUSTER_SCOPED_KIND_DENYLIST: ReadonlySet<string> = new Set([
  'ClusterRole',
  'ClusterRoleBinding',
  'Namespace',
  'Node',
  'PersistentVolume',
  'StorageClass',
  'CustomResourceDefinition',
  'MutatingWebhookConfiguration',
  'ValidatingWebhookConfiguration',
]);

/** A single Kubernetes manifest document. */
export interface ManifestDoc {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
  };
  spec?: Record<string, unknown>;
  [extra: string]: unknown;
}

/** Structural subset of `AppsV1Api`. */
export interface AppsV1LikeApi {
  readNamespacedDeployment(
    name: string,
    namespace: string,
  ): Promise<{ body: ManifestDoc & { status?: DeploymentStatus } }>;
  replaceNamespacedDeployment(
    name: string,
    namespace: string,
    body: ManifestDoc,
  ): Promise<{ body: ManifestDoc }>;
  /**
   * Equivalent to `kubectl rollout undo`. The K8s typed client exposes
   * `createNamespacedDeploymentRollback` for this; v1 of the SDK keeps
   * this name even though the cluster API is `/rollback`.
   */
  createNamespacedDeploymentRollback(
    name: string,
    namespace: string,
  ): Promise<{ body: ManifestDoc }>;
}

/** Structural subset of `CoreV1Api`. */
export interface CoreV1LikeApi {
  replaceNamespacedService(
    name: string,
    namespace: string,
    body: ManifestDoc,
  ): Promise<{ body: ManifestDoc }>;
  listNamespacedPod(
    namespace: string,
    fieldSelector?: string,
    labelSelector?: string,
  ): Promise<{ body: { items: Array<{ status?: PodStatus; metadata?: { name?: string } }> } }>;
}

/** Structural subset of `KubernetesObjectApi.patch`. */
export interface KubernetesObjectLikeApi {
  patch(body: ManifestDoc): Promise<{ body: ManifestDoc }>;
}

/** Subset of Deployment.status fields used here. */
export interface DeploymentStatus {
  replicas?: number;
  readyReplicas?: number;
  observedGeneration?: number;
  conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
}

/** Subset of Pod.status fields used here. */
export interface PodStatus {
  phase?: string;
  conditions?: Array<{ type?: string; status?: string; reason?: string }>;
  containerStatuses?: Array<{
    name?: string;
    ready?: boolean;
    state?: {
      waiting?: { reason?: string; message?: string };
      running?: Record<string, unknown>;
      terminated?: { reason?: string; exitCode?: number };
    };
  }>;
}

/**
 * Reject docs that escape the configured namespace OR target a
 * cluster-scoped kind. Returns the array of validation errors (empty
 * when all docs are in scope).
 */
export function validateManifestScope(
  docs: readonly ManifestDoc[],
  configuredNamespace: string,
): string[] {
  const errors: string[] = [];
  for (const [i, doc] of docs.entries()) {
    const kind = doc.kind ?? '';
    if (CLUSTER_SCOPED_KIND_DENYLIST.has(kind)) {
      errors.push(
        `manifest[${i}] kind=${kind} is cluster-scoped and rejected by the K8s backend`,
      );
      continue;
    }
    const docNs = doc.metadata?.namespace;
    if (docNs && docNs !== configuredNamespace) {
      errors.push(
        `manifest[${i}] metadata.namespace='${docNs}' does not match configured namespace='${configuredNamespace}'`,
      );
    }
  }
  return errors;
}

/** Options for `applyManifest`. */
export interface ApplyManifestOptions {
  appsV1: AppsV1LikeApi;
  coreV1: CoreV1LikeApi;
  objectApi: KubernetesObjectLikeApi;
  namespace: string;
  docs: readonly ManifestDoc[];
}

/** Result of `applyManifest`. */
export interface ApplyManifestResult {
  appliedKinds: string[];
  appliedCount: number;
}

/**
 * Apply each manifest doc to the cluster via the typed clients. Unknown
 * kinds fall back to `KubernetesObjectApi.patch`. OPA Gatekeeper
 * rejections are translated to `POLICY_VIOLATION`.
 */
export async function applyManifest(
  opts: ApplyManifestOptions,
): Promise<ApplyManifestResult> {
  const appliedKinds: string[] = [];
  for (const doc of opts.docs) {
    const kind = doc.kind ?? '';
    const name = doc.metadata?.name ?? '';
    if (!name) {
      throw new CloudDeployError(
        'DEPLOY_FAILED',
        'k8s',
        'K8s:Apply',
        false,
        `manifest doc kind=${kind} missing metadata.name`,
      );
    }
    try {
      switch (kind) {
        case 'Deployment':
          await opts.appsV1.replaceNamespacedDeployment(name, opts.namespace, doc);
          break;
        case 'Service':
          await opts.coreV1.replaceNamespacedService(name, opts.namespace, doc);
          break;
        default:
          await opts.objectApi.patch(doc);
          break;
      }
      appliedKinds.push(kind);
    } catch (err) {
      throw mapK8sError(err, 'K8s:Apply');
    }
  }
  return {
    appliedKinds,
    appliedCount: appliedKinds.length,
  };
}

/** Options for `getDeploymentStatus`. */
export interface GetDeploymentStatusOptions {
  appsV1: AppsV1LikeApi;
  coreV1: CoreV1LikeApi;
  namespace: string;
  deploymentName: string;
  readyTimeoutSeconds: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Result of `getDeploymentStatus`. */
export interface GetDeploymentStatusResult {
  healthy: boolean;
  checks: Array<{ name: string; passed: boolean; message?: string }>;
  unhealthyReason?: string;
}

const DEFAULT_POLL_MS = 5_000;

/**
 * Poll a Deployment's status until ready or timeout. Aggregates Pod-
 * level reasons (e.g. `ImagePullBackOff`) into `unhealthyReason`.
 */
export async function getDeploymentStatus(
  opts: GetDeploymentStatusOptions,
): Promise<GetDeploymentStatusResult> {
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const start = now();
  const deadline = start + opts.readyTimeoutSeconds * 1000;
  let lastChecks: Array<{ name: string; passed: boolean; message?: string }> = [];
  let lastReason = 'unknown';

  while (true) {
    const dep = await opts.appsV1.readNamespacedDeployment(
      opts.deploymentName,
      opts.namespace,
    );
    const status = dep.body.status ?? {};
    const generation = (dep.body.metadata as { generation?: number } | undefined)?.generation ?? 0;
    const observed = status.observedGeneration ?? 0;
    const replicas = status.replicas ?? 0;
    const ready = status.readyReplicas ?? 0;
    const generationCaughtUp = observed >= generation;
    const replicasReady = replicas > 0 && ready === replicas;

    let podsReason: string | undefined;
    try {
      const pods = await opts.coreV1.listNamespacedPod(opts.namespace);
      lastChecks = pods.body.items.map((p) => {
        const podName = p.metadata?.name ?? '<pod>';
        const cs = p.status?.containerStatuses ?? [];
        const allReady = cs.length > 0 && cs.every((c) => c.ready === true);
        const waitingReason = cs
          .map((c) => c.state?.waiting?.reason)
          .find((r) => !!r);
        if (waitingReason && !podsReason) podsReason = waitingReason;
        return {
          name: podName,
          passed: allReady,
          ...(waitingReason ? { message: waitingReason } : {}),
        };
      });
    } catch {
      // Pod listing is best-effort; absence of detail does not change
      // top-level health verdict.
      lastChecks = [];
    }

    if (replicasReady && generationCaughtUp) {
      return { healthy: true, checks: lastChecks };
    }
    lastReason =
      podsReason ??
      (!generationCaughtUp
        ? 'observedGeneration-behind'
        : `ready=${ready}/replicas=${replicas}`);

    if (now() >= deadline) {
      return {
        healthy: false,
        checks: lastChecks,
        unhealthyReason: lastReason,
      };
    }
    await sleep(pollMs);
  }
}

/** Options for `rolloutUndo`. */
export interface RolloutUndoOptions {
  appsV1: AppsV1LikeApi;
  namespace: string;
  deploymentName: string;
}

/**
 * Trigger a `kubectl rollout undo`-equivalent. Returns the new
 * Deployment generation captured from the response, or empty string
 * when the API does not surface one.
 */
export async function rolloutUndo(
  opts: RolloutUndoOptions,
): Promise<{ revisionRestored: string }> {
  const resp = await opts.appsV1.createNamespacedDeploymentRollback(
    opts.deploymentName,
    opts.namespace,
  );
  const annotations = resp.body.metadata?.annotations ?? {};
  const revisionRestored =
    annotations['deployment.kubernetes.io/revision'] ?? '';
  return { revisionRestored };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

interface K8sSdkLikeError {
  code?: string | number;
  statusCode?: number;
  status?: number;
  message?: string;
  body?: {
    kind?: string;
    code?: number;
    reason?: string;
    message?: string;
    details?: {
      kind?: string;
      causes?: Array<{ message?: string; reason?: string; field?: string }>;
    };
  };
  response?: {
    statusCode?: number;
    body?: {
      kind?: string;
      code?: number;
      reason?: string;
      message?: string;
      details?: {
        kind?: string;
        causes?: Array<{ message?: string; reason?: string; field?: string }>;
      };
    };
  };
}

/**
 * Translate a K8s SDK error into `CloudDeployError`. OPA Gatekeeper
 * rejections (HTTP 403 with `details.kind: 'AdmissionReview'` OR a
 * status `reason` of `Forbidden` with `Gatekeeper`-tagged causes) map
 * to `POLICY_VIOLATION`; the OPA reason text is preserved in the
 * message.
 */
export function mapK8sError(err: unknown, operation: string): CloudDeployError {
  const e = err as K8sSdkLikeError;
  const status =
    e?.statusCode ??
    e?.status ??
    e?.response?.statusCode ??
    (typeof e?.code === 'number' ? e.code : 0);
  const body = e?.body ?? e?.response?.body ?? {};
  const reason = body.reason ?? '';
  const message = body.message ?? e?.message ?? String(err);

  const isOpaAdmission =
    body.details?.kind === 'AdmissionReview' ||
    /admission webhook .* denied/i.test(message) ||
    body.details?.causes?.some((c) =>
      /gatekeeper|opa|admission/i.test(c.reason ?? c.message ?? ''),
    );

  if (status === 403 && isOpaAdmission) {
    const opaReason =
      body.details?.causes?.[0]?.message ??
      body.details?.causes?.[0]?.reason ??
      message;
    return new CloudDeployError(
      'POLICY_VIOLATION',
      'k8s',
      operation,
      false,
      opaReason,
      err,
    );
  }
  if (status === 401 || status === 403 || reason === 'Forbidden' || reason === 'Unauthorized') {
    return new CloudDeployError('AUTH_FAILED', 'k8s', operation, false, message, err);
  }
  if (status === 404 || reason === 'NotFound') {
    return new CloudDeployError('NOT_FOUND', 'k8s', operation, false, message, err);
  }
  if (status === 409 || reason === 'AlreadyExists' || reason === 'Conflict') {
    return new CloudDeployError(
      'RESOURCE_CONFLICT',
      'k8s',
      operation,
      false,
      message,
      err,
    );
  }
  if (status === 429) {
    return new CloudDeployError('RATE_LIMIT', 'k8s', operation, true, message, err);
  }
  const errno = (err as { code?: string })?.code;
  if (
    errno === 'ETIMEDOUT' ||
    errno === 'ECONNRESET' ||
    errno === 'ENOTFOUND' ||
    errno === 'ECONNREFUSED'
  ) {
    return new CloudDeployError('NETWORK', 'k8s', operation, true, message, err);
  }
  return new CloudDeployError('UNKNOWN', 'k8s', operation, false, message, err);
}
