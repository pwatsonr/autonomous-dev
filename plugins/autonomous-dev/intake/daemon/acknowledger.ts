/**
 * Daemon-side acknowledgment writer (SPEC-012-1-03 §"Acknowledger").
 *
 * Marks a request as consumed by the daemon. Uses `BEGIN IMMEDIATE` so two
 * racing daemons cannot both ack the same request — exactly one wins;
 * the other receives `ALREADY_ACKED` (which callers SHOULD treat as
 * success).
 *
 * Schema dependency: requires migration `003_add_acknowledgment.sql`
 * (adds `acknowledged_at` + `acknowledged_by` columns + supporting
 * partial index on the unacked set).
 *
 * @module daemon/acknowledger
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type Database = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Discriminated outcome of an `acknowledgeRequest` call. */
export type AckResult =
  | { ok: true }
  | { ok: false; reason: 'ALREADY_ACKED' | 'NOT_FOUND' | 'DB_ERROR'; details?: string };

// ---------------------------------------------------------------------------
// acknowledgeRequest
// ---------------------------------------------------------------------------

/**
 * Atomically claim a request for the calling daemon instance.
 *
 * Protocol:
 *   1. Open `BEGIN IMMEDIATE` (acquires SQLite reserved lock).
 *   2. SELECT acknowledged_at + check NULL.
 *   3. UPDATE both columns + COMMIT.
 *
 * Returns:
 *   - `ok: true`              — exclusive winner.
 *   - `ALREADY_ACKED`         — another daemon (or a previous run) already
 *                                acknowledged. Treat as success.
 *   - `NOT_FOUND`             — no such request_id row exists.
 *   - `DB_ERROR`              — unexpected SQLite error (logged + surfaced).
 */
export async function acknowledgeRequest(
  db: Database,
  requestId: string,
  consumerId: string,
): Promise<AckResult> {
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    return {
      ok: false,
      reason: 'DB_ERROR',
      details: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const row = db
      .prepare('SELECT acknowledged_at FROM requests WHERE request_id = ?')
      .get(requestId) as { acknowledged_at: string | null } | undefined;

    if (!row) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'NOT_FOUND' };
    }

    if (row.acknowledged_at !== null) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'ALREADY_ACKED' };
    }

    const ts = new Date().toISOString();
    db.prepare(
      `UPDATE requests
       SET acknowledged_at = ?, acknowledged_by = ?
       WHERE request_id = ? AND acknowledged_at IS NULL`,
    ).run(ts, consumerId, requestId);

    db.exec('COMMIT');
    return { ok: true };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore double-rollback
    }
    return {
      ok: false,
      reason: 'DB_ERROR',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}
