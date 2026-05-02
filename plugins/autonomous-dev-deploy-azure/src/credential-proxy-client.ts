/**
 * Azure-side `CredentialProxy` consumer wrapper (SPEC-024-1-03).
 *
 * Converts a `ScopedCredential` returned by the proxy into the
 * `TokenCredential`-shaped object every `@azure/arm-*` client constructor
 * accepts. Centralised so AzureBackend never touches credential fields
 * directly.
 *
 * @module @autonomous-dev/deploy-azure/credential-proxy-client
 */

import type {
  CredentialProxy,
  ResourceScope,
  ScopedCredential,
} from '../../autonomous-dev/intake/deploy/credential-proxy-types';

/**
 * Subset of `@azure/core-auth`'s `TokenCredential`. Defined inline so
 * this module does not depend on the Azure SDKs at compile time (they
 * live in this plugin's own node_modules).
 */
export interface AzureTokenCredential {
  getToken(
    scopes: string | string[],
    options?: Record<string, unknown>,
  ): Promise<{ token: string; expiresOnTimestamp: number }>;
}

/**
 * Build an Azure `TokenCredential` from a proxy-issued credential.
 * Throws when `cred.token` is unset.
 */
export function toAzureTokenCredential(cred: ScopedCredential): AzureTokenCredential {
  if (cred.cloud !== 'azure') {
    throw new Error(`toAzureTokenCredential: expected cloud=azure, got ${cred.cloud}`);
  }
  const token = cred.token;
  if (!token) {
    throw new Error('toAzureTokenCredential: cred.token is empty');
  }
  const expiresOnTimestamp = cred.expiresAt.getTime();
  return {
    async getToken() {
      return { token, expiresOnTimestamp };
    },
  };
}

/** Convenience: acquire + convert in one call. */
export async function acquireAzureTokenCredential(
  proxy: CredentialProxy,
  operationName: string,
  scope: ResourceScope,
): Promise<{ cred: ScopedCredential; tokenCredential: AzureTokenCredential }> {
  const cred = await proxy.acquire('azure', operationName, scope);
  return { cred, tokenCredential: toAzureTokenCredential(cred) };
}
