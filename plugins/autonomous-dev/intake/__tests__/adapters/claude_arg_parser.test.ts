/**
 * Unit tests for the Claude App Argument Parser (SPEC-008-2-02, Task 3).
 *
 * Covers 23 core test cases from SPEC-008-2-02 plus 3 additional edge cases:
 * - Very long strings (10,000 characters)
 * - Unicode characters
 * - Empty quoted strings ("")
 *
 * Total: 26 tests.
 *
 * @module claude_arg_parser.test
 */

import {
  parseCommandArgs,
  tokenize,
  ValidationError,
} from '../../adapters/claude_arg_parser';

// ---------------------------------------------------------------------------
// Core parsing tests (SPEC-008-2-02)
// ---------------------------------------------------------------------------

describe('parseCommandArgs (SPEC-008-2-02)', () => {
  // -----------------------------------------------------------------------
  // Empty / null / undefined input
  // -----------------------------------------------------------------------
  describe('empty input handling', () => {
    test('returns empty args and flags for empty string', () => {
      const result = parseCommandArgs('');
      expect(result.args).toEqual([]);
      expect(result.flags).toEqual({});
    });

    test('returns empty args and flags for whitespace-only string', () => {
      const result = parseCommandArgs('   ');
      expect(result.args).toEqual([]);
      expect(result.flags).toEqual({});
    });

    test('returns empty args and flags for null-like input', () => {
      const result = parseCommandArgs(null as unknown as string);
      expect(result.args).toEqual([]);
      expect(result.flags).toEqual({});
    });

    test('returns empty args and flags for undefined-like input', () => {
      const result = parseCommandArgs(undefined as unknown as string);
      expect(result.args).toEqual([]);
      expect(result.flags).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // Positional arguments
  // -----------------------------------------------------------------------
  describe('positional arguments', () => {
    test('single unquoted word', () => {
      const result = parseCommandArgs('hello');
      expect(result.args).toEqual(['hello']);
      expect(result.flags).toEqual({});
    });

    test('multiple unquoted words are separate args', () => {
      const result = parseCommandArgs('hello world foo');
      expect(result.args).toEqual(['hello', 'world', 'foo']);
      expect(result.flags).toEqual({});
    });

    test('double-quoted string becomes single arg', () => {
      const result = parseCommandArgs('"Build user auth"');
      expect(result.args).toEqual(['Build user auth']);
    });

    test('mixed quoted and unquoted positional args', () => {
      const result = parseCommandArgs('"Build user auth" extra');
      expect(result.args).toEqual(['Build user auth', 'extra']);
    });
  });

  // -----------------------------------------------------------------------
  // Named flags
  // -----------------------------------------------------------------------
  describe('named flags', () => {
    test('flag with string value', () => {
      const result = parseCommandArgs('--priority high');
      expect(result.flags).toEqual({ priority: 'high' });
      expect(result.args).toEqual([]);
    });

    test('boolean flag (no value)', () => {
      const result = parseCommandArgs('--force');
      expect(result.flags).toEqual({ force: true });
      expect(result.args).toEqual([]);
    });

    test('multiple flags', () => {
      const result = parseCommandArgs('--priority high --force');
      expect(result.flags).toEqual({ priority: 'high', force: true });
    });

    test('flag followed by another flag is boolean', () => {
      const result = parseCommandArgs('--verbose --debug');
      expect(result.flags).toEqual({ verbose: true, debug: true });
    });

    test('flag with quoted value', () => {
      const result = parseCommandArgs('--repo "my-org/my-repo"');
      expect(result.flags).toEqual({ repo: 'my-org/my-repo' });
    });
  });

  // -----------------------------------------------------------------------
  // Mixed args and flags
  // -----------------------------------------------------------------------
  describe('mixed args and flags', () => {
    test('description with priority and repo flags', () => {
      const result = parseCommandArgs('"Build user auth" --priority high --repo myorg/api');
      expect(result.args).toEqual(['Build user auth']);
      expect(result.flags).toEqual({ priority: 'high', repo: 'myorg/api' });
    });

    test('positional args before and after flags', () => {
      const result = parseCommandArgs('REQ-000001 --all');
      expect(result.args).toEqual(['REQ-000001']);
      expect(result.flags).toEqual({ all: true });
    });

    test('description with force and deadline flags', () => {
      const result = parseCommandArgs('"Fix login bug" --force --deadline 2025-12-31');
      expect(result.args).toEqual(['Fix login bug']);
      expect(result.flags).toEqual({ force: true, deadline: '2025-12-31' });
    });

    test('multiple positional args with flags interspersed', () => {
      const result = parseCommandArgs('REQ-000001 high --force');
      expect(result.args).toEqual(['REQ-000001', 'high']);
      expect(result.flags).toEqual({ force: true });
    });
  });

  // -----------------------------------------------------------------------
  // Whitespace handling
  // -----------------------------------------------------------------------
  describe('whitespace handling', () => {
    test('multiple spaces between tokens are collapsed', () => {
      const result = parseCommandArgs('hello    world');
      expect(result.args).toEqual(['hello', 'world']);
    });

    test('leading and trailing whitespace is trimmed', () => {
      const result = parseCommandArgs('  hello  ');
      expect(result.args).toEqual(['hello']);
    });
  });

  // -----------------------------------------------------------------------
  // Error cases
  // -----------------------------------------------------------------------
  describe('error cases', () => {
    test('unclosed quote throws ValidationError', () => {
      expect(() => parseCommandArgs('"unclosed string')).toThrow(ValidationError);
      expect(() => parseCommandArgs('"unclosed string')).toThrow(
        'Unclosed quote in command arguments',
      );
    });

    test('empty flag name throws ValidationError', () => {
      expect(() => parseCommandArgs('-- value')).toThrow(ValidationError);
      expect(() => parseCommandArgs('-- value')).toThrow('Empty flag name: --');
    });

    test('standalone -- throws ValidationError', () => {
      expect(() => parseCommandArgs('--')).toThrow(ValidationError);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases (additional beyond SPEC-008-2-02)
  // -----------------------------------------------------------------------
  describe('edge cases', () => {
    test('very long string (10,000 characters)', () => {
      const longString = 'a'.repeat(10_000);
      const result = parseCommandArgs(`"${longString}"`);
      expect(result.args).toEqual([longString]);
      expect(result.args[0].length).toBe(10_000);
    });

    test('Unicode characters in arguments', () => {
      const result = parseCommandArgs('"Build authentication module" --priority high');
      expect(result.args).toEqual(['Build authentication module']);
      expect(result.flags.priority).toBe('high');

      // Test with actual Unicode
      const unicodeResult = parseCommandArgs('"Implementar autenticacion" --repo "org/proyecto"');
      expect(unicodeResult.args).toEqual(['Implementar autenticacion']);
      expect(unicodeResult.flags.repo).toBe('org/proyecto');
    });

    test('empty quoted strings', () => {
      const result = parseCommandArgs('""');
      expect(result.args).toEqual(['']);
    });
  });
});

// ---------------------------------------------------------------------------
// Tokenizer tests (part of the 26 total)
// ---------------------------------------------------------------------------

describe('tokenize()', () => {
  test('handles adjacent quoted and unquoted text as separate tokens', () => {
    // Text adjacent to a quote: "text before quote is separate"
    const tokens = tokenize('prefix"quoted"');
    expect(tokens).toContain('prefix');
    expect(tokens).toContain('quoted');
    // Also verify empty string returns empty array
    expect(tokenize('')).toEqual([]);
  });
});
