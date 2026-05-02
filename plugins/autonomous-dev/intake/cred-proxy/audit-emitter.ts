/**
 * Audit-event shim for the credential proxy (SPEC-024-2-04).
 *
 * The HMAC chaining and on-disk persistence live in PLAN-019-4's
 * `AuditWriter`. This file is the minimal adapter between the proxy's
 * `credential_*` event vocabulary and whatever audit sink is wired in by
 * the daemon at boot — declared structurally as `AuditSink` so unit tests
 * inject a fake without touching the real writer.
 *
 * Audit emission MUST NOT block the credential flow: if the sink throws,
 * the emitter logs to stderr and swallows the error. The cloud's TTL is
 * the truth-source for "is the credential valid"; the audit log is
 * observability, not authorization.
 *
 * @module intake/cred-proxy/audit-emitter
 */

import type { Provider } from './types';

export type CredentialEventType =
  | 'credential_issued'
  | 'credential_revoked'
  | 'credential_expired'
  | 'credential_denied';

export interface CredentialEvent {
  readonly type: CredentialEventType;
  readonly caller: string;
  readonly provider: Provider;
  readonly operation: string;
  readonly scope: Record<string, string>;
  readonly token_id?: string;
  /** Populated on `_denied` and on `_revoked` when forced. */
  readonly reason?: string;
}

/**
 * Minimal structural interface of a PLAN-019-4-style audit writer that
 * accepts arbitrary categorised entries. Declared here so the proxy
 * doesn't import the writer module directly — the daemon does the wiring.
 */
export interface AuditSink {
  append(entry: {
    category: 'cred-proxy';
    timestamp: string;
    type: CredentialEventType;
    caller: string;
    provider: Provider;
    operation: string;
    scope: Record<string, string>;
    token_id?: string;
    reason?: string;
  }): void | Promise<void>;
}

export class CredentialAuditEmitter {
  constructor(
    private readonly sink: AuditSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Best-effort emit. Synchronous-looking callers can ignore the return
   * value; `Promise<void>` is returned so tests can `await` if the sink
   * is async.
   */
  async emit(event: CredentialEvent): Promise<void> {
    try {
      await this.sink.append({
        category: 'cred-proxy',
        timestamp: this.now().toISOString(),
        ...event,
      });
    } catch (err) {
      // Audit failure must not fail the credential flow. Surface to
      // stderr so operators can wire log shipping.
      // eslint-disable-next-line no-console
      console.error('[cred-proxy] audit emit failed:', err);
    }
  }
}
