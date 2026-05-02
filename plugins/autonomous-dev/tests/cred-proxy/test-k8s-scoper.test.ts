/**
 * K8sCredentialScoper unit tests (SPEC-024-2-03).
 */

import {
  K8sCredentialScoper,
  type AuthV1Like,
  type CoreV1Like,
  type K8sClients,
  type K8sClusterInfo,
  type RbacV1Like,
} from '../../intake/cred-proxy/scopers/k8s';

interface FakeState {
  serviceAccountsCreated: Array<{ ns: string; name: string }>;
  serviceAccountsDeleted: Array<{ ns: string; name: string }>;
  rolesCreated: Array<{ ns: string; name: string; rules: unknown }>;
  rolesDeleted: Array<{ ns: string; name: string }>;
  bindingsCreated: Array<{
    ns: string;
    name: string;
    subjects: unknown;
    roleRef: unknown;
  }>;
  bindingsDeleted: Array<{ ns: string; name: string }>;
  tokenRequests: Array<{
    ns: string;
    sa: string;
    expirationSeconds: number;
    audiences: string[];
  }>;
  /** Force the Nth delete (1-indexed across binding/role/SA order) to reject. */
  rejectDeletes: { binding?: unknown; role?: unknown; sa?: unknown };
  tokenResponse: {
    token?: string;
    expirationTimestamp?: string | Date;
  };
  /** When true, body is on `.body`; when false, on top-level. */
  bodyShape: 'body' | 'flat';
}

function makeClients(clusters: Record<string, K8sClusterInfo>): {
  clients: K8sClients;
  state: FakeState;
} {
  const state: FakeState = {
    serviceAccountsCreated: [],
    serviceAccountsDeleted: [],
    rolesCreated: [],
    rolesDeleted: [],
    bindingsCreated: [],
    bindingsDeleted: [],
    tokenRequests: [],
    rejectDeletes: {},
    tokenResponse: {
      token: 'k8s-tok',
      expirationTimestamp: '2030-01-01T00:00:00.000Z',
    },
    bodyShape: 'body',
  };
  const core: CoreV1Like = {
    async createNamespacedServiceAccount(ns, body) {
      state.serviceAccountsCreated.push({ ns, name: body.metadata.name });
      return undefined;
    },
    async deleteNamespacedServiceAccount(name, ns) {
      if (state.rejectDeletes.sa) throw state.rejectDeletes.sa;
      state.serviceAccountsDeleted.push({ ns, name });
      return undefined;
    },
  };
  const rbac: RbacV1Like = {
    async createNamespacedRole(ns, body) {
      state.rolesCreated.push({
        ns,
        name: body.metadata.name,
        rules: body.rules,
      });
      return undefined;
    },
    async createNamespacedRoleBinding(ns, body) {
      state.bindingsCreated.push({
        ns,
        name: body.metadata.name,
        subjects: body.subjects,
        roleRef: body.roleRef,
      });
      return undefined;
    },
    async deleteNamespacedRole(name, ns) {
      if (state.rejectDeletes.role) throw state.rejectDeletes.role;
      state.rolesDeleted.push({ ns, name });
      return undefined;
    },
    async deleteNamespacedRoleBinding(name, ns) {
      if (state.rejectDeletes.binding) throw state.rejectDeletes.binding;
      state.bindingsDeleted.push({ ns, name });
      return undefined;
    },
  };
  const auth: AuthV1Like = {
    async createServiceAccountToken(ns, sa, body) {
      state.tokenRequests.push({
        ns,
        sa,
        expirationSeconds: body.spec.expirationSeconds,
        audiences: body.spec.audiences,
      });
      const status = state.tokenResponse;
      return state.bodyShape === 'body'
        ? { body: { status } }
        : { status };
    },
  };
  const clients: K8sClients = {
    core,
    rbac,
    auth,
    clusterFor: (n) => clusters[n],
  };
  return { clients, state };
}

const cfg = { adminKubeconfigPath: '/dev/null' };
const CLUSTER: K8sClusterInfo = {
  server: 'https://api.k8s.example:6443',
  caCertBase64: 'BASE64CADATA==',
};
const SCOPE = { cluster: 'c1', namespace: 'app-ns' };

describe('K8sCredentialScoper.scope', () => {
  it('creates ServiceAccount, Role, RoleBinding, and TokenRequest with correct shape', async () => {
    const { clients, state } = makeClients({ c1: CLUSTER });
    const scoper = new K8sCredentialScoper(cfg, clients, () => 'abcd1234');
    const out = await scoper.scope('deploy', SCOPE);

    expect(state.serviceAccountsCreated).toEqual([
      { ns: 'app-ns', name: 'cred-proxy-deploy-abcd1234' },
    ]);
    expect(state.rolesCreated).toHaveLength(1);
    expect(state.rolesCreated[0].ns).toBe('app-ns');
    expect(state.rolesCreated[0].name).toBe(
      'cred-proxy-deploy-abcd1234-role',
    );
    expect(state.rolesCreated[0].rules).toEqual([
      {
        apiGroups: ['apps'],
        resources: ['deployments'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
      {
        apiGroups: [''],
        resources: ['services', 'configmaps'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
      {
        apiGroups: [''],
        resources: ['pods'],
        verbs: ['get', 'list', 'watch'],
      },
    ]);
    expect(state.bindingsCreated[0]).toEqual({
      ns: 'app-ns',
      name: 'cred-proxy-deploy-abcd1234-binding',
      subjects: [
        {
          kind: 'ServiceAccount',
          name: 'cred-proxy-deploy-abcd1234',
          namespace: 'app-ns',
        },
      ],
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'Role',
        name: 'cred-proxy-deploy-abcd1234-role',
      },
    });
    expect(state.tokenRequests).toEqual([
      {
        ns: 'app-ns',
        sa: 'cred-proxy-deploy-abcd1234',
        expirationSeconds: 900,
        audiences: ['https://api.k8s.example:6443'],
      },
    ]);
    expect(out.expires_at).toBe('2030-01-01T00:00:00.000Z');
  });

  it('returns kubeconfig containing cluster server, CA, and token', async () => {
    const { clients } = makeClients({ c1: CLUSTER });
    const scoper = new K8sCredentialScoper(cfg, clients, () => 'feedface');
    const out = await scoper.scope('deploy', SCOPE);
    const payload = JSON.parse(out.payload) as { kubeconfig: string };
    expect(payload.kubeconfig).toContain('https://api.k8s.example:6443');
    expect(payload.kubeconfig).toContain('BASE64CADATA==');
    expect(payload.kubeconfig).toContain('k8s-tok');
    expect(payload.kubeconfig).toContain('namespace: app-ns');
    expect(payload.kubeconfig).toContain('current-context: c1-cred-proxy');
  });

  it('SA name matches ^cred-proxy-deploy-[0-9a-f]{8}$', async () => {
    const { clients, state } = makeClients({ c1: CLUSTER });
    const scoper = new K8sCredentialScoper(cfg, clients);
    await scoper.scope('deploy', SCOPE);
    expect(state.serviceAccountsCreated[0].name).toMatch(
      /^cred-proxy-deploy-[0-9a-f]{8}$/,
    );
  });

  it('all created resource names are ≤ 63 characters', async () => {
    const { clients, state } = makeClients({ c1: CLUSTER });
    const scoper = new K8sCredentialScoper(cfg, clients);
    await scoper.scope('deploy', SCOPE);
    expect(state.serviceAccountsCreated[0].name.length).toBeLessThanOrEqual(63);
    expect(state.rolesCreated[0].name.length).toBeLessThanOrEqual(63);
    expect(state.bindingsCreated[0].name.length).toBeLessThanOrEqual(63);
  });

  it('accepts top-level status (no .body wrapper) for newer client versions', async () => {
    const { clients, state } = makeClients({ c1: CLUSTER });
    state.bodyShape = 'flat';
    const scoper = new K8sCredentialScoper(cfg, clients);
    const out = await scoper.scope('deploy', SCOPE);
    expect(out.expires_at).toBe('2030-01-01T00:00:00.000Z');
  });

  it('accepts a Date expirationTimestamp', async () => {
    const { clients, state } = makeClients({ c1: CLUSTER });
    state.tokenResponse = {
      token: 'k8s-tok',
      expirationTimestamp: new Date('2030-06-01T12:00:00.000Z'),
    };
    const scoper = new K8sCredentialScoper(cfg, clients);
    const out = await scoper.scope('deploy', SCOPE);
    expect(out.expires_at).toBe('2030-06-01T12:00:00.000Z');
  });

  it('throws when cluster is not in admin kubeconfig', async () => {
    const { clients } = makeClients({});
    const scoper = new K8sCredentialScoper(cfg, clients);
    await expect(scoper.scope('deploy', SCOPE)).rejects.toThrow(
      /not in admin kubeconfig/,
    );
  });

  it('throws when TokenRequest returns empty token', async () => {
    const { clients, state } = makeClients({ c1: CLUSTER });
    state.tokenResponse = {
      token: '',
      expirationTimestamp: '2030-01-01T00:00:00.000Z',
    };
    const scoper = new K8sCredentialScoper(cfg, clients);
    await expect(scoper.scope('deploy', SCOPE)).rejects.toThrow(/no token/);
  });

  it('throws on unknown operation', async () => {
    const { clients } = makeClients({ c1: CLUSTER });
    const scoper = new K8sCredentialScoper(cfg, clients);
    await expect(scoper.scope('UnknownOp', SCOPE)).rejects.toThrow(
      /unknown K8s operation/,
    );
  });

  it('throws when a required scope key is missing', async () => {
    const { clients } = makeClients({ c1: CLUSTER });
    const scoper = new K8sCredentialScoper(cfg, clients);
    await expect(
      scoper.scope('deploy', { cluster: 'c1' } as Record<string, string>),
    ).rejects.toThrow(/missing required scope key 'namespace'/);
  });

  it('revoke() deletes binding, role, and SA exactly once each', async () => {
    const { clients, state } = makeClients({ c1: CLUSTER });
    const scoper = new K8sCredentialScoper(cfg, clients);
    const out = await scoper.scope('deploy', SCOPE);
    await out.revoke();
    expect(state.bindingsDeleted).toHaveLength(1);
    expect(state.rolesDeleted).toHaveLength(1);
    expect(state.serviceAccountsDeleted).toHaveLength(1);
  });

  it('revoke() continues other deletes when one rejects (best-effort)', async () => {
    const { clients, state } = makeClients({ c1: CLUSTER });
    const scoper = new K8sCredentialScoper(cfg, clients);
    const out = await scoper.scope('deploy', SCOPE);
    state.rejectDeletes.role = new Error('boom');
    await out.revoke();
    expect(state.bindingsDeleted).toHaveLength(1);
    expect(state.rolesDeleted).toHaveLength(0);
    expect(state.serviceAccountsDeleted).toHaveLength(1);
  });

  it('exposes provider="k8s" and is structurally a CredentialScoper', () => {
    const { clients } = makeClients({ c1: CLUSTER });
    const scoper = new K8sCredentialScoper(cfg, clients);
    expect(scoper.provider).toBe('k8s');
    expect(typeof scoper.scope).toBe('function');
  });
});
