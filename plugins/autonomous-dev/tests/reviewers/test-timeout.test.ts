/**
 * Unit tests for the timeout leaf module (REQ-000053 Task 1, §4.1).
 *
 * Covers TS01..TS13: verifies exported constants, `clampTimeoutMs`,
 * `parseTimeoutEnvInt`, and structural invariants (leaf import-freedom,
 * barrel re-export).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  TIMEOUT_DEFAULT,
  TIMEOUT_MAX,
  TIMEOUT_MIN,
  clampTimeoutMs,
  parseTimeoutEnvInt,
} from '../../intake/reviewers/timeout';

// ---------------------------------------------------------------------------
// clampTimeoutMs — TS01..TS05
// ---------------------------------------------------------------------------

describe('clampTimeoutMs', () => {
  it('TS01: clamps value below MIN up to 30_000', () => {
    expect(clampTimeoutMs(15_000)).toBe(30_000);
  });

  it('TS02: passthrough for in-range value', () => {
    expect(clampTimeoutMs(900_000)).toBe(900_000);
  });

  it('TS03: clamps value above MAX down to 3_600_000', () => {
    expect(clampTimeoutMs(10_000_000)).toBe(3_600_000);
  });

  it('TS04: NaN collapses to TIMEOUT_DEFAULT then returned as-is (in range)', () => {
    expect(clampTimeoutMs(NaN)).toBe(900_000);
  });

  it('TS05: negative value clamped to 30_000', () => {
    expect(clampTimeoutMs(-1)).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// parseTimeoutEnvInt — TS06..TS10
// ---------------------------------------------------------------------------

describe('parseTimeoutEnvInt', () => {
  it('TS06: undefined input returns undefined', () => {
    expect(parseTimeoutEnvInt(undefined)).toBeUndefined();
  });

  it('TS07: empty string returns undefined', () => {
    expect(parseTimeoutEnvInt('')).toBeUndefined();
  });

  it('TS08: non-numeric string returns undefined', () => {
    expect(parseTimeoutEnvInt('not-a-number')).toBeUndefined();
  });

  it('TS09: lenient parse — "500000ms" returns 500000', () => {
    expect(parseTimeoutEnvInt('500000ms')).toBe(500000);
  });

  it('TS10: plain numeric string returns the integer', () => {
    expect(parseTimeoutEnvInt('45000')).toBe(45000);
  });
});

// ---------------------------------------------------------------------------
// Structural tests — TS11..TS13
// ---------------------------------------------------------------------------

describe('timeout.ts structural invariants', () => {
  it('TS11: timeout.ts has no import statements from the reviewer suite', () => {
    const timeoutPath = path.resolve(__dirname, '../../intake/reviewers/timeout.ts');
    const source = fs.readFileSync(timeoutPath, 'utf8');
    // The module MUST have zero `import ... from` statements.
    const importMatches = source.match(/^\s*import .* from /m);
    expect(importMatches).toBeNull();
  });

  it('TS12: constant values are exactly 30_000, 3_600_000, and 900_000', () => {
    expect(TIMEOUT_MIN).toBe(30_000);
    expect(TIMEOUT_MAX).toBe(3_600_000);
    expect(TIMEOUT_DEFAULT).toBe(900_000);
  });

  it('TS13: all five symbols are re-exported from the barrel (intake/reviewers)', () => {
    // Dynamic require so this test actually imports from the barrel.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('../../intake/reviewers') as Record<string, unknown>;
    expect(typeof barrel['TIMEOUT_MIN']).toBe('number');
    expect(typeof barrel['TIMEOUT_MAX']).toBe('number');
    expect(typeof barrel['TIMEOUT_DEFAULT']).toBe('number');
    expect(typeof barrel['clampTimeoutMs']).toBe('function');
    expect(typeof barrel['parseTimeoutEnvInt']).toBe('function');
  });
});
