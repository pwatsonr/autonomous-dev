/**
 * In-process registry of issued credential tokens + auto-revoke timers
 * (SPEC-024-2-04).
 *
 * The registry is the single source of truth for "which tokens are
 * currently live, who issued them, and when do they expire". It owns the
 * TTL timer for each token; `remove()` cancels the timer and `drainAll()`
 * cancels every timer at daemon shutdown. The registry is NOT thread-safe
 * across processes — it lives inside one daemon process per TDD-024 §7.4.
 *
 * @module intake/cred-proxy/active-tokens
 */

import type { Provider } from './types';

/**
 * One live credential token. Includes both the cloud-side `revoke()`
 * closure (returned by the scoper) and the JS-side TTL timer handle so
 * the registry can cancel the timer atomically with removal.
 */
export interface ActiveToken {
  readonly token_id: string;
  readonly provider: Provider;
  readonly operation: string;
  readonly caller: string;
  readonly issued_at: string;
  readonly expires_at: string;
  /** Cloud-side revocation closure returned by the scoper. */
  readonly revoke: () => Promise<void>;
  /** Timer handle for auto-revocation; cancelled on early release. */
  readonly timer: NodeJS.Timeout;
}

/**
 * Public view of an active token suitable for `cred-proxy status` and
 * IPC responses — strips the closure and the timer handle (neither
 * serialises cleanly).
 */
export type ActiveTokenView = Omit<ActiveToken, 'revoke' | 'timer'>;

export class ActiveTokenRegistry {
  private readonly byId = new Map<string, ActiveToken>();

  register(t: ActiveToken): void {
    this.byId.set(t.token_id, t);
  }

  get(token_id: string): ActiveToken | undefined {
    return this.byId.get(token_id);
  }

  list(): readonly ActiveToken[] {
    return Array.from(this.byId.values());
  }

  /** Remove and clear timer; returns the removed entry (or undefined). */
  remove(token_id: string): ActiveToken | undefined {
    const t = this.byId.get(token_id);
    if (t) {
      clearTimeout(t.timer);
      this.byId.delete(token_id);
    }
    return t;
  }

  /** Remove every entry and clear every timer. Used at daemon shutdown. */
  drainAll(): readonly ActiveToken[] {
    const all = this.list();
    for (const t of all) clearTimeout(t.timer);
    this.byId.clear();
    return all;
  }

  size(): number {
    return this.byId.size;
  }
}

/** Project an internal entry to the public view. */
export function viewOf(t: ActiveToken): ActiveTokenView {
  const { revoke: _r, timer: _t, ...rest } = t;
  void _r;
  void _t;
  return rest;
}
