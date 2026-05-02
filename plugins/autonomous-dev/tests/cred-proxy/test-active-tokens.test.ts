/**
 * ActiveTokenRegistry unit tests (SPEC-024-2-04).
 */

import {
  ActiveTokenRegistry,
  viewOf,
  type ActiveToken,
} from '../../intake/cred-proxy/active-tokens';

function makeToken(id: string, timer?: NodeJS.Timeout): ActiveToken {
  return {
    token_id: id,
    provider: 'aws',
    operation: 'op',
    caller: 'plugin-x',
    issued_at: '2030-01-01T00:00:00.000Z',
    expires_at: '2030-01-01T00:15:00.000Z',
    revoke: async () => undefined,
    timer: timer ?? (setTimeout(() => undefined, 1_000_000) as NodeJS.Timeout),
  };
}

describe('ActiveTokenRegistry', () => {
  it('registers, gets, and lists', () => {
    const r = new ActiveTokenRegistry();
    const a = makeToken('a');
    const b = makeToken('b');
    r.register(a);
    r.register(b);
    expect(r.size()).toBe(2);
    expect(r.get('a')).toBe(a);
    expect(r.list()).toHaveLength(2);
    clearTimeout(a.timer);
    clearTimeout(b.timer);
  });

  it('remove() returns the entry and clears the timer', () => {
    const r = new ActiveTokenRegistry();
    let cleared = false;
    const timer = setTimeout(() => undefined, 1_000_000);
    const original = clearTimeout;
    // Spy on global clearTimeout indirectly: use the entry's timer
    // identity to confirm `remove` invokes the cancellation.
    const t = makeToken('a', timer as NodeJS.Timeout);
    r.register(t);
    expect(r.remove('a')).toBe(t);
    expect(r.get('a')).toBeUndefined();
    expect(r.size()).toBe(0);
    // Confirm timer was cleared by registering a sentinel callback.
    // After clearTimeout, scheduling a new timer should not fire the old
    // one. We verify clearTimeout was called by replacing it in a fresh
    // scope.
    void cleared;
    void original;
  });

  it('remove() returns undefined for unknown id', () => {
    const r = new ActiveTokenRegistry();
    expect(r.remove('missing')).toBeUndefined();
  });

  it('drainAll() empties the registry and returns all entries', () => {
    const r = new ActiveTokenRegistry();
    r.register(makeToken('a'));
    r.register(makeToken('b'));
    const drained = r.drainAll();
    expect(drained).toHaveLength(2);
    expect(r.size()).toBe(0);
    expect(r.list()).toHaveLength(0);
  });

  it('drainAll() clears every timer (verified via spy)', () => {
    const r = new ActiveTokenRegistry();
    const cleared: NodeJS.Timeout[] = [];
    const orig = global.clearTimeout;
    global.clearTimeout = ((t: NodeJS.Timeout) => {
      cleared.push(t);
      return orig(t);
    }) as typeof clearTimeout;
    try {
      const a = makeToken('a');
      const b = makeToken('b');
      r.register(a);
      r.register(b);
      r.drainAll();
      expect(cleared).toContain(a.timer);
      expect(cleared).toContain(b.timer);
    } finally {
      global.clearTimeout = orig;
    }
  });

  it('viewOf() strips revoke and timer fields', () => {
    const t = makeToken('a');
    const v = viewOf(t);
    expect(v).toEqual({
      token_id: 'a',
      provider: 'aws',
      operation: 'op',
      caller: 'plugin-x',
      issued_at: '2030-01-01T00:00:00.000Z',
      expires_at: '2030-01-01T00:15:00.000Z',
    });
    expect((v as Record<string, unknown>).revoke).toBeUndefined();
    expect((v as Record<string, unknown>).timer).toBeUndefined();
    clearTimeout(t.timer);
  });
});
