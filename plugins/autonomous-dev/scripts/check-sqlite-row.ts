#!/usr/bin/env bun
/**
 * Check if a SQLite row exists for a request ID.
 * Emits true|false
 *
 * Usage: bun scripts/check-sqlite-row.ts <request_id>
 */

import { Repository } from '../intake/db/repository';
import { initializeDatabase } from '../intake/db/migrator';
import * as path from 'path';

function defaultDbPath(): string {
  const home = process.env.HOME || process.cwd();
  return path.join(home, '.autonomous-dev', 'intake.db');
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: bun scripts/check-sqlite-row.ts <request_id>');
    process.exit(1);
  }

  const [requestId] = args;

  const dbPath = defaultDbPath();
  const migrationsDir = path.resolve(__dirname, '..', 'intake', 'db', 'migrations');
  const { db } = initializeDatabase(dbPath, migrationsDir);
  const repo = new Repository(db);

  try {
    const request = repo.getRequest(requestId);
    console.log(request ? 'true' : 'false');
  } catch (err) {
    // If getRequest throws, treat as not found
    console.log('false');
  }
}

if (import.meta.main) {
  main();
}