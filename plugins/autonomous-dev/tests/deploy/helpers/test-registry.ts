/**
 * Stub `SelectorBackendRegistry` for SPEC-023-2 unit + integration tests.
 *
 * The selector is decoupled from the production singleton so tests can
 * inject deterministic backends here without touching `BackendRegistry`.
 *
 * @module tests/deploy/helpers/test-registry
 */

import type { ParamSchema } from '../../../intake/deploy/parameters';
import type { SelectorBackendRegistry } from '../../../intake/deploy/selector';

interface StubEntry {
  schema?: Record<string, ParamSchema>;
  defaults?: Record<string, unknown>;
}

export function makeStubRegistry(
  entries: Record<string, StubEntry> = defaultEntries(),
): SelectorBackendRegistry {
  return {
    has(name) {
      return Object.prototype.hasOwnProperty.call(entries, name);
    },
    getSchema(name) {
      return entries[name]?.schema;
    },
    getDefaults(name) {
      return entries[name]?.defaults ?? {};
    },
    listNames() {
      return Object.keys(entries).sort();
    },
  };
}

export function defaultEntries(): Record<string, StubEntry> {
  return {
    'local-stub': { schema: {}, defaults: {} },
    'static-stub': {
      schema: {
        target_dir: { type: 'string', format: 'path', required: false },
      },
      defaults: {},
    },
    'docker-stub': {
      schema: {
        port: { type: 'number', range: [1024, 65535] },
        host: { type: 'string' },
      },
      defaults: { host: '0.0.0.0' },
    },
  };
}
