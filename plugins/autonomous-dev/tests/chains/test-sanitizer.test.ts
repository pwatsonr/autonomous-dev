/**
 * SPEC-022-3-02 sanitizer tests.
 *
 * Covers each schema-format-driven rule (path, uri, shell-command, default)
 * plus recursion into nested objects and arrays. The sanitizer runs AFTER
 * strict-schema validation, so by contract it never sees fields the
 * consumer did not declare.
 *
 * @module tests/chains/test-sanitizer
 */

import { sanitizeArtifact } from '../../intake/chains/sanitizer';
import { SanitizationError } from '../../intake/chains/types';

const PATH_SCHEMA = {
  type: 'object',
  properties: { p: { type: 'string', format: 'path' } },
};
const URI_SCHEMA = {
  type: 'object',
  properties: { u: { type: 'string', format: 'uri' } },
};
const SHELL_SCHEMA = {
  type: 'object',
  properties: { c: { type: 'string', format: 'shell-command' } },
};
const FREEFORM_SCHEMA = {
  type: 'object',
  properties: { s: { type: 'string' } },
};

const WORKTREE = '/tmp/wt';

describe('SPEC-022-3-02 sanitizer: path format', () => {
  it("rejects '..' path traversal anywhere in the value", () => {
    let caught: SanitizationError | null = null;
    try {
      sanitizeArtifact('test', { p: '../../../etc/passwd' }, PATH_SCHEMA, WORKTREE);
    } catch (err) {
      caught = err as SanitizationError;
    }
    expect(caught).toBeInstanceOf(SanitizationError);
    expect(caught?.rule).toBe('path-traversal');
    expect(caught?.fieldPath).toBe('p');
  });

  it('rejects URL-encoded `%2e%2e` defensively', () => {
    expect(() =>
      sanitizeArtifact('test', { p: 'a/%2e%2e/b' }, PATH_SCHEMA, WORKTREE),
    ).toThrow(SanitizationError);
  });

  it('rejects empty path strings', () => {
    let caught: SanitizationError | null = null;
    try {
      sanitizeArtifact('test', { p: '' }, PATH_SCHEMA, WORKTREE);
    } catch (err) {
      caught = err as SanitizationError;
    }
    expect(caught).toBeInstanceOf(SanitizationError);
    expect(caught?.rule).toBe('path-traversal');
  });

  it('rejects absolute paths outside the worktree', () => {
    let caught: SanitizationError | null = null;
    try {
      sanitizeArtifact('test', { p: '/etc/passwd' }, PATH_SCHEMA, WORKTREE);
    } catch (err) {
      caught = err as SanitizationError;
    }
    expect(caught).toBeInstanceOf(SanitizationError);
    expect(caught?.rule).toBe('absolute-path-outside-worktree');
  });

  it('accepts absolute paths INSIDE the worktree', () => {
    expect(() =>
      sanitizeArtifact('test', { p: '/tmp/wt/src/foo.ts' }, PATH_SCHEMA, WORKTREE),
    ).not.toThrow();
  });

  it('accepts relative paths inside the worktree (no traversal segment)', () => {
    expect(() =>
      sanitizeArtifact('test', { p: 'src/foo.ts' }, PATH_SCHEMA, WORKTREE),
    ).not.toThrow();
  });
});

describe('SPEC-022-3-02 sanitizer: uri format', () => {
  it('rejects http://', () => {
    let caught: SanitizationError | null = null;
    try {
      sanitizeArtifact('test', { u: 'http://example.com' }, URI_SCHEMA, WORKTREE);
    } catch (err) {
      caught = err as SanitizationError;
    }
    expect(caught).toBeInstanceOf(SanitizationError);
    expect(caught?.rule).toBe('non-https-uri');
  });

  it('rejects javascript:', () => {
    expect(() =>
      sanitizeArtifact(
        'test',
        { u: 'javascript:alert(1)' },
        URI_SCHEMA,
        WORKTREE,
      ),
    ).toThrow(SanitizationError);
  });

  it.each([
    ['file://', 'file:///etc/passwd'],
    ['data:', 'data:text/plain,hi'],
    ['ftp:', 'ftp://example.com'],
  ])('rejects %s scheme', (_label, uri) => {
    expect(() =>
      sanitizeArtifact('test', { u: uri }, URI_SCHEMA, WORKTREE),
    ).toThrow(SanitizationError);
  });

  it('accepts https://', () => {
    expect(() =>
      sanitizeArtifact(
        'test',
        { u: 'https://example.com/x' },
        URI_SCHEMA,
        WORKTREE,
      ),
    ).not.toThrow();
  });
});

describe('SPEC-022-3-02 sanitizer: shell-command format (opt-in permissive)', () => {
  it('accepts metacharacters in a shell-command field', () => {
    expect(() =>
      sanitizeArtifact(
        'test',
        { c: 'cat a.txt | grep x; echo "$VAR"' },
        SHELL_SCHEMA,
        WORKTREE,
      ),
    ).not.toThrow();
  });
});

describe('SPEC-022-3-02 sanitizer: default-deny on free-form strings', () => {
  it.each([';', '|', '&', '`', '$(', '${', '>', '<'])(
    "rejects metachar '%s'",
    (meta) => {
      let caught: SanitizationError | null = null;
      try {
        sanitizeArtifact(
          'test',
          { s: `payload ${meta} malicious` },
          FREEFORM_SCHEMA,
          WORKTREE,
        );
      } catch (err) {
        caught = err as SanitizationError;
      }
      expect(caught).toBeInstanceOf(SanitizationError);
      expect(caught?.rule).toBe('shell-metacharacter');
    },
  );

  it('accepts a clean string', () => {
    expect(() =>
      sanitizeArtifact('test', { s: 'hello world' }, FREEFORM_SCHEMA, WORKTREE),
    ).not.toThrow();
  });
});

describe('SPEC-022-3-02 sanitizer: recursion', () => {
  it('descends into nested objects with the right field path', () => {
    const schema = {
      type: 'object',
      properties: {
        a: {
          type: 'object',
          properties: {
            b: { type: 'string', format: 'path' },
          },
        },
      },
    };
    let caught: SanitizationError | null = null;
    try {
      sanitizeArtifact('test', { a: { b: '../foo' } }, schema, WORKTREE);
    } catch (err) {
      caught = err as SanitizationError;
    }
    expect(caught).toBeInstanceOf(SanitizationError);
    expect(caught?.fieldPath).toBe('a.b');
  });

  it('descends into arrays with bracket-indexed field path', () => {
    const schema = {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string', format: 'path' },
        },
      },
    };
    let caught: SanitizationError | null = null;
    try {
      sanitizeArtifact(
        'test',
        { paths: ['ok/file.ts', '../bad'] },
        schema,
        WORKTREE,
      );
    } catch (err) {
      caught = err as SanitizationError;
    }
    expect(caught).toBeInstanceOf(SanitizationError);
    expect(caught?.fieldPath).toBe('paths[1]');
  });

  it('first violation short-circuits (does NOT continue scanning)', () => {
    // Two bad paths; expect the first one's fieldPath only.
    const schema = {
      type: 'object',
      properties: {
        a: { type: 'string', format: 'path' },
        b: { type: 'string', format: 'path' },
      },
    };
    let caught: SanitizationError | null = null;
    try {
      sanitizeArtifact(
        'test',
        { a: '../first', b: '../second' },
        schema,
        WORKTREE,
      );
    } catch (err) {
      caught = err as SanitizationError;
    }
    expect(caught?.fieldPath).toBe('a');
  });

  it('default-deny on a string field whose schema has no format', () => {
    // Even if the schema declares the field as a plain string (no format),
    // shell metachars must trigger the default rule.
    expect(() =>
      sanitizeArtifact(
        'test',
        { s: 'rm -rf / | sh' },
        FREEFORM_SCHEMA,
        WORKTREE,
      ),
    ).toThrow(SanitizationError);
  });

  it('null/undefined and primitive numbers/booleans are skipped', () => {
    const schema = {
      type: 'object',
      properties: {
        s: { type: 'string' },
        n: { type: 'number' },
        b: { type: 'boolean' },
      },
    };
    expect(() =>
      sanitizeArtifact(
        'test',
        { s: 'safe', n: 42, b: true },
        schema,
        WORKTREE,
      ),
    ).not.toThrow();
  });
});

describe('SPEC-022-3-02 sanitizer: error shape', () => {
  it('SanitizationError carries artifactType, fieldPath, rule, offendingValue', () => {
    let err: SanitizationError | null = null;
    try {
      sanitizeArtifact(
        'security-findings',
        { p: '../etc/passwd' },
        PATH_SCHEMA,
        WORKTREE,
      );
    } catch (e) {
      err = e as SanitizationError;
    }
    expect(err).toBeInstanceOf(SanitizationError);
    expect(err?.artifactType).toBe('security-findings');
    expect(err?.fieldPath).toBe('p');
    expect(err?.rule).toBe('path-traversal');
    expect(err?.offendingValue).toBe('../etc/passwd');
    expect(err?.code).toBe('SANITIZATION_FAILED');
  });

  it('truncates very long offendingValue in the message', () => {
    const long = 'a'.repeat(200) + ';danger';
    let err: SanitizationError | null = null;
    try {
      sanitizeArtifact('t', { s: long }, FREEFORM_SCHEMA, WORKTREE);
    } catch (e) {
      err = e as SanitizationError;
    }
    expect(err?.message.length).toBeLessThan(200);
  });
});
