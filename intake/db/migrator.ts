/**
 * SQLite migration framework for the Intake Layer.
 *
 * Scans `intake/db/migrations/` for numbered `.sql` files, tracks which
 * have been applied in a `_migrations` table, and runs new ones inside
 * transactions.  Fully idempotent: running twice produces no change.
 *
 * Requires `better-sqlite3` at runtime.
 *
 * @module migrator
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Optional better-sqlite3 import
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type Database = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

let BetterSqlite3: ((...args: unknown[]) => Database) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  BetterSqlite3 = require('better-sqlite3');
} catch {
  // Module not available at compile time; callers must provide a db instance.
}

// ---------------------------------------------------------------------------
// Migration tracking DDL
// ---------------------------------------------------------------------------

const CREATE_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS _migrations (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Result returned after running migrations. */
export interface MigrationResult {
  /** Names of migration files that were newly applied in this run. */
  applied: string[];
  /** Names of migration files that were already applied (skipped). */
  skipped: string[];
}

/**
 * Open (or create) a SQLite database at `dbPath` and return the
 * `better-sqlite3` instance.  Enables WAL mode and foreign keys.
 *
 * @param dbPath  Filesystem path to the database file, or `':memory:'`.
 * @returns The opened database instance.
 * @throws If `better-sqlite3` is not installed.
 */
export function openDatabase(dbPath: string): Database {
  if (!BetterSqlite3) {
    throw new Error(
      'better-sqlite3 is required but not installed. Run: npm install better-sqlite3',
    );
  }
  const db = (BetterSqlite3 as any)(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * Run all pending migrations from `migrationsDir` against `db`.
 *
 * 1. Ensures the `_migrations` tracking table exists.
 * 2. Reads all `*.sql` files from `migrationsDir`, sorted by name.
 * 3. For each file not already in `_migrations`, wraps execution in a
 *    transaction: runs the SQL, then records the migration name.
 * 4. Returns the list of newly applied and skipped migration names.
 *
 * @param db             An open `better-sqlite3` database instance.
 * @param migrationsDir  Path to the directory containing `*.sql` migration files.
 * @returns A {@link MigrationResult} summarizing what happened.
 */
export function runMigrations(db: Database, migrationsDir: string): MigrationResult {
  // Ensure the migrations tracking table exists
  db.exec(CREATE_MIGRATIONS_TABLE);

  // Discover migration files, sorted lexicographically
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f: string) => f.endsWith('.sql'))
    .sort();

  // Determine which migrations have already been applied
  const appliedRows: Array<{ name: string }> = db
    .prepare('SELECT name FROM _migrations')
    .all();
  const appliedSet = new Set(appliedRows.map((r) => r.name));

  const result: MigrationResult = {
    applied: [],
    skipped: [],
  };

  for (const file of files) {
    if (appliedSet.has(file)) {
      result.skipped.push(file);
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

    // Wrap in a transaction: execute the migration SQL, then record it.
    // The PRAGMA statements in the migration file (journal_mode, foreign_keys)
    // cannot run inside a transaction, so we strip them out and handle them
    // via openDatabase() instead.
    const executableSql = stripPragmas(sql);

    const applyMigration = db.transaction(() => {
      db.exec(executableSql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    });

    applyMigration();
    result.applied.push(file);
  }

  return result;
}

/**
 * Convenience: open a database and run all migrations in one call.
 *
 * @param dbPath         Path to the SQLite database file (or `':memory:'`).
 * @param migrationsDir  Path to the migrations directory.
 * @returns An object with the database instance and the migration result.
 */
export function initializeDatabase(
  dbPath: string,
  migrationsDir?: string,
): { db: Database; migrations: MigrationResult } {
  const db = openDatabase(dbPath);
  const dir = migrationsDir ?? path.join(__dirname, 'migrations');
  const migrations = runMigrations(db, dir);
  return { db, migrations };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Remove PRAGMA statements from a SQL string.
 * PRAGMAs cannot execute inside a transaction in SQLite; they are handled
 * separately by `openDatabase()`.
 */
function stripPragmas(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().toUpperCase().startsWith('PRAGMA'))
    .join('\n');
}
