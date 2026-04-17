/**
 * Repository Data Access Layer & Request ID Generation.
 *
 * Single point of database interaction for the entire intake layer.
 * All methods use parameterized queries (never string interpolation).
 * Prepared statements are used for performance.
 *
 * Implements SPEC-008-1-02 (Tasks 3 & 4).
 *
 * @module repository
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import type {
  ChannelType,
  MessageTarget,
  Priority,
  RequestStatus,
  AuthzDecision,
} from '../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Type alias for better-sqlite3 database (avoids hard dependency at compile time)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type Database = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Entity interfaces (derived from the SQLite schema in schema.sql)
// ---------------------------------------------------------------------------

/** Row entity for the `requests` table. */
export interface RequestEntity {
  request_id: string;
  title: string;
  description: string;
  raw_input: string;
  priority: Priority;
  target_repo: string | null;
  status: RequestStatus;
  current_phase: string;
  phase_progress: string | null;
  requester_id: string;
  source_channel: ChannelType;
  notification_config: string;
  deadline: string | null;
  related_tickets: string;
  technical_constraints: string | null;
  acceptance_criteria: string | null;
  blocker: string | null;
  promotion_count: number;
  last_promoted_at: string | null;
  paused_at_phase: string | null;
  created_at: string;
  updated_at: string;
}

/** Row entity for the `conversation_messages` table. */
export interface ConversationMessage {
  message_id: string;
  request_id: string;
  direction: 'inbound' | 'outbound';
  channel: ChannelType | 'feedback';
  content: string;
  message_type:
    | 'clarifying_question'
    | 'feedback'
    | 'escalation'
    | 'status_update'
    | 'approval_request';
  responded: number;
  timeout_at: string | null;
  thread_id: string | null;
  created_at?: string;
}

/** Row entity for the `activity_log` table. */
export interface ActivityLogEntry {
  log_id?: number;
  request_id: string;
  event: string;
  phase: string | null;
  details: string;
  created_at?: string;
}

/** Row entity for the `notification_deliveries` table. */
export interface NotificationDelivery {
  delivery_id?: number;
  request_id: string;
  channel_type: string;
  target: string;
  payload_hash: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  last_error: string | null;
  created_at?: string;
  delivered_at: string | null;
}

/** Row entity for the `user_identities` table. */
export interface UserIdentity {
  internal_id: string;
  role: 'admin' | 'operator' | 'contributor' | 'viewer';
  discord_id: string | null;
  slack_id: string | null;
  claude_user: string | null;
  repo_permissions: string;
  rate_limit_override: string | null;
  created_at?: string;
  updated_at?: string;
}

/** Returned by `getRequestEmbeddings`. */
export interface EmbeddingCandidate {
  request_id: string;
  embedding: Float32Array;
  status: RequestStatus;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Priority ordering constant (used for queue position queries)
// ---------------------------------------------------------------------------

const PRIORITY_CASE = `
  CASE priority
    WHEN 'high'   THEN 0
    WHEN 'normal' THEN 1
    WHEN 'low'    THEN 2
  END`;

// ---------------------------------------------------------------------------
// Repository class
// ---------------------------------------------------------------------------

/**
 * Typed data access layer wrapping a `better-sqlite3` database instance.
 *
 * Every SQL query uses parameterized `?` placeholders. Prepared statements
 * are cached on the database instance by `better-sqlite3` automatically.
 */
export class Repository {
  constructor(private db: Database) {}

  // =========================================================================
  // Request CRUD
  // =========================================================================

  /** Insert a new request row. */
  insertRequest(request: RequestEntity): void {
    this.db
      .prepare(
        `INSERT INTO requests (
          request_id, title, description, raw_input, priority, target_repo,
          status, current_phase, phase_progress, requester_id, source_channel,
          notification_config, deadline, related_tickets, technical_constraints,
          acceptance_criteria, blocker, promotion_count, last_promoted_at,
          paused_at_phase, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?
        )`,
      )
      .run(
        request.request_id,
        request.title,
        request.description,
        request.raw_input,
        request.priority,
        request.target_repo,
        request.status,
        request.current_phase,
        request.phase_progress,
        request.requester_id,
        request.source_channel,
        request.notification_config,
        request.deadline,
        request.related_tickets,
        request.technical_constraints,
        request.acceptance_criteria,
        request.blocker,
        request.promotion_count,
        request.last_promoted_at,
        request.paused_at_phase,
        request.created_at,
        request.updated_at,
      );
  }

  /** Retrieve a request by ID, or null if not found. */
  getRequest(requestId: string): RequestEntity | null {
    const row = this.db
      .prepare('SELECT * FROM requests WHERE request_id = ?')
      .get(requestId);
    return (row as RequestEntity) ?? null;
  }

  /** Update specific fields on a request. Automatically bumps `updated_at`. */
  updateRequest(requestId: string, updates: Partial<RequestEntity>): void {
    const allowedColumns = new Set<string>([
      'title',
      'description',
      'raw_input',
      'priority',
      'target_repo',
      'status',
      'current_phase',
      'phase_progress',
      'requester_id',
      'source_channel',
      'notification_config',
      'deadline',
      'related_tickets',
      'technical_constraints',
      'acceptance_criteria',
      'blocker',
      'promotion_count',
      'last_promoted_at',
      'paused_at_phase',
    ]);

    const entries = Object.entries(updates).filter(([key]) =>
      allowedColumns.has(key),
    );

    if (entries.length === 0) return;

    // Always bump updated_at
    entries.push([
      'updated_at',
      new Date().toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z'),
    ]);

    const setClauses = entries.map(([key]) => `${key} = ?`).join(', ');
    const values = entries.map(([, val]) => val);
    values.push(requestId);

    this.db
      .prepare(`UPDATE requests SET ${setClauses} WHERE request_id = ?`)
      .run(...values);
  }

  // =========================================================================
  // Queue queries
  // =========================================================================

  /** Count of requests with status = 'queued'. */
  getQueuedRequestCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM requests WHERE status = 'queued'")
      .get() as { cnt: number };
    return row.cnt;
  }

  /**
   * 1-based position of a request in the priority-ordered queue.
   *
   * Uses the TDD 3.7.1 ordering: priority (high=0, normal=1, low=2), then
   * created_at ASC (FIFO within each priority band).  Counts how many queued
   * requests come before the target request in that ordering.
   */
  getQueuePosition(requestId: string): number {
    const target = this.db
      .prepare(
        `SELECT ${PRIORITY_CASE} AS prio_ord, created_at
         FROM requests
         WHERE request_id = ? AND status = 'queued'`,
      )
      .get(requestId) as { prio_ord: number; created_at: string } | undefined;

    if (!target) return 0;

    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM requests
         WHERE status = 'queued'
           AND (
             ${PRIORITY_CASE} < ?
             OR (${PRIORITY_CASE} = ? AND created_at < ?)
             OR (${PRIORITY_CASE} = ? AND created_at = ? AND request_id <= ?)
           )`,
      )
      .get(
        target.prio_ord,
        target.prio_ord,
        target.created_at,
        target.prio_ord,
        target.created_at,
        requestId,
      ) as { cnt: number };

    return row.cnt;
  }

  /** Count of queued requests grouped by priority. */
  getQueuedCountByPriority(): Record<Priority, number> {
    const rows = this.db
      .prepare(
        `SELECT priority, COUNT(*) AS cnt
         FROM requests
         WHERE status = 'queued'
         GROUP BY priority`,
      )
      .all() as Array<{ priority: Priority; cnt: number }>;

    const result: Record<Priority, number> = { high: 0, normal: 0, low: 0 };
    for (const row of rows) {
      result[row.priority] = row.cnt;
    }
    return result;
  }

  // =========================================================================
  // Conversation messages
  // =========================================================================

  /**
   * Insert a conversation message. Generates and returns a UUID v4 for
   * `message_id` if not already set on the input.
   */
  insertConversationMessage(msg: ConversationMessage): string {
    const messageId = msg.message_id || crypto.randomUUID();

    this.db
      .prepare(
        `INSERT INTO conversation_messages (
          message_id, request_id, direction, channel, content,
          message_type, responded, timeout_at, thread_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        messageId,
        msg.request_id,
        msg.direction,
        msg.channel,
        msg.content,
        msg.message_type,
        msg.responded ?? 0,
        msg.timeout_at,
        msg.thread_id,
      );

    return messageId;
  }

  /** Mark a conversation message as responded. */
  markMessageResponded(messageId: string): void {
    this.db
      .prepare(
        'UPDATE conversation_messages SET responded = 1 WHERE message_id = ?',
      )
      .run(messageId);
  }

  /** Return all conversation messages that are pending (responded = 0). */
  getPendingPrompts(): ConversationMessage[] {
    return this.db
      .prepare(
        `SELECT * FROM conversation_messages
         WHERE responded = 0
         ORDER BY created_at ASC`,
      )
      .all() as ConversationMessage[];
  }

  /** Return all conversation messages for a request, ordered chronologically. */
  getConversationMessages(requestId: string): ConversationMessage[] {
    return this.db
      .prepare(
        `SELECT * FROM conversation_messages
         WHERE request_id = ?
         ORDER BY created_at ASC`,
      )
      .all(requestId) as ConversationMessage[];
  }

  /**
   * Look up an escalation target for a request.
   *
   * Checks the request's `notification_config` JSON for an escalation route,
   * then resolves the target user. Returns null if no escalation target is
   * configured.
   */
  getEscalationTarget(requestId: string): MessageTarget | null {
    const request = this.getRequest(requestId);
    if (!request) return null;

    try {
      const config = JSON.parse(request.notification_config);
      const escalationRoute = config.routes?.find(
        (r: { events?: string[] }) =>
          r.events && r.events.includes('escalation'),
      );
      if (!escalationRoute) return null;

      return {
        channelType: escalationRoute.channelType,
        platformChannelId: escalationRoute.platformChannelId,
        threadId: escalationRoute.threadId,
        userId: escalationRoute.userId,
      };
    } catch {
      return null;
    }
  }

  // =========================================================================
  // Activity logging
  // =========================================================================

  /** Insert an activity log entry. */
  insertActivityLog(entry: ActivityLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO activity_log (request_id, event, phase, details)
         VALUES (?, ?, ?, ?)`,
      )
      .run(entry.request_id, entry.event, entry.phase, entry.details);
  }

  /** Retrieve the activity log for a request, newest first, with optional limit. */
  getActivityLog(requestId: string, limit?: number): ActivityLogEntry[] {
    if (limit !== undefined) {
      return this.db
        .prepare(
          `SELECT * FROM activity_log
           WHERE request_id = ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(requestId, limit) as ActivityLogEntry[];
    }
    return this.db
      .prepare(
        `SELECT * FROM activity_log
         WHERE request_id = ?
         ORDER BY created_at DESC`,
      )
      .all(requestId) as ActivityLogEntry[];
  }

  // =========================================================================
  // Audit logging
  // =========================================================================

  /** Insert an authorization audit log entry. */
  insertAuditLog(decision: AuthzDecision): void {
    this.db
      .prepare(
        `INSERT INTO authz_audit_log (user_id, action, resource, decision, reason, source_channel)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.userId,
        decision.action,
        decision.action, // resource = action (the spec maps action as the resource)
        decision.granted ? 'grant' : 'deny',
        decision.reason,
        decision.action, // source_channel fallback to action when not available
      );
  }

  // =========================================================================
  // Rate limiting
  // =========================================================================

  /** Count actions for a user within a time window. */
  countActions(
    userId: string,
    actionType: string,
    windowStart: Date,
  ): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM rate_limit_actions
         WHERE user_id = ? AND action_type = ? AND created_at >= ?`,
      )
      .get(userId, actionType, windowStart.toISOString()) as { cnt: number };
    return row.cnt;
  }

  /** Record an action for rate limiting. */
  recordAction(
    userId: string,
    actionType: string,
    timestamp: Date,
  ): void {
    this.db
      .prepare(
        `INSERT INTO rate_limit_actions (user_id, action_type, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(userId, actionType, timestamp.toISOString());
  }

  /** Get the oldest action in a window, or null if none. */
  getOldestActionInWindow(
    userId: string,
    actionType: string,
    windowStart: Date,
  ): Date | null {
    const row = this.db
      .prepare(
        `SELECT MIN(created_at) AS oldest FROM rate_limit_actions
         WHERE user_id = ? AND action_type = ? AND created_at >= ?`,
      )
      .get(userId, actionType, windowStart.toISOString()) as {
      oldest: string | null;
    };
    return row.oldest ? new Date(row.oldest) : null;
  }

  // =========================================================================
  // Embeddings
  // =========================================================================

  /** Store an embedding BLOB for a request. */
  insertEmbedding(requestId: string, embedding: Float32Array): void {
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO request_embeddings (request_id, embedding)
         VALUES (?, ?)`,
      )
      .run(requestId, buffer);
  }

  /**
   * Return embeddings for requests that are queued, active, or completed
   * after `cutoffDate`.
   */
  getRequestEmbeddings(cutoffDate: Date): EmbeddingCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT re.request_id, re.embedding, r.status, re.created_at
         FROM request_embeddings re
         JOIN requests r ON r.request_id = re.request_id
         WHERE r.status IN ('queued', 'active')
            OR (r.status = 'done' AND r.updated_at >= ?)`,
      )
      .all(cutoffDate.toISOString()) as Array<{
      request_id: string;
      embedding: Buffer;
      status: RequestStatus;
      created_at: string;
    }>;

    return rows.map((row) => ({
      request_id: row.request_id,
      embedding: new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT,
      ),
      status: row.status,
      created_at: row.created_at,
    }));
  }

  // =========================================================================
  // Aggregations for digest and queue
  // =========================================================================

  /** Count requests grouped by status. */
  countRequestsByState(): Record<RequestStatus, number> {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS cnt
         FROM requests
         GROUP BY status`,
      )
      .all() as Array<{ status: RequestStatus; cnt: number }>;

    const result: Record<RequestStatus, number> = {
      queued: 0,
      active: 0,
      paused: 0,
      cancelled: 0,
      done: 0,
      failed: 0,
    };
    for (const row of rows) {
      result[row.status] = row.cnt;
    }
    return result;
  }

  /** Return all requests that have a non-null blocker. */
  getBlockedRequests(): RequestEntity[] {
    return this.db
      .prepare(
        `SELECT * FROM requests
         WHERE blocker IS NOT NULL AND status NOT IN ('done', 'cancelled', 'failed')
         ORDER BY created_at ASC`,
      )
      .all() as RequestEntity[];
  }

  /** Return requests completed (status = 'done') since `since`. */
  getCompletedSince(since: Date): RequestEntity[] {
    return this.db
      .prepare(
        `SELECT * FROM requests
         WHERE status = 'done' AND updated_at >= ?
         ORDER BY updated_at DESC`,
      )
      .all(since.toISOString()) as RequestEntity[];
  }

  /**
   * Average pipeline duration in milliseconds for the last `sampleSize`
   * completed requests. Returns null if no completed requests exist.
   */
  getAveragePipelineDuration(sampleSize: number): number | null {
    const rows = this.db
      .prepare(
        `SELECT created_at, updated_at FROM requests
         WHERE status = 'done'
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(sampleSize) as Array<{ created_at: string; updated_at: string }>;

    if (rows.length === 0) return null;

    const totalMs = rows.reduce((sum, row) => {
      const start = new Date(row.created_at).getTime();
      const end = new Date(row.updated_at).getTime();
      return sum + (end - start);
    }, 0);

    return totalMs / rows.length;
  }

  /**
   * Read max concurrent slots from `intake-config.yaml`. Returns 1 as the
   * default if the file is not found or unreadable.
   */
  getMaxConcurrentSlots(): number {
    try {
      // Walk up from this file's directory to find the plugin root
      const pluginRoot = path.resolve(__dirname, '..', '..');
      const configPath = path.join(pluginRoot, 'intake-config.yaml');
      const content = fs.readFileSync(configPath, 'utf-8');

      // Simple YAML value extraction (avoids a full YAML parser dependency)
      const match = content.match(
        /(?:^|\n)\s*max_concurrent_slots\s*:\s*(\d+)/,
      );
      if (match) return parseInt(match[1], 10);
    } catch {
      // Config file not found or unreadable -- use default
    }
    return 1;
  }

  // =========================================================================
  // Notification delivery tracking
  // =========================================================================

  /** Insert a notification delivery record. Returns the auto-incremented delivery_id. */
  insertDelivery(delivery: NotificationDelivery): number {
    const result = this.db
      .prepare(
        `INSERT INTO notification_deliveries (
          request_id, channel_type, target, payload_hash, status,
          attempts, last_error, delivered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        delivery.request_id,
        delivery.channel_type,
        delivery.target,
        delivery.payload_hash,
        delivery.status ?? 'pending',
        delivery.attempts ?? 0,
        delivery.last_error,
        delivery.delivered_at,
      );
    return Number(result.lastInsertRowid);
  }

  /** Update a delivery's status and optionally set last_error. */
  updateDeliveryStatus(
    deliveryId: number,
    status: string,
    error?: string,
  ): void {
    if (status === 'delivered') {
      this.db
        .prepare(
          `UPDATE notification_deliveries
           SET status = ?, last_error = ?, delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), attempts = attempts + 1
           WHERE delivery_id = ?`,
        )
        .run(status, error ?? null, deliveryId);
    } else {
      this.db
        .prepare(
          `UPDATE notification_deliveries
           SET status = ?, last_error = ?, attempts = attempts + 1
           WHERE delivery_id = ?`,
        )
        .run(status, error ?? null, deliveryId);
    }
  }

  /** Find a duplicate delivery by request_id and payload_hash. */
  findDuplicateDelivery(
    requestId: string,
    payloadHash: string,
  ): NotificationDelivery | null {
    const row = this.db
      .prepare(
        `SELECT * FROM notification_deliveries
         WHERE request_id = ? AND payload_hash = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(requestId, payloadHash);
    return (row as NotificationDelivery) ?? null;
  }

  // =========================================================================
  // User identity
  // =========================================================================

  /** Look up a user by platform-specific ID. */
  getUserByPlatformId(
    channelType: ChannelType,
    platformId: string,
  ): UserIdentity | null {
    const columnMap: Record<ChannelType, string> = {
      discord: 'discord_id',
      slack: 'slack_id',
      claude_app: 'claude_user',
    };

    const column = columnMap[channelType];
    if (!column) return null;

    const row = this.db
      .prepare(`SELECT * FROM user_identities WHERE ${column} = ?`)
      .get(platformId);
    return (row as UserIdentity) ?? null;
  }

  /** Look up a user by internal ID. */
  getUserByInternalId(internalId: string): UserIdentity | null {
    const row = this.db
      .prepare('SELECT * FROM user_identities WHERE internal_id = ?')
      .get(internalId);
    return (row as UserIdentity) ?? null;
  }

  /** Insert or update a user identity. */
  upsertUser(user: UserIdentity): void {
    this.db
      .prepare(
        `INSERT INTO user_identities (
          internal_id, role, discord_id, slack_id, claude_user,
          repo_permissions, rate_limit_override
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(internal_id) DO UPDATE SET
          role = excluded.role,
          discord_id = excluded.discord_id,
          slack_id = excluded.slack_id,
          claude_user = excluded.claude_user,
          repo_permissions = excluded.repo_permissions,
          rate_limit_override = excluded.rate_limit_override,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run(
        user.internal_id,
        user.role,
        user.discord_id,
        user.slack_id,
        user.claude_user,
        user.repo_permissions,
        user.rate_limit_override,
      );
  }

  /** Count total users. */
  getUserCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM user_identities')
      .get() as { cnt: number };
    return row.cnt;
  }

  // =========================================================================
  // Request ID generation (Task 4)
  // =========================================================================

  /**
   * Generate the next request ID atomically.
   *
   * Uses `UPDATE ... RETURNING` on the `id_counter` table, which is
   * atomic within SQLite's single-writer lock. Produces IDs in the
   * format `REQ-000001`, `REQ-000002`, etc.
   */
  generateRequestId(): string {
    const result = this.db
      .prepare(
        `UPDATE id_counter
         SET current_value = current_value + 1
         WHERE counter_name = 'request_id'
         RETURNING current_value`,
      )
      .get() as { current_value: number };
    return `REQ-${String(result.current_value).padStart(6, '0')}`;
  }

  // =========================================================================
  // Shutdown support
  // =========================================================================

  /** Force a WAL checkpoint (TRUNCATE mode). */
  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  // =========================================================================
  // Transaction support
  // =========================================================================

  /**
   * Execute `fn` inside a database transaction. If `fn` throws, all
   * changes are rolled back.
   */
  transaction<T>(fn: () => T): T {
    const wrapped = this.db.transaction(fn);
    return wrapped();
  }
}
