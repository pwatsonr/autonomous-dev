# SPEC-024-1-03: AzureBackend and K8sBackend Implementations

## Metadata
- **Parent Plan**: PLAN-024-1
- **Tasks Covered**: Task 4 (`AzureBackend` implementation), Task 5 (`K8sBackend` implementation)
- **Estimated effort**: 16 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-024-1-03-azure-and-k8s-backend-implementations.md`

## Description
Implement two more `DeploymentBackend` (SPEC-023-1-01) implementations against the cloud SDKs vendored in SPEC-024-1-01: `AzureBackend` (Azure Container Registry + Container Apps + Front Door, per TDD-024 §6.3) and `K8sBackend` (`@kubernetes/client-node` against a scoped kubeconfig, per TDD-024 §6.4). Both backends acquire credentials through the `CredentialProxy` (PLAN-024-2), produce HMAC-signed `DeploymentRecord`s via SPEC-023-1-01 helpers, validate `DeployParameters`, and use ZERO shell invocation (Kubernetes operations go through the typed client, not `kubectl` shelling out).

K8s notably has NO `build` step — it assumes the image already exists in a registry. This is deliberate (TDD-024 §6.4): operators that need image building should pair `K8sBackend` with a separate CI pipeline or use one of the cloud backends. Helper agents, READMEs, conformance suite extension, and integration tests are delivered by SPEC-024-1-04 and SPEC-024-1-05.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-deploy-azure/src/backend.ts` | Create | `AzureBackend implements DeploymentBackend` + `PARAM_SCHEMA` |
| `plugins/autonomous-dev-deploy-azure/src/acr-builder.ts` | Create | `pushImage(client, opts)` via ACR build task |
| `plugins/autonomous-dev-deploy-azure/src/container-apps-deployer.ts` | Create | `createRevision`, `swapRevisionTraffic` |
| `plugins/autonomous-dev-deploy-azure/src/front-door-health-prober.ts` | Create | Polls Front Door `/health` probe |
| `plugins/autonomous-dev-deploy-azure/src/credential-proxy-client.ts` | Create | Wraps `proxy.acquire('azure', op, scope)` into `TokenCredential` |
| `plugins/autonomous-dev-deploy-azure/tests/backend.test.ts` | Create | Mocked SDK tests for all four interface methods |
| `plugins/autonomous-dev-deploy-k8s/src/backend.ts` | Create | `K8sBackend implements DeploymentBackend` + `PARAM_SCHEMA` |
| `plugins/autonomous-dev-deploy-k8s/src/manifest-applier.ts` | Create | `applyManifest`, `getDeploymentStatus`, `rolloutUndo` |
| `plugins/autonomous-dev-deploy-k8s/src/credential-proxy-client.ts` | Create | Wraps `proxy.acquire('k8s', op, scope)` → `KubeConfig` |
| `plugins/autonomous-dev-deploy-k8s/tests/backend.test.ts` | Create | Mocked client tests; OPA-rejected fixture |

## Implementation Details

### `AzureBackend` (`plugins/autonomous-dev-deploy-azure/src/backend.ts`)

```ts
export const PARAM_SCHEMA: Record<string, ParamSchema> = {
  subscription_id: { type: 'string', required: true, regex: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ },
  resource_group: { type: 'string', required: true, format: 'identifier' },
  location: { type: 'string', required: true, enum: AZURE_LOCATIONS as readonly string[] },
  acr_name: { type: 'string', required: true, format: 'identifier' },
  container_app_name: { type: 'string', required: true, format: 'identifier' },
  image_repo: { type: 'string', required: true, format: 'shell-safe-arg' },
  cpu: { type: 'string', default: '0.5', regex: /^\d+(\.\d+)?$/ },
  memory_gib: { type: 'string', default: '1.0', regex: /^\d+(\.\d+)?$/ },
  front_door_endpoint: { type: 'string', required: false, format: 'url' },
  health_path: { type: 'string', default: '/health', format: 'shell-safe-arg' },
  health_timeout_seconds: { type: 'number', default: 180, range: [10, 600] },
};

readonly metadata: BackendMetadata = {
  name: 'azure',
  version: '0.1.0',
  supportedTargets: ['azure-container-apps'],
  capabilities: ['azure-container-apps'],
  requiredTools: [],
};
```

- **`build(ctx)`**:
  - Acquires creds for `ACR:BuildTask` scoped to `/subscriptions/${subscription_id}/resourceGroups/${resource_group}/providers/Microsoft.ContainerRegistry/registries/${acr_name}`.
  - Submits an ACR build task via `containerRegistryClient.scheduleRunWithDockerBuildRequest(...)` reading the Dockerfile from `ctx.repoPath`. Tag: `${acr_name}.azurecr.io/${image_repo}:${ctx.commitSha}`.
  - Polls run status via `containerRegistryClient.getRun(...)` every 10s up to 30 minutes; rejects on `Failed`/`Canceled`.
  - Returns `BuildArtifact { type: 'docker-image', location: <image-uri>, checksum: <image-digest>, sizeBytes, metadata: { run_id, acr_name, location } }`.
- **`deploy(artifact, env, params)`**:
  - Validates params.
  - Acquires creds for `ContainerApps:CreateRevision` scoped to `/subscriptions/${subscription_id}/resourceGroups/${resource_group}/providers/Microsoft.App/containerApps/${container_app_name}`.
  - Reads current Container App via `containerAppsClient.get(resource_group, container_app_name)`. Captures the active revision name as `previousRevision`.
  - Updates the Container App revision template with the new image. Container Apps creates a new revision automatically when the template changes (mode: `Single` or `Multiple`; this spec uses `Multiple` so traffic can be split for rollback).
  - Calls `containerAppsClient.beginCreateOrUpdateAndWait(resource_group, container_app_name, { properties: { template: { containers: [{ image: artifact.location, ... }] } } })`.
  - Captures `newRevision` from the response. If using `Multiple` mode, also splits traffic 100% to the new revision via a follow-up update.
  - Returns signed `DeploymentRecord` with `details: { revision_name: newRevision, previous_revision: previousRevision, image_uri, location, front_door_endpoint }`.
- **`healthCheck(record)`**:
  - When `front_door_endpoint` was set, polls `${front_door_endpoint}${health_path}` via `fetch` (5s interval, up to `health_timeout_seconds`). Returns `healthy: true` on first 200..299.
  - When `front_door_endpoint` was not set, polls Container App's own ingress URL (read from `record.details.ingress_fqdn` populated by `deploy`).
  - `checks[]` includes one entry per probe (last 5 max).
- **`rollback(record)`**:
  - Acquires creds for `ContainerApps:UpdateRevision`.
  - Calls a Container Apps revision-traffic-swap: `containerAppsClient.beginUpdateAndWait(resource_group, container_app_name, { properties: { configuration: { ingress: { traffic: [{ revisionName: previousRevision, weight: 100 }] } } } })`.
  - Returns `RollbackResult { success, restoredArtifactId: previousRevision, errors }`.

### `K8sBackend` (`plugins/autonomous-dev-deploy-k8s/src/backend.ts`)

```ts
export const PARAM_SCHEMA: Record<string, ParamSchema> = {
  namespace: { type: 'string', required: true, format: 'identifier' },
  manifest_path: { type: 'string', required: true, format: 'path' },
  deployment_name: { type: 'string', required: true, format: 'identifier' },
  context_name: { type: 'string', required: false, format: 'identifier' },  // selects from kubeconfig
  ready_timeout_seconds: { type: 'number', default: 180, range: [10, 600] },
};

readonly metadata: BackendMetadata = {
  name: 'k8s',
  version: '0.1.0',
  supportedTargets: ['k8s-kubectl-apply'],
  capabilities: ['k8s-kubectl-apply'],
  requiredTools: [],
};
```

- **`build(ctx)`**:
  - **No-op by design.** Returns a `BuildArtifact { type: 'commit', location: ctx.commitSha, checksum: sha256(ctx.commitSha + ctx.requestId), sizeBytes: 0, metadata: { kind: 'k8s-manifest-ref' } }`.
  - The "artifact" is a reference; the actual container image must already exist in a registry the cluster can pull from.
- **`deploy(artifact, env, params)`**:
  - Validates params. Reads `manifest_path` from disk (must be inside `ctx.repoPath`; absolute paths outside the repo are rejected by the validator).
  - Parses YAML (multi-document supported). For each doc, validates `metadata.namespace` matches the configured `namespace` (rejects if a doc tries to escape).
  - Acquires creds for `K8s:Apply` scoped to `cluster:${context_name}/namespace:${namespace}`. The `ScopedCredential.kubeconfig` is a YAML string restricted to the configured namespace.
  - Loads the kubeconfig via `KubeConfig.loadFromString(scopedCred.kubeconfig)`.
  - Captures the current `Deployment` revision via `appsV1Api.readNamespacedDeployment(deployment_name, namespace)` for rollback (deployment annotation `deployment.kubernetes.io/revision`).
  - Applies each manifest via the typed client (`appsV1Api.replaceNamespacedDeployment`, `coreV1Api.replaceNamespacedService`, etc.). For unknown kinds, falls back to `KubernetesObjectApi.patch(...)` with the typed object.
  - On apply failure, surfaces structured error including OPA Gatekeeper violations (parses `details.causes` from the API server response).
  - Returns signed `DeploymentRecord` with `details: { namespace, deployment_name, previous_revision, applied_kinds, applied_count, context_name }`.
- **`healthCheck(record)`**:
  - Reads the Deployment via `appsV1Api.readNamespacedDeployment(deployment_name, namespace)`.
  - Polls every 5s up to `ready_timeout_seconds`. Returns `healthy: true` when `status.readyReplicas === status.replicas` AND `status.observedGeneration >= metadata.generation`.
  - Returns `healthy: false` with `unhealthyReason` when timeout (e.g., `ImagePullBackOff` aggregated from Pod statuses).
  - `checks[]` includes per-Pod readiness state.
- **`rollback(record)`**:
  - Acquires creds for `K8s:Patch` scoped to the namespace.
  - Patches the Deployment with `kubernetes.io/change-cause: "rollback by autonomous-dev <deployId>"` and rolls back via the `appsV1Api.createNamespacedDeploymentRollback` API (which performs a `kubectl rollout undo` semantic — sets the Deployment template to the prior revision).
  - Polls until the rollback completes (new generation observed) or times out at 60s.
  - Returns `RollbackResult { success, restoredArtifactId: previous_revision, errors }`.

### Namespace scoping enforcement (K8s)

Two layers:
1. **At credential acquisition**: `proxy.acquire('k8s', op, { resource: 'cluster:<ctx>/namespace:<ns>' })` returns a kubeconfig whose embedded ServiceAccount or RoleBinding is restricted to that namespace. (PLAN-024-2 implements this; this spec consumes it.)
2. **At parameter validation in `deploy`**: each manifest document is rejected if `metadata.namespace` is set and does NOT match the configured `namespace`, OR if any `kind` is cluster-scoped (`ClusterRole`, `ClusterRoleBinding`, `Namespace`, `Node`, etc.). The denylist of cluster-scoped kinds is a static set in `manifest-applier.ts`.

### `front-door-health-prober.ts`

A small module that wraps `fetch` with retry + AbortSignal timeout. Used by `AzureBackend.healthCheck`. No Front Door SDK call required; the probe is just an HTTP GET against the Front Door endpoint URL.

### Error mapping (additions to SPEC-024-1-02 patterns)

- Azure `AuthenticationFailed` → `DeployError { code: 'AUTH_FAILED' }`.
- Azure `Throttled` → `DeployError { code: 'RATE_LIMIT', retriable: true }`.
- K8s `Forbidden` → `DeployError { code: 'AUTH_FAILED' }`.
- K8s `Conflict` (resource already exists with different owner) → `DeployError { code: 'RESOURCE_CONFLICT' }`.
- K8s OPA Gatekeeper rejection (HTTP 403 with `details.kind: 'AdmissionReview'`) → `DeployError { code: 'POLICY_VIOLATION', message: <OPA-emitted-reason> }`.

### Determinism in tests

- Azure tests use jest manual mocks for `@azure/arm-appcontainers` and `@azure/arm-containerregistry`. SDK responses are JSON fixtures in `tests/fixtures/azure/`.
- K8s tests use a mocked `KubeConfig` and mocked `AppsV1Api`/`CoreV1Api`/`KubernetesObjectApi` instances. Manifests are loaded from `tests/fixtures/k8s/manifests/` (e.g., `valid-deployment.yaml`, `cross-namespace-escape.yaml`, `cluster-role-rejection.yaml`, `opa-violation-response.json`).

## Acceptance Criteria

- [ ] `AzureBackend implements DeploymentBackend` — TypeScript compile under `strict: true` with no `any`.
- [ ] `K8sBackend implements DeploymentBackend` — TypeScript compile under `strict: true` with no `any`.
- [ ] Both classes export `PARAM_SCHEMA` matching the schema passed to `validateParameters`.
- [ ] `AzureBackend.build()` calls `proxy.acquire('azure', 'ACR:BuildTask', { resource: '/subscriptions/<id>/...' })` exactly once.
- [ ] `AzureBackend.build()` returns a `BuildArtifact` with `type: 'docker-image'` and `location` matching `<acr>.azurecr.io/<repo>:<sha>`.
- [ ] `AzureBackend.deploy()` captures `previous_revision` BEFORE updating the Container App (verified by mock call order).
- [ ] `AzureBackend.deploy()` returns a signed `DeploymentRecord` whose `hmac` is non-empty AND passes `verifyDeploymentRecord`.
- [ ] `AzureBackend.healthCheck()` polls `front_door_endpoint + health_path` when set; falls back to the Container App ingress URL when unset.
- [ ] `AzureBackend.rollback()` calls Container Apps' traffic-update API with `weight: 100` for the previous revision (verified by mock assertion).
- [ ] `AzureBackend.deploy()` rejects when `subscription_id` doesn't match the GUID regex (parameter validation).
- [ ] `K8sBackend.build()` is a no-op returning a `BuildArtifact { type: 'commit', sizeBytes: 0 }` whose `checksum` is reproducible across two calls with the same context.
- [ ] `K8sBackend.deploy()` calls `proxy.acquire('k8s', 'K8s:Apply', { resource: 'cluster:<ctx>/namespace:<ns>' })` exactly once.
- [ ] `K8sBackend.deploy()` does NOT shell out — verified by spying on `child_process` (no calls).
- [ ] `K8sBackend.deploy()` REJECTS a manifest whose `metadata.namespace` differs from the configured `namespace` parameter.
- [ ] `K8sBackend.deploy()` REJECTS a manifest whose `kind` is in the cluster-scoped denylist (`ClusterRole`, `ClusterRoleBinding`, `Namespace`, `Node`, `PersistentVolume`, `StorageClass`, `CustomResourceDefinition`, `MutatingWebhookConfiguration`, `ValidatingWebhookConfiguration`).
- [ ] `K8sBackend.deploy()` captures `previous_revision` from the Deployment annotation BEFORE applying.
- [ ] `K8sBackend.deploy()` translates an OPA Gatekeeper rejection (fixture `opa-violation-response.json`) into `DeployError { code: 'POLICY_VIOLATION' }` with the OPA reason in `message`.
- [ ] `K8sBackend.healthCheck()` returns `healthy: true` when `readyReplicas === replicas` AND `observedGeneration >= generation`; otherwise `healthy: false`.
- [ ] `K8sBackend.healthCheck()` reports `ImagePullBackOff` in `unhealthyReason` when Pod status fixtures contain that reason.
- [ ] `K8sBackend.rollback()` calls `createNamespacedDeploymentRollback` (the typed-client equivalent of `kubectl rollout undo`).
- [ ] `K8sBackend.rollback()` returns `success: false` with the API error in `errors[]` when the rollback API returns 404 or 500.
- [ ] All four `DeploymentBackend` methods on both backends are tested for the happy path AND at least one failure mode each.
- [ ] `tests/fixtures/azure/` contains at least 4 JSON fixtures (ACR run started/succeeded, Container App get response, Container App update response, traffic-update response).
- [ ] `tests/fixtures/k8s/manifests/` contains at minimum: a valid Deployment YAML, a cross-namespace-escape YAML (rejected), a cluster-scoped-kind YAML (rejected), and an OPA-violation API response JSON.
- [ ] Combined unit-test runtime for both backend test files is under 10 seconds.

## Dependencies

- **SPEC-023-1-01**: `DeploymentBackend`, `BuildContext`, `DeployParameters`, `BuildArtifact`, `DeploymentRecord`, `HealthStatus`, `RollbackResult`, `validateParameters`, `signDeploymentRecord`, `verifyDeploymentRecord`.
- **SPEC-024-1-01**: cloud-plugin scaffolding and `package.json` with vendored SDKs.
- **SPEC-024-1-02**: shared `CredentialProxy` consumer pattern, `DeployError` class definition. This spec re-uses both. If `DeployError` is not yet promoted to a shared module by SPEC-024-1-02, this spec promotes it to `plugins/autonomous-dev/src/deploy/errors.ts` so all four backends can import it.
- **PLAN-024-2** (companion, type-only consumer): `CredentialProxy.acquire(...)` returning a `ScopedCredential` whose `kubeconfig` field is set for K8s.
- **NPM packages** (vendored by SPEC-024-1-01): `@azure/arm-appcontainers`, `@azure/arm-containerregistry`, `@azure/identity`, `@kubernetes/client-node`. New: `js-yaml` (added to K8s plugin `package.json` for manifest parsing).

## Notes
- Container Apps natively supports multi-revision deployments with traffic splitting, which is why rollback is a single API call (traffic swap) instead of redeploy. v1 uses `Multiple` revision mode; operators can switch to `Single` via a future config option (out of scope here).
- Azure has no good public emulator (per PLAN-024-1's risk register). All Azure tests are mocked; SPEC-024-1-05 documents Azure as a release-time manual smoke step rather than a CI integration test.
- K8s is the only backend with no `build` step. This is per TDD-024 §6.4 design: bringing a Docker daemon and image push into the K8s plugin would couple it to a registry choice. Operators run their own image pipeline and pass the image via the manifest's `containers[].image` field.
- The K8s namespace-scoping check is defense in depth. The `ScopedCredential.kubeconfig` from PLAN-024-2 should ALREADY be restricted by RBAC to the configured namespace; the in-process check at `deploy()` is a belt-and-braces safeguard against misconfigured proxies.
- The cluster-scoped kinds denylist is static. Operators who need to manage cluster-scoped resources should NOT use this backend; that is a separate operator workflow (out of scope for v1).
- `createNamespacedDeploymentRollback` is the typed-client API equivalent of `kubectl rollout undo`. It uses the Deployment's `revisionHistoryLimit` to find the previous revision; if `revisionHistoryLimit: 0`, rollback fails. Operators are warned in the README (SPEC-024-1-04) to keep `revisionHistoryLimit >= 2`.
- Azure's `previous_revision` field stores the revision NAME (e.g., `myapp--abc123`), not the image URI, because Container Apps revisions are identified by name. The image URI is recoverable via the revision name if needed.
- Front Door probing is HTTP-only in this spec. Azure Front Door supports its own native health probe configuration; v1 uses operator-side polling for simplicity. Native probe integration is documented as a future enhancement.
