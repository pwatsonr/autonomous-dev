/**
 * Unit tests for HashChainComputer (SPEC-009-5-7, Task 21).
 *
 * Tests cover:
 *   - Enabled mode produces valid SHA-256 hashes
 *   - Disabled mode returns empty strings
 *   - GENESIS hash for first event
 *   - Chain continuity across events
 *   - Canonical serialization determinism
 */

import { createHash } from 'crypto';
import {
  HashChainComputer,
  GENESIS_HASH,
  canonicalize,
  deepSortKeys,
} from '../hash-chain';
import type { AuditEvent } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEventData(): Omit<AuditEvent, 'hash' | 'prev_hash'> {
  return {
    event_id: 'test-uuid-001',
    event_type: 'gate_decision',
    timestamp: '2024-01-15T10:30:00.000Z',
    request_id: 'req-001',
    repository: 'test-repo',
    pipeline_phase: 'code_review',
    agent: 'test-agent',
    payload: { decision: 'approved', confidence: 0.95 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HashChainComputer', () => {
  // Enabled mode
  describe('enabled mode', () => {
    const computer = new HashChainComputer(true);

    test('computeHash returns a hex SHA-256 hash', () => {
      const result = computer.computeHash(makeEventData(), GENESIS_HASH);

      expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.prev_hash).toBe(GENESIS_HASH);
    });

    test('first event uses GENESIS as prev_hash', () => {
      const result = computer.computeHash(makeEventData(), GENESIS_HASH);

      expect(result.prev_hash).toBe('GENESIS');
    });

    test('chained events produce different hashes', () => {
      const event1 = makeEventData();
      const result1 = computer.computeHash(event1, GENESIS_HASH);

      const event2 = {
        ...makeEventData(),
        event_id: 'test-uuid-002',
        timestamp: '2024-01-15T10:31:00.000Z',
      };
      const result2 = computer.computeHash(event2, result1.hash);

      expect(result2.hash).not.toBe(result1.hash);
      expect(result2.prev_hash).toBe(result1.hash);
    });

    test('same input produces same hash (deterministic)', () => {
      const event = makeEventData();
      const result1 = computer.computeHash(event, GENESIS_HASH);
      const result2 = computer.computeHash(event, GENESIS_HASH);

      expect(result1.hash).toBe(result2.hash);
    });

    test('hash matches manual SHA-256 computation', () => {
      const event = makeEventData();
      const canonical = canonicalize(event);
      const expectedHash = createHash('sha256')
        .update(canonical + GENESIS_HASH)
        .digest('hex');

      const result = computer.computeHash(event, GENESIS_HASH);

      expect(result.hash).toBe(expectedHash);
    });

    test('isEnabled returns true', () => {
      expect(computer.isEnabled()).toBe(true);
    });
  });

  // Disabled mode
  describe('disabled mode', () => {
    const computer = new HashChainComputer(false);

    test('computeHash returns empty strings', () => {
      const result = computer.computeHash(makeEventData(), GENESIS_HASH);

      expect(result.hash).toBe('');
      expect(result.prev_hash).toBe('');
    });

    test('isEnabled returns false', () => {
      expect(computer.isEnabled()).toBe(false);
    });
  });
});

describe('canonicalize', () => {
  test('keys sorted lexicographically', () => {
    const event = makeEventData();
    const canonical = canonicalize(event);
    const parsed = JSON.parse(canonical);

    const keys = Object.keys(parsed);
    const sortedKeys = [...keys].sort();
    expect(keys).toEqual(sortedKeys);
  });

  test('nested object keys sorted', () => {
    const event = {
      ...makeEventData(),
      payload: { z_field: 1, a_field: 2 },
    };
    const canonical = canonicalize(event);

    // a_field should appear before z_field in the canonical string
    const aPos = canonical.indexOf('a_field');
    const zPos = canonical.indexOf('z_field');
    expect(aPos).toBeLessThan(zPos);
  });

  test('no whitespace in output', () => {
    const canonical = canonicalize(makeEventData());

    // Should not contain spaces/newlines outside of string values
    expect(canonical).not.toMatch(/\n/);
    expect(canonical).not.toMatch(/\t/);
  });
});

describe('deepSortKeys', () => {
  test('sorts object keys', () => {
    const result = deepSortKeys({ b: 1, a: 2 }) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(['a', 'b']);
  });

  test('recursively sorts nested objects', () => {
    const result = deepSortKeys({
      z: { c: 1, a: 2 },
      a: 1,
    }) as Record<string, unknown>;

    expect(Object.keys(result)).toEqual(['a', 'z']);
    expect(Object.keys(result.z as Record<string, unknown>)).toEqual([
      'a',
      'c',
    ]);
  });

  test('arrays preserve order but sort contained objects', () => {
    const result = deepSortKeys([
      { b: 1, a: 2 },
      { d: 3, c: 4 },
    ]) as Array<Record<string, unknown>>;

    expect(Object.keys(result[0])).toEqual(['a', 'b']);
    expect(Object.keys(result[1])).toEqual(['c', 'd']);
  });

  test('primitives returned as-is', () => {
    expect(deepSortKeys(42)).toBe(42);
    expect(deepSortKeys('hello')).toBe('hello');
    expect(deepSortKeys(null)).toBe(null);
    expect(deepSortKeys(true)).toBe(true);
  });
});
