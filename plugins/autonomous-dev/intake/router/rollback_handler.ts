/**
 * Rollback handlers for F1/F2/F3 failures (SPEC-012-1-02 §"Rollback Handlers").
 *
 * The rollback handlers execute WITHIN the two-phase commit on detection of
 * a failure. F1 (validation/lock) is a no-op for FS/DB, F2 (temp write)
 * unlinks the temp, F3 (SQLite commit) rolls back the txn AND unlinks the
 * temp. F4 is intentionally NOT a rollback — it is forward-recovery via
 * `intake/recovery/promotion.ts` (SPEC-012-1-04).
 *
 * Idempotency:
 *   - Every handler is safe to call multiple times.
 *   - `unlink` ENOENT → success.
 *   - `db.rollback()` "no transaction in progress" → success.
 *
 * Path sanitization:
 *   - Logs surfaced for adapters with `source ∈ {discord, slack, github}`
 *     are passed through `sanitizeErrorMessage` to strip filesystem paths.
 *   - Internal logs (DEBUG-equivalent) MAY include paths.
 *
 * Note: SPEC-012-1-01's `submitRequest` already performs the F2/F3
 * cleanup inline in its protocol implementation (`unlinkIfExists` + the
 * SQLite txn's catch+ROLLBACK). This module exposes the same logic as
 * standalone helpers for callers (e.g., the recovery runner, tests, and
 * adapter-level retry loops) that need to invoke the cleanup without
 * driving the full submit protocol.
 *
 * @module router/rollback_handler
 */

import * as fs from 'fs';

import { sanitizeErrorMessage } from '../core/handoff_manager';
import type { RequestSource } from '../types/request_source';

// ---------------------------------------------------------------------------
// RollbackContext
// ---------------------------------------------------------------------------

/**
 * Inputs to a rollback handler. Every field is OPTIONAL because the F1
 * handler needs none, F2 needs only `tmpPath`, and F3 needs both. Tests
 * pass partial contexts; production calls always pass everything.
 */
export interface RollbackContext {
  /** ID of the request being rolled back (for log enrichment). */
  requestId: string;
  /** Original adapter source (drives sanitization). */
  source?: RequestSource;
  /** Path to the temp file (Phase A artifact); if present, unlinked. */
  tmpPath?: string;
  /**
   * Open SQLite handle. F3 calls `db.exec('ROLLBACK')`; "no transaction"
   * is treated as success.
   */
  /* eslint-disable @typescript-eslint/no-explicit-any */
  db?: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  /** Underlying error (for logging only; sanitized when surfaced). */
  error?: Error;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Adapters whose error surfaces are external/untrusted. */
const UNTRUSTED_SOURCES = new Set<string>(['discord', 'slack', 'github']);

function maybeSanitize(message: string, source?: RequestSource): string {
  if (!source) return message;
  return UNTRUSTED_SOURCES.has(source) ? sanitizeErrorMessage(message) : message;
}

function logRollback(
  handler: 'F1' | 'F2' | 'F3',
  ctx: RollbackContext,
  extra: Record<string, unknown> = {},
): void {
  const message = ctx.error?.message ?? '';
  // eslint-disable-next-line no-console
  console.warn(
    JSON.stringify({
      event: `handoff.rollback.${handler}`,
      requestId: ctx.requestId,
      source: ctx.source ?? null,
      error: maybeSanitize(message, ctx.source),
      ...extra,
    }),
  );
}

function unlinkIdempotent(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      // Surface as warning so operators see persistent unlink failures
      // (e.g., EACCES on a misconfigured mount), but do NOT throw —
      // rollback handlers MUST be infallible.
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          event: 'handoff.rollback.unlink_failed',
          path: p,
          error: (err as Error).message,
        }),
      );
    }
  }
}

function rollbackTxnIdempotent(
  /* eslint-disable @typescript-eslint/no-explicit-any */
  db: any,
  /* eslint-enable @typescript-eslint/no-explicit-any */
): void {
  try {
    db.exec('ROLLBACK');
  } catch (err: unknown) {
    const message = (err as Error).message ?? '';
    // SQLite reports "cannot rollback - no transaction is active" or
    // similar wording across versions. Treat any "no transaction" variant
    // as success.
    if (/no transaction/i.test(message)) return;
    // Other errors surface as a warning; we do NOT re-throw because
    // rollback handlers MUST be infallible.
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        event: 'handoff.rollback.txn_failed',
        error: message,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * F1: validation / lock failure. No FS or DB state was created, so there
 * is nothing to clean up — we simply log the validation error.
 *
 * Idempotent: a no-op the second time (still just a log line).
 */
export async function rollbackF1(ctx: RollbackContext): Promise<void> {
  logRollback('F1', ctx);
}

/**
 * F2: temp write failed. SQLite never opened a txn, so there is nothing
 * to roll back. The temp file MAY exist (open succeeded but write failed)
 * — unlink it idempotently.
 */
export async function rollbackF2(ctx: RollbackContext): Promise<void> {
  if (ctx.tmpPath) unlinkIdempotent(ctx.tmpPath);
  logRollback('F2', ctx, { tmpPath: ctx.tmpPath ?? null });
}

/**
 * F3: SQLite commit failed (or threw mid-txn). Roll back the txn AND
 * unlink the temp. Both operations are idempotent. We perform BOTH even
 * if one throws — a partial cleanup is worse than a noisy log.
 */
export async function rollbackF3(ctx: RollbackContext): Promise<void> {
  let txnErr: Error | null = null;
  if (ctx.db) {
    try {
      rollbackTxnIdempotent(ctx.db);
    } catch (err) {
      txnErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  if (ctx.tmpPath) unlinkIdempotent(ctx.tmpPath);
  logRollback('F3', ctx, {
    tmpPath: ctx.tmpPath ?? null,
    txn_rollback_error: txnErr?.message ?? null,
  });
}
