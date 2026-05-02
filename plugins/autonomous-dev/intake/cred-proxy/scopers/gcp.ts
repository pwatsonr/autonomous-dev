/**
 * GCPCredentialScoper — temporary IAM binding + impersonation token
 * (SPEC-024-2-02, TDD-024 §7.2).
 *
 * Each `scope(operation, scope)` call:
 *   1. `getIamPolicy` on the resource (via the resourceType-specific
 *      client supplied by the dispatcher).
 *   2. Adds a binding granting the operation's role to the delegated
 *      service account; calls `setIamPolicy` with the etag from step 1.
 *   3. Mints a 900-second access token via
 *      `IAMCredentialsClient.generateAccessToken`, impersonating the
 *      delegated SA.
 *   4. Returns a `revoke()` closure that fetches a FRESH IAM policy at
 *      revocation time and removes the binding (if still present).
 *
 * The IAM-client and per-resourceType clients are constructor-injected
 * so unit tests pass mocks. The default constructor builds the
 * iam-credentials client; resource clients MUST be supplied because the
 * full `@google-cloud/run`, `@google-cloud/storage`, and
 * `@google-cloud/resource-manager` packages are NOT bundled in the
 * autonomous-dev plugin (the cloud plugins vendor them; the proxy can
 * import from the cloud plugin's path or a runtime-injected client).
 *
 * @module intake/cred-proxy/scopers/gcp
 */

import { IAMCredentialsClient } from '@google-cloud/iam-credentials';

import type { CredentialScoper, Provider, Scope } from '../types';
import {
  GCP_OPERATIONS,
  type GcpResourceType,
} from './operation-catalog';

/** Minimal structural interface of `IAMCredentialsClient` we depend on. */
export interface IamCredentialsLike {
  generateAccessToken(req: {
    name: string;
    scope: string[];
    lifetime: { seconds: number };
  }): Promise<[
    {
      accessToken?: string | null;
      expireTime?: { seconds?: number | string | null } | null;
    },
    ...unknown[],
  ]>;
}

/**
 * Generic IAM-policy editor. Each `resourceType` supplies one of these,
 * which the scoper drives via `getPolicy → mutate → setPolicy`. Keeping
 * this shape resource-agnostic lets the test inject a single fake for
 * any resourceType and lets production ship a per-resourceType wrapper
 * around the corresponding `@google-cloud/*` client without coupling
 * this file to those packages.
 */
export interface IamPolicyEditor {
  getIamPolicy(resource: string): Promise<{
    bindings?: Array<{ role?: string; members?: string[] }>;
    etag?: string;
  }>;
  setIamPolicy(
    resource: string,
    policy: {
      bindings: Array<{ role: string; members: string[] }>;
      etag?: string;
    },
  ): Promise<void>;
}

export interface GcpScoperConfig {
  /** Service account the proxy impersonates to mint downstream tokens. */
  readonly proxyServiceAccount: string;
  /**
   * Pre-provisioned service account whose permissions are issued to the
   * backend. The proxy SA must have
   * `roles/iam.serviceAccountTokenCreator` on this delegated SA.
   */
  readonly delegatedServiceAccount: string;
}

export class GCPCredentialScoper implements CredentialScoper {
  readonly provider: Provider = 'gcp';

  constructor(
    private readonly cfg: GcpScoperConfig,
    /** Resource-specific IAM editors keyed by `GcpResourceType`. */
    private readonly editors: ReadonlyMap<GcpResourceType, IamPolicyEditor>,
    private readonly creds: IamCredentialsLike = new IAMCredentialsClient() as unknown as IamCredentialsLike,
    /** Injectable for fake-timer tests. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  async scope(operation: string, scope: Scope) {
    const spec = GCP_OPERATIONS[operation];
    if (!spec) throw new Error(`unknown GCP operation: ${operation}`);
    for (const key of spec.requiredScopeKeys) {
      if (!scope[key]) {
        throw new Error(
          `missing required scope key '${key}' for ${operation}`,
        );
      }
    }
    const editor = this.editors.get(spec.resourceType);
    if (!editor) {
      throw new Error(
        `no IAM editor registered for resourceType '${spec.resourceType}'`,
      );
    }

    const resourcePath = spec.resourcePath(scope as Record<string, string>);
    const member = `serviceAccount:${this.cfg.delegatedServiceAccount}`;

    // 1. Add binding (read-modify-write with etag).
    await this.addBinding(editor, resourcePath, spec.role, member);

    // 2. Mint impersonation token.
    const [tokenResp] = await this.creds.generateAccessToken({
      name: `projects/-/serviceAccounts/${this.cfg.delegatedServiceAccount}`,
      scope: ['https://www.googleapis.com/auth/cloud-platform'],
      lifetime: { seconds: 900 },
    });
    if (!tokenResp.accessToken) {
      throw new Error(
        'GCP generateAccessToken returned no token',
      );
    }
    const expires_at = new Date(this.now() + 900_000).toISOString();

    return {
      payload: JSON.stringify({
        access_token: tokenResp.accessToken,
        expires_at,
      }),
      expires_at,
      revoke: async () => {
        await this.removeBinding(editor, resourcePath, spec.role, member);
      },
    };
  }

  private async addBinding(
    editor: IamPolicyEditor,
    resource: string,
    role: string,
    member: string,
  ): Promise<void> {
    const policy = await editor.getIamPolicy(resource);
    const bindings = (policy.bindings ?? []).map((b) => ({
      role: b.role ?? '',
      members: [...(b.members ?? [])],
    }));
    const existing = bindings.find((b) => b.role === role);
    if (existing) {
      if (!existing.members.includes(member)) {
        existing.members.push(member);
      }
    } else {
      bindings.push({ role, members: [member] });
    }
    await editor.setIamPolicy(resource, { bindings, etag: policy.etag });
  }

  private async removeBinding(
    editor: IamPolicyEditor,
    resource: string,
    role: string,
    member: string,
  ): Promise<void> {
    // Fetch a FRESH policy at revoke time — etag mismatches surface as
    // setIamPolicy rejections; we propagate them so the proxy's revoke
    // wrapper (SPEC-024-2-04) records the failure in audit and the
    // cloud's TTL ultimately reclaims the credential.
    const policy = await editor.getIamPolicy(resource);
    const bindings = (policy.bindings ?? [])
      .map((b) => ({
        role: b.role ?? '',
        members: (b.members ?? []).filter((m) => m !== member),
      }))
      .filter((b) => b.members.length > 0);
    if (bindings.length === 0 && (policy.bindings?.length ?? 0) === 0) {
      // Nothing to do; binding already absent. Idempotent revoke.
      return;
    }
    const _stillHasRole = bindings.some((b) => b.role === role);
    void _stillHasRole; // future: assert no orphaned grant remained
    await editor.setIamPolicy(resource, { bindings, etag: policy.etag });
  }
}
