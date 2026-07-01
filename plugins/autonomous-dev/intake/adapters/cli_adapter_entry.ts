/**
 * CLI adapter entry point — exposes a `routerProvider` accessor for
 * programmatic callers (e.g. the self-improvement `submit.ts`) that need
 * to submit requests without going through the CLI argument parser.
 *
 * This is an ADDITIVE export; all existing exports in `cli_adapter.ts`
 * are unaffected.
 *
 * @module intake/adapters/cli_adapter_entry
 */

export { initRouter, buildCommand, type IntakeRouterLike } from './cli_adapter';
import type { IntakeRouterLike } from './cli_adapter';

/**
 * Lazily-initialised production router instance.
 *
 * Returns the same `IntakeRouterLike` instance used by the CLI adapter's
 * `dispatch('submit', ...)` path. The router is initialised on first call
 * and cached for subsequent invocations within the same process.
 *
 * @returns A promise resolving to the production `IntakeRouterLike`.
 */
export async function routerProvider(): Promise<IntakeRouterLike> {
  const { initRouter } = await import('./cli_adapter');
  return initRouter();
}

// Re-export IntakeRouterLike so external consumers can import from a single
// location.
export type { IntakeRouterLike as SubmitRouter } from './cli_adapter';
