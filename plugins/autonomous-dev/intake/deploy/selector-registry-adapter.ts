/**
 * Adapter exposing the production `BackendRegistry` (static class) as a
 * `SelectorBackendRegistry` (SPEC-023-2-02).
 *
 * The selector deliberately does NOT depend on the singleton — it takes
 * a `SelectorBackendRegistry` instance so unit tests can inject stubs.
 * This adapter bridges the two for production code paths.
 *
 * @module intake/deploy/selector-registry-adapter
 */

import { BackendRegistry } from './registry';
import { PARAM_SCHEMA as DOCKER_LOCAL_SCHEMA } from './backends/docker-local';
import { PARAM_SCHEMA as GITHUB_PAGES_SCHEMA } from './backends/github-pages';
import { PARAM_SCHEMA as LOCAL_SCHEMA } from './backends/local';
import { PARAM_SCHEMA as STATIC_SCHEMA } from './backends/static';
import type { ParamSchema } from './parameters';
import type { SelectorBackendRegistry } from './selector';

/**
 * Map of backend name -> exported parameter schema. Mirrors
 * `cli/deploy_backends_command.ts` so adding a new backend requires
 * extending exactly one place per consumer (selector + describe CLI).
 */
const PARAM_SCHEMAS: Record<string, Record<string, ParamSchema>> = {
  local: LOCAL_SCHEMA,
  static: STATIC_SCHEMA,
  'docker-local': DOCKER_LOCAL_SCHEMA,
  'github-pages': GITHUB_PAGES_SCHEMA,
};

/**
 * Backend default-parameter map. Backends in PLAN-023-1 do not currently
 * carry separate `defaultParameters`; the schema's per-key `default`
 * field serves the same purpose and is applied by `validateParameters`.
 * This adapter therefore returns an empty defaults map and lets the
 * validator pull defaults from the schema.
 */
const DEFAULT_PARAMETERS: Record<string, Record<string, unknown>> = {
  local: {},
  static: {},
  'docker-local': {},
  'github-pages': {},
};

export const productionSelectorRegistry: SelectorBackendRegistry = {
  has(name: string): boolean {
    return BackendRegistry.list().some((e) => e.backend.metadata.name === name);
  },
  getSchema(name: string): Record<string, ParamSchema> | undefined {
    return PARAM_SCHEMAS[name];
  },
  getDefaults(name: string): Record<string, unknown> {
    return DEFAULT_PARAMETERS[name] ?? {};
  },
  listNames(): string[] {
    return BackendRegistry.list()
      .map((e) => e.backend.metadata.name)
      .sort();
  },
};
