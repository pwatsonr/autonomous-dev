/**
 * Secret binding types and JIT resolution for deploy requests (issue #667).
 *
 * Operators declare `secretBindings` in the deploy request. Each binding
 * names a `credentialRef` (a path in the credential store, e.g. a Vault
 * path or AWS Secrets Manager ARN) plus an injection mode (`'env'` or
 * `'file'`) and a `name` (env var name or file path).
 *
 * Resolution is **just-in-time**: the orchestrator calls
 * `resolveSecretBindings()` immediately before dispatch, using the
 * per-target `CredentialProxy`. Resolved bindings carry live secret
 * material for in-process injection only.
 *
 * **Persistence contract**: the orchestrator persists ONLY
 * `RecordSafeBinding` objects to `DeploymentRecord.secretBindings`.
 * These contain only a SHA-256 hash of the `credentialRef` — never secret
 * material, never the raw ref, never logged. Use `toRecordSafeBindings()`
 * to project `ResolvedSecretBinding[]` → `RecordSafeBinding[]`.
 *
 * ## Homelab plugin compatibility
 *
 * The homelab plugin provides a `CredentialProxy` shim that resolves refs
 * against a local credential store (e.g., Vault agent socket, pass(1),
 * or a local secrets file). The same `resolveSecretBindings()` function is
 * used for both cloud and homelab targets — the proxy implementation differs,
 * the resolution path is identical.
 *
 * Cross-reference: issues #667, credential-proxy-types.ts.
 *
 * @module intake/deploy/secret-binding
 */

import { createHash } from 'node:crypto';
import type { CredentialProxy } from './credential-proxy-types';

// ---------------------------------------------------------------------------
// Public types (shared with plugin — no cross-repo imports needed)
// ---------------------------------------------------------------------------

/**
 * A secret binding declared in the deploy request.
 *
 * `credentialRef` is an opaque reference interpreted by the `CredentialProxy`
 * implementation (Vault path, AWS ARN, etc.). Core never inspects or logs it
 * beyond computing its SHA-256 hash for the deployment record.
 */
export interface SecretBinding {
  /**
   * Opaque reference to the credential in the backing store.
   * Examples: `'vault/prod/db-password'`, `'arn:aws:secretsmanager:...'`.
   */
  credentialRef: string;

  /**
   * How the resolved secret is injected into the deploy target.
   *
   * - `'env'`  — the secret value is set as an environment variable named
   *              by `name` in the deploy process / container entrypoint.
   * - `'file'` — the secret value is written to a file at the path given by
   *              `name` (e.g., `/run/secrets/db_password`).
   */
  injectAs: 'env' | 'file';

  /**
   * Injection destination.
   *
   * - When `injectAs === 'env'`:  the environment variable name (e.g.,
   *   `'DB_PASSWORD'`).
   * - When `injectAs === 'file'`: the absolute file path (e.g.,
   *   `'/run/secrets/db_password'`).
   */
  name: string;
}

/**
 * A resolved secret binding. Contains live secret material for in-process
 * injection. MUST NOT be persisted, logged, or forwarded outside the
 * orchestrator process.
 *
 * Use `toRecordSafeBindings()` to strip material before persisting.
 */
export interface ResolvedSecretBinding extends SecretBinding {
  /**
   * The resolved secret value, returned by the `CredentialProxy`.
   * MUST NOT be persisted or logged.
   */
  secretMaterial: string;
}

/**
 * A persistence-safe projection of a `ResolvedSecretBinding`.
 *
 * Contains only `refHash` (SHA-256 hex of the `credentialRef`), `injectAs`,
 * and `name`. Secret material and the raw `credentialRef` are absent so
 * this object is safe to store in `DeploymentRecord.secretBindings` and
 * in audit logs.
 */
export interface RecordSafeBinding {
  /**
   * SHA-256 hex hash of `credentialRef`.
   * Allows correlation with the original binding without exposing the ref.
   */
  refHash: string;

  /** Injection mode — preserved for operator auditing. */
  injectAs: 'env' | 'file';

  /** Injection destination name / path — preserved for operator auditing. */
  name: string;
}

// ---------------------------------------------------------------------------
// JIT resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a list of `SecretBinding` objects just-in-time via the provided
 * `CredentialProxy`.
 *
 * Each binding is resolved concurrently. If any proxy call rejects (e.g.
 * permission denied, ref not found), `resolveSecretBindings` rejects with
 * that error and NO partial results are returned. The caller must handle the
 * rejection and abort the deploy.
 *
 * The `CredentialProxy.acquire()` call maps `credentialRef` to a resource
 * scope. The proxy implementation (cloud vs. homelab shim) determines how
 * `credentialRef` maps to the provider's API — core does not parse the ref.
 *
 * @param bindings - Declared secret bindings from the deploy request.
 * @param proxy    - `CredentialProxy` instance for the current target.
 * @returns Resolved bindings with live secret material.
 * @throws When the proxy rejects any binding (permission denied, not found, etc.).
 */
export async function resolveSecretBindings(
  bindings: SecretBinding[],
  proxy: CredentialProxy,
): Promise<ResolvedSecretBinding[]> {
  if (bindings.length === 0) {
    return [];
  }

  return Promise.all(
    bindings.map(async (binding): Promise<ResolvedSecretBinding> => {
      const cred = await proxy.acquire(
        // The provider discriminator is not encoded in SecretBinding — we use
        // a homelab-compatible default. Cloud backends override via their own
        // CredentialProxy implementation that ignores the provider field.
        'gcp',
        'secret-binding:resolve',
        { resource: binding.credentialRef },
      );

      // Extract the secret material from the ScopedCredential. We use
      // `token` as the canonical material field; the homelab shim sets
      // `token` to the resolved secret value regardless of the underlying
      // store (Vault, pass, etc.).
      const secretMaterial = cred.token ?? '';

      return {
        ...binding,
        secretMaterial,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Persistence projection
// ---------------------------------------------------------------------------

/**
 * Project `ResolvedSecretBinding[]` to `RecordSafeBinding[]` for persistence.
 *
 * Strips `secretMaterial` and `credentialRef` from each binding, replacing
 * `credentialRef` with its SHA-256 hex hash (`refHash`). The resulting
 * objects are safe to store in `DeploymentRecord.secretBindings` and audit
 * logs.
 *
 * @param resolved - Resolved bindings with live secret material.
 * @returns Persistence-safe bindings containing only hash, mode, and name.
 */
export function toRecordSafeBindings(resolved: ResolvedSecretBinding[]): RecordSafeBinding[] {
  return resolved.map((r): RecordSafeBinding => ({
    refHash: createHash('sha256').update(r.credentialRef).digest('hex'),
    injectAs: r.injectAs,
    name: r.name,
  }));
}
