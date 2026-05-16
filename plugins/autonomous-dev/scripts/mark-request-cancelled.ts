#!/usr/bin/env node
/**
 * Mark a request as cancelled with a reason.
 *
 * Usage: npx tsx scripts/mark-request-cancelled.ts <request_id> <reason>
 */

import { Repository } from '../intake/db/repository';
import { initializeDatabase } from '../intake/db/migrator';
import * as path from 'path';
import { fileURLToPath } from 'url';

function defaultDbPath(): string {
  const home = process.env.HOME || process.cwd();
  return path.join(home, '.autonomous-dev', 'intake.db');
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error('Usage: npx tsx scripts/mark-request-cancelled.ts <request_id> <reason>');
    process.exit(1);
  }

  const [requestId, reason] = args;

  const dbPath = defaultDbPath();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDir = path.resolve(__dirname, '..', 'intake', 'db', 'migrations');
  const { db } = initializeDatabase(dbPath, migrationsDir);
  const repo = new Repository(db);

  try {
    repo.markRequestCancelled(requestId, reason);
    console.log(`Request ${requestId} marked as cancelled with reason: ${reason}`);
  } catch (err) {
    console.error(`Failed to mark request as cancelled: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}