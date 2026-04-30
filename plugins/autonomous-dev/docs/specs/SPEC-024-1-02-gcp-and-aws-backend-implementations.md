# SPEC-024-1-02: GCPBackend and AWSBackend Implementations

## Metadata
- **Parent Plan**: PLAN-024-1
- **Tasks Covered**: Task 2 (`GCPBackend` implementation), Task 3 (`AWSBackend` implementation)
- **Estimated effort**: 18 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-024-1-02-gcp-and-aws-backend-implementations.md`

## Description
Implement two `DeploymentBackend` (SPEC-023-1-01) implementations against the cloud SDKs vendored in SPEC-024-1-01: `GCPBackend` (Cloud Build + Cloud Run, per TDD-024 §6.1) and `AWSBackend` (ECR + ECS Fargate + ALB, per TDD-024 §6.2). Each backend acquires per-operation credentials through the `CredentialProxy` interface (consumed; implemented by PLAN-024-2), produces HMAC-signed `DeploymentRecord`s, validates all `DeployParameters` via the framework from SPEC-023-1-01, and uses ZERO shell invocation — every external operation goes through a typed SDK call.

This spec covers the backends and their helper modules only. Helper agents (`gcp-deploy-expert.md`, `aws-deploy-expert.md`), READMEs, conformance suite extension, and integration tests are delivered by SPEC-024-1-04 and SPEC-024-1-05.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-deploy-gcp/src/backend.ts` | Create | `GCPBackend implements DeploymentBackend` + `PARAM_SCHEMA` export |
| `plugins/autonomous-dev-deploy-gcp/src/cloud-build-helper.ts` | Create | `submitBuild(client, opts)` + status polling |
| `plugins/autonomous-dev-deploy-gcp/src/cloud-run-helper.ts` | Create | `deployRevision`, `pollHealth`, `rollbackToRevision` |
| `plugins/autonomous-dev-deploy-gcp/src/credential-proxy-client.ts` | Create | Thin typed wrapper for `proxy.acquire('gcp', op, scope)` |
| `plugins/autonomous-dev-deploy-gcp/tests/backend.test.ts` | Create | Mocked SDK tests, all four interface methods |
| `plugins/autonomous-dev-deploy-aws/src/backend.ts` | Create | `AWSBackend implements DeploymentBackend` + `PARAM_SCHEMA` export |
| `plugins/autonomous-dev-deploy-aws/src/ecr-builder.ts` | Create | `loginAndPush(image, tag, creds)` using vendored docker client |
| `plugins/autonomous-dev-deploy-aws/src/ecs-deployer.ts` | Create | `updateService`, `revertTaskDef` |
| `plugins/autonomous-dev-deploy-aws/src/health-checker.ts` | Create | ALB target group polling |
| `plugins/autonomous-dev-deploy-aws/src/credential-proxy-client.ts` | Create | Typed wrapper for `proxy.acquire('aws', op, scope)` |
| `plugins/autonomous-dev-deploy-aws/tests/backend.test.ts` | Create | Mocked SDK tests, all four interface methods |

## Implementation Details

### Shared `CredentialProxy` consumer contract

Both backends import the type from `@autonomous-dev/credential-proxy` (PLAN-024-2). For this spec, the type is consumed via a peer dependency declared in each plugin's `package.json` (added by SPEC-024-1-01 already; if absent, this spec adds it as a `peerDependency`):

```ts
// Imported from @autonomous-dev/credential-proxy
export interface CredentialProxy {
  acquire(
    cloud: 'gcp' | 'aws' | 'azure' | 'k8s',
    operationName: string,
    resourceScope: { resource: string; region?: string; account?: string },
    options?: { ttlSeconds?: number },
  ): Promise<ScopedCredential>;
}
export interface ScopedCredential {
  cloud: string;
  expiresAt: Date;
  token?: string;          // GCP/Azure access token
  awsCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
  kubeconfig?: string;     // K8s only
}
```

Both backends accept `CredentialProxy` via constructor injection so tests can inject a mock without touching the real proxy module:

```ts
constructor(private readonly proxy: CredentialProxy) {}
```

### `GCPBackend` (`plugins/autonomous-dev-deploy-gcp/src/backend.ts`)

`metadata` (note: extends `BackendCapability` from SPEC-023-1-01 with `'gcp-cloud-run'`):

```ts
export const PARAM_SCHEMA: Record<string, ParamSchema> = {
  project_id: { type: 'string', required: true, format: 'identifier' },
  region: { type: 'string', required: true, enum: GCP_REGIONS as readonly string[] },
  service_name: { type: 'string', required: true, format: 'identifier' },
  image_repo: { type: 'string', required: true, format: 'shell-safe-arg' },
  cpu: { type: 'string', default: '1', regex: /^\d+(\.\d+)?$/ },
  memory_mib: { type: 'number', default: 512, range: [128, 32768] },
  health_path: { type: 'string', default: '/health', format: 'shell-safe-arg' },
  health_timeout_seconds: { type: 'number', default: 120, range: [10, 600] },
};

readonly metadata: BackendMetadata = {
  name: 'gcp',
  version: '0.1.0',
  supportedTargets: ['gcp-cloud-run'],
  capabilities: ['gcp-cloud-run'],
  requiredTools: [], // no external CLIs; pure SDK
};
```

- **`build(ctx)`**:
  - Acquires creds via `proxy.acquire('gcp', 'CloudBuild:CreateBuild', { resource: `projects/${project_id}`, region })`.
  - Calls `cloudBuildClient.createBuild({ projectId, build: { ... } })`. Build steps push to `gcr.io/${project_id}/${image_repo}:${ctx.commitSha}`.
  - Polls `cloudBuildClient.getBuild({ projectId, id: buildId })` every 10s up to 30 minutes; rejects if status `FAILURE`/`CANCELLED`/`TIMEOUT`.
  - Returns `BuildArtifact { type: 'docker-image', location: <image-uri>, checksum: <image-digest>, sizeBytes: <reported-by-cloud-build>, metadata: { build_id, project_id, region } }`.
- **`deploy(artifact, env, params)`**:
  - Validates `params` via `validateParameters(PARAM_SCHEMA, params)`; rejects on errors.
  - Acquires creds for `Run.Deploy` scoped to `projects/${project_id}/locations/${region}/services/${service_name}`.
  - Calls `runClient.replaceService({ name, service: { template: { containers: [{ image: artifact.location, resources, ports }] } } })`.
  - Captures the new revision name from the response.
  - Returns signed `DeploymentRecord` with `details: { service_url, revision_name, project_id, region, image_uri }`.
- **`healthCheck(record)`**:
  - Reads `service_url` from `record.details`. Polls `${service_url}${health_path}` (defaults to `/health`) via `fetch` (Node 20+) every 5s up to `health_timeout_seconds`. Returns `healthy: true` on first 200..299; `healthy: false` with `unhealthyReason` on timeout or non-2xx.
  - `checks` array contains one entry per probe (last 5 max).
- **`rollback(record)`**:
  - Acquires creds for `Run.UpdateService` scoped to the same service.
  - Lists previous revisions via `runClient.listRevisions({ parent })`.
  - Picks the previous active revision (the one immediately before `record.details.revision_name`).
  - Calls `runClient.updateService({ name, service: { traffic: [{ revisionName: previousRevision, percent: 100 }] } })`.
  - Returns `RollbackResult { success, restoredArtifactId: <previousRevisionImageUri>, errors }`.

### `AWSBackend` (`plugins/autonomous-dev-deploy-aws/src/backend.ts`)

```ts
export const PARAM_SCHEMA: Record<string, ParamSchema> = {
  account_id: { type: 'string', required: true, regex: /^\d{12}$/ },
  region: { type: 'string', required: true, enum: AWS_REGIONS as readonly string[] },
  cluster_name: { type: 'string', required: true, format: 'identifier' },
  service_name: { type: 'string', required: true, format: 'identifier' },
  ecr_repo: { type: 'string', required: true, format: 'identifier' },
  task_family: { type: 'string', required: true, format: 'identifier' },
  target_group_arn: { type: 'string', required: true, format: 'shell-safe-arg' },
  health_timeout_seconds: { type: 'number', default: 180, range: [10, 600] },
  desired_count: { type: 'number', default: 1, range: [1, 100] },
};

readonly metadata: BackendMetadata = {
  name: 'aws',
  version: '0.1.0',
  supportedTargets: ['aws-ecs-fargate'],
  capabilities: ['aws-ecs-fargate'],
  requiredTools: [], // no external CLIs; pure SDK
};
```

- **`build(ctx)`**:
  - Acquires creds for `ECR:PutImage` scoped to `arn:aws:ecr:${region}:${account_id}:repository/${ecr_repo}`.
  - `ecr-builder.loginAndPush(...)` performs:
    1. `ecrClient.getAuthorizationToken({})` to retrieve a base64 user/pass.
    2. Builds the Docker image from `ctx.repoPath` using a vendored docker library (`dockerode`) — NOT shelling out. Tag: `${account_id}.dkr.ecr.${region}.amazonaws.com/${ecr_repo}:${ctx.commitSha}`.
    3. Pushes via `dockerode` with the ECR auth credentials.
    4. Captures the pushed image digest from the push response.
  - Returns `BuildArtifact { type: 'docker-image', location: <image-uri>, checksum: <digest>, sizeBytes: <image-size>, metadata: { ecr_repo, region, account_id } }`.
- **`deploy(artifact, env, params)`**:
  - Validates params.
  - Acquires creds for `ECS:UpdateService` scoped to `arn:aws:ecs:${region}:${account_id}:service/${cluster_name}/${service_name}`.
  - `ecs-deployer.updateService(...)`:
    1. Reads the current task definition via `ecsClient.describeTaskDefinition({ taskDefinition: task_family })`.
    2. Registers a new revision with the container image set to `artifact.location` via `ecsClient.registerTaskDefinition({...})`.
    3. Captures `previousTaskDefArn` (from the current service description) for rollback.
    4. Calls `ecsClient.updateService({ cluster, service, taskDefinition: <new-revision-arn>, desiredCount })`.
  - Returns signed `DeploymentRecord` with `details: { service_arn, task_definition_arn, previous_task_definition_arn, target_group_arn, region }`.
- **`healthCheck(record)`**:
  - `health-checker.pollAlbHealth(elbV2Client, target_group_arn, timeoutMs)`:
    1. Calls `describeTargetHealth({ TargetGroupArn })` every 5s.
    2. Returns `healthy: true` when ALL targets report `state: 'healthy'` AND target count >= `desired_count`.
    3. Returns `healthy: false` with the most recent `state` and `reason` per target on timeout.
  - `checks[]` includes one entry per target.
- **`rollback(record)`**:
  - Acquires creds for `ECS:UpdateService` scoped to the service ARN.
  - Calls `ecsClient.updateService({ cluster, service, taskDefinition: previousTaskDefinitionArn })`.
  - Returns `RollbackResult { success, restoredArtifactId: previousTaskDefinitionArn, errors }`.

### `credential-proxy-client.ts` (per backend)

A thin typed wrapper that converts `ScopedCredential` into the SDK-specific options object (e.g., `{ credentials: { accessKeyId, secretAccessKey, sessionToken } }` for AWS, or a `GoogleAuth` instance for GCP). Centralized so backend code never touches credential fields directly.

### Error mapping

Both backends translate SDK errors into structured `DeployError` (a class extending `Error` with `code`, `cloud`, `operation`, `retriable: boolean`):
- AWS `AccessDeniedException` → `DeployError { code: 'AUTH_FAILED', retriable: false }`.
- AWS `ThrottlingException` → `DeployError { code: 'RATE_LIMIT', retriable: true }`.
- GCP `PERMISSION_DENIED` → `DeployError { code: 'AUTH_FAILED' }`.
- GCP `RESOURCE_EXHAUSTED` → `DeployError { code: 'QUOTA_EXCEEDED', retriable: true }`.
- Network errors (`ETIMEDOUT`, `ECONNRESET`) → `DeployError { code: 'NETWORK', retriable: true }`.

### Determinism in tests

Tests inject mocked SDK clients (e.g., via `aws-sdk-client-mock` for AWS; manual jest mocks for GCP). No real cloud calls. `proxy.acquire` is replaced with a stub returning a fixed `ScopedCredential`. SDK responses are JSON fixtures stored in `tests/fixtures/aws/` and `tests/fixtures/gcp/`.

## Acceptance Criteria

- [ ] `GCPBackend implements DeploymentBackend` — TypeScript compile under `strict: true` with no `any`.
- [ ] `AWSBackend implements DeploymentBackend` — TypeScript compile under `strict: true` with no `any`.
- [ ] Both classes export `PARAM_SCHEMA` constant matching the schema passed to `validateParameters` (so SPEC-023-1-04's `describe` CLI can render it).
- [ ] `GCPBackend.build()` calls `proxy.acquire('gcp', 'CloudBuild:CreateBuild', { resource: 'projects/<id>', region })` exactly once (verified by spying on the proxy).
- [ ] `GCPBackend.build()` returns a `BuildArtifact` with `type: 'docker-image'` and `location` matching `gcr.io/<project>/<repo>:<sha>`.
- [ ] `GCPBackend.deploy()` calls `runClient.replaceService` with the artifact URI as the container image (verified by mock assertion).
- [ ] `GCPBackend.deploy()` returns a `DeploymentRecord` whose `hmac` is non-empty AND passes `verifyDeploymentRecord`.
- [ ] `GCPBackend.healthCheck()` returns `healthy: true` when the mocked HTTP probe returns 200 within timeout; `healthy: false` with `unhealthyReason` set when all probes return 500.
- [ ] `GCPBackend.rollback()` calls `runClient.updateService` with `traffic: [{ revisionName: <previous>, percent: 100 }]` (verified by mock assertion).
- [ ] `GCPBackend.deploy()` rejects when `region` is not in `GCP_REGIONS` enum (parameter validation).
- [ ] `AWSBackend.build()` calls `proxy.acquire('aws', 'ECR:PutImage', { resource: 'arn:aws:ecr:<region>:<acct>:repository/<repo>' })` exactly once.
- [ ] `AWSBackend.build()` does NOT shell out — verified by asserting `child_process.execFile`/`spawn`/`exec` are not called during the test (jest spies on `child_process`).
- [ ] `AWSBackend.build()` returns a `BuildArtifact` with `location` matching `<account>.dkr.ecr.<region>.amazonaws.com/<repo>:<sha>`.
- [ ] `AWSBackend.deploy()` registers a new task definition AND updates the service in that order (verified by mock call order).
- [ ] `AWSBackend.deploy()` captures `previousTaskDefinitionArn` BEFORE updating the service (verified by mock call order).
- [ ] `AWSBackend.deploy()` returns a signed `DeploymentRecord` whose `details.previous_task_definition_arn` matches the service's pre-deploy task def ARN.
- [ ] `AWSBackend.healthCheck()` returns `healthy: true` when all targets report `state: 'healthy'` and count >= `desired_count`; otherwise `healthy: false` with reasons populated.
- [ ] `AWSBackend.rollback()` calls `ecsClient.updateService` with `taskDefinition: previousTaskDefinitionArn`.
- [ ] `AWSBackend.deploy()` rejects when `account_id` doesn't match `^\d{12}$` (parameter validation).
- [ ] Both backends translate `AccessDeniedException` / `PERMISSION_DENIED` to `DeployError { code: 'AUTH_FAILED' }`.
- [ ] Both backends translate throttling errors to `DeployError { code: 'RATE_LIMIT', retriable: true }`.
- [ ] All four `DeploymentBackend` methods on both backends are tested for the happy path AND at least one failure mode each (build failure, deploy failure, health timeout, rollback failure).
- [ ] `tests/fixtures/gcp/` and `tests/fixtures/aws/` contain at least 5 JSON SDK-response fixtures each (Cloud Build success, Cloud Run replaceService response, ECR putImage response, ECS describeServices response, ECS updateService response).
- [ ] Combined unit-test runtime for both backend test files is under 10 seconds.

## Dependencies

- **SPEC-023-1-01**: `DeploymentBackend`, `BuildContext`, `DeployParameters`, `BuildArtifact`, `DeploymentRecord`, `HealthStatus`, `RollbackResult`, `validateParameters`, `signDeploymentRecord`, `verifyDeploymentRecord`.
- **SPEC-024-1-01**: cloud-plugin scaffolding and `package.json` with vendored SDKs.
- **PLAN-024-2** (companion, type-only consumer): `CredentialProxy` interface and `ScopedCredential` shape. Implementation is mocked in this spec's tests.
- **NPM packages** (vendored by SPEC-024-1-01): `@google-cloud/run`, `@google-cloud/cloudbuild`, `@aws-sdk/client-ecs`, `@aws-sdk/client-ecr`, `@aws-sdk/client-elastic-load-balancing-v2`, `@aws-sdk/client-sts`. New transitive: `dockerode` (added by this spec to `plugins/autonomous-dev-deploy-aws/package.json`).
- **Test packages**: `aws-sdk-client-mock` (devDependency added to AWS plugin); jest with manual mocks for GCP clients.

## Notes

- Cloud-Build-as-the-builder is mandatory for GCP because Cloud Run images must live in GCR/Artifact Registry, and Cloud Build's IAM-scoped service-account model is what the `CredentialProxy` aligns with. Local Docker builds are explicitly out of scope (TDD-024 §6.1).
- `dockerode` is vendored for AWS to avoid shelling out to `docker push`. The library uses Docker Engine's HTTP API directly; the daemon socket location defaults to `/var/run/docker.sock` and is configurable via `DOCKER_HOST`.
- `previousTaskDefinitionArn` is captured INSIDE `deploy()` (not later) because once the new task def is registered, the service description has already advanced. Capturing this in the deploy record is what makes rollback a one-call operation.
- `proxy.acquire()` returns short-lived credentials (default TTL 15 minutes per PLAN-024-2). All operations within a single `build`/`deploy`/`rollback` call complete inside that window; if a long-running build risks expiring credentials, the backend re-acquires inside the polling loop. This is documented as a follow-up optimization, not a v1 requirement.
- Rollback to a non-existent previous revision is a hard error returned to the operator. PLAN-023-3's observability surface notifies operators when a backend is on its first deploy and rollback would have no target.
- The `aws-deploy-expert` and `gcp-deploy-expert` helper agents (SPEC-024-1-04) consume `PARAM_SCHEMA` to render best-practice guidance; promoting `PARAM_SCHEMA` to a module export is therefore mandatory, not optional.
- Both backends produce records that are HMAC-signed using the helpers from SPEC-023-1-01. The signing is delegated to `signDeploymentRecord(record)`; this spec does not re-implement signing.
