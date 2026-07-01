/**
 * T009 — Events module unit tests.
 */
import { createEmitter } from '../events';
import type { SelfImproveEvent } from '../events';

describe('createEmitter', () => {
  it('T009-01: emitter auto-populates ts when absent', () => {
    const audited: object[] = [];
    const emit = createEmitter({
      audit: (r) => audited.push(r),
      now: () => 1_234_000,
    });
    emit({ type: 'self_improve_disabled' } as SelfImproveEvent);
    expect(audited).toHaveLength(1);
    expect((audited[0] as { ts: string }).ts).toBe(new Date(1_234_000).toISOString());
  });

  it('T009-02: emitter preserves explicit ts', () => {
    const audited: object[] = [];
    const emit = createEmitter({ audit: (r) => audited.push(r), now: () => 0 });
    const explicitTs = '2026-07-01T12:00:00.000Z';
    emit({ type: 'self_improve_disabled', ts: explicitTs });
    expect((audited[0] as { ts: string }).ts).toBe(explicitTs);
  });
});
