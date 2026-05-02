/**
 * Server-side parameter validation framework (SPEC-023-1-01, Task 2).
 *
 * Cross-reference: TDD-023 §7. Backends NEVER see raw operator input —
 * the orchestrator runs `validateParameters(schema, values)` and forwards
 * only `result.sanitized` (an immutable typed map) to the backend.
 *
 * Defense in depth: every backend additionally invokes external commands
 * via `runTool` (`execFile`, `shell: false`), so even if a malicious
 * value somehow slipped past validation it would not be interpreted as a
 * shell metacharacter.
 *
 * @module intake/deploy/parameters
 */

/** Format hints that pick the per-string validator. */
export type ParamFormat = 'path' | 'shell-safe-arg' | 'url' | 'identifier';

/**
 * Per-key schema. `type: 'enum'` requires `enum` to be set; `type: 'number'`
 * may set `range`; `type: 'string'` may set `regex` and/or `format`.
 */
export interface ParamSchema {
  type: 'string' | 'number' | 'boolean' | 'enum';
  required?: boolean;
  default?: string | number | boolean;
  /** Required iff `type === 'enum'`. */
  enum?: readonly string[];
  /** String regex. Applied AFTER format checks, so format takes priority. */
  regex?: RegExp;
  /** Inclusive `[min, max]` for `type: 'number'`. */
  range?: [number, number];
  /** Pick a string validator. Omitted formats fall through to default-deny. */
  format?: ParamFormat;
}

/** Result of `validateParameters`. */
export interface ParamValidationResult {
  valid: boolean;
  /** Validated + defaulted values. Empty when `valid` is false. */
  sanitized: Record<string, string | number | boolean>;
  errors: { key: string; message: string }[];
}

// ---------------------------------------------------------------------------
// Character allowlists / denylists
// ---------------------------------------------------------------------------

/**
 * Default-deny: any string that lacks `format: 'shell-safe-arg'` or
 * another permissive format MUST NOT contain these. They are precisely
 * the characters a hostile shell expansion could weaponize.
 */
const SHELL_METACHARS = [
  ';', '|', '&', '$', '`', '>', '<', '\n', '\r', '\0', '(', ')', '{', '}',
];

/**
 * `format: 'shell-safe-arg'` allowlist. We deliberately exclude `+` and
 * `,` so that even an `execFile` slot containing a future shell wrapper
 * could not interpret the value as a glob list.
 */
const SHELL_SAFE_ARG_RE = /^[A-Za-z0-9._\-/=: ]+$/;

/** `format: 'identifier'` allowlist; common project conventions. */
const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_\-]*$/;

/**
 * Denylisted absolute path roots for `format: 'path'`. Even a "valid"
 * absolute path under `/etc/`, `/proc/`, or `/sys/` is rejected because
 * those are system-control surfaces.
 */
const PATH_DENYLISTED_ROOTS = ['/etc/', '/proc/', '/sys/'];
const PATH_DENYLISTED_EQUAL = ['/etc', '/proc', '/sys'];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a `values` map against `schema`. Returns `{valid, sanitized,
 * errors}`. On failure, `sanitized` is an empty object (callers MUST
 * check `valid` before consuming `sanitized`).
 *
 * Defaults are applied BEFORE per-key validation so a default like
 * `{ default: '/', format: 'path' }` still goes through the path
 * validator.
 */
export function validateParameters(
  schema: Record<string, ParamSchema>,
  values: Record<string, unknown>,
): ParamValidationResult {
  const errors: { key: string; message: string }[] = [];
  const out: Record<string, string | number | boolean> = {};

  for (const key of Object.keys(schema)) {
    const spec = schema[key];
    const present = Object.prototype.hasOwnProperty.call(values, key);
    let raw: unknown = values[key];

    if (!present || raw === undefined || raw === null) {
      if (spec.default !== undefined) {
        raw = spec.default;
      } else if (spec.required) {
        errors.push({ key, message: 'required parameter missing' });
        continue;
      } else {
        // Not required, no default → omit from sanitized.
        continue;
      }
    }

    const result = validateOne(key, spec, raw);
    if (result.error) {
      errors.push({ key, message: result.error });
    } else if (result.value !== undefined) {
      out[key] = result.value;
    }
  }

  // Reject extra keys NOT in schema — closed-world to prevent operators
  // from sneaking in undeclared parameters that the validator did not vet.
  for (const key of Object.keys(values)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      errors.push({ key, message: 'unknown parameter' });
    }
  }

  if (errors.length > 0) {
    return { valid: false, sanitized: {}, errors };
  }
  return { valid: true, sanitized: out, errors: [] };
}

// ---------------------------------------------------------------------------
// Per-type validators
// ---------------------------------------------------------------------------

interface OneResult {
  value?: string | number | boolean;
  error?: string;
}

function validateOne(key: string, spec: ParamSchema, raw: unknown): OneResult {
  switch (spec.type) {
    case 'boolean':
      return validateBoolean(raw);
    case 'number':
      return validateNumber(raw, spec);
    case 'enum':
      return validateEnum(raw, spec);
    case 'string':
      return validateString(raw, spec);
    default:
      return { error: `unsupported schema type: ${(spec as { type: string }).type}` };
  }
}

function validateBoolean(raw: unknown): OneResult {
  if (typeof raw === 'boolean') return { value: raw };
  return { error: 'expected boolean' };
}

function validateNumber(raw: unknown, spec: ParamSchema): OneResult {
  if (typeof raw !== 'number') return { error: 'expected number' };
  if (!Number.isFinite(raw)) return { error: 'must be finite' };
  if (spec.range) {
    const [min, max] = spec.range;
    if (raw < min || raw > max) {
      return { error: `out of range [${min}, ${max}]` };
    }
  }
  return { value: raw };
}

function validateEnum(raw: unknown, spec: ParamSchema): OneResult {
  if (!spec.enum) return { error: "enum schema missing 'enum' member list" };
  if (typeof raw !== 'string') return { error: 'expected string for enum' };
  if (!spec.enum.includes(raw)) {
    return { error: `not in allowed set [${spec.enum.join(', ')}]` };
  }
  return { value: raw };
}

function validateString(raw: unknown, spec: ParamSchema): OneResult {
  if (typeof raw !== 'string') return { error: 'expected string' };

  switch (spec.format) {
    case 'path': {
      const pathErr = checkPath(raw);
      if (pathErr) return { error: pathErr };
      break;
    }
    case 'shell-safe-arg': {
      if (!SHELL_SAFE_ARG_RE.test(raw)) {
        return {
          error:
            'contains characters outside [A-Za-z0-9._\\-/=: ] (shell-safe-arg)',
        };
      }
      // Even shell-safe-arg explicitly forbids the metachar set as a
      // belt-and-braces measure.
      const meta = findShellMeta(raw);
      if (meta) return { error: `contains shell metacharacter: ${meta}` };
      break;
    }
    case 'identifier': {
      if (!IDENTIFIER_RE.test(raw)) {
        return { error: 'must match identifier [A-Za-z][A-Za-z0-9_\\-]*' };
      }
      break;
    }
    case 'url': {
      const urlErr = checkUrl(raw);
      if (urlErr) return { error: urlErr };
      break;
    }
    default: {
      // No format declared → default-deny shell metacharacters.
      const meta = findShellMeta(raw);
      if (meta) return { error: `contains shell metacharacter: ${meta}` };
    }
  }

  if (spec.regex && !spec.regex.test(raw)) {
    return { error: `does not match required pattern ${spec.regex.source}` };
  }
  return { value: raw };
}

// ---------------------------------------------------------------------------
// String-format helpers
// ---------------------------------------------------------------------------

function findShellMeta(value: string): string | null {
  for (const meta of SHELL_METACHARS) {
    if (value.includes(meta)) {
      // Render NUL/newlines visibly in the error message.
      if (meta === '\0') return '\\0';
      if (meta === '\n') return '\\n';
      if (meta === '\r') return '\\r';
      return meta;
    }
  }
  return null;
}

function checkPath(value: string): string | null {
  if (value.length === 0) return 'path is empty';
  if (value.includes('\0')) return 'path contains NUL byte';
  if (value.includes('..')) return 'path contains ".." traversal segment';
  // Defensive: reject URL-encoded `..` even though we never decode.
  if (value.toLowerCase().includes('%2e%2e')) {
    return 'path contains encoded ".." traversal segment';
  }
  for (const root of PATH_DENYLISTED_EQUAL) {
    if (value === root) return `path under denylisted root '${root}'`;
  }
  for (const root of PATH_DENYLISTED_ROOTS) {
    if (value.startsWith(root)) {
      return `path under denylisted root '${root.replace(/\/$/, '')}'`;
    }
  }
  return null;
}

function checkUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'not a valid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `unsupported URL protocol '${parsed.protocol}' (expected http: or https:)`;
  }
  return null;
}
