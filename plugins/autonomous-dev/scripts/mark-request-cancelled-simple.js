#!/usr/bin/env node
/**
 * Mark a request as cancelled with a reason (Node.js version).
 *
 * Usage: node scripts/mark-request-cancelled-simple.js <request_id> <reason>
 */

import Database from 'better-sqlite3';
import * as path from 'path';

function defaultDbPath() {
  const home = process.env.HOME || process.cwd();
  return path.join(home, '.autonomous-dev', 'intake.db');
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error('Usage: node scripts/mark-request-cancelled-simple.js <request_id> <reason>');
    process.exit(1);
  }

  const [requestId, reason] = args;
  const dbPath = defaultDbPath();

  try {
    const db = new Database(dbPath);

    const now = new Date().toISOString();
    const updateStmt = db.prepare(`
      UPDATE requests
      SET status = 'cancelled',
          cancelled_reason = ?,
          updated_at = ?
      WHERE request_id = ?
    `);

    const result = updateStmt.run(reason, now, requestId);

    if (result.changes === 0) {
      console.error(`Request ${requestId} not found`);
      process.exit(1);
    }

    console.log(`Request ${requestId} marked as cancelled with reason: ${reason}`);
    db.close();
  } catch (err) {
    console.error(`Failed to mark request as cancelled: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}