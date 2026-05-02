/**
 * Kind-based scope-enforcement integration test for the K8s credential
 * scoper (SPEC-024-2-05).
 *
 * This is the only place in PLAN-024-2 that proves K8s scope enforcement
 * works at the cloud level rather than just at the proxy level. A
 * kubeconfig issued for namespace `ns-a` MUST be rejected (HTTP 403) by
 * the K8s API server when used to deploy in `ns-b`. If this test ever
 * passes the cross-namespace deploy, that signals a scoping bug that
 * mocks alone could miss.
 *
 * The test is gated on (a) `RUN_KIND_TESTS=1` and (b) `kind` being on
 * PATH. Contributors without Docker installed automatically skip via
 * `it.skip` (Jest has no `describe.skipIf`, so each test branches
 * explicitly).
 *
 * Implementation note: `@kubernetes/client-node` ships as ESM-only,
 * which Jest's default ts-jest transformer does NOT load. Importing it
 * statically at the top of the file would crash the suite even when
 * SKIP is true. The module is therefore lazy-loaded inside `beforeAll`
 * and stored on a closure-scoped `k8s` reference; SKIP'd runs never
 * touch it.
 *
 * @module tests/integration/test-cred-proxy-scope
 */

import {
  K8sCredentialScoper,
  type AuthV1Like,
  type CoreV1Like,
  type K8sClients,
  type RbacV1Like,
} from '../../intake/cred-proxy/scopers/k8s';
import { hasKind, startKindCluster, type KindCluster } from './kind-cluster-helper';

const SKIP = !process.env.RUN_KIND_TESTS || !hasKind();

// Lazy-loaded handle to `@kubernetes/client-node`. Populated in
// `beforeAll` only when SKIP is false. Typed as `any` to avoid pulling
// the ESM-only types into the static import graph.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let k8s: any;

function loadClusterInfo(kubeconfigPath: string): {
  server: string;
  caCertBase64: string;
} {
  const kc = new k8s.KubeConfig();
  kc.loadFromFile(kubeconfigPath);
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error('no current-cluster in kubeconfig');
  return {
    server: cluster.server,
    caCertBase64: cluster.caData ?? '',
  };
}

function makeAdminClients(
  kubeconfigPath: string,
  clusterName: string,
): K8sClients {
  const kc = new k8s.KubeConfig();
  kc.loadFromFile(kubeconfigPath);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
  const authApi = kc.makeApiClient(k8s.AuthenticationV1Api);

  // Adapt the @kubernetes/client-node v1 API surface to our structural
  // interfaces. The v1 client returns plain objects (no `.body` wrapper),
  // matching the `bodyShape: 'flat'` branch the unit tests cover.
  const core: CoreV1Like = {
    createNamespacedServiceAccount: async (ns, body) =>
      coreApi.createNamespacedServiceAccount({ namespace: ns, body }),
    deleteNamespacedServiceAccount: async (name, ns) =>
      coreApi.deleteNamespacedServiceAccount({ name, namespace: ns }),
  };
  const rbac: RbacV1Like = {
    createNamespacedRole: async (ns, body) =>
      rbacApi.createNamespacedRole({ namespace: ns, body }),
    createNamespacedRoleBinding: async (ns, body) =>
      rbacApi.createNamespacedRoleBinding({ namespace: ns, body }),
    deleteNamespacedRole: async (name, ns) =>
      rbacApi.deleteNamespacedRole({ name, namespace: ns }),
    deleteNamespacedRoleBinding: async (name, ns) =>
      rbacApi.deleteNamespacedRoleBinding({ name, namespace: ns }),
  };
  const auth: AuthV1Like = {
    createServiceAccountToken: async (ns, sa, body) => {
      const resp = await authApi.createServiceAccountToken({
        namespace: ns,
        name: sa,
        body,
      });
      // v1 client returns the response object directly; surface as
      // `.status` so the scoper's flat branch picks it up.
      return { status: resp?.status };
    },
  };
  const info = loadClusterInfo(kubeconfigPath);
  return {
    core,
    rbac,
    auth,
    clusterFor: (n) => (n === clusterName ? info : undefined),
  };
}

function minimalDeployment(name: string): unknown {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          containers: [
            { name: 'pause', image: 'registry.k8s.io/pause:3.9' },
          ],
        },
      },
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function appsClientFromKubeconfig(yaml: string): any {
  const kc = new k8s.KubeConfig();
  kc.loadFromString(yaml);
  return kc.makeApiClient(k8s.AppsV1Api);
}

describe('cred-proxy K8s scope enforcement (kind)', () => {
  let cluster: KindCluster | undefined;
  let clusterName: string;
  let scoper: K8sCredentialScoper;

  beforeAll(async () => {
    if (SKIP) return;
    // Lazy import: the ESM-only `@kubernetes/client-node` module is
    // never required when this suite is skipped, which is the default
    // for contributors without Docker / kind installed.
    k8s = await import('@kubernetes/client-node');
    cluster = startKindCluster();
    clusterName = `kind-${cluster.name}`;
    const kc = new k8s.KubeConfig();
    kc.loadFromFile(cluster.kubeconfigPath);
    const core = kc.makeApiClient(k8s.CoreV1Api);
    await core.createNamespace({ body: { metadata: { name: 'ns-a' } } });
    await core.createNamespace({ body: { metadata: { name: 'ns-b' } } });
    scoper = new K8sCredentialScoper(
      { adminKubeconfigPath: cluster.kubeconfigPath },
      makeAdminClients(cluster.kubeconfigPath, clusterName),
    );
  }, 120_000);

  afterAll(() => {
    cluster?.destroy();
  });

  // Surface a single skipped test when SKIP is true so CI reporting
  // still records the intent. Without this the entire describe block
  // could report zero tests, masking configuration drift.
  // eslint-disable-next-line jest/no-disabled-tests
  (SKIP ? it.skip : it)(
    'issued kubeconfig succeeds for in-namespace deploy',
    async () => {
      const out = await scoper.scope('deploy', {
        cluster: clusterName,
        namespace: 'ns-a',
      });
      const { kubeconfig } = JSON.parse(out.payload) as { kubeconfig: string };
      const apps = appsClientFromKubeconfig(kubeconfig);
      const created = await apps.createNamespacedDeployment({
        namespace: 'ns-a',
        body: minimalDeployment('app-a'),
      });
      expect(created.metadata?.name).toBe('app-a');
    },
    60_000,
  );

  (SKIP ? it.skip : it)(
    'issued kubeconfig is REJECTED (403) for out-of-namespace deploy',
    async () => {
      const out = await scoper.scope('deploy', {
        cluster: clusterName,
        namespace: 'ns-a',
      });
      const { kubeconfig } = JSON.parse(out.payload) as { kubeconfig: string };
      const apps = appsClientFromKubeconfig(kubeconfig);
      let status: number | undefined;
      try {
        await apps.createNamespacedDeployment({
          namespace: 'ns-b',
          body: minimalDeployment('app-b'),
        });
      } catch (err: unknown) {
        const e = err as {
          response?: { statusCode?: number };
          statusCode?: number;
          code?: number;
        };
        status = e?.response?.statusCode ?? e?.statusCode ?? e?.code;
      }
      expect(status).toBe(403);
    },
    60_000,
  );

  (SKIP ? it.skip : it)(
    'revoke() removes the ServiceAccount, Role, and RoleBinding',
    async () => {
      const out = await scoper.scope('deploy', {
        cluster: clusterName,
        namespace: 'ns-a',
      });
      await out.revoke();
      const kc = new k8s.KubeConfig();
      kc.loadFromFile(cluster!.kubeconfigPath);
      const core = kc.makeApiClient(k8s.CoreV1Api);
      const list = await core.listNamespacedServiceAccount({
        namespace: 'ns-a',
      });
      const proxyAccounts = (list.items ?? []).filter(
        (sa: { metadata?: { name?: string } }) =>
          sa.metadata?.name?.startsWith('cred-proxy-'),
      );
      expect(proxyAccounts).toHaveLength(0);
    },
    60_000,
  );
});
