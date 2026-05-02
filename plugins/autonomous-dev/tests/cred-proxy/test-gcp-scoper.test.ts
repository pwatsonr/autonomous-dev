/**
 * GCPCredentialScoper unit tests (SPEC-024-2-02).
 */

import {
  GCPCredentialScoper,
  type IamCredentialsLike,
  type IamPolicyEditor,
} from '../../intake/cred-proxy/scopers/gcp';
import type { GcpResourceType } from '../../intake/cred-proxy/scopers/operation-catalog';

interface FakeEditorState {
  policy: {
    bindings?: Array<{ role?: string; members?: string[] }>;
    etag?: string;
  };
  getCalls: number;
  setCalls: number;
  setArgs: Array<{ resource: string; policy: unknown }>;
}

function makeEditor(initialEtag = 'etag-1'): {
  editor: IamPolicyEditor;
  state: FakeEditorState;
} {
  const state: FakeEditorState = {
    policy: { bindings: [], etag: initialEtag },
    getCalls: 0,
    setCalls: 0,
    setArgs: [],
  };
  const editor: IamPolicyEditor = {
    async getIamPolicy(_resource) {
      state.getCalls += 1;
      return JSON.parse(JSON.stringify(state.policy));
    },
    async setIamPolicy(resource, policy) {
      state.setCalls += 1;
      state.setArgs.push({ resource, policy });
      // Simulate the cloud-side update so subsequent get reflects it.
      state.policy = {
        bindings: policy.bindings.map((b) => ({
          role: b.role,
          members: [...b.members],
        })),
        etag: 'etag-' + (state.setCalls + 1),
      };
    },
  };
  return { editor, state };
}

function makeIam(token = 'gcp-tok'): {
  iam: IamCredentialsLike;
  calls: number;
} {
  let calls = 0;
  return {
    iam: {
      async generateAccessToken(req) {
        calls += 1;
        if (req.lifetime.seconds !== 900) {
          throw new Error(`expected lifetime 900, got ${req.lifetime.seconds}`);
        }
        return [{ accessToken: token }];
      },
    },
    get calls() {
      return calls;
    },
  };
}

const cfg = {
  proxyServiceAccount: 'proxy@p.iam.gserviceaccount.com',
  delegatedServiceAccount: 'deleg@p.iam.gserviceaccount.com',
};

const RUN_SCOPE = { project: 'p1', location: 'us-central1', service: 's1' };

describe('GCPCredentialScoper.scope', () => {
  it('adds binding then mints token for Run.Deploy', async () => {
    const { editor, state } = makeEditor();
    const iamWrap = makeIam();
    const editors = new Map<GcpResourceType, IamPolicyEditor>([
      ['service', editor],
    ]);
    const scoper = new GCPCredentialScoper(
      cfg,
      editors,
      iamWrap.iam,
      () => 1_700_000_000_000,
    );
    const out = await scoper.scope('Run.Deploy', RUN_SCOPE);
    expect(state.getCalls).toBe(1);
    expect(state.setCalls).toBe(1);
    expect(state.setArgs[0].resource).toBe(
      'projects/p1/locations/us-central1/services/s1',
    );
    const policy = state.setArgs[0].policy as {
      bindings: Array<{ role: string; members: string[] }>;
    };
    expect(policy.bindings).toEqual([
      {
        role: 'roles/run.developer',
        members: ['serviceAccount:deleg@p.iam.gserviceaccount.com'],
      },
    ]);
    expect(iamWrap.calls).toBe(1);
    const payload = JSON.parse(out.payload);
    expect(payload.access_token).toBe('gcp-tok');
    expect(out.expires_at).toBe(
      new Date(1_700_000_000_000 + 900_000).toISOString(),
    );
  });

  it('dispatches Storage.Upload to the bucket editor', async () => {
    const svc = makeEditor();
    const buc = makeEditor();
    const editors = new Map<GcpResourceType, IamPolicyEditor>([
      ['service', svc.editor],
      ['bucket', buc.editor],
    ]);
    const iamWrap = makeIam();
    const scoper = new GCPCredentialScoper(cfg, editors, iamWrap.iam);
    await scoper.scope('Storage.Upload', { bucket: 'b1' });
    expect(buc.state.setCalls).toBe(1);
    expect(svc.state.setCalls).toBe(0);
    expect(buc.state.setArgs[0].resource).toBe('projects/_/buckets/b1');
  });

  it('throws when a required scope key is missing', async () => {
    const editors = new Map<GcpResourceType, IamPolicyEditor>([
      ['service', makeEditor().editor],
    ]);
    const scoper = new GCPCredentialScoper(cfg, editors, makeIam().iam);
    await expect(
      scoper.scope('Run.Deploy', { project: 'p1', service: 's1' } as Record<
        string,
        string
      >),
    ).rejects.toThrow(/missing required scope key 'location'/);
  });

  it('throws on unknown operation', async () => {
    const editors = new Map<GcpResourceType, IamPolicyEditor>();
    const scoper = new GCPCredentialScoper(cfg, editors, makeIam().iam);
    await expect(scoper.scope('UnknownOp', {})).rejects.toThrow(
      /unknown GCP operation/,
    );
  });

  it('throws when no editor is registered for the resourceType', async () => {
    const editors = new Map<GcpResourceType, IamPolicyEditor>();
    const scoper = new GCPCredentialScoper(cfg, editors, makeIam().iam);
    await expect(scoper.scope('Run.Deploy', RUN_SCOPE)).rejects.toThrow(
      /no IAM editor registered for resourceType 'service'/,
    );
  });

  it('throws when generateAccessToken returns empty token', async () => {
    const { editor } = makeEditor();
    const iam: IamCredentialsLike = {
      async generateAccessToken() {
        return [{ accessToken: null }];
      },
    };
    const editors = new Map<GcpResourceType, IamPolicyEditor>([
      ['service', editor],
    ]);
    const scoper = new GCPCredentialScoper(cfg, editors, iam);
    await expect(scoper.scope('Run.Deploy', RUN_SCOPE)).rejects.toThrow(/no token/);
  });

  it('revoke() fetches a fresh policy and removes the binding', async () => {
    const { editor, state } = makeEditor();
    const editors = new Map<GcpResourceType, IamPolicyEditor>([
      ['service', editor],
    ]);
    const scoper = new GCPCredentialScoper(cfg, editors, makeIam().iam);
    const out = await scoper.scope('Run.Deploy', RUN_SCOPE);
    const getsAfterScope = state.getCalls;
    const setsAfterScope = state.setCalls;
    await out.revoke();
    expect(state.getCalls).toBe(getsAfterScope + 1);
    expect(state.setCalls).toBe(setsAfterScope + 1);
    const finalPolicy = state.setArgs[state.setArgs.length - 1]
      .policy as { bindings: Array<{ role: string; members: string[] }> };
    // No more bindings for the delegated SA.
    const stillThere = finalPolicy.bindings.some((b) =>
      b.members.includes('serviceAccount:deleg@p.iam.gserviceaccount.com'),
    );
    expect(stillThere).toBe(false);
  });

  it('revoke() propagates editor errors (etag conflict)', async () => {
    const { editor } = makeEditor();
    const editors = new Map<GcpResourceType, IamPolicyEditor>([
      ['service', editor],
    ]);
    const scoper = new GCPCredentialScoper(cfg, editors, makeIam().iam);
    const out = await scoper.scope('Run.Deploy', RUN_SCOPE);
    // Force the next setIamPolicy to reject — simulates 409 etag conflict.
    editor.setIamPolicy = async () => {
      throw new Error('409 etag-conflict');
    };
    await expect(out.revoke()).rejects.toThrow(/etag-conflict/);
  });

  it('two consecutive scopes both add the binding (idempotent on duplicate member)', async () => {
    const { editor, state } = makeEditor();
    const editors = new Map<GcpResourceType, IamPolicyEditor>([
      ['service', editor],
    ]);
    const scoper = new GCPCredentialScoper(cfg, editors, makeIam().iam);
    await scoper.scope('Run.Deploy', RUN_SCOPE);
    await scoper.scope('Run.Deploy', RUN_SCOPE);
    expect(state.setCalls).toBe(2);
    // Second setIamPolicy must NOT duplicate the member.
    const finalPolicy = state.setArgs[1].policy as {
      bindings: Array<{ role: string; members: string[] }>;
    };
    const runBinding = finalPolicy.bindings.find(
      (b) => b.role === 'roles/run.developer',
    );
    expect(runBinding?.members).toEqual([
      'serviceAccount:deleg@p.iam.gserviceaccount.com',
    ]);
  });

  it('preserves pre-existing bindings on other roles', async () => {
    const { editor, state } = makeEditor();
    state.policy = {
      bindings: [{ role: 'roles/viewer', members: ['user:alice@x.com'] }],
      etag: 'etag-pre',
    };
    const editors = new Map<GcpResourceType, IamPolicyEditor>([
      ['service', editor],
    ]);
    const scoper = new GCPCredentialScoper(cfg, editors, makeIam().iam);
    await scoper.scope('Run.Deploy', RUN_SCOPE);
    const finalPolicy = state.setArgs[0].policy as {
      bindings: Array<{ role: string; members: string[] }>;
    };
    expect(finalPolicy.bindings).toContainEqual({
      role: 'roles/viewer',
      members: ['user:alice@x.com'],
    });
  });
});
