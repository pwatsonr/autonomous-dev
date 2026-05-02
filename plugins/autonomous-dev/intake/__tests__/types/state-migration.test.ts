/**
 * Unit tests for `intake/types/request-state.ts`
 * (SPEC-018-1-04, Task 8 — covers SPEC-018-1-02).
 *
 * @module __tests__/types/state-migration.test
 */

import { RequestType } from '../../types/request-type';
import { PHASE_OVERRIDE_MATRIX } from '../../types/phase-override';
import {
  type RequestState,
  type RequestStateV1_0,
  type RequestStateV1_1,
  isLegacyState,
  migrateStateV1_0ToV1_1,
  requireV1_1,
} from '../../types/request-state';

// ---------------------------------------------------------------------------
// migrateStateV1_0ToV1_1
// ---------------------------------------------------------------------------

describe('migrateStateV1_0ToV1_1()', () => {
  test('sets schema_version 1.1, request_type feature, populates phase_overrides + type_config', () => {
    const v10: RequestStateV1_0 = {
      schema_version: 1.0,
      id: 'req-001',
      status: 'queued',
    };
    const v11 = migrateStateV1_0ToV1_1(v10);

    expect(v11.schema_version).toBe(1.1);
    expect(v11.request_type).toBe('feature');
    expect(v11.phase_overrides).toHaveLength(14);
    expect(v11.type_config).toBe(PHASE_OVERRIDE_MATRIX[RequestType.FEATURE]);
  });

  test('preserves all input fields including unknown extras (lossless)', () => {
    const v10 = {
      schema_version: 1.0 as const,
      id: 'X',
      status: 'queued',
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-02T00:00:00Z',
      custom_field: 42,
      experimental: { value: 'kept' },
      phase_history: [{ phase: 'intake', at: '2025-01-01T00:00:00Z' }],
      current_phase_metadata: { foo: 'bar' },
    };
    const v11 = migrateStateV1_0ToV1_1(v10);

    expect(v11.id).toBe('X');
    expect(v11.status).toBe('queued');
    expect(v11.custom_field).toBe(42);
    expect(v11.experimental).toEqual({ value: 'kept' });
    expect(v11.phase_history).toEqual([{ phase: 'intake', at: '2025-01-01T00:00:00Z' }]);
    expect(v11.current_phase_metadata).toEqual({ foo: 'bar' });
    expect(v11.created_at).toBe('2025-01-01T00:00:00Z');
    expect(v11.updated_at).toBe('2025-01-02T00:00:00Z');
  });

  test('bug_context is undefined own-property after migration', () => {
    const v11 = migrateStateV1_0ToV1_1({
      schema_version: 1.0,
      id: 'r',
    });
    expect(v11.bug_context).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(v11, 'bug_context')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isLegacyState
// ---------------------------------------------------------------------------

describe('isLegacyState()', () => {
  test('true for { schema_version: 1.0 }', () => {
    expect(isLegacyState({ schema_version: 1.0 })).toBe(true);
  });

  test('false for { schema_version: 1.1 }', () => {
    expect(isLegacyState({ schema_version: 1.1 })).toBe(false);
  });

  test('false when v1.0 carries an own request_type (forward-compat shim)', () => {
    expect(isLegacyState({ schema_version: 1.0, request_type: 'feature' })).toBe(false);
  });

  test('false for null / undefined / primitives / empty object / missing schema_version', () => {
    expect(isLegacyState(null)).toBe(false);
    expect(isLegacyState(undefined)).toBe(false);
    expect(isLegacyState('string')).toBe(false);
    expect(isLegacyState(42)).toBe(false);
    expect(isLegacyState({})).toBe(false);
    expect(isLegacyState({ id: 'no-version' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// requireV1_1
// ---------------------------------------------------------------------------

describe('requireV1_1()', () => {
  test('passes through a v1.1 input unchanged', () => {
    const v11: RequestStateV1_1 = {
      schema_version: 1.1,
      id: 'r',
      request_type: RequestType.FEATURE,
      phase_overrides: [],
      type_config: PHASE_OVERRIDE_MATRIX[RequestType.FEATURE],
    };
    expect(requireV1_1(v11)).toBe(v11);
  });

  test('migrates a v1.0 input', () => {
    const v10: RequestStateV1_0 = {
      schema_version: 1.0,
      id: 'r',
    };
    const out = requireV1_1(v10);
    expect(out.schema_version).toBe(1.1);
    expect(out.request_type).toBe('feature');
  });

  test('throws on unrecognized schema_version', () => {
    // Cast through unknown to model untyped JSON arriving at the boundary.
    const garbage = { schema_version: 2.0, id: 'r' } as unknown as RequestState;
    expect(() => requireV1_1(garbage)).toThrow(/Unrecognized state schema_version/);
  });
});

// ---------------------------------------------------------------------------
// TypeScript narrowing (compile-time check)
// ---------------------------------------------------------------------------

describe('RequestState union narrowing', () => {
  test('switch on schema_version narrows without `as` casts', () => {
    function describe(state: RequestState): string {
      switch (state.schema_version) {
        case 1.0:
          // state is RequestStateV1_0 here
          return `v1.0:${state.id}`;
        case 1.1:
          // state is RequestStateV1_1 here
          return `v1.1:${state.id}:${state.phase_overrides.length}`;
      }
    }

    expect(describe({ schema_version: 1.0, id: 'a' })).toBe('v1.0:a');
    expect(describe({
      schema_version: 1.1,
      id: 'b',
      phase_overrides: ['intake'],
      type_config: PHASE_OVERRIDE_MATRIX[RequestType.FEATURE],
    })).toBe('v1.1:b:1');
  });
});
