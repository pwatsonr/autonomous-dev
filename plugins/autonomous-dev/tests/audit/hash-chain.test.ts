/**
 * Unit tests for HashChainComputer (SPEC-009-5-2, Task 3).
 *
 * Test cases 1-8 from the spec:
 *   1. Genesis event hash
 *   2. Chain continuation
 *   3. Deterministic canonicalization
 *   4. Nested objects sorted
 *   5. Arrays preserved in order
 *   6. Disabled mode returns empty
 *   7. Different payloads produce different hashes
 *   8. Same payload different prevHash produces different hash
 */

import { createHash } from 'crypto';
import {
  HashChainComputer,
  GENESIS_HASH,
  canonicalize,
  deepSortKeys,
} from '../../src/audit/hash-chain';
import { AuditEvent } from '../../src/audit/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PartialEvent = Omit<AuditEvent, 'hash' | 'prev_hash'>;

function makeEvent(overrides?: Partial<PartialEvent>): PartialEvent {
  return {
    event_id: overrides?.event_id ?? 'evt-001',
    event_type: overrides?.event_type ?? 'gate_decision',
    timestamp: overrides?.timestamp ?? '2026-04-08T10:00:00.000Z',
    request_id: overrides?.request_id ?? 'req-001',
    repository: overrides?.repository ?? 'test-repo',
    pipeline_phase: overrides?.pipeline_phase ?? 'code_review',
    agent: overrides?.agent ?? 'test-agent',
    payload: overrides?.payload ?? { decision: 'approved', gate: 'code_review' },
  };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    throw new Error(
      `Assertion failed: ${message}\n  expected: ${expectedStr}\n  actual:   ${actualStr}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test 1: Genesis event hash
// ---------------------------------------------------------------------------

function test_genesis_event_hash(): void {
  const computer = new HashChainComputer(true);
  const event = makeEvent();

  const result = computer.computeHash(event, GENESIS_HASH);

  // prev_hash should be GENESIS
  assertEqual(result.prev_hash, 'GENESIS', 'prev_hash should be GENESIS');

  // hash should be sha256(canonical + "GENESIS")
  const expectedHash = createHash('sha256')
    .update(canonicalize(event) + 'GENESIS')
    .digest('hex');
  assertEqual(result.hash, expectedHash, 'hash should match sha256(canonical + GENESIS)');

  // hash should be a 64-char hex string (SHA-256)
  assert(result.hash.length === 64, 'hash should be 64 hex characters');
  assert(/^[a-f0-9]{64}$/.test(result.hash), 'hash should be lowercase hex');

  console.log('PASS: test_genesis_event_hash');
}

// ---------------------------------------------------------------------------
// Test 2: Chain continuation
// ---------------------------------------------------------------------------

function test_chain_continuation(): void {
  const computer = new HashChainComputer(true);

  // First event
  const event1 = makeEvent({ event_id: 'evt-001' });
  const result1 = computer.computeHash(event1, GENESIS_HASH);

  // Second event chains to first
  const event2 = makeEvent({ event_id: 'evt-002', timestamp: '2026-04-08T10:01:00.000Z' });
  const result2 = computer.computeHash(event2, result1.hash);

  // prev_hash of second event should be hash of first event
  assertEqual(result2.prev_hash, result1.hash, 'event2.prev_hash should equal event1.hash');

  // hash should be sha256(canonical(event2) + event1.hash)
  const expectedHash = createHash('sha256')
    .update(canonicalize(event2) + result1.hash)
    .digest('hex');
  assertEqual(result2.hash, expectedHash, 'event2 hash should chain correctly');

  // Two different events should produce different hashes
  assert(result1.hash !== result2.hash, 'chained events should have different hashes');

  console.log('PASS: test_chain_continuation');
}

// ---------------------------------------------------------------------------
// Test 3: Deterministic canonicalization
// ---------------------------------------------------------------------------

function test_deterministic_canonicalization(): void {
  // Create two events with the same fields but different insertion order
  const event1: PartialEvent = {
    event_id: 'evt-001',
    event_type: 'gate_decision',
    timestamp: '2026-04-08T10:00:00.000Z',
    request_id: 'req-001',
    repository: 'test-repo',
    pipeline_phase: 'code_review',
    agent: 'test-agent',
    payload: { decision: 'approved', gate: 'code_review' },
  };

  // Same fields, different insertion order
  const event2: PartialEvent = {
    payload: { gate: 'code_review', decision: 'approved' },
    agent: 'test-agent',
    pipeline_phase: 'code_review',
    repository: 'test-repo',
    request_id: 'req-001',
    timestamp: '2026-04-08T10:00:00.000Z',
    event_type: 'gate_decision',
    event_id: 'evt-001',
  };

  const canonical1 = canonicalize(event1);
  const canonical2 = canonicalize(event2);

  assertEqual(canonical1, canonical2, 'same fields in different order should canonicalize identically');

  // Both should produce the same hash
  const computer = new HashChainComputer(true);
  const result1 = computer.computeHash(event1, GENESIS_HASH);
  const result2 = computer.computeHash(event2, GENESIS_HASH);

  assertEqual(result1.hash, result2.hash, 'same events with different key order should hash identically');

  console.log('PASS: test_deterministic_canonicalization');
}

// ---------------------------------------------------------------------------
// Test 4: Nested objects sorted
// ---------------------------------------------------------------------------

function test_nested_objects_sorted(): void {
  const event = makeEvent({
    payload: { z_field: 1, a_field: 2, nested: { zebra: true, alpha: false } },
  });

  const canonical = canonicalize(event);

  // In the canonical string, 'a_field' should appear before 'z_field'
  const aIdx = canonical.indexOf('"a_field"');
  const zIdx = canonical.indexOf('"z_field"');
  assert(aIdx < zIdx, '"a_field" should appear before "z_field" in canonical output');

  // In the nested object, 'alpha' should appear before 'zebra'
  const alphaIdx = canonical.indexOf('"alpha"');
  const zebraIdx = canonical.indexOf('"zebra"');
  assert(alphaIdx < zebraIdx, '"alpha" should appear before "zebra" in nested object');

  console.log('PASS: test_nested_objects_sorted');
}

// ---------------------------------------------------------------------------
// Test 5: Arrays preserved in order
// ---------------------------------------------------------------------------

function test_arrays_preserved_in_order(): void {
  const event = makeEvent({
    payload: { items: [3, 1, 2] },
  });

  const canonical = canonicalize(event);

  // Array should appear as [3,1,2], not sorted
  assert(canonical.includes('[3,1,2]'), 'arrays should preserve original order, not be sorted');

  // Verify deepSortKeys on arrays
  const result = deepSortKeys({ items: [3, 1, 2] });
  assertEqual(
    JSON.stringify(result),
    '{"items":[3,1,2]}',
    'deepSortKeys should not sort array elements',
  );

  console.log('PASS: test_arrays_preserved_in_order');
}

// ---------------------------------------------------------------------------
// Test 6: Disabled mode returns empty
// ---------------------------------------------------------------------------

function test_disabled_mode_returns_empty(): void {
  const computer = new HashChainComputer(false);
  const event = makeEvent();

  const result = computer.computeHash(event, GENESIS_HASH);

  assertEqual(result.hash, '', 'disabled mode should return empty hash');
  assertEqual(result.prev_hash, '', 'disabled mode should return empty prev_hash');

  // Verify isEnabled returns false
  assertEqual(computer.isEnabled(), false, 'isEnabled should return false');

  console.log('PASS: test_disabled_mode_returns_empty');
}

// ---------------------------------------------------------------------------
// Test 7: Different payloads produce different hashes
// ---------------------------------------------------------------------------

function test_different_payloads_different_hashes(): void {
  const computer = new HashChainComputer(true);

  const event1 = makeEvent({ payload: { action: 'approve' } });
  const event2 = makeEvent({ payload: { action: 'reject' } });

  const result1 = computer.computeHash(event1, GENESIS_HASH);
  const result2 = computer.computeHash(event2, GENESIS_HASH);

  assert(
    result1.hash !== result2.hash,
    'events with different payloads should produce different hashes',
  );

  console.log('PASS: test_different_payloads_different_hashes');
}

// ---------------------------------------------------------------------------
// Test 8: Same payload different prevHash produces different hash
// ---------------------------------------------------------------------------

function test_same_payload_different_prev_hash(): void {
  const computer = new HashChainComputer(true);
  const event = makeEvent();

  const result1 = computer.computeHash(event, GENESIS_HASH);
  const result2 = computer.computeHash(event, 'some_other_hash_value');

  assert(
    result1.hash !== result2.hash,
    'same event with different prevHash should produce different hash',
  );

  // prev_hash values should reflect what was passed in
  assertEqual(result1.prev_hash, GENESIS_HASH, 'prev_hash should be GENESIS');
  assertEqual(result2.prev_hash, 'some_other_hash_value', 'prev_hash should be the alternate value');

  console.log('PASS: test_same_payload_different_prev_hash');
}

// ---------------------------------------------------------------------------
// Bonus: deepSortKeys edge cases
// ---------------------------------------------------------------------------

function test_deep_sort_keys_edge_cases(): void {
  // null
  assertEqual(deepSortKeys(null), null, 'null should pass through');

  // primitive
  assertEqual(deepSortKeys(42), 42, 'number should pass through');
  assertEqual(deepSortKeys('hello'), 'hello', 'string should pass through');
  assertEqual(deepSortKeys(true), true, 'boolean should pass through');

  // empty object
  assertEqual(JSON.stringify(deepSortKeys({})), '{}', 'empty object should stay empty');

  // empty array
  assertEqual(JSON.stringify(deepSortKeys([])), '[]', 'empty array should stay empty');

  // deeply nested
  const input = { c: { z: { b: 1, a: 2 }, y: 3 }, a: 4 };
  const expected = '{"a":4,"c":{"y":3,"z":{"a":2,"b":1}}}';
  assertEqual(JSON.stringify(deepSortKeys(input)), expected, 'deep nesting should be sorted at every level');

  // array of objects
  const arrInput = [{ b: 1, a: 2 }, { d: 3, c: 4 }];
  const arrExpected = '[{"a":2,"b":1},{"c":4,"d":3}]';
  assertEqual(
    JSON.stringify(deepSortKeys(arrInput)),
    arrExpected,
    'objects inside arrays should have sorted keys',
  );

  console.log('PASS: test_deep_sort_keys_edge_cases');
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const tests = [
  test_genesis_event_hash,
  test_chain_continuation,
  test_deterministic_canonicalization,
  test_nested_objects_sorted,
  test_arrays_preserved_in_order,
  test_disabled_mode_returns_empty,
  test_different_payloads_different_hashes,
  test_same_payload_different_prev_hash,
  test_deep_sort_keys_edge_cases,
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  try {
    test();
    passed++;
  } catch (err) {
    console.log(`FAIL: ${test.name} -- ${err}`);
    failed++;
  }
}

console.log(`\nResults: ${passed}/${tests.length} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
