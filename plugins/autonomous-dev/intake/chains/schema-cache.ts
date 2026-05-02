/**
 * Memoized AJV compile cache keyed by `(artifact_type, schema_version)`
 * (SPEC-022-3-01).
 *
 * The strict-schema consumer boundary needs to compile the consumer's
 * declared `(artifactType, schemaVersion)` pair on demand because validation
 * happens with `removeAdditional: 'all'` (a payload-mutating mode that the
 * default `ArtifactRegistry` AJV instance — strict + non-mutating — cannot
 * provide).
 *
 * The cache:
 *   - returns the same `ValidateFunction` for repeat calls (no recompile);
 *   - throws `SchemaNotFoundError` when the resolver has no schema for the
 *     pair (caller distinguishes from `SchemaValidationError`);
 *   - exposes a test-only `clearSchemaCache()` so suites can reset state.
 *
 * The schema resolver is INJECTED so production code can point it at the
 * shipped `<schemaRoot>/<type>/<version>.json` tree while tests can supply
 * an in-memory map.
 *
 * @module intake/chains/schema-cache
 */

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import { SchemaNotFoundError } from './types';

/**
 * Resolves a schema body for `(artifactType, schemaVersion)`. Returns
 * `null`/`undefined` when the pair is unknown so the cache can throw
 * `SchemaNotFoundError`. Synchronous because the production resolver loads
 * pre-warmed schemas from memory; tests use plain object lookups.
 */
export type SchemaResolver = (
  artifactType: string,
  schemaVersion: string,
) => object | null | undefined;

/** Lazily-initialized AJV instance shared by every cached validator. */
let ajv: Ajv2020 | null = null;

function getAjv(): Ajv2020 {
  if (ajv) return ajv;
  ajv = new Ajv2020({
    // Strip any field not declared in the schema. This is the consumer
    // boundary's primary defense: a producer leaking `extra_data: 'leak'`
    // is silently dropped before the consumer ever sees it.
    removeAdditional: 'all',
    useDefaults: true,
    // Coercion would silently convert `"1"` to `1`; we want strict types.
    coerceTypes: false,
    allErrors: false,
    // Permissive in keyword names — schemas may carry forward-compatible
    // extension keywords (e.g. `x-allow-extensions`). Strict structural
    // checks are still on by virtue of `additionalProperties: false` in
    // the schemas themselves.
    strict: false,
  });
  addFormats(ajv);
  return ajv;
}

/** key = `${artifactType}@${schemaVersion}` */
const cache = new Map<string, ValidateFunction>();

/** Counter for tests that want to assert `ajv.compile` ran exactly once. */
let compileCount = 0;

/**
 * Return (creating if necessary) a strict-mode `ValidateFunction` for the
 * `(artifactType, schemaVersion)` pair. Throws `SchemaNotFoundError` when
 * the resolver has no schema for the pair.
 *
 * The returned validator MUTATES its input (strips additional properties).
 * Callers that need to preserve the original payload should clone it first.
 */
export function getValidator(
  artifactType: string,
  schemaVersion: string,
  schemaResolver: SchemaResolver,
): ValidateFunction {
  const key = `${artifactType}@${schemaVersion}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const schema = schemaResolver(artifactType, schemaVersion);
  if (!schema) throw new SchemaNotFoundError(artifactType, schemaVersion);
  const validator = getAjv().compile(schema as object);
  compileCount += 1;
  cache.set(key, validator);
  return validator;
}

/** Test-only: drop every cached validator and reset the AJV instance. */
export function clearSchemaCache(): void {
  cache.clear();
  ajv = null;
  compileCount = 0;
}

/** Test-only: number of times `ajv.compile` ran since the last clear. */
export function getCompileCount(): number {
  return compileCount;
}
