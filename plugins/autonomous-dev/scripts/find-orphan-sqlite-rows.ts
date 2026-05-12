#!/usr/bin/env bun
/**
 * Find orphan SQLite rows for reconciliation.
 * Emits pipe-delimited output: request_id|target_repo|created_at
 *
 * Usage: bun scripts/find-orphan-sqlite-rows.ts
 */

import { Repository } from '../intake/db/repository';
import { initializeDatabase } from '../intake/db/migrator';
import * as path from 'path';

function defaultDbPath(): string {
  const home = process.env.HOME || process.cwd();
  return path.join(home, '.autonomous-dev', 'intake.db');
}

function main() {
  const dbPath = defaultDbPath();
  const migrationsDir = path.resolve(__dirname, '..', 'intake', 'db', 'migrations');
  const { db } = initializeDatabase(dbPath, migrationsDir);
  const repo = new Repository(db);

  const orphans = repo.findOrphanRows();
  for (const orphan of orphans) {
    console.log(`${orphan.request_id}|${orphan.target_repo}|${orphan.created_at}`);
  }
}

if (import.meta.main) {
  main();
}