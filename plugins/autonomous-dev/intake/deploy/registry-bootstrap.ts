/**
 * One-shot registration of the four bundled backends (SPEC-023-1-04) plus
 * the optional cloud-plugin registration helper (SPEC-024-1-05).
 *
 * Idempotent — safe to call twice. `BackendRegistry.register` overwrites
 * by name, so the second call is a no-op-equivalent.
 *
 * @module intake/deploy/registry-bootstrap
 */

import { DockerLocalBackend } from './backends/docker-local';
import { GithubPagesBackend } from './backends/github-pages';
import { LocalBackend } from './backends/local';
import { StaticBackend } from './backends/static';
import { BackendRegistry, type RegistryRegisterOptions } from './registry';
import type { CredentialProxy } from './credential-proxy-types';
import type { DeploymentBackend } from './types';

/** Register every bundled backend. Tool-availability probes happen here. */
export async function registerBundledBackends(
  opts: RegistryRegisterOptions = {},
): Promise<void> {
  await BackendRegistry.register(new LocalBackend(), opts);
  await BackendRegistry.register(new StaticBackend(), opts);
  await BackendRegistry.register(new DockerLocalBackend(), opts);
  await BackendRegistry.register(new GithubPagesBackend(), opts);
}

/** Sync registration variant — skips tool probes. Tests + conformance. */
export function registerBundledBackendsSync(): void {
  BackendRegistry.registerSync(new LocalBackend());
  BackendRegistry.registerSync(new StaticBackend());
  BackendRegistry.registerSync(new DockerLocalBackend());
  BackendRegistry.registerSync(new GithubPagesBackend());
}

/** Cloud plugin discriminator used by `registerCloudBackends`. */
export type CloudPluginName = 'gcp' | 'aws' | 'azure' | 'k8s';

/**
 * Constructor signature each cloud-plugin backend module exposes. Tests
 * (and the production plugin loader, PLAN-019-1) inject backend
 * constructors via this shape so the cloud-plugin packages stay
 * loose-coupled from this module.
 *
 * Real cloud-backend constructors take an options bag with `proxy`; the
 * helper threads a single proxy across all four. Tests can pass per-cloud
 * factories that pre-bind SDK client mocks before the constructor runs.
 */
export interface CloudBackendCtor {
  new (opts: { proxy: CredentialProxy }): DeploymentBackend;
}

/**
 * Optional dependency-injection hook used by tests to avoid going through
 * the dynamic plugin loader. Production callers (the plugin loader,
 * PLAN-019-1) pass the constructors discovered from the installed cloud
 * plugins. Each constructor is invoked with `{ proxy }`.
 */
export interface RegisterCloudBackendsOptions extends RegistryRegisterOptions {
  /**
   * Map from cloud plugin name to the backend constructor exposed by
   * that plugin. When provided, the helper uses the constructor instead
   * of attempting a dynamic import.
   */
  ctors?: Partial<Record<CloudPluginName, CloudBackendCtor>>;
}

/**
 * Register the requested cloud backends in the global `BackendRegistry`.
 * Idempotent: re-calling with the same plugins overwrites the existing
 * entries by name. Per-plugin tool probes are skipped (cloud backends
 * declare empty `requiredTools`).
 *
 * Test usage:
 * ```ts
 * await registerCloudBackends(['gcp', 'aws'], proxy, {
 *   ctors: { gcp: GCPBackend, aws: AWSBackend },
 * });
 * ```
 *
 * Production usage flows through the plugin loader (PLAN-019-1), which
 * resolves `ctors` at install time and threads them into this helper.
 */
export async function registerCloudBackends(
  plugins: readonly CloudPluginName[],
  proxy: CredentialProxy,
  opts: RegisterCloudBackendsOptions = {},
): Promise<void> {
  const ctors = opts.ctors ?? {};
  for (const name of plugins) {
    const Ctor = ctors[name];
    if (!Ctor) {
      throw new Error(
        `registerCloudBackends: no constructor injected for '${name}'. ` +
          `Pass {ctors: { ${name}: <Backend> }} or rely on the plugin loader.`,
      );
    }
    const backend = new Ctor({ proxy });
    await BackendRegistry.register(backend, { ...opts, skipToolProbe: true });
  }
}
