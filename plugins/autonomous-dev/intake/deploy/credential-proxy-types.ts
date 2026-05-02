/**
 * `CredentialProxy` consumer-side types (PLAN-024-1, consumed by
 * SPEC-024-1-02 and SPEC-024-1-03; implemented by PLAN-024-2).
 *
 * Cloud backends never receive long-lived operator credentials. They
 * call `proxy.acquire(provider, operationName, scope)` for each cloud
 * API operation; the proxy returns a short-lived (15 min) operation-
 * scoped credential that the backend forwards to its SDK client and
 * then discards.
 *
 * This module is the type-only contract: the runtime implementation
 * (STS AssumeRole on AWS, generateAccessToken on GCP, Managed Identity
 * on Azure, ServiceAccount tokens on K8s) lands in PLAN-024-2.
 *
 * The shape mirrors TDD-024 §7.1 (`ScopedCredential` payload) but
 * surfaces the per-cloud delivery format directly so a backend's
 * `credential-proxy-client.ts` wrapper can convert to the SDK's native
 * options object without parsing JSON blobs at runtime.
 *
 * @module intake/deploy/credential-proxy-types
 */

/** Discriminator for which cloud the credential targets. */
export type CredentialProvider = 'gcp' | 'aws' | 'azure' | 'k8s';

/**
 * Resource scope identifying the precise resource the credential is
 * issued for. The proxy uses this to generate a minimal-permissions
 * session policy (AWS), IAM binding (GCP), Role Assignment (Azure), or
 * ServiceAccount token (K8s). Backends MUST pass the most specific
 * resource identifier they have at acquire time.
 */
export interface ResourceScope {
  /**
   * Cloud-specific resource identifier (ARN on AWS, fully-qualified
   * resource name on GCP/Azure, `cluster:<ctx>/namespace:<ns>` on K8s).
   */
  resource: string;
  /** Region (AWS, GCP) or location (Azure). Omitted for K8s. */
  region?: string;
  /** AWS account id (12 digits) or GCP project id. Omitted for Azure/K8s. */
  account?: string;
}

/** Optional `acquire()` modifiers. */
export interface AcquireOptions {
  /**
   * Override the default 900-second TTL. The proxy may cap this lower
   * for sensitive operations; backends MUST NOT assume the cap is
   * fixed.
   */
  ttlSeconds?: number;
}

/**
 * Credential payload returned by `acquire()`. Exactly one of `token`,
 * `awsCredentials`, or `kubeconfig` is populated, picked by the
 * provider.
 */
export interface ScopedCredential {
  cloud: CredentialProvider;
  /** Wall-clock expiry. Backends MUST NOT cache past this instant. */
  expiresAt: Date;
  /** Stable identifier for revocation / audit. */
  tokenId: string;
  /** GCP / Azure: bearer access token. */
  token?: string;
  /** AWS: STS triplet for `credentials` SDK option. */
  awsCredentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
  };
  /** K8s: kubeconfig YAML restricted to the operation's namespace. */
  kubeconfig?: string;
}

/**
 * Consumer-side interface backends program against. The runtime
 * implementation in PLAN-024-2 satisfies this shape; tests inject a
 * mock that returns fixed `ScopedCredential` instances.
 */
export interface CredentialProxy {
  /**
   * Acquire a scoped credential. Backends MUST call this for every
   * cloud API operation rather than caching across calls; the proxy
   * is responsible for short-window caching.
   *
   * @param provider Discriminator picking the per-cloud scoper.
   * @param operationName Cloud API operation, e.g.
   *   `'CloudBuild:CreateBuild'`, `'ECS:UpdateService'`. Free-form
   *   string; the proxy maps it to a per-cloud policy template.
   * @param scope Resource scope for least-privilege policy generation.
   * @param options Optional TTL override.
   */
  acquire(
    provider: CredentialProvider,
    operationName: string,
    scope: ResourceScope,
    options?: AcquireOptions,
  ): Promise<ScopedCredential>;
}
