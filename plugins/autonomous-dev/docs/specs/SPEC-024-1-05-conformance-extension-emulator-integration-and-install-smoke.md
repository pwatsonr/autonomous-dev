# SPEC-024-1-05: Conformance Suite Extension + Emulator Integration Tests + Plugin-Install Smoke

## Metadata
- **Parent Plan**: PLAN-024-1
- **Tasks Covered**: Task 8 (conformance suite extension), Task 10 (integration tests with emulators), Task 11 (plugin-installation smoke test)
- **Estimated effort**: 14 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-024-1-05-conformance-extension-emulator-integration-and-install-smoke.md`

## Description
Verify the four cloud backends (built by SPEC-024-1-02 and SPEC-024-1-03) by extending the existing conformance suite (PLAN-023-1 / SPEC-023-1-04) to cover them, adding emulator-based integration tests for GCP/AWS/K8s (Azure remains stub-only), and running an end-to-end plugin-install smoke that confirms each cloud backend appears in `deploy backends list` after `claude plugin install`. After this spec, every PR touching a cloud backend gets the same battery as the bundled backends, plus emulator-based confidence that the SDK calls actually work, plus a smoke confirmation that the plugin shape installs and registers correctly.

This spec is test-only — no production code changes beyond adding `PARAM_SCHEMA` test fixtures and importing the cloud backends into the conformance suite's bootstrap.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `tests/deploy/cloud-conformance.test.ts` | Create | Parameterized conformance over 4 cloud backends |
| `tests/fixtures/cloud/gcp.params.ts` | Create | Valid `DeployParameters` for GCPBackend |
| `tests/fixtures/cloud/aws.params.ts` | Create | Valid `DeployParameters` for AWSBackend |
| `tests/fixtures/cloud/azure.params.ts` | Create | Valid `DeployParameters` for AzureBackend |
| `tests/fixtures/cloud/k8s.params.ts` | Create | Valid `DeployParameters` for K8sBackend |
| `tests/fixtures/cloud/sdk-mocks/` | Create | Per-backend mock SDK responses (JSON) |
| `tests/integration/test-gcp-backend.test.ts` | Create | Cloud Run emulator + Cloud Build via local Docker |
| `tests/integration/test-aws-backend.test.ts` | Create | LocalStack ECS/ECR |
| `tests/integration/test-k8s-backend.test.ts` | Create | kind cluster |
| `tests/integration/setup/start-localstack.ts` | Create | Spawns LocalStack via `dockerode` |
| `tests/integration/setup/start-cloud-run-emulator.ts` | Create | Spawns Cloud Run local emulator |
| `tests/integration/setup/start-kind-cluster.ts` | Create | Provisions a kind cluster |
| `tests/integration/setup/teardown.ts` | Create | Stops all containers / clusters |
| `tests/integration/azure-release-checklist.md` | Create | Manual smoke steps for Azure |
| `tests/integration/test-plugin-install-smoke.test.ts` | Create | End-to-end install + `deploy backends list` |
| `plugins/autonomous-dev/src/deploy/registry-bootstrap.ts` | Modify | Add cloud-backend registration helper used by tests |
| `.github/workflows/cloud-integration.yml` | Create | CI job running all 3 emulator tests + install smoke |

## Implementation Details

### `tests/deploy/cloud-conformance.test.ts`

Parameterized conformance for the four cloud backends. Re-uses the conformance battery from SPEC-023-1-04 by importing its test helpers (extracted to `src/deploy/conformance-battery.ts` if not already done; SPEC-023-1-04 produced this test inline — this spec promotes the battery to a reusable module). Each backend is constructed with a mock `CredentialProxy` returning fixed `ScopedCredential`s, and SDK clients are replaced with mock fixtures from `tests/fixtures/cloud/sdk-mocks/`.

```ts
import { runConformanceBattery } from '../../src/deploy/conformance-battery';
import { GCPBackend } from '../../plugins/autonomous-dev-deploy-gcp/src/backend';
import { AWSBackend } from '../../plugins/autonomous-dev-deploy-aws/src/backend';
import { AzureBackend } from '../../plugins/autonomous-dev-deploy-azure/src/backend';
import { K8sBackend } from '../../plugins/autonomous-dev-deploy-k8s/src/backend';
import { createMockProxy } from './helpers/mock-credential-proxy';
import gcpParams from '../fixtures/cloud/gcp.params';
import awsParams from '../fixtures/cloud/aws.params';
import azureParams from '../fixtures/cloud/azure.params';
import k8sParams from '../fixtures/cloud/k8s.params';

const CASES = [
  { name: 'gcp',   make: () => new GCPBackend(createMockProxy('gcp')),     params: gcpParams },
  { name: 'aws',   make: () => new AWSBackend(createMockProxy('aws')),     params: awsParams },
  { name: 'azure', make: () => new AzureBackend(createMockProxy('azure')), params: azureParams },
  { name: 'k8s',   make: () => new K8sBackend(createMockProxy('k8s')),     params: k8sParams },
];

describe.each(CASES)('cloud conformance: $name', ({ make, params }) => {
  runConformanceBattery({
    backendFactory: make,
    validParams: params,
    fixturesRoot: `tests/fixtures/cloud/sdk-mocks/${'$name'}`,
  });
});
```

`runConformanceBattery` from SPEC-023-1-04 covers: metadata shape, build returns valid artifact, deploy returns signed record, healthcheck returns valid status, rollback returns valid result, tampering is detected. This spec does NOT add new battery items; it just runs the existing battery against the new backends.

### Integration tests — common shape

Each integration test file:
- Skipped when `process.env.RUN_CLOUD_INTEGRATION !== '1'` (so `npm test` doesn't accidentally provision LocalStack).
- Uses `beforeAll` to spawn the emulator via the corresponding setup file; `afterAll` tears down.
- Tests a full lifecycle: `build` → `deploy` → `healthCheck` → `rollback`.
- Uses a REAL `CredentialProxy` stub configured for the emulator (e.g., LocalStack accepts any AWS creds; Cloud Run emulator uses a no-auth gRPC endpoint).
- Asserts that the signed `DeploymentRecord` from `deploy()` passes `verifyDeploymentRecord` and that `rollback()` returns `success: true`.

### `tests/integration/test-gcp-backend.test.ts`

```ts
import { startCloudRunEmulator, stopEmulator } from './setup/start-cloud-run-emulator';
import { GCPBackend } from '../../plugins/autonomous-dev-deploy-gcp/src/backend';

const RUN = process.env.RUN_CLOUD_INTEGRATION === '1';
const skip = RUN ? describe : describe.skip;

skip('GCPBackend integration (Cloud Run emulator + local Cloud Build)', () => {
  let emulator: { endpoint: string; cleanup: () => Promise<void> };
  let backend: GCPBackend;

  beforeAll(async () => {
    emulator = await startCloudRunEmulator();
    backend = new GCPBackend(createEmulatorProxy(emulator.endpoint));
  }, 60_000);

  afterAll(async () => {
    if (emulator) await emulator.cleanup();
  });

  test('full lifecycle: build → deploy → health → rollback', async () => {
    const ctx = makeBuildContext({ repoPath: fixturePath('hello-server') });
    const artifact = await backend.build(ctx);
    expect(artifact.location).toMatch(/^gcr\.io\//);
    const record = await backend.deploy(artifact, 'integration', validGcpParams);
    expect(record.hmac).not.toBe('');
    const health = await backend.healthCheck(record);
    expect(health.healthy).toBe(true);
    // Deploy a second revision so rollback has a target.
    const ctx2 = makeBuildContext({ repoPath: fixturePath('hello-server-v2') });
    const artifact2 = await backend.build(ctx2);
    await backend.deploy(artifact2, 'integration', validGcpParams);
    const rollback = await backend.rollback(record);
    expect(rollback.success).toBe(true);
  }, 240_000);
});
```

### `tests/integration/test-aws-backend.test.ts`

LocalStack provides ECR and ECS endpoints. Setup spawns LocalStack via `dockerode`; backend is configured to use `endpoint: http://localhost:4566`. The `CredentialProxy` stub returns `{ accessKeyId: 'test', secretAccessKey: 'test', sessionToken: 'test' }` (LocalStack accepts these).

Lifecycle test:
- `build`: pushes a Dockerized hello-server to LocalStack's ECR.
- `deploy`: registers a task definition and updates an ECS service in LocalStack.
- `healthCheck`: LocalStack does NOT fully simulate ALB target health; the test asserts that the health-checker calls `describeTargetHealth` and handles the LocalStack-emitted "no targets registered" response gracefully (returns `healthy: false` with a structured reason).
- `rollback`: confirms `updateService` is called with the previous task def ARN; LocalStack returns success.

Documented LocalStack limitations:
- Target health is simulated, not real. Production ALB integration is verified by manual release-time smoke (documented in `azure-release-checklist.md` style file `aws-release-checklist.md`).
- ECS Fargate networking is partially simulated; the test uses `EC2`-launch-type tasks for compatibility.

### `tests/integration/test-k8s-backend.test.ts`

Setup provisions a kind cluster via `kind create cluster --name autonomous-dev-test`. The test reads the kubeconfig file, builds a `ScopedCredential { kubeconfig: <yaml> }`, and constructs `K8sBackend` with a proxy that returns it.

Lifecycle test:
- `build`: no-op (returns the commit-SHA artifact).
- `deploy`: applies a fixture manifest (`tests/fixtures/k8s/integration/hello-deployment.yaml`) into a fresh test namespace.
- `healthCheck`: polls the Deployment until `readyReplicas === replicas`.
- `rollback`: deploys a v2 image (broken on purpose), confirms rollout undo restores v1, and Pods become Ready again.
- Cleanup deletes the test namespace.

A second test verifies the OPA-rejection path: applies an OPA Gatekeeper constraint into the cluster, attempts to deploy a manifest violating it, asserts `K8sBackend.deploy` rejects with `DeployError { code: 'POLICY_VIOLATION' }`.

### `tests/integration/setup/*.ts`

Each setup file exports an async `start*()` returning `{ endpoint, cleanup }` (or equivalent). Implementations:

- `start-localstack.ts`: pulls `localstack/localstack:3` image via `dockerode`, runs with `SERVICES=ecs,ecr,elbv2,sts`, waits for `/_localstack/health` to report `running`, returns `{ endpoint: 'http://localhost:4566', cleanup }`.
- `start-cloud-run-emulator.ts`: pulls `gcr.io/cloud-builders/cloud-run-emulator:latest` (placeholder; actual image is the `cloud-build` + `cloud-run` SDK emulator), exposes port 9090 for Cloud Build mock + 8080 for Cloud Run, returns `{ endpoint, cleanup }`.
- `start-kind-cluster.ts`: shells out to `kind create cluster --name autonomous-dev-test --kubeconfig /tmp/kind-config.yaml` (this is the ONE place we shell out — kind doesn't have a Node.js binding). Validates `kubectl` and `kind` are on PATH; skips with a clear message if absent. Returns `{ kubeconfigPath, cleanup }`.
- `teardown.ts`: aggregates `cleanup` calls; called from each test's `afterAll`. Logs failures but does not throw (avoid masking real test failures).

### `tests/integration/azure-release-checklist.md`

A markdown file enumerated as a release-checklist per PLAN-024-1's Definition of Done. Sections:
1. **Pre-conditions**: subscription ID, resource group, ACR, Container Apps environment, Managed Identity assigned.
2. **Build**: run `AzureBackend.build` against the real subscription, confirm an ACR run completes, image tag matches commit SHA.
3. **Deploy**: run `AzureBackend.deploy`, confirm new revision appears in `az containerapp revision list`, traffic routes to new revision.
4. **HealthCheck**: confirm Front Door endpoint returns 200 within 3 minutes.
5. **Rollback**: run `AzureBackend.rollback`, confirm traffic swaps back to previous revision, healthcheck passes.
6. **Cleanup**: deactivate test revisions, leave subscription clean.

The file is referenced in the Azure plugin's README (added by SPEC-024-1-04) under "Release-time manual smoke checklist".

### `tests/integration/test-plugin-install-smoke.test.ts`

End-to-end test using the local marketplace shape (PLAN-019-1). Steps:

1. Start a local marketplace pointing at the four cloud-plugin directories.
2. For each plugin, invoke `claude plugin install autonomous-dev-deploy-<cloud>` (via the CLI under test).
3. Assert the plugin appears in `claude plugin list` output.
4. Run `deploy backends list` (default text); assert each new backend appears.
5. Run `deploy backends list --json`; parse the JSON, assert the new backend objects have the expected `name`, `version`, `supportedTargets`, `capabilities`.
6. Run `deploy backends describe <cloud>` for each; assert `Parameter schema` section lists keys from the backend's `PARAM_SCHEMA`.
7. Run `deploy plan --env test --backend <cloud> --dry-run` (no actual deploy); assert exit code 0 with the backend selected.

This test does NOT require real cloud credentials — `--dry-run` short-circuits before `proxy.acquire()`.

### `plugins/autonomous-dev/src/deploy/registry-bootstrap.ts` modification

The existing `registerBundledBackends()` (from SPEC-023-1-04) is extended with a new exported helper:

```ts
export async function registerCloudBackends(
  plugins: Array<'gcp' | 'aws' | 'azure' | 'k8s'>,
  proxy: CredentialProxy,
): Promise<void> {
  for (const name of plugins) {
    const mod = await import(`@autonomous-dev/deploy-${name}`);
    const Backend = mod.default ?? mod[`${name.toUpperCase()}Backend`];
    BackendRegistry.register(new Backend(proxy));
  }
}
```

Tests use this helper to register backends without going through the full plugin loader. Production deploy phases use the plugin loader (PLAN-019-1) which calls into `registerCloudBackends` via the plugin's exposed entry point. (The plugin entry-point change is OUT of scope for this spec; the loader integration is delivered by PLAN-019-1's existing logic.)

### `.github/workflows/cloud-integration.yml`

A new CI job (separate from the main test workflow) that runs the three emulator tests + install smoke. Triggered on PRs touching `plugins/autonomous-dev-deploy-*` or `tests/integration/test-*-backend.test.ts`. Sets `RUN_CLOUD_INTEGRATION=1`. Provisions Docker for LocalStack/Cloud Run emulator and installs `kind` + `kubectl` for the K8s job. Job timeout: 15 minutes. Failure does NOT block merge by default (manual override available); per PLAN-024-1's risk register, the manual release-time smoke is the canonical safety net.

## Acceptance Criteria

- [ ] `tests/deploy/cloud-conformance.test.ts` runs the conformance battery against all four cloud backends.
- [ ] All four cloud backends pass every battery item (metadata shape, build artifact validity, signed-record verification, healthcheck shape, rollback shape, tamper detection) — same items as the bundled backends.
- [ ] Adding a fictional fifth backend in a test DOES extend the cloud-conformance describe.each automatically (no new test code per backend).
- [ ] The conformance test runs in under 30 seconds total.
- [ ] `tests/fixtures/cloud/sdk-mocks/` contains per-backend mock-response directories with at minimum: build-create, build-status-success, deploy-success, healthcheck-success, healthcheck-failure, rollback-success.
- [ ] `tests/integration/test-gcp-backend.test.ts` runs the full lifecycle against the Cloud Run emulator and asserts: build returns a `gcr.io/...` URI; deploy returns a signed record; healthcheck returns `healthy: true`; rollback returns `success: true`.
- [ ] `tests/integration/test-aws-backend.test.ts` runs the full lifecycle against LocalStack and asserts: ECR push succeeds; ECS service is updated; rollback reverts the task def. LocalStack target-health limitations are documented and the test asserts the limitation is handled gracefully.
- [ ] `tests/integration/test-k8s-backend.test.ts` runs against a kind cluster: applies a manifest, healthcheck reports Ready, deploys a broken v2, rollback restores v1, OPA-rejection scenario asserts `DeployError { code: 'POLICY_VIOLATION' }`.
- [ ] All three integration tests are gated behind `RUN_CLOUD_INTEGRATION=1` and skipped otherwise (verified by running `npm test` without the env var: integration tests show `skipped` status).
- [ ] All three integration tests COMPLETE (pass or fail) within their declared timeouts; combined runtime under 5 minutes per PLAN-024-1 task 10 acceptance criterion.
- [ ] `tests/integration/azure-release-checklist.md` exists with all 6 documented sections (Pre-conditions, Build, Deploy, HealthCheck, Rollback, Cleanup).
- [ ] `tests/integration/test-plugin-install-smoke.test.ts` installs each cloud plugin from the local marketplace and asserts: `claude plugin list` shows it; `deploy backends list` shows it; `deploy backends list --json` includes the expected fields; `deploy backends describe <cloud>` lists the parameter schema; `deploy plan --env test --backend <cloud> --dry-run` exits 0.
- [ ] The install smoke test does NOT require real cloud credentials (verified by the test running in a CI environment with no cloud secrets).
- [ ] `registerCloudBackends(['gcp', 'aws', 'azure', 'k8s'], mockProxy)` registers all four backends; `BackendRegistry.list()` returns 8 entries (4 bundled + 4 cloud) when called after `registerBundledBackends() + registerCloudBackends(...)`.
- [ ] `.github/workflows/cloud-integration.yml` is valid YAML; declares triggers, Docker setup, kind/kubectl install, env vars; runs to completion in under 15 minutes against an empty repo (verified by initial CI run).
- [ ] No regression in the conformance suite for the bundled backends (`local`, `static`, `docker-local`, `github-pages`) after this spec — they continue to pass their own conformance battery.

## Dependencies

- **SPEC-023-1-04**: `BackendRegistry`, conformance battery (this spec promotes the battery from inline tests to a reusable `src/deploy/conformance-battery.ts` module if not already done).
- **SPEC-024-1-01**: cloud-plugin scaffolding; `package.json` lockfiles enable `npm ci` for the install smoke.
- **SPEC-024-1-02 / SPEC-024-1-03**: `GCPBackend`, `AWSBackend`, `AzureBackend`, `K8sBackend` classes and their `PARAM_SCHEMA` exports.
- **SPEC-024-1-04**: README files referenced by the install smoke (asserts each README exists).
- **PLAN-019-1** (existing on main): plugin loader and local marketplace shape consumed by the install-smoke test.
- **PLAN-024-2** (companion, type-only consumer): `CredentialProxy` interface; mocked or stubbed in this spec's tests.
- **External tools (CI only)**: Docker (for LocalStack and Cloud Run emulator); `kind` and `kubectl` (for K8s integration). Documented as `cloud-integration.yml` job prerequisites.

## Notes
- This spec is intentionally test-heavy and production-light. The four cloud backends already exist (SPEC-024-1-02, SPEC-024-1-03); this spec verifies them and surfaces them via the registry. The only production-code change is the `registerCloudBackends` helper.
- LocalStack's coverage of ECS Fargate is incomplete; the AWS integration test compensates by using EC2-launch-type tasks. This is documented as a known limitation; PLAN-024-1's risk register identifies "emulator divergence from real cloud" as the rationale for mandatory release-time manual smoke.
- The Cloud Run emulator referenced by `start-cloud-run-emulator.ts` is the GCP-supplied local emulator (currently in beta as of 2026-04). If GCP discontinues the emulator, the GCP integration test falls back to mocked SDK calls (matching Azure's posture); this fallback path is documented in the test file's header comment.
- kind requires Docker on the runner. The K8s integration test asserts Docker availability in `beforeAll` and skips with a clear message when absent (so developers without Docker still get green local tests).
- The install-smoke test is the FIRST end-to-end test of the v2 plugin manifest's `deployment_backend` block in production-like flow. If it fails, the issue is most likely in the v2 schema validator (PLAN-022-1) or the plugin loader (PLAN-019-1), not in this spec's code.
- Conformance and integration tests are SEPARATE — conformance runs in the main `npm test` job; integration runs in the `cloud-integration.yml` workflow. Mixing them risks slow developer iteration.
- The release-time manual smoke checklists (one per cloud, not just Azure) are tracked outside this spec in each plugin's README (SPEC-024-1-04). Azure's checklist is the most detailed because it's the only cloud with no CI emulator.
- Future cloud plugins (e.g., Oracle Cloud, IBM Cloud) plug into `registerCloudBackends` and `cloud-conformance.test.ts` by adding a fixture file and a one-line entry in the `CASES` array. No further test scaffolding required.
