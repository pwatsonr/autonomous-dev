#!/usr/bin/env node
/**
 * Find orphan SQLite rows for reconciliation (Node.js version).
 * Emits pipe-delimited output: request_id|target_repo|created_at
 *
 * Usage: node scripts/find-orphan-sqlite-rows-simple.js
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import { fileURLToPath } from 'url';

function defaultDbPath() {
  const home = process.env.HOME || process.cwd();
  return path.join(home, '.autonomous-dev', 'intake.db');
}

function main() {
  const dbPath = defaultDbPath();

  try {
    const db = new Database(dbPath);

    // Find orphan SQLite rows (queued status, older than 24h)
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - 24);
    const cutoffIso = cutoff.toISOString();

    const query = `
      SELECT request_id, target_repo, created_at
      FROM requests
      WHERE status = 'queued'
      AND created_at < ?
      ORDER BY created_at ASC
    `;

    const rows = db.prepare(query).all(cutoffIso);

    for (const row of rows) {
      console.log(`${row.request_id}|${row.target_repo}|${row.created_at}`);
    }

    db.close();
  } catch (err) {
    console.error(`Database error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}