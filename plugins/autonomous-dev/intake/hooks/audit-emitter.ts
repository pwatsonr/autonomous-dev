/**
 * TrustAuditEmitter — thin wrapper that emits one structured entry per
 * trust decision (SPEC-019-3-04, Task 10).
 *
 * The emitter accepts any writer with `append(channel, entry)`. The
 * underlying durability story (HMAC-chained NDJSON, database insert,
 * etc.) is the writer's responsibility — PLAN-014-3's HMAC-chained
 * AuditLogger from `autonomous-dev-portal/server/security/audit-logger.ts`
 * is the intended production target. PLAN-019-4 will own the canonical
 * on-disk schema; the field set here is the placeholder per
 * SPEC-019-3-04 and is additive-only across plans (never rename
 * `pluginId`, `decision`, `timestamp`).
 *
 * @module intake/hooks/audit-emitter
 */

/** The four kinds of trust-decision audit entries. */
export type AuditDecision =
  | 'registered'
  | 'rejected'
  | 'runtime-revoked'
  | 'meta-review-verdict';

/** Placeholder shape — PLAN-019-4 may add fields, never rename. */
export interface TrustAuditEntry {
  decision: AuditDecision;
  pluginId: string;
  pluginVersion: string;
  /** Set on `runtime-revoked` so operators can correlate to the call site. */
  hookPoint?: string;
  /** Step-specific reason string (mirrors TrustVerdict.reason). */
  reason?: string;
  /** Set on `meta-review-verdict` and on `registered` if meta-review ran. */
  metaReviewVerdict?: { pass: boolean; findings: string[] };
  /** ISO 8601 UTC. */
  timestamp: string;
}

/**
 * Minimal writer contract. Matches the `append(channel, entry)` shape
 * exposed by PLAN-014-3's HMAC-chained AuditLogger and the simpler
 * authz logger in `intake/authz/audit_logger.ts`. Tests substitute an
 * in-memory implementation (see SPEC-019-3-05).
 */
export interface AuditWriter {
  append(channel: string, entry: TrustAuditEntry): void;
}

/**
 * Default in-process writer used when no other writer is wired. Buffers
 * entries in memory so unit tests can introspect without configuring a
 * real audit backend. NOT durable — production callers MUST provide a
 * real writer.
 */
export class InMemoryAuditWriter implements AuditWriter {
  private readonly buf: Map<string, TrustAuditEntry[]> = new Map();
  append(channel: string, entry: TrustAuditEntry): void {
    const list = this.buf.get(channel) ?? [];
    list.push(entry);
    this.buf.set(channel, list);
  }
  entries(channel: string): readonly TrustAuditEntry[] {
    return this.buf.get(channel) ?? [];
  }
  clear(): void {
    this.buf.clear();
  }
}

export class TrustAuditEmitter {
  constructor(private readonly writer: AuditWriter) {}

  /** Append one trust-decision entry to the `trust` channel. */
  emit(entry: TrustAuditEntry): void {
    this.writer.append('trust', entry);
  }
}
