/**
 * Type guard + parser tests for `intake/types/request_source.ts`
 * (SPEC-012-2-04, test file 3 of 3).
 *
 * Covers:
 *  - REQUEST_SOURCES contains exactly the 6 documented values.
 *  - isRequestSource: true for each of the 6 valid values; false for
 *    unknown strings, casing variants, empty string, and non-strings
 *    (null, undefined, numbers, arrays, objects).
 *  - parseAdapterMetadata: accepts each per-source allowed shape and
 *    drops excess fields; returns `{}` for null / undefined / empty
 *    objects without `source`; throws ValidationError on unknown
 *    `source` values and on non-object inputs (string, number, array).
 *  - Discriminated union narrows correctly after a `source` check.
 *
 * @module __tests__/types/request_source.test
 */

import {
  REQUEST_SOURCES,
  ValidationError,
  isRequestSource,
  parseAdapterMetadata,
  type AdapterMetadata,
  type RequestSource,
} from '../../types/request_source';

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe('REQUEST_SOURCES', () => {
  test('contains exactly the 6 documented values, in declaration order', () => {
    expect(REQUEST_SOURCES).toEqual([
      'cli',
      'claude-app',
      'discord',
      'slack',
      'production-intelligence',
      'portal',
    ]);
    expect(REQUEST_SOURCES).toHaveLength(6);
  });
});

describe('isRequestSource()', () => {
  test('returns true for each of the 6 valid sources', () => {
    for (const src of REQUEST_SOURCES) {
      expect(isRequestSource(src)).toBe(true);
    }
  });

  test('returns false for unknown strings', () => {
    const bad = [
      'urgent',
      'unknown',
      'CLI', // wrong case
      'Discord', // wrong case
      'claude_app', // underscore vs hyphen
      'production_intelligence',
      '',
    ];
    for (const v of bad) {
      expect(isRequestSource(v)).toBe(false);
    }
  });

  test('returns false for non-string inputs', () => {
    const nonStrings: unknown[] = [
      null,
      undefined,
      123,
      0,
      true,
      false,
      [],
      ['cli'],
      {},
      { source: 'cli' },
    ];
    for (const v of nonStrings) {
      expect(isRequestSource(v)).toBe(false);
    }
  });

  test('narrows the type when used as a guard', () => {
    const v: unknown = 'discord';
    if (isRequestSource(v)) {
      // After the guard, `v` is RequestSource — assignment must compile.
      const narrowed: RequestSource = v;
      expect(narrowed).toBe('discord');
    } else {
      throw new Error('expected isRequestSource to accept "discord"');
    }
  });
});

describe('parseAdapterMetadata() — null / empty handling', () => {
  test('returns {} for null', () => {
    expect(parseAdapterMetadata(null)).toEqual({});
  });

  test('returns {} for undefined', () => {
    expect(parseAdapterMetadata(undefined)).toEqual({});
  });

  test('returns {} for empty object (no source key)', () => {
    expect(parseAdapterMetadata({})).toEqual({});
  });

  test('returns {} for object without source key but with extras', () => {
    expect(parseAdapterMetadata({ foo: 'bar', count: 1 })).toEqual({});
  });
});

describe('parseAdapterMetadata() — non-object inputs', () => {
  test('throws ValidationError for a string', () => {
    expect(() => parseAdapterMetadata('cli')).toThrow(ValidationError);
  });

  test('throws ValidationError for a number', () => {
    expect(() => parseAdapterMetadata(123)).toThrow(ValidationError);
  });

  test('throws ValidationError for a boolean', () => {
    expect(() => parseAdapterMetadata(true)).toThrow(ValidationError);
  });

  test('throws ValidationError for an array', () => {
    expect(() => parseAdapterMetadata([1, 2, 3])).toThrow(ValidationError);
  });
});

describe('parseAdapterMetadata() — unknown source', () => {
  test('throws ValidationError on a string source not in REQUEST_SOURCES', () => {
    expect(() => parseAdapterMetadata({ source: 'banana' })).toThrow(
      ValidationError,
    );
  });

  test('throws ValidationError on a non-string source', () => {
    expect(() => parseAdapterMetadata({ source: 42 })).toThrow(
      ValidationError,
    );
  });

  test('error message includes the offending value', () => {
    try {
      parseAdapterMetadata({ source: 'banana' });
      throw new Error('expected ValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toContain('banana');
    }
  });
});

describe('parseAdapterMetadata() — per-source shapes', () => {
  test('cli: keeps source + pid + cwd + branch', () => {
    const input = {
      source: 'cli',
      pid: 12345,
      cwd: '/Users/dev',
      branch: 'main',
    };
    const out = parseAdapterMetadata(input);
    expect(out).toEqual(input);
  });

  test('claude-app: keeps source + session_id + user + workspace', () => {
    const input = {
      source: 'claude-app',
      session_id: 'sess-1',
      user: 'alice',
      workspace: 'workspace-a',
    };
    expect(parseAdapterMetadata(input)).toEqual(input);
  });

  test('discord: keeps source + guild_id + channel_id + user_id + message_id', () => {
    const input = {
      source: 'discord',
      guild_id: 'g1',
      channel_id: 'c1',
      user_id: 'u1',
      message_id: 'm1',
    };
    expect(parseAdapterMetadata(input)).toEqual(input);
  });

  test('slack: keeps source + team_id + channel_id + user_id + message_ts', () => {
    const input = {
      source: 'slack',
      team_id: 't1',
      channel_id: 'c2',
      user_id: 'u2',
      message_ts: '170.001',
    };
    expect(parseAdapterMetadata(input)).toEqual(input);
  });

  test('production-intelligence: keeps source + alert_id + severity', () => {
    const input = {
      source: 'production-intelligence',
      alert_id: 'PI-1',
      severity: 'high',
    };
    expect(parseAdapterMetadata(input)).toEqual(input);
  });

  test('portal: keeps source + session_id + user_agent', () => {
    const input = {
      source: 'portal',
      session_id: 'p-1',
      user_agent: 'Mozilla/5.0',
    };
    expect(parseAdapterMetadata(input)).toEqual(input);
  });
});

describe('parseAdapterMetadata() — excess-field dropping', () => {
  test('drops fields not in the per-source allow-list (discord)', () => {
    const out = parseAdapterMetadata({
      source: 'discord',
      guild_id: 'g1',
      // extras that should be silently dropped
      team_id: 'wrong-channel-field',
      bogus: 'x',
      _internal: { nested: true },
    });
    expect(out).toEqual({ source: 'discord', guild_id: 'g1' });
    expect(out).not.toHaveProperty('team_id');
    expect(out).not.toHaveProperty('bogus');
  });

  test('drops undefined values from the input', () => {
    const out = parseAdapterMetadata({
      source: 'cli',
      pid: undefined,
      cwd: '/tmp',
    });
    // undefined fields are not copied; result shape is { source, cwd }.
    expect(out).toEqual({ source: 'cli', cwd: '/tmp' });
    expect(out).not.toHaveProperty('pid');
  });

  test('keeps source even when no other fields are provided', () => {
    expect(parseAdapterMetadata({ source: 'slack' })).toEqual({
      source: 'slack',
    });
  });
});

describe('AdapterMetadata discriminated union', () => {
  test('narrows correctly after checking source === "discord"', () => {
    const m: AdapterMetadata = parseAdapterMetadata({
      source: 'discord',
      guild_id: 'g',
      channel_id: 'c',
    });

    if ('source' in m && m.source === 'discord') {
      // TS knows m.guild_id exists on this branch — no cast required.
      const guildId: string | undefined = m.guild_id;
      expect(guildId).toBe('g');
    } else {
      throw new Error('expected discord branch');
    }
  });

  test('narrows correctly for cli with optional fields', () => {
    const m: AdapterMetadata = parseAdapterMetadata({
      source: 'cli',
      pid: 1,
    });
    if ('source' in m && m.source === 'cli') {
      const pid: number | undefined = m.pid;
      expect(pid).toBe(1);
    } else {
      throw new Error('expected cli branch');
    }
  });
});

describe('ValidationError', () => {
  test('has the documented name', () => {
    const e = new ValidationError('test');
    expect(e.name).toBe('ValidationError');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('test');
  });
});
