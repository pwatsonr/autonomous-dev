/**
 * AzureCredentialScoper unit tests (SPEC-024-2-03).
 *
 * Mocks Azure SDK clients via the `RoleAssignmentsLike` and
 * `AzureCredentialLike` structural interfaces from the scoper module.
 */

import {
  AzureCredentialScoper,
  type AzureCredentialLike,
  type RoleAssignmentsLike,
} from '../../intake/cred-proxy/scopers/azure';

interface CreatedAssignment {
  scope: string;
  name: string;
  parameters: {
    roleDefinitionId: string;
    principalId: string;
    principalType: 'ServicePrincipal';
  };
}

interface FakeRoleAssignmentsState {
  created: CreatedAssignment[];
  deleted: Array<{ scope: string; name: string }>;
  /** When set, next delete call rejects with this error. */
  nextDeleteError: unknown | null;
}

function makeRoleAssignments(): {
  client: RoleAssignmentsLike;
  state: FakeRoleAssignmentsState;
} {
  const state: FakeRoleAssignmentsState = {
    created: [],
    deleted: [],
    nextDeleteError: null,
  };
  const client: RoleAssignmentsLike = {
    async create(scope, name, parameters) {
      state.created.push({ scope, name, parameters });
      return undefined;
    },
    async delete(scope, name) {
      if (state.nextDeleteError) {
        const e = state.nextDeleteError;
        state.nextDeleteError = null;
        throw e;
      }
      state.deleted.push({ scope, name });
      return undefined;
    },
  };
  return { client, state };
}

function makeCred(token: string | null = 'azure-token'): {
  cred: AzureCredentialLike;
  calls: number;
  lastScopes: string | string[] | null;
} {
  const ctx: { calls: number; lastScopes: string | string[] | null } = {
    calls: 0,
    lastScopes: null,
  };
  const cred: AzureCredentialLike = {
    async getToken(scopes) {
      ctx.calls += 1;
      ctx.lastScopes = scopes;
      return token === null ? null : { token };
    },
  };
  return Object.assign(ctx, { cred });
}

const cfg = {
  subscriptionId: 'sub1',
  managedIdentityObjectId: 'mi-object-id',
};

const VALID = {
  subscriptionId: 'sub1',
  resourceGroup: 'rg1',
  appName: 'app1',
};

describe('AzureCredentialScoper.scope', () => {
  it('creates a role assignment with the documented scope and parameters', async () => {
    const ra = makeRoleAssignments();
    const cred = makeCred();
    const scoper = new AzureCredentialScoper(
      cfg,
      ra.client,
      cred.cred,
      () => 1_700_000_000_000,
      () => 'fixed-uuid',
    );
    await scoper.scope('ContainerApps.Deploy', VALID);
    expect(ra.state.created).toHaveLength(1);
    const created = ra.state.created[0];
    expect(created.scope).toBe(
      '/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.App/containerApps/app1',
    );
    expect(created.name).toBe('fixed-uuid');
    expect(created.parameters.roleDefinitionId).toBe(
      '/providers/Microsoft.Authorization/roleDefinitions/b24988ac-6180-42a0-ab88-20f7382dd24c',
    );
    expect(created.parameters.principalId).toBe('mi-object-id');
    expect(created.parameters.principalType).toBe('ServicePrincipal');
  });

  it('mints an ARM-scope token exactly once', async () => {
    const ra = makeRoleAssignments();
    const cred = makeCred();
    const scoper = new AzureCredentialScoper(cfg, ra.client, cred.cred);
    await scoper.scope('ContainerApps.Deploy', VALID);
    expect(cred.calls).toBe(1);
    expect(cred.lastScopes).toBe('https://management.azure.com/.default');
  });

  it('returns expires_at exactly 900s from injected now()', async () => {
    const ra = makeRoleAssignments();
    const cred = makeCred();
    const NOW = 1_700_000_000_000;
    const scoper = new AzureCredentialScoper(cfg, ra.client, cred.cred, () => NOW);
    const out = await scoper.scope('ContainerApps.Deploy', VALID);
    expect(out.expires_at).toBe(new Date(NOW + 900_000).toISOString());
    const payload = JSON.parse(out.payload);
    expect(payload.access_token).toBe('azure-token');
    expect(payload.expires_at).toBe(out.expires_at);
  });

  it('revoke() deletes the role assignment by (scope, assignmentName)', async () => {
    const ra = makeRoleAssignments();
    const cred = makeCred();
    const scoper = new AzureCredentialScoper(
      cfg,
      ra.client,
      cred.cred,
      () => 0,
      () => 'asn-uuid-xyz',
    );
    const out = await scoper.scope('ContainerApps.Deploy', VALID);
    await out.revoke();
    expect(ra.state.deleted).toEqual([
      {
        scope:
          '/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.App/containerApps/app1',
        name: 'asn-uuid-xyz',
      },
    ]);
  });

  it("revoke() treats 404 as success (idempotent)", async () => {
    const ra = makeRoleAssignments();
    const cred = makeCred();
    const scoper = new AzureCredentialScoper(cfg, ra.client, cred.cred);
    const out = await scoper.scope('ContainerApps.Deploy', VALID);
    ra.state.nextDeleteError = { statusCode: 404, message: 'NotFound' };
    await expect(out.revoke()).resolves.toBeUndefined();
  });

  it('revoke() treats RoleAssignmentNotFound code as success', async () => {
    const ra = makeRoleAssignments();
    const cred = makeCred();
    const scoper = new AzureCredentialScoper(cfg, ra.client, cred.cred);
    const out = await scoper.scope('ContainerApps.Deploy', VALID);
    ra.state.nextDeleteError = {
      code: 'NotFound',
      message: 'RoleAssignmentNotFound: it is gone',
    };
    await expect(out.revoke()).resolves.toBeUndefined();
  });

  it('revoke() propagates non-404 errors', async () => {
    const ra = makeRoleAssignments();
    const cred = makeCred();
    const scoper = new AzureCredentialScoper(cfg, ra.client, cred.cred);
    const out = await scoper.scope('ContainerApps.Deploy', VALID);
    ra.state.nextDeleteError = { statusCode: 500, message: 'server error' };
    await expect(out.revoke()).rejects.toMatchObject({ statusCode: 500 });
  });

  it('two consecutive scopes produce distinct assignment names', async () => {
    const ra = makeRoleAssignments();
    const cred = makeCred();
    let i = 0;
    const scoper = new AzureCredentialScoper(
      cfg,
      ra.client,
      cred.cred,
      () => 0,
      () => `uuid-${i++}`,
    );
    await scoper.scope('ContainerApps.Deploy', VALID);
    await scoper.scope('ContainerApps.Deploy', VALID);
    expect(ra.state.created[0].name).not.toBe(ra.state.created[1].name);
  });

  it('default genId() returns RFC-4122 UUIDs', async () => {
    const ra = makeRoleAssignments();
    const cred = makeCred();
    const scoper = new AzureCredentialScoper(cfg, ra.client, cred.cred);
    await scoper.scope('ContainerApps.Deploy', VALID);
    const name = ra.state.created[0].name;
    expect(name).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('throws when ManagedIdentityCredential returns null', async () => {
    const ra = makeRoleAssignments();
    const cred = makeCred(null);
    const scoper = new AzureCredentialScoper(cfg, ra.client, cred.cred);
    await expect(scoper.scope('ContainerApps.Deploy', VALID)).rejects.toThrow(
      /no token/,
    );
  });

  it('throws on unknown operation', async () => {
    const ra = makeRoleAssignments();
    const cred = makeCred();
    const scoper = new AzureCredentialScoper(cfg, ra.client, cred.cred);
    await expect(scoper.scope('UnknownOp', {})).rejects.toThrow(
      /unknown Azure operation/,
    );
  });

  it('throws when a required scope key is missing', async () => {
    const ra = makeRoleAssignments();
    const cred = makeCred();
    const scoper = new AzureCredentialScoper(cfg, ra.client, cred.cred);
    await expect(
      scoper.scope('ContainerApps.Deploy', {
        subscriptionId: 'sub1',
        resourceGroup: 'rg1',
      } as Record<string, string>),
    ).rejects.toThrow(/missing required scope key 'appName'/);
  });

  it('revoke() treats message-only "404" as success', async () => {
    const ra = makeRoleAssignments();
    const cred = makeCred();
    const scoper = new AzureCredentialScoper(cfg, ra.client, cred.cred);
    const out = await scoper.scope('ContainerApps.Deploy', VALID);
    // Neither statusCode nor code, but message matches the regex.
    ra.state.nextDeleteError = { message: 'request returned 404 from server' };
    await expect(out.revoke()).resolves.toBeUndefined();
  });

  it('revoke() treats numeric code 404 as success', async () => {
    const ra = makeRoleAssignments();
    const cred = makeCred();
    const scoper = new AzureCredentialScoper(cfg, ra.client, cred.cred);
    const out = await scoper.scope('ContainerApps.Deploy', VALID);
    ra.state.nextDeleteError = { code: 404, message: 'gone' };
    await expect(out.revoke()).resolves.toBeUndefined();
  });

  it('revoke() propagates non-object errors as-is', async () => {
    const ra = makeRoleAssignments();
    const cred = makeCred();
    const scoper = new AzureCredentialScoper(cfg, ra.client, cred.cred);
    const out = await scoper.scope('ContainerApps.Deploy', VALID);
    // Non-object error: isNotFound() returns false on `typeof !== 'object'`,
    // so this propagates verbatim.
    ra.state.nextDeleteError = 'string-error';
    await expect(out.revoke()).rejects.toBe('string-error');
  });

  it('revoke() propagates errors with no statusCode/code/message', async () => {
    const ra = makeRoleAssignments();
    const cred = makeCred();
    const scoper = new AzureCredentialScoper(cfg, ra.client, cred.cred);
    const out = await scoper.scope('ContainerApps.Deploy', VALID);
    // Object error but no recognised 404 markers — message field absent.
    ra.state.nextDeleteError = { foo: 'bar' };
    await expect(out.revoke()).rejects.toEqual({ foo: 'bar' });
  });

  it('revoke() propagates errors whose message does NOT match the 404 regex', async () => {
    const ra = makeRoleAssignments();
    const cred = makeCred();
    const scoper = new AzureCredentialScoper(cfg, ra.client, cred.cred);
    const out = await scoper.scope('ContainerApps.Deploy', VALID);
    ra.state.nextDeleteError = { message: 'unrelated server error' };
    await expect(out.revoke()).rejects.toMatchObject({
      message: 'unrelated server error',
    });
  });

  it('exposes provider="azure" and is structurally a CredentialScoper', () => {
    const ra = makeRoleAssignments();
    const cred = makeCred();
    const scoper = new AzureCredentialScoper(cfg, ra.client, cred.cred);
    expect(scoper.provider).toBe('azure');
    expect(typeof scoper.scope).toBe('function');
  });
});
