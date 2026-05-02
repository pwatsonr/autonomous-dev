/**
 * SPEC-023-1-01 parameter-validator tests.
 *
 * Each branch of `validateParameters` (number range, enum membership,
 * string formats: path, shell-safe-arg, identifier, url, default-deny)
 * has a positive and a negative case. Acceptance criteria from the spec
 * are mapped 1:1 onto `it()` blocks.
 *
 * @module tests/deploy/parameters.test
 */

import { validateParameters } from '../../intake/deploy/parameters';

describe('SPEC-023-1-01 validateParameters: number/range', () => {
  it('accepts in-range integers', () => {
    const r = validateParameters(
      { port: { type: 'number', range: [1024, 65535] } },
      { port: 8080 },
    );
    expect(r.valid).toBe(true);
    expect(r.sanitized.port).toBe(8080);
  });

  it('rejects values below the lower bound', () => {
    const r = validateParameters(
      { port: { type: 'number', range: [1024, 65535] } },
      { port: 80 },
    );
    expect(r.valid).toBe(false);
    expect(r.errors.find((e) => e.key === 'port')?.message).toMatch(/range/);
  });

  it('rejects non-finite numbers', () => {
    const r = validateParameters(
      { x: { type: 'number' } },
      { x: Number.POSITIVE_INFINITY },
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0].message).toMatch(/finite/);
  });

  it('rejects non-number types', () => {
    const r = validateParameters({ x: { type: 'number' } }, { x: '42' });
    expect(r.valid).toBe(false);
  });
});

describe('SPEC-023-1-01 validateParameters: enum', () => {
  it('accepts allowed enum values', () => {
    const r = validateParameters(
      { mode: { type: 'enum', enum: ['dev', 'prod'] as const } },
      { mode: 'dev' },
    );
    expect(r.valid).toBe(true);
    expect(r.sanitized.mode).toBe('dev');
  });

  it('rejects values outside the enum', () => {
    const r = validateParameters(
      { mode: { type: 'enum', enum: ['dev', 'prod'] as const } },
      { mode: 'staging' },
    );
    expect(r.valid).toBe(false);
  });
});

describe('SPEC-023-1-01 validateParameters: format=path', () => {
  it('accepts ordinary absolute paths', () => {
    const r = validateParameters(
      { target: { type: 'string', format: 'path' } },
      { target: '/var/www/site' },
    );
    expect(r.valid).toBe(true);
    expect(r.sanitized.target).toBe('/var/www/site');
  });

  it('rejects denylisted system paths', () => {
    const r = validateParameters(
      { target: { type: 'string', format: 'path' } },
      { target: '/etc/passwd' },
    );
    expect(r.valid).toBe(false);
  });

  it('rejects ".." traversal segments', () => {
    const r = validateParameters(
      { target: { type: 'string', format: 'path' } },
      { target: '/var/www/../etc' },
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0].message).toMatch(/traversal|\.\./);
  });

  it('rejects URL-encoded traversal', () => {
    const r = validateParameters(
      { target: { type: 'string', format: 'path' } },
      { target: '/var/www/%2e%2e/etc' },
    );
    expect(r.valid).toBe(false);
  });

  it('rejects empty paths', () => {
    const r = validateParameters(
      { target: { type: 'string', format: 'path' } },
      { target: '' },
    );
    expect(r.valid).toBe(false);
  });

  it('rejects NUL bytes', () => {
    const r = validateParameters(
      { target: { type: 'string', format: 'path' } },
      { target: '/var/www/\0evil' },
    );
    expect(r.valid).toBe(false);
  });
});

describe('SPEC-023-1-01 validateParameters: default-deny shell metacharacters', () => {
  const SCHEMA = { s: { type: 'string' as const } };

  for (const meta of [';', '|', '&', '$', '`', '<', '>', '\n', '\r', '\0', '(', ')']) {
    it(`rejects strings containing ${JSON.stringify(meta)}`, () => {
      const r = validateParameters(SCHEMA, { s: `safe${meta}value` });
      expect(r.valid).toBe(false);
    });
  }

  it('accepts plain alphanumeric strings', () => {
    const r = validateParameters(SCHEMA, { s: 'hello world 123' });
    expect(r.valid).toBe(true);
  });
});

describe('SPEC-023-1-01 validateParameters: format=shell-safe-arg', () => {
  it('accepts allowlisted characters', () => {
    const r = validateParameters(
      { v: { type: 'string', format: 'shell-safe-arg' } },
      { v: 'npm run build' },
    );
    expect(r.valid).toBe(true);
  });

  it('rejects $ even under shell-safe-arg', () => {
    const r = validateParameters(
      { v: { type: 'string', format: 'shell-safe-arg' } },
      { v: 'echo $HOME' },
    );
    expect(r.valid).toBe(false);
  });
});

describe('SPEC-023-1-01 validateParameters: format=identifier', () => {
  it('accepts simple identifiers', () => {
    const r = validateParameters(
      { v: { type: 'string', format: 'identifier' } },
      { v: 'gh-pages' },
    );
    expect(r.valid).toBe(true);
  });

  it('rejects identifiers with whitespace', () => {
    const r = validateParameters(
      { v: { type: 'string', format: 'identifier' } },
      { v: 'gh pages' },
    );
    expect(r.valid).toBe(false);
  });

  it('rejects identifiers starting with a digit', () => {
    const r = validateParameters(
      { v: { type: 'string', format: 'identifier' } },
      { v: '1foo' },
    );
    expect(r.valid).toBe(false);
  });
});

describe('SPEC-023-1-01 validateParameters: format=url', () => {
  it('accepts https URLs', () => {
    const r = validateParameters(
      { u: { type: 'string', format: 'url' } },
      { u: 'https://example.com/health' },
    );
    expect(r.valid).toBe(true);
  });

  it('accepts http URLs', () => {
    const r = validateParameters(
      { u: { type: 'string', format: 'url' } },
      { u: 'http://localhost:8080' },
    );
    expect(r.valid).toBe(true);
  });

  it('rejects file URLs', () => {
    const r = validateParameters(
      { u: { type: 'string', format: 'url' } },
      { u: 'file:///etc/passwd' },
    );
    expect(r.valid).toBe(false);
  });

  it('rejects malformed URLs', () => {
    const r = validateParameters(
      { u: { type: 'string', format: 'url' } },
      { u: 'not a url' },
    );
    expect(r.valid).toBe(false);
  });
});

describe('SPEC-023-1-01 validateParameters: required + defaults', () => {
  it('reports an error when a required key is missing', () => {
    const r = validateParameters(
      { x: { type: 'string', required: true } },
      {},
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0].key).toBe('x');
    expect(r.errors[0].message).toMatch(/required/);
  });

  it('applies defaults when key is absent', () => {
    const r = validateParameters(
      { branch: { type: 'string', default: 'main', format: 'identifier' } },
      {},
    );
    expect(r.valid).toBe(true);
    expect(r.sanitized.branch).toBe('main');
  });

  it('rejects unknown extra parameters', () => {
    const r = validateParameters(
      { x: { type: 'string' } },
      { x: 'ok', extra: 'nope' },
    );
    expect(r.valid).toBe(false);
    expect(r.errors.find((e) => e.key === 'extra')).toBeDefined();
  });
});

describe('SPEC-023-1-01 validateParameters: boolean', () => {
  it('accepts true and false', () => {
    expect(validateParameters({ b: { type: 'boolean' } }, { b: true }).valid).toBe(true);
    expect(validateParameters({ b: { type: 'boolean' } }, { b: false }).valid).toBe(true);
  });
  it('rejects truthy non-booleans', () => {
    expect(validateParameters({ b: { type: 'boolean' } }, { b: 1 }).valid).toBe(false);
    expect(validateParameters({ b: { type: 'boolean' } }, { b: 'true' }).valid).toBe(false);
  });
});
