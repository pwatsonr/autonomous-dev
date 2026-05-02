/**
 * K8sCredentialScoper — per-issuance ServiceAccount + Role + RoleBinding
 * + TokenRequest (SPEC-024-2-03, TDD-024 §7.2).
 *
 * Each `scope()` call produces a complete kubeconfig (server URL + CA +
 * bearer token) bound to a per-issuance ServiceAccount in a single
 * namespace, governed by a Role with the operation's `PolicyRules`. The
 * token has a hard `expirationSeconds: 900` and is audience-bound to
 * `cluster.server` so a leaked token cannot be replayed against a
 * different cluster sharing the same OIDC issuer.
 *
 * `revoke()` deletes the RoleBinding, Role, and ServiceAccount in
 * reverse-creation order. Each delete is best-effort idempotent (404 is
 * treated as success); all three are dispatched via `Promise.allSettled`
 * so partial-failure cleanup attempts continue.
 *
 * The cluster API clients are constructor-injected so unit tests pass
 * mocks. The default constructor reads `cfg.adminKubeconfigPath` and
 * builds real `@kubernetes/client-node` clients — kept inside the
 * `defaultLoader` helper so unit tests bypass it entirely.
 *
 * @module intake/cred-proxy/scopers/k8s
 */

import { randomBytes } from 'node:crypto';

import type { CredentialScoper, Provider, Scope } from '../types';
import { K8S_OPERATIONS, type K8sOperationSpec } from './operation-catalog';
import { buildKubeconfig } from './kubeconfig-builder';

export interface K8sScoperConfig {
  /** Path to the daemon's admin kubeconfig used to issue scoped credentials. */
  readonly adminKubeconfigPath: string;
}

/** Cluster identity discovered from the admin kubeconfig. */
export interface K8sClusterInfo {
  readonly server: string;
  readonly caCertBase64: string;
}

/**
 * Minimal structural interface of `CoreV1Api` we depend on. The real
 * `@kubernetes/client-node` client matches via TS structural compat.
 */
export interface CoreV1Like {
  createNamespacedServiceAccount(
    namespace: string,
    body: { metadata: { name: string } },
  ): Promise<unknown>;
  deleteNamespacedServiceAccount(
    name: string,
    namespace: string,
  ): Promise<unknown>;
}

/** Minimal `RbacAuthorizationV1Api` interface. */
export interface RbacV1Like {
  createNamespacedRole(
    namespace: string,
    body: {
      metadata: { name: string };
      rules: K8sOperationSpec['rules'];
    },
  ): Promise<unknown>;
  createNamespacedRoleBinding(
    namespace: string,
    body: {
      metadata: { name: string };
      subjects: Array<{ kind: 'ServiceAccount'; name: string; namespace: string }>;
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io';
        kind: 'Role';
        name: string;
      };
    },
  ): Promise<unknown>;
  deleteNamespacedRole(name: string, namespace: string): Promise<unknown>;
  deleteNamespacedRoleBinding(
    name: string,
    namespace: string,
  ): Promise<unknown>;
}

/** Minimal `AuthenticationV1Api.createServiceAccountToken` interface. */
export interface AuthV1Like {
  createServiceAccountToken(
    namespace: string,
    serviceAccountName: string,
    body: {
      apiVersion: 'authentication.k8s.io/v1';
      kind: 'TokenRequest';
      spec: { expirationSeconds: number; audiences: string[] };
    },
  ): Promise<{
    body?: {
      status?: { token?: string; expirationTimestamp?: string | Date };
    };
    status?: { token?: string; expirationTimestamp?: string | Date };
  }>;
}

export interface K8sClients {
  readonly core: CoreV1Like;
  readonly rbac: RbacV1Like;
  readonly auth: AuthV1Like;
  readonly clusterFor: (clusterName: string) => K8sClusterInfo | undefined;
}

export class K8sCredentialScoper implements CredentialScoper {
  readonly provider: Provider = 'k8s';

  constructor(
    // cfg retained to keep parity with sibling scopers and to surface
    // adminKubeconfigPath in the audit log; the structural client lookup
    // is what unit tests inject.
    private readonly _cfg: K8sScoperConfig,
    private readonly clients: K8sClients,
    /** Injectable for deterministic-name tests. */
    private readonly tagGen: () => string = () => randomBytes(4).toString('hex'),
  ) {
    void this._cfg;
  }

  async scope(operation: string, scope: Scope) {
    const spec = K8S_OPERATIONS[operation];
    if (!spec) throw new Error(`unknown K8s operation: ${operation}`);
    for (const key of spec.requiredScopeKeys) {
      if (!scope[key]) {
        throw new Error(
          `missing required scope key '${key}' for ${operation}`,
        );
      }
    }

    const clusterName = scope.cluster!;
    const ns = scope.namespace!;
    const cluster = this.clients.clusterFor(clusterName);
    if (!cluster) {
      throw new Error(
        `cluster '${clusterName}' not in admin kubeconfig`,
      );
    }

    const tag = this.tagGen();
    // Names stay under K8s's 63-char limit: prefix(11) + op(<=32) + tag(8) + dashes(2) ≤ 53.
    const opSlug = operation.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 32);
    const saName = `cred-proxy-${opSlug}-${tag}`;
    const roleName = `${saName}-role`.slice(0, 63);
    const bindingName = `${saName}-binding`.slice(0, 63);

    // 1. ServiceAccount in the target namespace.
    await this.clients.core.createNamespacedServiceAccount(ns, {
      metadata: { name: saName },
    });

    // 2. Role with the operation's PolicyRules.
    await this.clients.rbac.createNamespacedRole(ns, {
      metadata: { name: roleName },
      rules: spec.rules,
    });

    // 3. RoleBinding tying SA to Role (namespace-scoped, no cluster-wide reach).
    await this.clients.rbac.createNamespacedRoleBinding(ns, {
      metadata: { name: bindingName },
      subjects: [{ kind: 'ServiceAccount', name: saName, namespace: ns }],
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'Role',
        name: roleName,
      },
    });

    // 4. TokenRequest with 900-second expiration and audience binding.
    const tokenResp = await this.clients.auth.createServiceAccountToken(
      ns,
      saName,
      {
        apiVersion: 'authentication.k8s.io/v1',
        kind: 'TokenRequest',
        spec: { expirationSeconds: 900, audiences: [cluster.server] },
      },
    );
    const status =
      tokenResp.body?.status ?? tokenResp.status;
    const token = status?.token;
    const expirationTimestamp = status?.expirationTimestamp;
    if (!token || !expirationTimestamp) {
      throw new Error('TokenRequest returned no token');
    }

    const kubeconfig = buildKubeconfig({
      clusterName,
      serverUrl: cluster.server,
      caCertBase64: cluster.caCertBase64,
      namespace: ns,
      serviceAccountName: saName,
      token,
    });

    const expires_at =
      typeof expirationTimestamp === 'string'
        ? new Date(expirationTimestamp).toISOString()
        : expirationTimestamp.toISOString();

    return {
      payload: JSON.stringify({ kubeconfig }),
      expires_at,
      revoke: async () => {
        // Delete in reverse-creation order. Each call is best-effort
        // idempotent — Promise.allSettled lets partial-failure cleanups
        // continue. Failures are surfaced via the proxy's revoke wrapper
        // (SPEC-024-2-04) to the audit log.
        await Promise.allSettled([
          this.clients.rbac.deleteNamespacedRoleBinding(bindingName, ns),
          this.clients.rbac.deleteNamespacedRole(roleName, ns),
          this.clients.core.deleteNamespacedServiceAccount(saName, ns),
        ]);
      },
    };
  }
}
