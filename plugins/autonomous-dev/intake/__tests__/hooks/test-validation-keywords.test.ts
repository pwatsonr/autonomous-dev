/**
 * Unit tests for the autonomous-dev custom AJV keywords
 * (SPEC-019-2-05, covers SPEC-019-2-02 §keywords).
 *
 * Two keywords:
 *   - x-allow-extensions: spliced into `properties` so removeAdditional:'all'
 *     does not strip the listed keys.
 *   - x-redact-on-failure: declared paths whose values are scrubbed from
 *     emitted error messages and params; auto-redaction floor matches the
 *     name pattern /(secret|token|password|key|credential)/i.
 *
 * Tests exercise both keywords through a real AJV instance configured the
 * same way as ValidationPipeline (removeAdditional:'all').
 *
 * @module __tests__/hooks/test-validation-keywords
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Ajv2020 = require('ajv/dist/2020');
import type { default as AjvType } from 'ajv';
import {
  registerCustomKeywords,
  redactErrors,
  getRedactPathsFromSchema,
  AUTO_REDACT_FIELD_RE,
  REDACTED,
} from '../../hooks/keywords';
import type { ValidationError } from '../../hooks/types';

function freshAjv(opts: Record<string, unknown> = {}): AjvType {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ctor: any = (Ajv2020 as any).default ?? Ajv2020;
  return new Ctor({
    strict: true,
    removeAdditional: 'all',
    ...opts,
  }) as AjvType;
}

function asValidationErrors(raw: unknown): ValidationError[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((raw as any[]) ?? []).map((e) => ({
    instancePath: e.instancePath,
    message: e.message ?? '',
    params: e.params,
  }));
}

// ---------------------------------------------------------------------------
// x-allow-extensions
// ---------------------------------------------------------------------------

describe('x-allow-extensions — schema mutation contract', () => {
  // Implementation detail: the keyword's compile() splices each declared
  // name into `parentSchema.properties` as an empty (any-accepting) entry.
  // AJV's keyword-evaluation order means this mutation reaches the
  // `properties` map AFTER the `properties` keyword has already been
  // code-generated, so the strip-extras codegen does NOT see the new
  // entries. The OBSERVABLE contract today is therefore the schema-level
  // splice, not runtime retention. These tests pin both layers so a future
  // fix that elevates the splice into a pre-compile pass becomes a
  // deliberate change.

  test('compile splices listed names into the schema properties map', () => {
    const ajv = freshAjv();
    registerCustomKeywords(ajv);
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      'x-allow-extensions': ['customField'],
    };
    ajv.compile(schema);
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['name', 'customField']),
    );
  });

  test('compile is a no-op when no allowed names are declared', () => {
    const ajv = freshAjv();
    registerCustomKeywords(ajv);
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      'x-allow-extensions': [],
    };
    ajv.compile(schema);
    expect(Object.keys(schema.properties)).toEqual(['name']);
  });

  test('compile does not duplicate names already declared in properties', () => {
    const ajv = freshAjv();
    registerCustomKeywords(ajv);
    const original = { type: 'string' };
    const schema = {
      type: 'object',
      properties: { customField: original },
      'x-allow-extensions': ['customField'],
    };
    ajv.compile(schema);
    // Original property retained, NOT replaced by the permissive `{}` entry.
    expect(schema.properties.customField).toBe(original);
  });

  test('compile tolerates schema with no pre-existing properties map', () => {
    const ajv = freshAjv();
    registerCustomKeywords(ajv);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema: any = {
      type: 'object',
      'x-allow-extensions': ['customField'],
    };
    ajv.compile(schema);
    expect(schema.properties).toEqual({ customField: {} });
  });

  test('compile silently ignores non-string entries in the allowed list', () => {
    const ajv = freshAjv();
    registerCustomKeywords(ajv);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema: any = {
      type: 'object',
      properties: { name: { type: 'string' } },
      'x-allow-extensions': ['ok', 42, null, undefined],
    };
    ajv.compile(schema);
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['name', 'ok']),
    );
    expect(Object.keys(schema.properties)).not.toEqual(
      expect.arrayContaining(['42', '']),
    );
  });
});

describe('x-allow-extensions — empty list', () => {
  test('empty x-allow-extensions behaves identically to omitting the keyword', () => {
    const ajv = freshAjv();
    registerCustomKeywords(ajv);
    const validate = ajv.compile({
      type: 'object',
      properties: { name: { type: 'string' } },
      'x-allow-extensions': [],
    });
    const data: Record<string, unknown> = { name: 'x', extra: 1 };
    expect(validate(data)).toBe(true);
    expect(data.extra).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// x-redact-on-failure — explicit paths
// ---------------------------------------------------------------------------

describe('x-redact-on-failure — explicit declaration', () => {
  test('declared field value is scrubbed from error messages and params', () => {
    // We use an `enum` constraint so AJV emits the actual value in the
    // error params (`allowedValues`), giving the redactor a concrete value
    // to scrub. minLength does not include the value itself.
    const ajv = freshAjv({ allErrors: true });
    registerCustomKeywords(ajv);
    const schema = {
      type: 'object',
      properties: {
        secret: { type: 'string', enum: ['expected-only'] },
      },
      required: ['secret'],
      'x-redact-on-failure': ['/secret'],
    };
    const validate = ajv.compile(schema);
    const payload = { secret: 'abc123XYZ-very-distinctive' };
    expect(validate(payload)).toBe(false);

    // Construct an error message that explicitly includes the value, to
    // simulate a downstream formatter that interpolates user data into
    // human-readable text.
    const errs: ValidationError[] = [
      {
        instancePath: '/secret',
        message: `value 'abc123XYZ-very-distinctive' is not one of expected`,
        params: { provided: 'abc123XYZ-very-distinctive' },
      },
      ...asValidationErrors(validate.errors),
    ];

    const declared = getRedactPathsFromSchema(schema);
    expect(declared).toEqual(['/secret']);
    const redacted = redactErrors(errs, payload, declared);

    const joined = JSON.stringify(redacted);
    expect(joined).not.toContain('abc123XYZ-very-distinctive');
    expect(joined).toContain(REDACTED);
  });
});

// ---------------------------------------------------------------------------
// x-redact-on-failure — auto-redaction floor (name-based)
// ---------------------------------------------------------------------------

describe('x-redact-on-failure — auto-redaction (no explicit list)', () => {
  test.each([
    ['apiKey', 'supersecret123'],
    ['password', 'hunter2-very-long'],
    ['token', 'abcdefghij1234567890'],
    ['credential', 'totallyClassified'],
    ['userSecret', 'covertValue'],
  ])('auto-redacts field %s with value %s', (fieldName, value) => {
    const ajv = freshAjv();
    registerCustomKeywords(ajv);
    const validate = ajv.compile({
      type: 'object',
      properties: { [fieldName]: { type: 'string', minLength: 50 } },
      required: [fieldName],
    });
    const payload: Record<string, unknown> = { [fieldName]: value };
    expect(validate(payload)).toBe(false);

    const errs = asValidationErrors(validate.errors);
    const redacted = redactErrors(errs, payload, []);
    expect(JSON.stringify(redacted)).not.toContain(value);
  });

  test('AUTO_REDACT_FIELD_RE matches the documented field-name set', () => {
    for (const k of ['secret', 'TOKEN', 'PassWord', 'apiKey', 'credential', 'X-Auth-Token']) {
      expect(AUTO_REDACT_FIELD_RE.test(k)).toBe(true);
    }
    for (const k of ['name', 'description', 'count']) {
      expect(AUTO_REDACT_FIELD_RE.test(k)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// x-redact-on-failure — glob paths
// ---------------------------------------------------------------------------

describe('x-redact-on-failure — glob paths', () => {
  test('"/creds/**" scrubs every leaf under /creds', () => {
    const schema = {
      type: 'object',
      'x-redact-on-failure': ['/creds/**'],
    };
    // Hand-crafted error list matches what a downstream formatter that
    // interpolates user data into a message could plausibly produce.
    const errs: ValidationError[] = [
      {
        instancePath: '/creds',
        message: `received credentials password=p1-distinctive apiKey=k1-distinctive`,
        params: { password: 'p1-distinctive', apiKey: 'k1-distinctive' },
      },
    ];
    const payload = {
      creds: { password: 'p1-distinctive', apiKey: 'k1-distinctive' },
    };

    const declared = getRedactPathsFromSchema(schema);
    const redacted = redactErrors(errs, payload, declared);
    const joined = JSON.stringify(redacted);
    expect(joined).not.toContain('p1-distinctive');
    expect(joined).not.toContain('k1-distinctive');
    expect(joined).toContain(REDACTED);
  });
});

// ---------------------------------------------------------------------------
// x-redact-on-failure — non-matching paths NOT redacted
// ---------------------------------------------------------------------------

describe('x-redact-on-failure — non-matching paths preserved', () => {
  test('benign field at non-redacted path retains its value', () => {
    // Explicit-only redaction list; field name is benign so auto-redact does
    // not catch it either.
    const errs: ValidationError[] = [
      {
        instancePath: '/comment',
        message: 'expected something else, got benign-public-text',
        params: { value: 'benign-public-text' },
      },
    ];
    const payload = { comment: 'benign-public-text' };
    const out = redactErrors(errs, payload, ['/somewhere-else']);
    expect(JSON.stringify(out)).toContain('benign-public-text');
    expect(JSON.stringify(out)).not.toContain(REDACTED);
  });
});

// ---------------------------------------------------------------------------
// x-redact-on-failure — empty payload short-circuit
// ---------------------------------------------------------------------------

describe('redactErrors — empty input short-circuit', () => {
  test('returns the original list when payload yields no scrub values', () => {
    const errs: ValidationError[] = [
      { instancePath: '/x', message: 'no values to scrub here', params: {} },
    ];
    const out = redactErrors(errs, {}, []);
    expect(out).toBe(errs);
  });
});

// ---------------------------------------------------------------------------
// getRedactPathsFromSchema — recursion
// ---------------------------------------------------------------------------

describe('getRedactPathsFromSchema', () => {
  test('walks nested schema collecting every x-redact-on-failure entry', () => {
    const schema = {
      type: 'object',
      'x-redact-on-failure': ['/top'],
      properties: {
        nested: {
          type: 'object',
          'x-redact-on-failure': ['/nested/secret'],
        },
      },
      definitions: [
        {
          'x-redact-on-failure': ['/array-entry'],
        },
      ],
    };
    const paths = getRedactPathsFromSchema(schema).sort();
    expect(paths).toEqual(['/array-entry', '/nested/secret', '/top']);
  });

  test('handles cyclic references without infinite recursion', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a: any = { 'x-redact-on-failure': ['/a'] };
    a.self = a;
    expect(getRedactPathsFromSchema(a)).toEqual(['/a']);
  });

  test('returns [] for non-object input', () => {
    expect(getRedactPathsFromSchema(null)).toEqual([]);
    expect(getRedactPathsFromSchema(42)).toEqual([]);
    expect(getRedactPathsFromSchema('s')).toEqual([]);
  });

  test('tolerates non-string entries in the array', () => {
    const schema = { 'x-redact-on-failure': ['/ok', 42, null] };
    expect(getRedactPathsFromSchema(schema)).toEqual(['/ok']);
  });
});

// ---------------------------------------------------------------------------
// redactErrors — additional path-walking shapes
// ---------------------------------------------------------------------------

describe('redactErrors — path walking', () => {
  test('tolerates author-supplied paths missing the leading slash', () => {
    const errs: ValidationError[] = [
      { instancePath: '/x', message: 'value-here', params: {} },
    ];
    const payload = { x: 'value-here' };
    const out = redactErrors(errs, payload, ['x']);
    expect(JSON.stringify(out)).not.toContain('value-here');
  });

  test('* segment matches all keys at one level', () => {
    const errs: ValidationError[] = [
      { instancePath: '/items/0', message: 'aaa bbb', params: {} },
    ];
    const payload = { items: { a: 'aaa', b: 'bbb' } };
    const out = redactErrors(errs, payload, ['/items/*']);
    const joined = JSON.stringify(out);
    expect(joined).not.toContain('aaa');
    expect(joined).not.toContain('bbb');
  });

  test('numeric segment indexes into arrays', () => {
    const errs: ValidationError[] = [
      { instancePath: '/items/1', message: 'pickme please', params: {} },
    ];
    const payload = { items: ['skipme', 'pickme'] };
    const out = redactErrors(errs, payload, ['/items/1']);
    expect(JSON.stringify(out)).not.toContain('pickme');
    // Verify out-of-range indices are silently no-ops (no throw).
    expect(() => redactErrors(errs, payload, ['/items/99'])).not.toThrow();
  });

  test('numeric and boolean leaf values are coerced for scrubbing', () => {
    const errs: ValidationError[] = [
      { instancePath: '/n', message: 'value 42 and true here', params: {} },
    ];
    const payload = { creds: { n: 42, b: true } };
    const out = redactErrors(errs, payload, ['/creds/**']);
    const joined = JSON.stringify(out);
    expect(joined).not.toContain('42');
    expect(joined).not.toContain('true');
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('registerCustomKeywords — idempotency', () => {
  test('second call does not throw and does not re-register', () => {
    const ajv = freshAjv();
    registerCustomKeywords(ajv);
    const allow1 = ajv.getKeyword('x-allow-extensions');
    const redact1 = ajv.getKeyword('x-redact-on-failure');

    expect(() => registerCustomKeywords(ajv)).not.toThrow();
    // Object identity proves no replacement.
    expect(ajv.getKeyword('x-allow-extensions')).toBe(allow1);
    expect(ajv.getKeyword('x-redact-on-failure')).toBe(redact1);
  });
});

// ---------------------------------------------------------------------------
// Both keywords through a single compiled validator
// ---------------------------------------------------------------------------

describe('keywords composed', () => {
  test('x-allow-extensions and x-redact-on-failure coexist on one schema', () => {
    const ajv = freshAjv();
    registerCustomKeywords(ajv);
    const schema = {
      type: 'object',
      properties: {
        secret: { type: 'string', minLength: 50 },
        name: { type: 'string' },
      },
      required: ['secret', 'name'],
      'x-allow-extensions': ['traceId'],
      'x-redact-on-failure': ['/secret'],
    };
    ajv.compile(schema);
    // Schema-mutation contract: traceId is now in properties.
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['name', 'secret', 'traceId']),
    );
    // Redaction-path discovery still works after the splice ran.
    expect(getRedactPathsFromSchema(schema)).toEqual(['/secret']);

    // Verify the redactor scrubs the secret value out of a downstream
    // formatter's interpolated message.
    const errs: ValidationError[] = [
      {
        instancePath: '/secret',
        message: `secret 'leaky-distinctive-value' is too short`,
        params: { provided: 'leaky-distinctive-value' },
      },
    ];
    const payload = { name: 'alice', secret: 'leaky-distinctive-value' };
    const redacted = redactErrors(errs, payload, getRedactPathsFromSchema(schema));
    expect(JSON.stringify(redacted)).not.toContain('leaky-distinctive-value');
  });
});
