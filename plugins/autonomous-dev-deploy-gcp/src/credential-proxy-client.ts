/**
 * GCP-side `CredentialProxy` consumer wrapper (SPEC-024-1-02).
 *
 * Converts a `ScopedCredential` returned by the proxy into the option
 * object the Google Cloud SDK clients accept. Centralised so
 * GCPBackend never touches credential fields directly.
 *
 * @module @autonomous-dev/deploy-gcp/credential-proxy-client
 */

import type {
  CredentialProxy,
  ResourceScope,
  ScopedCredential,
} from '../../autonomous-dev/intake/deploy/credential-proxy-types';

/**
 * Subset of `GoogleAuthOptions`-shaped fields a Cloud Build / Cloud
 * Run client constructor accepts. Defined inline so this module does
 * not depend on `@google-cloud/run` at compile time (the SDK lives in
 * the deploy-gcp plugin's own node_modules; this wrapper is consumed
 * via duck-typed injection by `backend.ts`).
 */
export interface GcpClientAuthOptions {
  authClient: {
    /** Bearer access token forwarded as `Authorization: Bearer <token>`. */
    getAccessToken: () => Promise<{ token: string; expiresAt?: Date }>;
  };
}

/**
 * Build a GCP SDK auth options object from a proxy-issued credential.
 * Throws when `cred.token` is unset (proxy implementation bug — every
 * GCP `acquire()` MUST populate `token`).
 */
export function toGcpAuthOptions(cred: ScopedCredential): GcpClientAuthOptions {
  if (cred.cloud !== 'gcp') {
    throw new Error(
      `toGcpAuthOptions: expected cloud=gcp, got ${cred.cloud}`,
    );
  }
  const token = cred.token;
  if (!token) {
    throw new Error('toGcpAuthOptions: cred.token is empty');
  }
  const expiresAt = cred.expiresAt;
  return {
    authClient: {
      getAccessToken: async () => ({ token, expiresAt }),
    },
  };
}

/**
 * Convenience: acquire + convert in one call. Backends use this for
 * the common case of "get creds then construct client".
 */
export async function acquireGcpAuth(
  proxy: CredentialProxy,
  operationName: string,
  scope: ResourceScope,
): Promise<{ cred: ScopedCredential; auth: GcpClientAuthOptions }> {
  const cred = await proxy.acquire('gcp', operationName, scope);
  return { cred, auth: toGcpAuthOptions(cred) };
}
