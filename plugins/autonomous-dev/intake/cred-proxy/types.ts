/**
 * CredentialProxy internal types (SPEC-024-2-01).
 *
 * These are the IMPLEMENTATION-side types for the credential proxy that
 * runs inside the autonomous-dev daemon. The CONSUMER-side interface used
 * by cloud backends lives at `intake/deploy/credential-proxy-types.ts` and
 * intentionally differs in shape:
 *
 *   - Consumer-side `ScopedCredential` carries cloud-native fields
 *     (`awsCredentials`, `token`, `kubeconfig`) so backends can hand the
 *     value to an SDK client without parsing JSON.
 *   - Internal `ScopedCredential` (this file) carries an opaque `payload`
 *     string + `delivery` discriminator because the proxy ships it across
 *     a process boundary (stdin or socket) and is provider-agnostic.
 *
 * SPEC-024-2-04 wires an adapter that converts internal → consumer when
 * the daemon hands the credential to the backend. The two type surfaces
 * are deliberately disjoint to keep the proxy free of cloud-SDK types.
 *
 * @module intake/cred-proxy/types
 */

/** Discriminator picking the per-cloud scoper. */
export type Provider = 'aws' | 'gcp' | 'azure' | 'k8s';

/** How the credential reached the backend; recorded for audit attribution. */
export type Delivery = 'stdin' | 'socket';

/**
 * Free-form, provider-specific resource identifiers (region/account/
 * project/etc). Each scoper validates the keys it actually consumes; the
 * proxy itself does not validate scope shape (TDD-024 §7.1).
 */
export interface Scope {
  readonly [key: string]: string;
}

/**
 * Credential shipped from the proxy to a privileged backend. Fully
 * `readonly` — downstream code must not mutate after issuance.
 */
export interface ScopedCredential {
  readonly provider: Provider;
  readonly delivery: Delivery;
  /**
   * Provider-specific JSON payload (STS triplet, kubeconfig YAML, OAuth
   * token, etc.). Opaque to the proxy; parsed by the backend's
   * provider-specific adapter.
   */
  readonly payload: string;
  /** ISO-8601 UTC timestamp when the credential becomes invalid. */
  readonly expires_at: string;
  /** UUIDv4 — used by the proxy + audit log to correlate issue/revoke. */
  readonly token_id: string;
  /** What the credential authorises and against which resources. */
  readonly scope: { readonly operation: string; readonly resources: Scope };
}

/**
 * Pluggable per-provider scope-narrowing adapter. Each scoper translates
 * an `(operation, scope)` pair into a provider-native short-lived
 * credential and a `revoke()` callback the proxy invokes at TTL or on
 * early `release(token_id)`.
 */
export interface CredentialScoper {
  readonly provider: Provider;
  scope(
    operation: string,
    scope: Scope,
  ): Promise<{
    payload: string;
    expires_at: string;
    revoke: () => Promise<void>;
  }>;
}

/**
 * Authorisation failure surfaced from `CredentialProxy.acquire`. The
 * `code` discriminates the failure reason for the audit log; messages
 * are human-readable and may include identifying details.
 */
export class SecurityError extends Error {
  readonly code: 'NOT_ALLOWLISTED' | 'CALLER_UNKNOWN' | 'CALLER_SPOOFED';
  constructor(
    code: SecurityError['code'],
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'SecurityError';
  }
}
