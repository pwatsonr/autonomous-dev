/**
 * Custom AJV keywords for the autonomous-dev hook validation vocabulary
 * (SPEC-019-2-02, Task 4).
 *
 * Two keywords:
 *   - `x-allow-extensions`  — string[] of property names exempt from the
 *     pipeline's removeAdditional:'all' policy. Compile-time mutator: each
 *     listed name is spliced into `properties` as a permissive entry so AJV
 *     does not strip it.
 *   - `x-redact-on-failure` — string[] of JSON-pointer-ish paths whose
 *     values must be scrubbed from emitted error messages and params.
 *
 * The redaction floor is broader than user declarations: any field whose
 * name (case-insensitive) matches `/(secret|token|password|key|credential)/`
 * is auto-redacted even with no explicit declaration. Users SHOULD still
 * declare `x-redact-on-failure` for sensitive fields whose names don't
 * happen to match (e.g., `connectionString`).
 *
 * `registerCustomKeywords(ajv)` is idempotent: a repeat call is a no-op.
 *
 * @module intake/hooks/keywords
 */

import type Ajv from 'ajv';
import type { ValidationError } from './types';

/**
 * Default auto-redaction field-name pattern.
 *
 * Case-insensitive. Matches anywhere within a path segment so e.g.
 * `/credentials/apiKey` triggers on both `credentials` and `apiKey`.
 */
export const AUTO_REDACT_FIELD_RE = /(secret|token|password|key|credential)/i;

/** Sentinel string substituted in for redacted values. */
export const REDACTED = '[REDACTED]';

/**
 * Register `x-allow-extensions` and `x-redact-on-failure` on the supplied
 * AJV instance. Idempotent — checks for existing definitions first.
 */
export function registerCustomKeywords(ajv: Ajv): void {
  if (!ajv.getKeyword('x-allow-extensions')) {
    ajv.addKeyword({
      keyword: 'x-allow-extensions',
      type: 'object',
      schemaType: 'array',
      modifying: true,
      // Compile-time effect: splice each allowed name into `properties` as
      // a permissive entry so removeAdditional:'all' won't strip it. The
      // returned validate function is a no-op — the schema mutation is the
      // actual contract.
      compile: (allowed: unknown, parentSchema: unknown) => {
        if (Array.isArray(allowed) && parentSchema && typeof parentSchema === 'object') {
          const ps = parentSchema as Record<string, unknown>;
          const props = (ps.properties as Record<string, unknown> | undefined) ?? {};
          for (const name of allowed) {
            if (typeof name === 'string' && !(name in props)) {
              props[name] = {};
            }
          }
          ps.properties = props;
        }
        return () => true;
      },
    });
  }

  if (!ajv.getKeyword('x-redact-on-failure')) {
    ajv.addKeyword({
      keyword: 'x-redact-on-failure',
      schemaType: 'array',
      // No-op at validate time. The pipeline applies the redaction in
      // postProcessErrors using getRedactPathsFromSchema(validator.schema).
      validate: () => true,
    });
  }
}

/**
 * Walk a compiled schema (or any object) collecting every value found
 * under any `x-redact-on-failure` array, recursively. Returned paths are
 * de-duplicated.
 */
export function getRedactPathsFromSchema(schema: unknown): string[] {
  const out = new Set<string>();
  const seen = new Set<unknown>();

  function visit(node: unknown): void {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    const obj = node as Record<string, unknown>;
    const decl = obj['x-redact-on-failure'];
    if (Array.isArray(decl)) {
      for (const p of decl) {
        if (typeof p === 'string') out.add(p);
      }
    }
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) {
        for (const item of v) visit(item);
      } else if (v && typeof v === 'object') {
        visit(v);
      }
    }
  }

  visit(schema);
  return Array.from(out);
}

/**
 * Apply x-redact-on-failure (and the auto-redact floor) to a list of
 * validation errors.
 *
 * Algorithm:
 *   1. Walk `payload` collecting string-coerced values at every redacted
 *      path AND every field whose name matches AUTO_REDACT_FIELD_RE.
 *   2. For each error, replace any occurrence of those values inside the
 *      message and params (recursively) with `REDACTED`.
 *
 * The instancePath and message-template structure are preserved so
 * downstream consumers can still tell what failed.
 */
export function redactErrors(
  errors: ValidationError[],
  payload: unknown,
  redactPaths: string[],
): ValidationError[] {
  const valuesToScrub = new Set<string>();
  collectValuesAtPaths(payload, redactPaths, valuesToScrub);
  collectAutoRedactValues(payload, valuesToScrub);

  if (valuesToScrub.size === 0) return errors;

  const scrubbed = Array.from(valuesToScrub).filter((v) => v.length > 0);
  return errors.map((err) => ({
    ...err,
    message: scrubString(err.message, scrubbed),
    params: err.params ? (scrubObject(err.params, scrubbed) as Record<string, unknown>) : err.params,
  }));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function collectValuesAtPaths(
  payload: unknown,
  paths: string[],
  out: Set<string>,
): void {
  if (paths.length === 0) return;
  for (const p of paths) {
    walkPath(payload, p, out);
  }
}

function collectAutoRedactValues(payload: unknown, out: Set<string>): void {
  function visit(node: unknown): void {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (AUTO_REDACT_FIELD_RE.test(key)) {
        addStringValue(value, out);
      }
      visit(value);
    }
  }
  visit(payload);
}

function walkPath(payload: unknown, jsonPointer: string, out: Set<string>): void {
  // Tokenize the JSON-pointer path. A `**` segment matches zero-or-more
  // segments. Empty pointer means root.
  if (!jsonPointer.startsWith('/')) {
    // Tolerate authors who write 'foo/bar' instead of '/foo/bar'.
    walkPath(payload, '/' + jsonPointer, out);
    return;
  }
  const segments = jsonPointer.split('/').slice(1);
  matchSegments(payload, segments, out);
}

function matchSegments(node: unknown, segments: string[], out: Set<string>): void {
  if (segments.length === 0) {
    addStringValue(node, out);
    return;
  }
  const [head, ...rest] = segments;
  if (node === null || typeof node !== 'object') return;

  if (head === '**') {
    // Match zero segments...
    matchSegments(node, rest, out);
    // ...or one-or-more by recursing into every child.
    if (Array.isArray(node)) {
      for (const item of node) matchSegments(item, segments, out);
    } else {
      for (const v of Object.values(node)) matchSegments(v, segments, out);
    }
    return;
  }

  if (head === '*') {
    if (Array.isArray(node)) {
      for (const item of node) matchSegments(item, rest, out);
    } else {
      for (const v of Object.values(node)) matchSegments(v, rest, out);
    }
    return;
  }

  if (Array.isArray(node)) {
    const idx = Number(head);
    if (Number.isInteger(idx) && idx >= 0 && idx < node.length) {
      matchSegments(node[idx], rest, out);
    }
    return;
  }

  const obj = node as Record<string, unknown>;
  if (head in obj) {
    matchSegments(obj[head], rest, out);
  }
}

function addStringValue(value: unknown, out: Set<string>): void {
  if (typeof value === 'string' && value.length > 0) {
    out.add(value);
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    out.add(String(value));
  } else if (value && typeof value === 'object') {
    // Recursively collect leaves.
    if (Array.isArray(value)) {
      for (const v of value) addStringValue(v, out);
    } else {
      for (const v of Object.values(value)) addStringValue(v, out);
    }
  }
}

function scrubString(s: string, values: string[]): string {
  if (!s) return s;
  let out = s;
  for (const v of values) {
    if (!v) continue;
    // Plain string replacement (no regex) — values may contain regex meta.
    if (out.includes(v)) {
      out = out.split(v).join(REDACTED);
    }
  }
  return out;
}

function scrubObject(o: unknown, values: string[]): unknown {
  if (o === null || o === undefined) return o;
  if (typeof o === 'string') return scrubString(o, values);
  if (typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.map((v) => scrubObject(v, values));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    out[k] = scrubObject(v, values);
  }
  return out;
}
