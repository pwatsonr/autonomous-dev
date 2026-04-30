# SPEC-024-2-05: Per-Scoper Unit Test Suites and K8s Scope-Enforcement Integration Test

## Metadata
- **Parent Plan**: PLAN-024-2
- **Tasks Covered**: Task 12 (per-scoper unit tests), Task 13 (kind-cluster integration test for scope enforcement)
- **Estimated effort**: 9 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-024-2-05-tests-and-kind-integration.md`

## Description
Consolidate and harden the test surface for the entire CredentialProxy subsystem. Earlier specs (SPEC-024-2-02, -03) include focused unit tests for their own scopers; this spec brings them up to **≥95% line coverage per scoper file**, adds the systematic negative/error-path tests, fingerprints the IAM policy / IAM binding / Role / Role Assignment shapes via committed snapshots, and adds the single end-to-end integration test that runs against a real Kubernetes API server (`kind`).

The integration test is the only place in PLAN-024-2 that proves scope enforcement works **at the cloud level** rather than just at the proxy level. K8s is the only one of the four providers with a freely runnable, deterministic local emulator (`kind`); AWS/GCP/Azure rely on manual smoke tests at release time. The test plays out a real attack scenario: a backend acquires a kubeconfig scoped to namespace `ns-a`, then attempts an operation in namespace `ns-b`, and the K8s API responds 403. If the API does not respond 403, the test fails — that signals a scoping bug in the K8s scoper that mocks alone could miss.

Coverage measurement uses the project's existing tooling (likely `c8` or `vitest --coverage`). The CI pipeline gains a new `kind` job; the integration test is gated behind a `RUN_KIND_TESTS=1` env var so contributors without Docker installed can still run the rest of the suite.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/cred-proxy/test-aws-scoper.test.ts` | Modify | Reach 95% coverage; add negative paths, snapshot tests |
| `plugins/autonomous-dev/tests/cred-proxy/test-gcp-scoper.test.ts` | Modify | Reach 95% coverage; binding-removal failures, etag conflicts |
| `plugins/autonomous-dev/tests/cred-proxy/test-azure-scoper.test.ts` | Modify | Reach 95% coverage; idempotent revoke, GUID uniqueness |
| `plugins/autonomous-dev/tests/cred-proxy/test-k8s-scoper.test.ts` | Modify | Reach 95% coverage; partial-failure revocation |
| `plugins/autonomous-dev/tests/cred-proxy/__snapshots__/aws-policies.snap` | Create | Snapshot file for `awsPolicyFor` outputs |
| `plugins/autonomous-dev/tests/cred-proxy/__snapshots__/k8s-roles.snap` | Create | Snapshot file for K8s Role rules |
| `plugins/autonomous-dev/tests/integration/test-cred-proxy-scope.test.ts` | Create | kind-based scope-enforcement test |
| `plugins/autonomous-dev/tests/integration/kind-cluster-helper.ts` | Create | Helper: spin up / tear down kind cluster |
| `plugins/autonomous-dev/.github/workflows/kind-integration.yml` | Create | CI job for the kind test |
| `plugins/autonomous-dev/package.json` | Modify | Add `test:kind` npm script; pin `kind` version doc |
| `plugins/autonomous-dev/docs/testing/kind-setup.md` | Create | Operator/contributor docs: how to run kind tests locally |

## Implementation Details

### Coverage targets

Coverage is measured per file using the project's existing coverage tool. Required thresholds:

| File | Min line coverage | Min branch coverage |
|------|------------------|---------------------|
| `src/cred-proxy/scopers/aws-policy-for.ts` | 100% | 100% |
| `src/cred-proxy/scopers/aws.ts` | 95% | 90% |
| `src/cred-proxy/scopers/gcp.ts` | 95% | 90% |
| `src/cred-proxy/scopers/azure.ts` | 95% | 90% |
| `src/cred-proxy/scopers/k8s.ts` | 95% | 90% |
| `src/cred-proxy/scopers/operation-catalog.ts` | 100% | N/A (data only) |
| `src/cred-proxy/scopers/kubeconfig-builder.ts` | 100% | 100% |

The thresholds are enforced in the project's coverage config so CI fails when they regress.

### Negative-path test matrix

Every scoper test file MUST cover the following error paths:

| Error class | AWS | GCP | Azure | K8s |
|-------------|-----|-----|-------|-----|
| Unknown operation | yes | yes | yes | yes |
| Missing required scope key | yes | yes | yes | yes |
| Cloud API rejects scope creation (e.g., 403 on AssumeRole / 409 on setIamPolicy / 403 on roleAssignments.create / 403 on TokenRequest) | yes | yes | yes | yes |
| Cloud API returns success but with empty/partial credential | yes | yes | yes | yes |
| `revoke()` fails with retryable error | (no-op for AWS) | yes | yes | yes |
| `revoke()` fails with permanent error (e.g., 404) | (no-op) | yes (treated as success on 404) | yes (treated as success on 404) | yes (per-resource `Promise.allSettled`) |
| Two consecutive `scope` calls produce distinct identifiers | sessionName | binding-add called twice with no collision | distinct GUID per call | distinct hex-tag-suffixed names |

Each cell is a discrete test case. The test file structure groups them into describe blocks: `happy path`, `validation errors`, `cloud API errors`, `revoke behavior`, `idempotency / uniqueness`.

### Snapshot tests

`tests/cred-proxy/__snapshots__/aws-policies.snap` is the committed expectation for `awsPolicyFor` outputs. Format (Jest/Vitest standard):

```
exports[`awsPolicyFor ECS:UpdateService minimal scope 1`] = `
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ecs:UpdateService", "ecs:DescribeServices"],
      "Resource": "arn:aws:ecs:us-east-1:123456789012:service/prod/api"
    }
  ]
}
`;
```

Required snapshots: every operation in `AWS_OPERATIONS` (initially `ECS:UpdateService`, `Lambda:UpdateFunctionCode`; grows as cloud backends register operations). PR template (separate, ops concern) reminds contributors to regenerate the snapshot when adding an operation.

`tests/cred-proxy/__snapshots__/k8s-roles.snap` similarly snapshots the `rules` array passed to `createNamespacedRole` for each operation in `K8S_OPERATIONS`. Format mirrors the structure shipped to the K8s API server (verbs/resources/apiGroups arrays).

### `tests/integration/kind-cluster-helper.ts`

```ts
import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface KindCluster {
  name: string;
  kubeconfigPath: string;
  destroy(): void;
}

export function startKindCluster(name = `cred-proxy-${Date.now()}`): KindCluster {
  if (!hasKind()) throw new Error('kind binary not on PATH; run `brew install kind` or see docs/testing/kind-setup.md');
  execSync(`kind create cluster --name ${name} --image kindest/node:v1.27.3 --wait 60s`, { stdio: 'inherit' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kind-kc-'));
  const kc = path.join(tmp, 'kubeconfig');
  execSync(`kind get kubeconfig --name ${name}`, { stdio: ['ignore', fs.openSync(kc, 'w'), 'inherit'] });
  return {
    name,
    kubeconfigPath: kc,
    destroy: () => { try { execSync(`kind delete cluster --name ${name}`, { stdio: 'ignore' }); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

export function hasKind(): boolean {
  return spawnSync('kind', ['--version']).status === 0;
}
```

The pinned kindest/node image version (`v1.27.3`) ensures reproducibility. The image is pulled once and cached by Docker.

### `tests/integration/test-cred-proxy-scope.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as k8s from '@kubernetes/client-node';
import { startKindCluster, hasKind, type KindCluster } from './kind-cluster-helper';
import { K8sCredentialScoper } from '../../src/cred-proxy/scopers/k8s';

const SKIP = !process.env.RUN_KIND_TESTS || !hasKind();

describe.skipIf(SKIP)('cred-proxy K8s scope enforcement (kind)', () => {
  let cluster: KindCluster;
  let scoper: K8sCredentialScoper;

  beforeAll(async () => {
    cluster = startKindCluster();
    // Pre-create namespaces ns-a and ns-b
    const kc = new k8s.KubeConfig();
    kc.loadFromFile(cluster.kubeconfigPath);
    const core = kc.makeApiClient(k8s.CoreV1Api);
    await core.createNamespace({ metadata: { name: 'ns-a' } });
    await core.createNamespace({ metadata: { name: 'ns-b' } });
    scoper = new K8sCredentialScoper({ adminKubeconfigPath: cluster.kubeconfigPath });
  }, 90_000);

  afterAll(() => cluster?.destroy());

  it('issued kubeconfig succeeds for in-namespace deploy', async () => {
    const { payload } = await scoper.scope('deploy', { cluster: 'kind-' + cluster.name, namespace: 'ns-a' });
    const { kubeconfig } = JSON.parse(payload) as { kubeconfig: string };
    const kc = new k8s.KubeConfig();
    kc.loadFromString(kubeconfig);
    const apps = kc.makeApiClient(k8s.AppsV1Api);
    const res = await apps.createNamespacedDeployment('ns-a', minimalDeployment('app-a'));
    expect(res.body.metadata?.name).toBe('app-a');
  }, 30_000);

  it('issued kubeconfig is REJECTED (403) for out-of-namespace deploy', async () => {
    const { payload } = await scoper.scope('deploy', { cluster: 'kind-' + cluster.name, namespace: 'ns-a' });
    const { kubeconfig } = JSON.parse(payload) as { kubeconfig: string };
    const kc = new k8s.KubeConfig();
    kc.loadFromString(kubeconfig);
    const apps = kc.makeApiClient(k8s.AppsV1Api);
    let status: number | undefined;
    try { await apps.createNamespacedDeployment('ns-b', minimalDeployment('app-b')); }
    catch (err: any) { status = err?.response?.statusCode ?? err?.statusCode; }
    expect(status).toBe(403);
  }, 30_000);

  it('revoke() removes the ServiceAccount, Role, and RoleBinding', async () => {
    const { payload, revoke } = await acquireRaw(scoper, 'ns-a');
    await revoke();
    const kc = new k8s.KubeConfig(); kc.loadFromFile(cluster.kubeconfigPath);
    const core = kc.makeApiClient(k8s.CoreV1Api);
    const list = await core.listNamespacedServiceAccount('ns-a');
    const proxyAccounts = list.body.items.filter(sa => sa.metadata?.name?.startsWith('cred-proxy-'));
    expect(proxyAccounts).toHaveLength(0);
  }, 30_000);
});

function minimalDeployment(name: string) { /* 8-line k8s.V1Deployment fixture */ }
async function acquireRaw(scoper: K8sCredentialScoper, ns: string) {
  return scoper.scope('deploy', { cluster: 'kind-...', namespace: ns });
}
```

The test file uses `describe.skipIf(SKIP)` so contributors without Docker (no `kind` binary, no `RUN_KIND_TESTS=1`) automatically skip. CI sets the env var.

### `.github/workflows/kind-integration.yml`

A new GitHub Actions job (or equivalent for the project's CI) that:
1. Runs on `ubuntu-latest` (kind requires Docker, available on GitHub-hosted Linux runners).
2. Installs `kind` via the official action: `engineerd/setup-kind@v0.5.0` (or equivalent).
3. Runs `RUN_KIND_TESTS=1 npm run test:kind` with a 5-minute job timeout.
4. Uploads test logs as artifact on failure.

The workflow runs only on PRs that modify `src/cred-proxy/scopers/k8s.ts`, `src/cred-proxy/scopers/operation-catalog.ts`, `tests/integration/**`, or this workflow file (path-filtered to keep CI fast).

### `package.json` additions

```json
{
  "scripts": {
    "test:cred-proxy": "vitest run tests/cred-proxy",
    "test:kind": "RUN_KIND_TESTS=1 vitest run tests/integration/test-cred-proxy-scope.test.ts"
  }
}
```

### `docs/testing/kind-setup.md`

≤ 80 lines. Required sections:
1. **Why kind:** the integration test is the only proof that scope enforcement works at the K8s API level.
2. **Install:** `brew install kind` (macOS), `go install sigs.k8s.io/kind@latest` (Linux), or download from releases page.
3. **Docker requirement:** kind needs Docker Desktop (macOS/Windows) or Docker Engine (Linux). Verify with `docker info`.
4. **Run locally:** `RUN_KIND_TESTS=1 npm run test:kind`. Expected runtime: 60-90s for cluster spin-up + ~10s for the test itself.
5. **Troubleshooting:** "image pull failed" (slow network, retry), "no kind binary" (missing install), "namespace already exists" (stale prior cluster — `kind delete cluster --name <prefix>*`).

## Acceptance Criteria

### Coverage thresholds (CI-enforced)

- [ ] `aws-policy-for.ts`: line coverage ≥ 100%, branch coverage ≥ 100%.
- [ ] `aws.ts`: line coverage ≥ 95%, branch coverage ≥ 90%.
- [ ] `gcp.ts`: line coverage ≥ 95%, branch coverage ≥ 90%.
- [ ] `azure.ts`: line coverage ≥ 95%, branch coverage ≥ 90%.
- [ ] `k8s.ts`: line coverage ≥ 95%, branch coverage ≥ 90%.
- [ ] `kubeconfig-builder.ts`: line coverage ≥ 100%.
- [ ] CI fails with a non-zero exit if any threshold regresses.

### Negative-path matrix

- [ ] Each cell of the 8-row × 4-column matrix above has at least one passing test case (verified by grep against the test files for the documented case names).
- [ ] At least one "cloud API rejects" test per scoper uses an SDK-mock-thrown error to drive the path; the error propagates with the original message preserved.
- [ ] At least one "partial credential" test per scoper (where the SDK returns success but with missing fields) results in an explicit `Error` (not a runtime crash from a null deref).

### Snapshots

- [ ] `__snapshots__/aws-policies.snap` exists, is checked in, and contains at minimum entries for `ECS:UpdateService` and `Lambda:UpdateFunctionCode`.
- [ ] `__snapshots__/k8s-roles.snap` exists, is checked in, and contains at minimum the `deploy` operation's rules.
- [ ] Running `vitest run tests/cred-proxy` with no source changes leaves the snapshots unchanged (idempotent).
- [ ] Modifying any operation's actions/resources/rules in `operation-catalog.ts` causes the corresponding snapshot test to fail with a clear diff.

### kind integration test

- [ ] When `RUN_KIND_TESTS=1` is set AND `kind` is on PATH, the integration test file runs three test cases.
- [ ] When `RUN_KIND_TESTS` is unset, all test cases are skipped (verified by Vitest's reported skip count).
- [ ] The first test (in-namespace deploy) succeeds: a deployment is created in `ns-a` using the issued kubeconfig.
- [ ] The second test (out-of-namespace deploy) fails with HTTP 403 when attempting `ns-b`. The 403 originates from the K8s API server, not from the K8s client library or the scoper.
- [ ] The third test confirms revocation removes all created resources from the namespace.
- [ ] The full integration test file completes (cluster spin-up + 3 cases + tear-down) in under 2 minutes on a developer laptop (M1 / Linux x86_64 with Docker running).
- [ ] The cluster is destroyed in `afterAll`, even when individual tests fail. Verified by listing `kind` clusters before and after a forced test failure.

### CI

- [ ] The `kind-integration.yml` workflow runs only when changes touch `src/cred-proxy/scopers/k8s.ts`, `src/cred-proxy/scopers/operation-catalog.ts`, `tests/integration/**`, or itself (path filter verified by inspection).
- [ ] The workflow's overall job timeout is ≤ 5 minutes.
- [ ] On test failure, the workflow uploads the kind cluster logs (`docker logs <kind-control-plane>`) as a debug artifact.

### Documentation

- [ ] `docs/testing/kind-setup.md` exists, ≤ 80 lines, includes all 5 documented sections.
- [ ] The README in `plugins/autonomous-dev/` (or the closest equivalent) gets a one-line pointer to `docs/testing/kind-setup.md` (single-line edit; no scope creep).

## Dependencies

- SPEC-024-2-02 (AWS, GCP scopers exist + initial unit tests).
- SPEC-024-2-03 (Azure, K8s scopers exist + initial unit tests).
- SPEC-024-2-04 (the proxy is wired end-to-end — needed for any future expansion of the integration test, but the current scope-enforcement test exercises only the K8s scoper directly).
- `kind` ≥ 0.20.0 (provides the kindest/node v1.27 image used by the test).
- Docker Engine / Docker Desktop on the test runner.
- `@kubernetes/client-node` (already a dependency from SPEC-024-2-03).
- The project's coverage tooling (`c8` or `vitest --coverage`) configured with per-file thresholds.

## Notes

- **Why only K8s gets a real-cloud integration test:** AWS/GCP/Azure each cost money to provision against and require credentials in CI. K8s + kind costs only Docker time. Manual smoke-tests at release time (PLAN-024-2 §Testing Strategy) cover the other three; their unit tests with SDK mocks lock in the SDK call shapes.
- **Snapshot diff workflow:** when an operation's permissions legitimately change (e.g., ECS adds a required permission), the developer runs `vitest -u` to update the snapshot, AND must re-justify the change in the PR description. The risk-register entry on "policy generator widening scope" is partly mitigated by this workflow.
- **kind cluster pinned to v1.27.3:** chosen because (a) it supports the TokenRequest API (required since 1.22), (b) it's a recent stable, (c) pinning prevents random breakage from kind upgrades. Quarterly bump as part of dependency hygiene.
- **3-test integration coverage is intentional:** more cases would inflate CI time without adding scoping evidence. The third test (revoke cleanup) is included because it's the only way to verify the `Promise.allSettled` cleanup path against real K8s — the unit tests use mocks that can't observe the actual cluster state.
- **No Azure RBAC integration test:** Azure has no offline emulator. Even Azurite doesn't cover RBAC. This gap is captured in the operator manual smoke checklist (out of scope for this spec).
- **Performance budget:** PLAN-024-2 §Testing Strategy specifies <500ms p95 token issuance per provider. That budget is NOT enforced in this spec — it's verified manually at release time, and a follow-up spec can wire it into CI as a synthetic perf test once a benchmarking harness exists.
- **Test isolation:** the kind cluster name includes `Date.now()` to prevent collisions when two runs happen back-to-back on the same machine. The afterAll destroy is best-effort; if a prior crashed test left a cluster behind, the next test creates a new one with a different name (no collision).
