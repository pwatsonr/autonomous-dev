/**
 * Content-level artifact sanitizer (SPEC-022-3-02).
 *
 * Runs AFTER strict-schema validation: at this point AJV has already
 * stripped any field the consumer did not declare, so the sanitizer can
 * trust the structure and focus on hostile CONTENT inside known fields:
 *
 *   - `format: 'path'`        → reject `..`, reject absolute paths
 *                                outside the request worktree, reject
 *                                empty strings.
 *   - `format: 'uri'`         → require `https://` scheme.
 *   - `format: 'shell-command'` → permissive (opt-in).
 *   - default (no format)      → reject shell metacharacters.
 *
 * Default-deny: any string field without an explicit `format` declaration
 * is treated as untrusted text and may not contain `;`, `|`, `&`,
 * `` ` ``, `$(`, `${`, `>`, or `<`.
 *
 * The walker recurses into nested `properties` and `items` schemas using
 * a JSON-Pointer-style traversal. When the schema is unknown for a path
 * (no `properties.<key>` or `items` to descend into), the sanitizer
 * applies the default-deny rule. This makes the sanitizer fail-safe: an
 * incomplete schema can never silently let malicious content through.
 *
 * Throws `SanitizationError` on the FIRST violation; subsequent fields
 * are not scanned (short-circuit).
 *
 * @module intake/chains/sanitizer
 */

import * as path from 'node:path';

import { SanitizationError } from './types';

/**
 * Sanitize a payload against its declaring schema. Walks `payload` and
 * `schema` in lockstep, throwing `SanitizationError` on the first
 * violation. Mutates nothing.
 *
 * @param artifactType for inclusion in the error.
 * @param payload      the post-validate payload (already strict-stripped).
 * @param schema       the JSON Schema body the payload was validated against.
 * @param worktreePath absolute path to the request's worktree, used for
 *                     containment checks on `format: 'path'` fields.
 */
export function sanitizeArtifact(
  artifactType: string,
  payload: unknown,
  schema: object,
  worktreePath: string,
): void {
  walk(payload, schema as JsonSchema, '', {
    artifactType,
    worktreePath: path.resolve(worktreePath),
  });
}

interface WalkCtx {
  artifactType: string;
  worktreePath: string;
}

/**
 * Subset of JSON Schema shape the sanitizer cares about. Other keywords
 * (`anyOf`, `oneOf`, `$ref`, …) are intentionally ignored — the
 * default-deny rule kicks in when a string lacks a recognized `format`.
 */
interface JsonSchema {
  type?: string | string[];
  format?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  $defs?: Record<string, JsonSchema>;
}

const SHELL_METACHARS = [';', '|', '&', '`', '$(', '${', '>', '<'];

function walk(
  value: unknown,
  schema: JsonSchema | undefined,
  fieldPath: string,
  ctx: WalkCtx,
): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    checkString(value, schema, fieldPath, ctx);
    return;
  }
  if (Array.isArray(value)) {
    const itemSchema = schema?.items;
    for (let i = 0; i < value.length; i++) {
      const childPath = fieldPath ? `${fieldPath}[${i}]` : `[${i}]`;
      walk(value[i], itemSchema, childPath, ctx);
    }
    return;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const props = schema?.properties;
    for (const key of Object.keys(obj)) {
      const childSchema = props ? props[key] : undefined;
      const childPath = fieldPath ? `${fieldPath}.${key}` : key;
      walk(obj[key], childSchema, childPath, ctx);
    }
    return;
  }
  // Numbers, booleans: nothing to sanitize.
}

function checkString(
  value: string,
  schema: JsonSchema | undefined,
  fieldPath: string,
  ctx: WalkCtx,
): void {
  const format = schema?.format;
  if (format === 'shell-command') {
    // Opt-in permissive — caller knows the field carries shell content.
    return;
  }
  if (format === 'path') {
    checkPath(value, fieldPath, ctx);
    return;
  }
  if (format === 'uri') {
    checkUri(value, fieldPath, ctx);
    return;
  }
  // Default-deny on free-form strings.
  checkShellMetacharacters(value, fieldPath, ctx);
}

function checkPath(value: string, fieldPath: string, ctx: WalkCtx): void {
  if (value.length === 0) {
    throw new SanitizationError(
      ctx.artifactType,
      fieldPath,
      'path-traversal',
      value,
    );
  }
  // Reject any literal `..` segment regardless of position. Also reject
  // URL-encoded `%2e%2e` defensively (we do NOT decode; presence of the
  // literal sequence is suspicious enough to refuse).
  if (
    value.includes('..') ||
    value.toLowerCase().includes('%2e%2e')
  ) {
    throw new SanitizationError(
      ctx.artifactType,
      fieldPath,
      'path-traversal',
      value,
    );
  }
  if (path.isAbsolute(value)) {
    const resolved = path.resolve(value);
    const root = ctx.worktreePath;
    const inside =
      resolved === root || resolved.startsWith(root + path.sep);
    if (!inside) {
      throw new SanitizationError(
        ctx.artifactType,
        fieldPath,
        'absolute-path-outside-worktree',
        value,
      );
    }
  }
}

function checkUri(value: string, fieldPath: string, ctx: WalkCtx): void {
  if (!value.startsWith('https://')) {
    throw new SanitizationError(
      ctx.artifactType,
      fieldPath,
      'non-https-uri',
      value,
    );
  }
}

function checkShellMetacharacters(
  value: string,
  fieldPath: string,
  ctx: WalkCtx,
): void {
  for (const meta of SHELL_METACHARS) {
    if (value.includes(meta)) {
      throw new SanitizationError(
        ctx.artifactType,
        fieldPath,
        'shell-metacharacter',
        value,
      );
    }
  }
}
