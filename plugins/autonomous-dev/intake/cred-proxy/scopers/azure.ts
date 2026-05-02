/**
 * AzureCredentialScoper — temporary RBAC role assignment + Managed
 * Identity token (SPEC-024-2-03, TDD-024 §7.2).
 *
 * Azure has no inline session-policy concept; scope-narrowing is achieved
 * by creating a per-issuance Role Assignment scoped to a single ARM
 * resource path. The Managed Identity that holds the role assignment
 * mints a token via `getToken('https://management.azure.com/.default')`.
 *
 * `revoke()` deletes the role assignment by `(scope, assignmentName)`.
 * Azure RBAC is eventually consistent (~30-60s propagation); the cloud's
 * eventual consistency is a defense-in-depth caveat, NOT the primary
 * scope-enforcement mechanism — backends MUST stop using credentials at
 * the audit-revocation event.
 *
 * Both Azure clients are constructor-injected so unit tests pass mocks
 * without instantiating real `@azure/identity`/`@azure/arm-authorization`
 * clients.
 *
 * @module intake/cred-proxy/scopers/azure
 */

import { randomUUID } from 'node:crypto';

import type { CredentialScoper, Provider, Scope } from '../types';
import { AZURE_OPERATIONS } from './operation-catalog';

export interface AzureScoperConfig {
  readonly subscriptionId: string;
  /** Object ID of the Managed Identity that holds role assignments and mints tokens. */
  readonly managedIdentityObjectId: string;
}

/**
 * Minimal structural interface of Azure's
 * `AuthorizationManagementClient.roleAssignments` we depend on. The real
 * client's methods match this shape; declaring it here lets unit tests
 * inject a hand-rolled mock without bundling the SDK in tests.
 */
export interface RoleAssignmentsLike {
  create(
    scope: string,
    roleAssignmentName: string,
    parameters: {
      roleDefinitionId: string;
      principalId: string;
      principalType: 'ServicePrincipal';
    },
  ): Promise<unknown>;
  /**
   * Returns void on success. A 404 (assignment already gone) MUST resolve
   * — `revoke()` is idempotent. The implementation ignores 404 responses
   * by surface (the structural mock can simply resolve).
   */
  delete(scope: string, roleAssignmentName: string): Promise<unknown>;
}

/** Minimal structural interface of `ManagedIdentityCredential.getToken`. */
export interface AzureCredentialLike {
  getToken(scopes: string | string[]): Promise<{ token: string } | null>;
}

export class AzureCredentialScoper implements CredentialScoper {
  readonly provider: Provider = 'azure';

  constructor(
    private readonly cfg: AzureScoperConfig,
    private readonly roleAssignments: RoleAssignmentsLike,
    private readonly cred: AzureCredentialLike,
    /** Injectable for fake-timer tests. */
    private readonly now: () => number = () => Date.now(),
    /** Injectable for deterministic-name tests. */
    private readonly genId: () => string = () => randomUUID(),
  ) {}

  async scope(operation: string, scope: Scope) {
    const spec = AZURE_OPERATIONS[operation];
    if (!spec) throw new Error(`unknown Azure operation: ${operation}`);
    for (const key of spec.requiredScopeKeys) {
      if (!scope[key]) {
        throw new Error(
          `missing required scope key '${key}' for ${operation}`,
        );
      }
    }

    const assignmentName = this.genId();
    const resourceScope = spec.resourceScope(scope as Record<string, string>);

    await this.roleAssignments.create(resourceScope, assignmentName, {
      roleDefinitionId: spec.roleDefinitionId,
      principalId: this.cfg.managedIdentityObjectId,
      principalType: 'ServicePrincipal',
    });

    const tokenResp = await this.cred.getToken(
      'https://management.azure.com/.default',
    );
    if (!tokenResp) {
      throw new Error('Azure ManagedIdentityCredential returned no token');
    }

    // Azure tokens have a fixed cloud-side TTL (~60-90 min); we encode
    // the proxy's 15-min expiry in the payload. The role assignment is
    // the truth-source for "is this credential authorized."
    const expires_at = new Date(this.now() + 900_000).toISOString();

    return {
      payload: JSON.stringify({
        access_token: tokenResp.token,
        expires_at,
      }),
      expires_at,
      revoke: async () => {
        try {
          await this.roleAssignments.delete(resourceScope, assignmentName);
        } catch (err) {
          // 404 (already gone) is treated as success — `revoke()` is
          // idempotent. Other errors propagate to the proxy's revoke
          // wrapper (SPEC-024-2-04) for audit logging.
          if (isNotFound(err)) return;
          throw err;
        }
      },
    };
  }
}

/**
 * Best-effort 404 detector across the shapes the Azure ARM client uses
 * (HTTP error with statusCode/code, RestError-like, or a message
 * containing "NotFound"/"404").
 */
function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { statusCode?: number; code?: string | number; message?: string };
  if (e.statusCode === 404) return true;
  if (e.code === 404 || e.code === 'NotFound') return true;
  if (typeof e.message === 'string' && /\b(404|NotFound|RoleAssignmentNotFound)\b/.test(e.message)) {
    return true;
  }
  return false;
}
