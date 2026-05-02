/**
 * Deterministic backend selector + parameter merging (SPEC-023-2-02).
 *
 * Pure function over `(SelectionContext) -> BackendSelection`. Walks the
 * four-priority order specified in TDD-023 §10:
 *
 *   1. `request-override` (CLI `--backend`)
 *   2. `env-config`       (ResolvedEnvironment.backend, when source==='deploy.yaml')
 *   3. `repo-default`     (DeployConfig.default_backend)
 *   4. `fallback`         ("local")
 *
 * The selector MUST NOT invoke the backend, MUST NOT touch the filesystem,
 * MUST NOT emit telemetry; the orchestrator owns those side effects so a
 * single deploy emits a single selection event.
 *
 * Cross-reference: SPEC-023-2-02, TDD-023 §10.
 *
 * @module intake/deploy/selector
 */

import { ParameterValidationError, UnknownBackendError } from './errors';
import {
  validateParameters,
  type ParamSchema,
  type ParamValidationResult,
} from './parameters';
import type { ResolvedEnvironment } from './types-config';

/** Where the backend name came from. Locked enum (telemetry contract). */
export type SelectionSource =
  | 'request-override'
  | 'env-config'
  | 'repo-default'
  | 'fallback';

/**
 * Minimal abstraction over `BackendRegistry` so this module is unit-testable
 * without touching the registry singleton. Implementations:
 *   - `BackendRegistryAdapter` (production: wraps the static registry)
 *   - `makeStubRegistry()`     (tests)
 */
export interface SelectorBackendRegistry {
  /** Schema for the named backend, or undefined if not registered. */
  getSchema(name: string): Record<string, ParamSchema> | undefined;
  /** Default parameter values for the named backend (may be empty). */
  getDefaults(name: string): Record<string, unknown>;
  /** Whether the backend is registered. */
  has(name: string): boolean;
  /** Sorted list of registered backend names (for error messages). */
  listNames(): string[];
}

/** Optional per-request override (e.g., CLI `--backend`). */
export interface SelectionOverride {
  backend: string;
}

/** Inputs to `selectBackend`. */
export interface SelectionContext {
  /** Resolver output (SPEC-023-2-01). */
  resolved: ResolvedEnvironment;
  /** Backend lookup. */
  registry: SelectorBackendRegistry;
  /** Optional CLI / API override. */
  override?: SelectionOverride;
  /** Mirrors `DeployConfig.default_backend`; not on `resolved`. */
  repoDefaultBackend?: string;
}

/** Output of `selectBackend`. */
export interface BackendSelection {
  /** Selected backend name. */
  backendName: string;
  /** Where the name came from (telemetry-bound). */
  source: SelectionSource;
  /** Validated, sanitized parameters ready for `backend.deploy()`. */
  parameters: Record<string, string | number | boolean>;
  /** Pass-through for telemetry. */
  envName: string;
}

/**
 * Apply the four-priority order, verify the backend is registered, merge
 * `defaults <- env params`, and validate. Throws `UnknownBackendError`
 * or `ParameterValidationError` on the respective failures.
 *
 * Pure: same inputs always produce the same output.
 */
export function selectBackend(ctx: SelectionContext): BackendSelection {
  // 1. Determine backend name + source.
  let backendName: string;
  let source: SelectionSource;

  if (ctx.override && ctx.override.backend.length > 0) {
    backendName = ctx.override.backend;
    source = 'request-override';
  } else if (ctx.resolved.source === 'deploy.yaml') {
    backendName = ctx.resolved.backend;
    source = 'env-config';
  } else if (ctx.repoDefaultBackend && ctx.repoDefaultBackend.length > 0) {
    backendName = ctx.repoDefaultBackend;
    source = 'repo-default';
  } else {
    backendName = 'local';
    source = 'fallback';
  }

  // 2. Verify registration.
  if (!ctx.registry.has(backendName)) {
    throw new UnknownBackendError(backendName, ctx.registry.listNames());
  }

  // 3. Merge: defaults <- env params (shallow).
  const defaults = ctx.registry.getDefaults(backendName);
  const envParams = ctx.resolved.parameters ?? {};
  const merged = mergeParameters(defaults, envParams);

  // 4. Validate against the backend's schema.
  const schema = ctx.registry.getSchema(backendName) ?? {};
  const result: ParamValidationResult = validateParameters(schema, merged);
  if (!result.valid) {
    throw new ParameterValidationError(truncateErrors(result.errors));
  }

  return {
    backendName,
    source,
    parameters: result.sanitized,
    envName: ctx.resolved.envName,
  };
}

/**
 * Shallow merge: keys in `envParams` override `defaults`. Nested objects
 * and arrays are REPLACED (not deep-merged) — predictable beats clever.
 */
export function mergeParameters(
  defaults: Record<string, unknown>,
  envParams: Record<string, unknown>,
): Record<string, unknown> {
  return { ...defaults, ...envParams };
}

/**
 * Truncate any string parameter value longer than 64 chars in error
 * messages so secrets accidentally passed as parameters don't leak via
 * stderr / telemetry. We rewrite the per-key `message` field defensively.
 */
function truncateErrors(
  errors: readonly { key: string; message: string }[],
): { key: string; message: string }[] {
  const MAX = 64;
  return errors.map((e) => {
    if (e.message.length <= MAX) return { key: e.key, message: e.message };
    return { key: e.key, message: `${e.message.slice(0, MAX)}...` };
  });
}
