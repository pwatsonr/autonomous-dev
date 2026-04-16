/**
 * Audit logger for authorization decisions.
 *
 * Every {@link AuthzDecision} is:
 *   1. Inserted into the `authz_audit_log` table via the database.
 *   2. Written to structured JSON on stdout via `logger.info()`.
 *
 * @module audit_logger
 */

import type { AuthzDecision, ChannelType } from '../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Database interface (subset of Repository needed by this module)
// ---------------------------------------------------------------------------

/**
 * Minimal database interface for inserting audit log entries.
 * Matches the `authz_audit_log` table defined in `schema.sql`.
 */
export interface AuditLogRepository {
  insertAuditLog(entry: AuditLogEntry): void;
}

/**
 * A single row in the `authz_audit_log` table.
 */
export interface AuditLogEntry {
  user_id: string;
  action: string;
  resource: string;
  decision: 'grant' | 'deny';
  reason: string;
  source_channel: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/**
 * Structured logger interface.  Implementations can forward to any
 * logging backend (e.g. pino, winston, plain console).
 */
export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Default structured JSON logger that writes to stdout.
 * Each log line is a single JSON object with a `level`, `msg`, `ts`,
 * and any additional fields.
 */
export const defaultLogger: Logger = {
  info(message: string, fields?: Record<string, unknown>): void {
    const entry = {
      level: 'info',
      msg: message,
      ts: new Date().toISOString(),
      ...fields,
    };
    process.stdout.write(JSON.stringify(entry) + '\n');
  },
  warn(message: string, fields?: Record<string, unknown>): void {
    const entry = {
      level: 'warn',
      msg: message,
      ts: new Date().toISOString(),
      ...fields,
    };
    process.stdout.write(JSON.stringify(entry) + '\n');
  },
  error(message: string, fields?: Record<string, unknown>): void {
    const entry = {
      level: 'error',
      msg: message,
      ts: new Date().toISOString(),
      ...fields,
    };
    process.stderr.write(JSON.stringify(entry) + '\n');
  },
};

// ---------------------------------------------------------------------------
// AuditLogger
// ---------------------------------------------------------------------------

/**
 * Records every authorization decision to both the database and
 * structured JSON stdout.
 */
export class AuditLogger {
  constructor(
    private readonly db: AuditLogRepository,
    private readonly logger: Logger = defaultLogger,
  ) {}

  /**
   * Create an {@link AuditLogRepository} adapter from any object that
   * exposes a `prepare(sql).run(...)` method (i.e. a `better-sqlite3` Database
   * or the existing {@link Repository}).
   *
   * This allows seamless integration with the existing `Repository` class
   * without coupling to its `insertAuditLog(AuthzDecision)` signature.
   */
  static fromDatabase(db: {
    prepare(sql: string): { run(...params: unknown[]): unknown };
  }): AuditLogRepository {
    return {
      insertAuditLog(entry: AuditLogEntry): void {
        db.prepare(
          `INSERT INTO authz_audit_log (user_id, action, resource, decision, reason, source_channel, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          entry.user_id,
          entry.action,
          entry.resource,
          entry.decision,
          entry.reason,
          entry.source_channel,
          entry.created_at,
        );
      },
    };
  }

  /**
   * Log an authorization decision.
   *
   * @param decision       The {@link AuthzDecision} returned by the engine.
   * @param resource       A human-readable resource descriptor (e.g. request ID or repo).
   * @param sourceChannel  The channel the request originated from.
   */
  log(
    decision: AuthzDecision,
    resource: string,
    sourceChannel: ChannelType | string,
  ): void {
    const entry: AuditLogEntry = {
      user_id: decision.userId,
      action: decision.action,
      resource,
      decision: decision.granted ? 'grant' : 'deny',
      reason: decision.reason,
      source_channel: sourceChannel,
      created_at: decision.timestamp.toISOString(),
    };

    // 1. Persist to database
    this.db.insertAuditLog(entry);

    // 2. Write structured JSON to stdout
    this.logger.info('authz_decision', {
      user_id: entry.user_id,
      action: entry.action,
      resource: entry.resource,
      decision: entry.decision,
      reason: entry.reason,
      source_channel: entry.source_channel,
      timestamp: entry.created_at,
    });
  }
}
