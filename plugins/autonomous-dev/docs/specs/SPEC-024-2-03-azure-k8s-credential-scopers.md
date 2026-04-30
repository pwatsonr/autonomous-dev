# SPEC-024-2-03: Azure and Kubernetes Credential Scopers

## Metadata
- **Parent Plan**: PLAN-024-2
- **Tasks Covered**: Task 5 (Azure scoper), Task 6 (Kubernetes scoper)
- **Estimated effort**: 10 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-024-2-03-azure-k8s-credential-scopers.md`

## Description
Implement the second pair of `CredentialScoper` instances per TDD-024 §7.2: Azure and Kubernetes. Both differ from the AWS/GCP shape in important ways that warrant their own spec.

The Azure scoper creates a **Role Assignment** (not an IAM policy) scoped to a single Azure resource (e.g., one Container Apps deployment) for 15 minutes. It uses Managed Identity to obtain a credential token; the role assignment is the actual scope-narrowing mechanism (Azure has no inline session-policy concept). On `revoke()`, the role assignment is deleted by ID — and unlike AWS STS, this DOES revoke effective access for new requests once Azure's RBAC propagation completes (~30-60s).

The Kubernetes scoper uses the cluster's `TokenRequest` API (K8s ≥ 1.22) to issue a ServiceAccount token bound to a per-issuance Role and RoleBinding scoped to a single namespace. The output is a complete kubeconfig (server URL + CA cert + bearer token) that the backend can write to disk and use directly with `kubectl --kubeconfig`. The token has a hard `expirationSeconds: 900` and the RoleBinding is deleted on revocation.

Both scopers extend the operation catalog from SPEC-024-2-02. Both implement `CredentialScoper` from SPEC-024-2-01. Neither knows about the proxy, the allowlist, or the audit log — those are wired in SPEC-024-2-04. Integration testing against a kind cluster is deferred to SPEC-024-2-05.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/cred-proxy/scopers/azure.ts` | Create | `AzureCredentialScoper` class |
| `plugins/autonomous-dev/src/cred-proxy/scopers/k8s.ts` | Create | `K8sCredentialScoper` class |
| `plugins/autonomous-dev/src/cred-proxy/scopers/operation-catalog.ts` | Modify | Add `AZURE_OPERATIONS` and `K8S_OPERATIONS` records |
| `plugins/autonomous-dev/src/cred-proxy/scopers/kubeconfig-builder.ts` | Create | Pure helper: server+CA+token → kubeconfig YAML |
| `plugins/autonomous-dev/tests/cred-proxy/test-azure-scoper.test.ts` | Create | Azure SDK mocks, role-assign + token + revoke |
| `plugins/autonomous-dev/tests/cred-proxy/test-k8s-scoper.test.ts` | Create | k8s-client mocks, TokenRequest + Role + RoleBinding |
| `plugins/autonomous-dev/tests/cred-proxy/test-kubeconfig-builder.test.ts` | Create | Snapshot of generated YAML |
| `plugins/autonomous-dev/package.json` | Modify | Add `@azure/identity`, `@azure/arm-authorization`, `@kubernetes/client-node` |

## Implementation Details

### `operation-catalog.ts` additions

```ts
export interface AzureOperationSpec {
  /** Built-in or custom Azure RBAC role definition ID (full path: /subscriptions/.../providers/Microsoft.Authorization/roleDefinitions/<guid>). */
  roleDefinitionId: string;
  /** ARM resource scope path: /subscriptions/<sub>/resourceGroups/<rg>/providers/<rp>/<resource>/<name> */
  resourceScope: (scope: Record<string, string>) => string;
  requiredScopeKeys: readonly string[];
}

export interface K8sOperationSpec {
  /** PolicyRules to embed in the per-issuance Role. Mirrors the K8s rbacv1 Rule shape. */
  rules: ReadonlyArray<{
    apiGroups: readonly string[];
    resources: readonly string[];
    verbs: readonly string[];
    resourceNames?: readonly string[];
  }>;
  requiredScopeKeys: readonly string[]; // typically ['cluster', 'namespace']
}

export const AZURE_OPERATIONS: Readonly<Record<string, AzureOperationSpec>> = {
  'ContainerApps.Deploy': {
    roleDefinitionId: '/providers/Microsoft.Authorization/roleDefinitions/b24988ac-6180-42a0-ab88-20f7382dd24c', // Contributor; replace with custom-scoped def in production
    resourceScope: (s) => `/subscriptions/${s.subscriptionId}/resourceGroups/${s.resourceGroup}/providers/Microsoft.App/containerApps/${s.appName}`,
    requiredScopeKeys: ['subscriptionId', 'resourceGroup', 'appName'],
  },
};

export const K8S_OPERATIONS: Readonly<Record<string, K8sOperationSpec>> = {
  'deploy': {
    rules: [
      { apiGroups: ['apps'], resources: ['deployments'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'] },
      { apiGroups: [''], resources: ['services', 'configmaps'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'] },
      { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] },
    ],
    requiredScopeKeys: ['cluster', 'namespace'],
  },
};
```

### `src/cred-proxy/scopers/azure.ts`

```ts
import { ManagedIdentityCredential } from '@azure/identity';
import { AuthorizationManagementClient } from '@azure/arm-authorization';
import { randomUUID } from 'node:crypto';
import type { CredentialScoper, Scope } from '../types';
import { AZURE_OPERATIONS } from './operation-catalog';

export interface AzureScoperConfig {
  readonly subscriptionId: string;
  /** Object ID of the Managed Identity that will hold the role assignment and mint tokens. */
  readonly managedIdentityObjectId: string;
}

export class AzureCredentialScoper implements CredentialScoper {
  readonly provider = 'azure' as const;
  constructor(
    private readonly cfg: AzureScoperConfig,
    private readonly auth: AuthorizationManagementClient = new AuthorizationManagementClient(
      new ManagedIdentityCredential(),
      cfg.subscriptionId,
    ),
    private readonly cred: ManagedIdentityCredential = new ManagedIdentityCredential(),
  ) {}

  async scope(operation: string, scope: Scope) {
    const spec = AZURE_OPERATIONS[operation];
    if (!spec) throw new Error(`unknown Azure operation: ${operation}`);
    for (const key of spec.requiredScopeKeys) {
      if (!scope[key]) throw new Error(`missing required scope key '${key}' for ${operation}`);
    }

    const assignmentName = randomUUID(); // Azure requires the assignment name to be a GUID
    const resourceScope = spec.resourceScope(scope as Record<string, string>);

    await this.auth.roleAssignments.create(resourceScope, assignmentName, {
      roleDefinitionId: spec.roleDefinitionId,
      principalId: this.cfg.managedIdentityObjectId,
      principalType: 'ServicePrincipal',
    });

    // Mint a token for the resource manager scope.
    const tokenResp = await this.cred.getToken('https://management.azure.com/.default');
    if (!tokenResp) throw new Error('Azure ManagedIdentityCredential returned no token');

    // Azure tokens default ~1h; we encode the proxy's 15-min expiry in our payload.
    const expires_at = new Date(Date.now() + 900_000).toISOString();

    return {
      payload: JSON.stringify({
        access_token: tokenResp.token,
        expires_at,
        // Backend uses this as `Authorization: Bearer <access_token>` against ARM.
      }),
      expires_at,
      revoke: async () => {
        await this.auth.roleAssignments.delete(resourceScope, assignmentName);
      },
    };
  }
}
```

**Important behavioral notes:**
- The token returned by `ManagedIdentityCredential.getToken` may have a longer cloud-side TTL than 900s — Azure does not honor a per-token lifetime override on Managed Identity. The proxy enforces 900s by revoking the role assignment. Until Azure's RBAC cache evicts (~30-60s), the token MAY still successfully call APIs that were authorized. This is documented in the risk register (defense in depth: the cloud is the authority).
- `roleAssignments.create` is idempotent on `(scope, assignmentName)` — using a fresh GUID per issuance prevents collisions.
- `roleAssignments.delete` returning 404 (already removed) is treated as success (`revoke()` is idempotent).

### `src/cred-proxy/scopers/kubeconfig-builder.ts`

```ts
export interface KubeconfigInputs {
  clusterName: string;
  serverUrl: string;
  caCertBase64: string;
  namespace: string;
  serviceAccountName: string;
  token: string;
}

export function buildKubeconfig(i: KubeconfigInputs): string {
  return [
    'apiVersion: v1',
    'kind: Config',
    `current-context: ${i.clusterName}-cred-proxy`,
    'clusters:',
    `- name: ${i.clusterName}`,
    '  cluster:',
    `    server: ${i.serverUrl}`,
    `    certificate-authority-data: ${i.caCertBase64}`,
    'users:',
    `- name: ${i.serviceAccountName}`,
    '  user:',
    `    token: ${i.token}`,
    'contexts:',
    `- name: ${i.clusterName}-cred-proxy`,
    '  context:',
    `    cluster: ${i.clusterName}`,
    `    user: ${i.serviceAccountName}`,
    `    namespace: ${i.namespace}`,
    '',
  ].join('\n');
}
```

Pure-string builder. No YAML library needed — the shape is fixed and the inputs are validated by the K8s scoper. Snapshot test locks the format.

### `src/cred-proxy/scopers/k8s.ts`

```ts
import * as k8s from '@kubernetes/client-node';
import { randomBytes } from 'node:crypto';
import type { CredentialScoper, Scope } from '../types';
import { K8S_OPERATIONS } from './operation-catalog';
import { buildKubeconfig } from './kubeconfig-builder';

export interface K8sScoperConfig {
  /** Path to the daemon's admin kubeconfig used to issue scoped credentials. */
  readonly adminKubeconfigPath: string;
}

export class K8sCredentialScoper implements CredentialScoper {
  readonly provider = 'k8s' as const;
  constructor(private readonly cfg: K8sScoperConfig) {}

  async scope(operation: string, scope: Scope) {
    const spec = K8S_OPERATIONS[operation];
    if (!spec) throw new Error(`unknown K8s operation: ${operation}`);
    for (const key of spec.requiredScopeKeys) {
      if (!scope[key]) throw new Error(`missing required scope key '${key}' for ${operation}`);
    }

    const kc = new k8s.KubeConfig();
    kc.loadFromFile(this.cfg.adminKubeconfigPath);
    kc.setCurrentContext(scope.cluster!);
    const cluster = kc.getCurrentCluster();
    if (!cluster) throw new Error(`cluster '${scope.cluster}' not in admin kubeconfig`);

    const core = kc.makeApiClient(k8s.CoreV1Api);
    const rbac = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
    const auth = kc.makeApiClient(k8s.AuthenticationV1Api);

    const ns = scope.namespace!;
    const tag = randomBytes(4).toString('hex');                 // collision-resistant suffix
    const saName = `cred-proxy-${operation}-${tag}`;
    const roleName = `${saName}-role`;
    const bindingName = `${saName}-binding`;

    // 1. ServiceAccount in the target namespace.
    await core.createNamespacedServiceAccount(ns, { metadata: { name: saName } });

    // 2. Role with the operation's PolicyRules.
    await rbac.createNamespacedRole(ns, {
      metadata: { name: roleName },
      rules: spec.rules.map((r) => ({ ...r })),
    });

    // 3. RoleBinding tying SA to Role (namespace-scoped, no cluster-wide reach).
    await rbac.createNamespacedRoleBinding(ns, {
      metadata: { name: bindingName },
      subjects: [{ kind: 'ServiceAccount', name: saName, namespace: ns }],
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: roleName },
    });

    // 4. TokenRequest with 900-second expiration.
    const { body: tokenReq } = await auth.createServiceAccountToken(ns, saName as any, {
      apiVersion: 'authentication.k8s.io/v1',
      kind: 'TokenRequest',
      spec: { expirationSeconds: 900, audiences: [cluster.server] },
    } as any);
    const token = tokenReq.status?.token;
    const expirationTimestamp = tokenReq.status?.expirationTimestamp;
    if (!token || !expirationTimestamp) throw new Error('TokenRequest returned no token');

    const caCertBase64 = cluster.caData ?? '';
    const kubeconfig = buildKubeconfig({
      clusterName: scope.cluster!,
      serverUrl: cluster.server,
      caCertBase64,
      namespace: ns,
      serviceAccountName: saName,
      token,
    });

    const expires_at = new Date(expirationTimestamp).toISOString();

    return {
      payload: JSON.stringify({ kubeconfig }),
      expires_at,
      revoke: async () => {
        // Delete in reverse-creation order. Each call is best-effort idempotent (404 ignored).
        await Promise.allSettled([
          rbac.deleteNamespacedRoleBinding(bindingName, ns),
          rbac.deleteNamespacedRole(roleName, ns),
          core.deleteNamespacedServiceAccount(saName, ns),
        ]);
      },
    };
  }
}
```

**Important behavioral notes:**
- The `audiences: [cluster.server]` field constrains the token to be presented only to that API server (defense in depth against token replay against a different cluster).
- `Promise.allSettled` in `revoke()` ensures partial-failure cleanup attempts continue. Any failures are surfaced via the proxy's revoke wrapper (SPEC-024-2-04) to the audit log.
- The 4-byte hex tag in resource names is sufficient for collision-resistance within a 15-minute window across all expected concurrency. Names stay under K8s's 63-char limit.

## Acceptance Criteria

### Operation catalog

- [ ] `AZURE_OPERATIONS['ContainerApps.Deploy']` exists with the documented `roleDefinitionId`, `resourceScope` builder, and `requiredScopeKeys`.
- [ ] `K8S_OPERATIONS['deploy']` exists with the three documented `rules`.
- [ ] Both records are exported as `Readonly<Record<...>>` (TypeScript prevents accidental mutation).

### Azure scoper

- [ ] `scope('ContainerApps.Deploy', { subscriptionId: 'sub1', resourceGroup: 'rg1', appName: 'app1' })` calls `roleAssignments.create` exactly once with: scope `/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.App/containerApps/app1`, the documented role definition ID, and a UUIDv4 assignment name.
- [ ] The same call passes `principalType: 'ServicePrincipal'` and `principalId === cfg.managedIdentityObjectId`.
- [ ] `getToken('https://management.azure.com/.default')` is called exactly once.
- [ ] Returned `payload` parses as JSON with `access_token` and `expires_at`.
- [ ] Returned `expires_at` is exactly 900 seconds from a stable `Date.now()` (fake timers).
- [ ] `revoke()` calls `roleAssignments.delete` with the original `(scope, assignmentName)` pair.
- [ ] `roleAssignments.delete` returning 404 in `revoke()` is treated as success (no error rethrown).
- [ ] Two consecutive `scope` calls produce two distinct `assignmentName` GUIDs (UUIDv4 collision-resistant).
- [ ] `scope('UnknownOp', {})` throws `Error` with message containing `'unknown Azure operation'`.
- [ ] Missing required scope key throws with message containing `"missing required scope key '<key>'"`.

### K8s scoper

- [ ] `scope('deploy', { cluster: 'c1', namespace: 'ns-a' })` results in: (a) ServiceAccount created in `ns-a` with name matching `^cred-proxy-deploy-[0-9a-f]{8}$`, (b) Role created in `ns-a` whose `rules` deep-equals `K8S_OPERATIONS['deploy'].rules`, (c) RoleBinding created in `ns-a` linking the SA to the Role, (d) TokenRequest called with `spec.expirationSeconds === 900` and `audiences[0] === cluster.server`.
- [ ] Returned `payload` parses as JSON with a `kubeconfig` string field.
- [ ] The kubeconfig string contains the `cluster.server` URL, the `caCertBase64`, and the issued `token`.
- [ ] The kubeconfig's `current-context` references the issued ServiceAccount's namespace.
- [ ] `expires_at` matches the TokenRequest's returned `expirationTimestamp` (ISO-8601).
- [ ] `revoke()` calls `deleteNamespacedRoleBinding`, `deleteNamespacedRole`, `deleteNamespacedServiceAccount` once each.
- [ ] If one delete in `revoke()` rejects (e.g., 404), the other deletes still execute (verified by mock call counts after a forced rejection on one of the three).
- [ ] `scope` requesting a `cluster` not present in the admin kubeconfig throws `Error` with message containing `"not in admin kubeconfig"`.
- [ ] TokenRequest returning empty `status.token` throws `Error` with message containing `'no token'`.
- [ ] All resource names produced by the scoper are ≤ 63 characters (K8s limit).

### Kubeconfig builder

- [ ] `buildKubeconfig({clusterName: 'c', serverUrl: 'https://example/', caCertBase64: 'AAA=', namespace: 'n', serviceAccountName: 'sa', token: 'tok'})` produces YAML containing all input values verbatim and no other dynamic content.
- [ ] Snapshot test pinned: any change to the YAML format triggers test failure (intentional — kubeconfig consumers depend on shape stability).
- [ ] The output ends with a trailing newline (POSIX file convention).

### Both

- [ ] Both scopers implement `CredentialScoper` from SPEC-024-2-01 (TypeScript assignment compiles).
- [ ] Both classes accept their SDK clients via constructor for test injection (no lazy SDK instantiation inside `scope`).
- [ ] Coverage ≥ 95% per file.

## Dependencies

- SPEC-024-2-01 — provides `CredentialScoper`, `Scope` types.
- SPEC-024-2-02 — extends `operation-catalog.ts` (additive only; no conflicts).
- `@azure/identity` (Managed Identity flow), `@azure/arm-authorization` (role assignments).
- `@kubernetes/client-node` (CoreV1, RbacAuthorizationV1, AuthenticationV1 APIs).
- Cluster prerequisites (operator-side, not enforced by code):
  - **K8s ≥ 1.22** for the TokenRequest API (PLAN-024-2 risk register documents this).
  - The admin kubeconfig at `cfg.adminKubeconfigPath` must have permission to create ServiceAccounts, Roles, RoleBindings, and TokenRequests in the target namespaces.
  - **Azure**: the daemon's Managed Identity must hold `Microsoft.Authorization/roleAssignments/write` on the target resource scopes.

## Notes

- **Azure RBAC propagation lag:** Azure's RBAC evaluation is eventually consistent (typically 30-60s). When `revoke()` returns, the role assignment is gone from the control plane immediately, but in-flight or recently-cached authorization decisions may briefly continue to succeed. Callers MUST stop using the credential at the audit-revocation event; the cloud's eventual consistency is a defense-in-depth caveat, not the primary scope-enforcement mechanism. Documented in the operator guide (separate spec).
- **K8s token audience binding:** Setting `audiences: [cluster.server]` makes the token a "projected" token usable only against that API server. This is a hardening measure: even if the token leaks, it cannot be used against other clusters that share the same OIDC issuer.
- **Why not `expirationSeconds` on Azure tokens:** Azure's Managed Identity tokens come with a fixed cloud-side TTL (~60-90 minutes); there is no per-token lifetime knob. The role assignment is the truth-source for "is this credential authorized." This asymmetry with AWS/GCP/K8s (all of which support per-token TTL) is intentionally surfaced in the audit events as `provider: 'azure'` so downstream observability can apply Azure-specific reasoning.
- **kubeconfig is YAML, not JSON:** The K8s ecosystem expects kubeconfig in YAML. Building it as a string template (rather than using `yaml`/`js-yaml`) avoids a runtime dependency for a fixed-shape document.
- **No K8s integration test here:** The kind-cluster test is in SPEC-024-2-05 (covers both unit and the kind-based scope-enforcement test in one place to keep test infrastructure setup isolated).
- **No Azure integration test:** Azure has no equivalent of kind. Manual smoke-tests at release time (PLAN-024-2 §Testing Strategy) cover Azure end-to-end against a real subscription. The unit tests in this spec lock in the SDK-call shape via mocks.
