/**
 * One-shot registration of the four bundled backends (SPEC-023-1-04).
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
