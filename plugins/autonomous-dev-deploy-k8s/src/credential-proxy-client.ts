/**
 * K8s-side `CredentialProxy` consumer wrapper (SPEC-024-1-03).
 *
 * Consumes a `ScopedCredential` whose `kubeconfig` field is a YAML
 * string restricted to the operation's namespace (issued by PLAN-024-2)
 * and feeds it into a structural `KubeConfigLike` that the typed K8s
 * clients (`AppsV1Api`, `CoreV1Api`, `KubernetesObjectApi`) consume
 * without depending on the SDK at compile time.
 *
 * @module @autonomous-dev/deploy-k8s/credential-proxy-client
 */

import type {
  CredentialProxy,
  ResourceScope,
  ScopedCredential,
} from '../../autonomous-dev/intake/deploy/credential-proxy-types';

/**
 * Subset of `@kubernetes/client-node`'s `KubeConfig` we use. Real
 * `KubeConfig.loadFromString(yaml)` mutates the instance in place and
 * the result has methods like `makeApiClient` / `getCurrentContext`.
 * We only declare what `manifest-applier` needs to construct typed API
 * clients; the runtime SDK satisfies this structurally.
 */
export interface KubeConfigLike {
  /** Currently-selected context name. */
  getCurrentContext(): string;
  /**
   * Make a typed API client instance. The real SDK has overloads keyed
   * by the API class constructor; tests inject simple records.
   */
  makeApiClient<T>(apiCtor: new (...args: unknown[]) => T): T;
}

/**
 * Factory that turns a kubeconfig YAML string into a `KubeConfigLike`.
 * In production this calls `new KubeConfig(); kc.loadFromString(yaml)`;
 * tests inject a stub.
 */
export interface KubeConfigFactory {
  (kubeconfigYaml: string): KubeConfigLike;
}

/**
 * Consume a proxy-issued K8s credential and produce a `KubeConfigLike`.
 * Throws when `cred.kubeconfig` is unset.
 */
export function toKubeConfig(
  cred: ScopedCredential,
  factory: KubeConfigFactory,
): KubeConfigLike {
  if (cred.cloud !== 'k8s') {
    throw new Error(`toKubeConfig: expected cloud=k8s, got ${cred.cloud}`);
  }
  const yaml = cred.kubeconfig;
  if (!yaml) {
    throw new Error('toKubeConfig: cred.kubeconfig is empty');
  }
  return factory(yaml);
}

/** Convenience: acquire + convert in one call. */
export async function acquireKubeConfig(
  proxy: CredentialProxy,
  operationName: string,
  scope: ResourceScope,
  factory: KubeConfigFactory,
): Promise<{ cred: ScopedCredential; kubeConfig: KubeConfigLike }> {
  const cred = await proxy.acquire('k8s', operationName, scope);
  return { cred, kubeConfig: toKubeConfig(cred, factory) };
}
