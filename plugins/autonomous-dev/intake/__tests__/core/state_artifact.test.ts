/**
 * state_artifact.buildInitialState tests (SPEC-012-1-02).
 *
 * @module __tests__/core/state_artifact.test
 */

import { buildInitialState } from '../../core/state_artifact';
import type { SubmitRequest } from '../../core/types';

function baseReq(): SubmitRequest {
  return {
    requestId: 'REQ-000001',
    description: 'demo',
    priority: 'normal',
    repository: '/tmp/repo',
    source: 'cli',
    adapterMetadata: { source: 'cli', pid: 123 },
  };
}

describe('buildInitialState', () => {
  test('created_at === updated_at', () => {
    const state = buildInitialState(baseReq(), '2026-04-30T10:00:00.000Z');
    expect(state.created_at).toBe('2026-04-30T10:00:00.000Z');
    expect(state.updated_at).toBe('2026-04-30T10:00:00.000Z');
  });

  test('phase_history is an empty array (not undefined)', () => {
    const state = buildInitialState(baseReq(), '2026-04-30T10:00:00.000Z');
    expect(Array.isArray(state.phase_history)).toBe(true);
    expect(state.phase_history).toEqual([]);
  });

  test('strips non-serializable values from adapter_metadata', () => {
    const req = baseReq();
    // Function value is silently dropped by JSON.stringify; Symbol too.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (req as any).adapterMetadata = {
      source: 'cli',
      pid: 7,
      fn: () => 1,
      ok: 'yes',
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const state = buildInitialState(req, '2026-04-30T10:00:00.000Z');
    expect(state.adapter_metadata).toEqual({ source: 'cli', pid: 7, ok: 'yes' });
  });

  test('emits source + adapter_metadata on the v1.1 shape', () => {
    const state = buildInitialState(baseReq(), '2026-04-30T10:00:00.000Z');
    expect(state.source).toBe('cli');
    expect(state.adapter_metadata).toEqual({ source: 'cli', pid: 123 });
  });

  test('does NOT set paused_from on initial state', () => {
    const state = buildInitialState(baseReq(), '2026-04-30T10:00:00.000Z');
    expect((state as Record<string, unknown>).paused_from).toBeUndefined();
  });

  test('result is JSON-serializable (round-trip stable)', () => {
    const state = buildInitialState(baseReq(), '2026-04-30T10:00:00.000Z');
    const serialized = JSON.stringify(state);
    expect(JSON.parse(serialized)).toEqual(state);
  });
});
