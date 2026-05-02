/**
 * CredentialProxy — issues 15-minute, operation-scoped cloud credentials
 * to privileged backend plugins (SPEC-024-2-04).
 *
 * This module replaces the SPEC-024-2-01 skeleton's `NotImplemented`
 * throws with the full implementation:
 *
 *   1. `acquire()` resolves caller identity, checks the allowlist, calls
 *      the matched scoper, registers the issued token in the
 *      `ActiveTokenRegistry`, schedules a TTL timer, and emits a
 *      `credential_issued` audit event.
 *   2. `revoke(token_id)` cancels the timer, calls the scoper's cloud-side
 *      revocation closure (with retries), and emits `credential_revoked`.
 *   3. `expire(token_id)` is the auto-fired path; it differs from
 *      `revoke` only in the audit `type` (`credential_expired`).
 *   4. `shutdown()` drains every active token and revokes each via
 *      `Promise.allSettled` so one failure does not block the others.
 *
 * The audit emitter is best-effort: it MUST NOT block the credential
 * flow (see `audit-emitter.ts`).
 *
 * @module intake/cred-proxy/proxy
 */

import { randomUUID } from 'node:crypto';

import {
  ActiveTokenRegistry,
  type ActiveToken,
} from './active-tokens';
import {
  CredentialAuditEmitter,
  type CredentialEvent,
} from './audit-emitter';
import { resolveCaller, type CallerContext } from './caller-identity';
import { TTL_SECONDS } from './ttl';
import {
  type CredentialScoper,
  type Provider,
  type Scope,
  type ScopedCredential,
  SecurityError,
} from './types';

export { TTL_SECONDS } from './ttl';

/** Reason annotation on `credential_revoked` events. */
export type RevokeReason = 'released' | 'admin-forced' | 'daemon-shutdown';

export interface CredentialProxyDeps {
  readonly scopers: ReadonlyMap<Provider, CredentialScoper>;
  readonly privilegedBackends: ReadonlySet<string>;
  readonly registry: ActiveTokenRegistry;
  readonly audit: CredentialAuditEmitter;
  /** Injectable for fake-timer tests. Defaults to global `setTimeout`. */
  readonly setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout;
  /** Injectable for tests; defaults to a real promise-based delay. */
  readonly delay?: (ms: number) => Promise<void>;
  /** Injectable to make retry tests deterministic. */
  readonly retryDelaysMs?: readonly number[];
}

/**
 * Default revoke retry schedule: 0 (immediate) → 100 → 400 → 1600 ms.
 * Total wall time on full failure: ~2.1s. After the 4th attempt the
 * cloud's 900s TTL is the safety net.
 */
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [0, 100, 400, 1600];

export class CredentialProxy {
  private readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly retryDelaysMs: readonly number[];

  constructor(private readonly deps: CredentialProxyDeps) {
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.delay =
      deps.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  async acquire(
    provider: Provider,
    operation: string,
    scope: Scope,
    caller?: CallerContext,
  ): Promise<ScopedCredential> {
    let pluginId: string;
    try {
      pluginId = resolveCaller(caller);
    } catch (err) {
      const e = err as SecurityError;
      void this.emitSafe({
        type: 'credential_denied',
        caller: 'unknown',
        provider,
        operation,
        scope: scope as Record<string, string>,
        reason: e.code ?? 'CALLER_UNKNOWN',
      });
      throw err;
    }

    if (!this.deps.privilegedBackends.has(pluginId)) {
      void this.emitSafe({
        type: 'credential_denied',
        caller: pluginId,
        provider,
        operation,
        scope: scope as Record<string, string>,
        reason: 'NOT_ALLOWLISTED',
      });
      throw new SecurityError(
        'NOT_ALLOWLISTED',
        `plugin ${pluginId} not in privileged_backends`,
      );
    }

    const scoper = this.deps.scopers.get(provider);
    if (!scoper) {
      throw new Error(`no scoper registered for provider ${provider}`);
    }

    const result = await scoper.scope(operation, scope);
    const token_id = randomUUID();
    const issued_at = new Date().toISOString();
    const delivery: 'stdin' | 'socket' = caller?.socketPeer
      ? 'socket'
      : 'stdin';

    const cred: ScopedCredential = {
      provider,
      delivery,
      payload: result.payload,
      expires_at: result.expires_at,
      token_id,
      scope: { operation, resources: scope },
    };

    const timer = this.setTimer(() => {
      this.expire(token_id).catch(() => {
        // expire() already swallows scoper errors via callRevokeWithRetry;
        // any escape here is a bug. Suppress to avoid unhandled rejection.
      });
    }, TTL_SECONDS * 1000);
    // Do not keep the daemon alive solely on this timer. NodeJS.Timeout
    // exposes `unref()` on Node; structural typing on tests may omit it.
    if (typeof (timer as { unref?: () => unknown }).unref === 'function') {
      (timer as { unref: () => unknown }).unref();
    }

    const entry: ActiveToken = {
      token_id,
      provider,
      operation,
      caller: pluginId,
      issued_at,
      expires_at: result.expires_at,
      revoke: result.revoke,
      timer,
    };
    this.deps.registry.register(entry);

    void this.emitSafe({
      type: 'credential_issued',
      caller: pluginId,
      provider,
      operation,
      scope: scope as Record<string, string>,
      token_id,
    });

    return cred;
  }

  async revoke(
    token_id: string,
    reason: RevokeReason = 'released',
  ): Promise<void> {
    const t = this.deps.registry.remove(token_id);
    if (!t) return; // already gone or never existed — idempotent.
    await this.callRevokeWithRetry(t.revoke);
    void this.emitSafe({
      type: 'credential_revoked',
      caller: t.caller,
      provider: t.provider,
      operation: t.operation,
      scope: {},
      token_id,
      reason,
    });
  }

  /** Internal: fired by the per-token TTL timer. */
  private async expire(token_id: string): Promise<void> {
    const t = this.deps.registry.remove(token_id);
    if (!t) return;
    await this.callRevokeWithRetry(t.revoke);
    void this.emitSafe({
      type: 'credential_expired',
      caller: t.caller,
      provider: t.provider,
      operation: t.operation,
      scope: {},
      token_id,
    });
  }

  /**
   * Up to N attempts (one per entry in `retryDelaysMs`). Final failure is
   * logged to stderr and swallowed — the cloud's TTL is the safety net.
   */
  private async callRevokeWithRetry(
    fn: () => Promise<void>,
  ): Promise<void> {
    let lastErr: unknown;
    for (let i = 0; i < this.retryDelaysMs.length; i++) {
      const d = this.retryDelaysMs[i];
      if (d > 0) await this.delay(d);
      try {
        await fn();
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    // eslint-disable-next-line no-console
    console.error(
      '[cred-proxy] revoke failed after retries; cloud TTL will reclaim',
      lastErr,
    );
  }

  /**
   * Daemon shutdown handler. Revokes every active token; emits one
   * `credential_revoked` event per token with `reason: 'daemon-shutdown'`.
   * `Promise.allSettled` ensures a single failed revoke does NOT block
   * the others.
   */
  async shutdown(): Promise<void> {
    const all = this.deps.registry.drainAll();
    await Promise.allSettled(
      all.map(async (t) => {
        await this.callRevokeWithRetry(t.revoke);
        await this.emitSafe({
          type: 'credential_revoked',
          caller: t.caller,
          provider: t.provider,
          operation: t.operation,
          scope: {},
          token_id: t.token_id,
          reason: 'daemon-shutdown',
        });
      }),
    );
  }

  /** Audit emission MUST NOT block the credential flow — swallow errors. */
  private async emitSafe(event: CredentialEvent): Promise<void> {
    try {
      await this.deps.audit.emit(event);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[cred-proxy] audit emission threw:', err);
    }
  }
}
